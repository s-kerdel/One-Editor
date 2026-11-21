// "Security updates" (opt-in, desktop only): does this build ship an Electron or a library with a known
// problem? Pure logic shared by main (src/main/update-check.ts does the requests) and the renderer UI.
// Two public APIs, nothing else: endoflife.date (Electron patches / end of support) and OSV (known
// vulnerabilities for the exact versions in dist/main/shipped-deps.json). No ids, paths or cookies.
export const UPDATE_CHECK_CHANNELS = {
  status: 'updates:status',
  check: 'updates:check',
  /** main → renderer: a new UpdateStatus. */
  changed: 'updates:changed',
} as const;

/** The only hosts a check may talk to. Don't add one: every host learns the user's IP + library versions. */
export const UPDATE_HOSTS: ReadonlySet<string> = new Set(['endoflife.date', 'api.osv.dev']);
export const UPDATE_ENDPOINTS = { eol: 'https://endoflife.date', osv: 'https://api.osv.dev' } as const;
export const EOL_PATH = '/api/v1/products/electron/';
export const OSV_BATCH_PATH = '/v1/querybatch';
export const OSV_VULN_PATH = '/v1/vulns/';

export const CHECK_INTERVAL_MS = 7 * 86_400_000;
export const EOL_WARN_DAYS = 45;
/** Detail requests per check (one per distinct advisory); further hits are listed without details. */
export const MAX_DETAILS = 25;
export const MAX_FINDINGS = 100;
/** Rows a stored summary may list (a build ships ~250): a doctored file stays small. */
export const MAX_SUMMARY_PACKAGES = 2000;

export type Severity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';
/** `high` = red, `warn` = orange, `info` = listed in the panel only (no shield). */
export type FindingLevel = 'high' | 'warn' | 'info';
export type FindingKind = 'vuln' | 'electron-patch' | 'electron-eol' | 'electron-major';

export interface Finding {
  id: string;
  kind: FindingKind;
  level: FindingLevel;
  /** Package name ("electron", "dompurify"). */
  pkg: string;
  /** Version this build ships. */
  version: string;
  /** Version that fixes it, when known. */
  fixed: string | null;
  severity?: Severity;
  /** One line. */
  summary: string;
  url: string;
}

export interface UpdateStatus {
  /** Time of the last complete check (ms), null = never. */
  lastChecked: number | null;
  /** Why the last attempt failed (short, no URL parameters), null = it worked. */
  lastError: string | null;
  lastAttempt: number | null;
  checking: boolean;
  findings: Finding[];
  /** What the last attempt looked at; null = none yet, or it was about another build. */
  summary: CheckSummary | null;
}

/** The running Electron's release line, as endoflife.date lists it. */
export interface ElectronSummary {
  /** The Electron this build runs. */
  version: string;
  /** Newest patch of that major; null = the major is not listed. */
  latest: string | null;
  /** End of support (YYYY-MM-DD); null = not announced. */
  eol: string | null;
  /** false = out of support; null = unknown (the major is not listed). */
  supported: boolean | null;
  /** A newer major, when there is one. */
  newestMajor: string | null;
}

/** One package sent to OSV and how many advisories OSV has for exactly that version. */
export interface PackageCheck {
  name: string;
  version: string;
  vulns: number;
}

/** One attempt, half by half: a failed half has no data, only its error (plain words). */
export interface CheckSummary {
  /** When it started (ms) and how long it took. */
  at: number;
  ms: number;
  electron: ElectronSummary | null;
  electronError: string | null;
  /** Everything sent to OSV, Electron first. */
  packages: PackageCheck[] | null;
  packagesError: string | null;
}

export const NO_STATUS: UpdateStatus = { lastChecked: null, lastError: null, lastAttempt: null, checking: false, findings: [], summary: null };

export type UpdateReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export interface ShippedDeps {
  electron: string;
  /** Production dependencies (transitive included), exact versions, sorted, unique. */
  packages: { name: string; version: string }[];
}

// ---- host allowlist ---------------------------------------------------------------------------------

/** https, one of the two hosts, default port, no credentials. Everything else is refused before a request. */
export function isAllowedUpdateUrl(raw: string, hosts: ReadonlySet<string> = UPDATE_HOSTS): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && hosts.has(u.hostname) && u.port === '' && u.username === '' && u.password === '';
}

// ---- versions ---------------------------------------------------------------------------------------

/** [major, minor, patch, prerelease] or null when it is not a version. */
function parseVersion(v: string): [number, number, number, string] | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ?? ''] : null;
}

/** < 0 when a is older than b. A prerelease is older than its release; unparsable sorts first. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  if (x[3] === y[3]) return 0;
  if (!x[3]) return 1;
  if (!y[3]) return -1;
  return x[3].localeCompare(y[3], 'en', { numeric: true });
}

export const majorOf = (v: string): string => String(parseVersion(v)?.[0] ?? '');

/** A version as the build's lockfile has it (parseShipped, a stored summary). */
export const isShippedVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(v);
/** A version taken from a reply: plain release or prerelease, nothing after it (it ends up in a link). */
const isReleaseVersion = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v);

// ---- schedule ---------------------------------------------------------------------------------------

/** The automatic check after launch: only when switched on and the last complete check is a week old. */
export function isCheckDue(enabled: boolean, lastChecked: number | null, now: number, interval = CHECK_INTERVAL_MS): boolean {
  if (!enabled) return false;
  if (lastChecked === null || !Number.isFinite(lastChecked)) return true;
  // A clock set back must not silence the check for good.
  return now - lastChecked >= interval || lastChecked > now;
}

// ---- Electron (endoflife.date) ----------------------------------------------------------------------

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const LEVEL_ORDER: Record<FindingLevel, number> = { high: 0, warn: 1, info: 2 };
const ELECTRON_RELEASES = 'https://releases.electronjs.org';
/** The two sources as the UI links them: fixed pages, nothing from a reply. */
export const EOL_PAGE = 'https://endoflife.date/electron';
export const OSV_PAGE = 'https://osv.dev/';

/** Days until `date` (YYYY-MM-DD), rounded up; ≤ 0 = that day has come. NaN when it is no date. */
export function daysUntil(date: string, now: number): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  return Math.ceil((t - now) / 86_400_000);
}

/** What endoflife.date says about the running Electron's major. A wrong shape is an error. */
export function electronSummary(body: unknown, running: string, now: number): ElectronSummary {
  const releases = (body as { result?: { releases?: unknown } } | null)?.result?.releases;
  if (!Array.isArray(releases)) throw new Error('Unexpected reply from endoflife.date');
  const major = majorOf(running);
  const rel = releases.find((r) => r && typeof r === 'object' && (r as { name?: unknown }).name === major) as { eolFrom?: unknown; isEol?: unknown; latest?: { name?: unknown } } | undefined;
  const latest = str(rel?.latest?.name, 40);
  const eol = str(rel?.eolFrom, 20);
  const days = daysUntil(eol, now);
  const newest = releases
    .map((r) => str((r as { name?: unknown } | null)?.name, 10))
    .filter((n) => /^\d+$/.test(n) && Number(n) > Number(major))
    .sort((a, b) => Number(b) - Number(a))[0];
  return {
    version: running,
    latest: rel && isReleaseVersion(latest) && majorOf(latest) === major ? latest : null,
    eol: Number.isFinite(days) ? eol : null,
    supported: rel ? !(rel.isEol === true || days <= 0) : null,
    newestMajor: newest ?? null,
  };
}

/** Findings for the running Electron from an endoflife.date `products/electron` reply. */
export function electronFindings(body: unknown, running: string, now: number): Finding[] {
  return electronFindingsOf(electronSummary(body, running, now), now);
}

export function electronFindingsOf(e: ElectronSummary, now: number): Finding[] {
  const { version: running, eol } = e;
  const major = majorOf(running);
  const out: Finding[] = [];
  if (e.latest && compareVersions(e.latest, running) > 0) {
    out.push({
      id: 'electron-patch',
      kind: 'electron-patch',
      level: 'warn',
      pkg: 'electron',
      version: running,
      fixed: e.latest,
      summary: `Electron ${e.latest} is out: patches carry Chromium security fixes.`,
      // Built from the version, not taken from the reply: only Electron's own release page is opened.
      url: `${ELECTRON_RELEASES}/release/v${e.latest}`,
    });
  }
  const days = eol ? daysUntil(eol, now) : NaN;
  const ended = e.supported === false;
  if (e.supported !== null && (ended || days <= EOL_WARN_DAYS)) {
    out.push({
      id: 'electron-eol',
      kind: 'electron-eol',
      level: 'warn',
      pkg: 'electron',
      version: running,
      fixed: null,
      summary: ended
        ? `Electron ${major} is out of support${eol ? ` since ${eol}` : ''}: no more security fixes. Move to a newer major.`
        : `Support for Electron ${major} ends ${eol} (${days} day${days === 1 ? '' : 's'}). Plan the move to a newer major.`,
      url: EOL_PAGE,
    });
  }
  if (e.newestMajor) {
    out.push({
      id: 'electron-major',
      kind: 'electron-major',
      level: 'info',
      pkg: 'electron',
      version: running,
      fixed: null,
      summary: `Electron ${e.newestMajor} is available. No hurry while ${major} is supported.`,
      url: ELECTRON_RELEASES,
    });
  }
  return out;
}

// ---- libraries (OSV) --------------------------------------------------------------------------------

export interface OsvQuery {
  package: { name: string; ecosystem: 'npm' };
  version: string;
}

/** One query per shipped package, Electron first. The whole request body: names + versions, nothing else. */
export function osvQueries(deps: ShippedDeps): OsvQuery[] {
  const seen = new Set<string>();
  const out: OsvQuery[] = [];
  for (const p of [{ name: 'electron', version: deps.electron }, ...deps.packages]) {
    const key = `${p.name}@${p.version}`;
    if (p.name === 'electron' && out.length) continue;
    if (seen.has(key) || !isPackageName(p.name) || !parseVersion(p.version)) continue;
    seen.add(key);
    out.push({ package: { name: p.name, ecosystem: 'npm' }, version: p.version });
  }
  return out;
}

export const isPackageName = (n: unknown): n is string => typeof n === 'string' && /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/i.test(n) && n.length <= 214;
/** OSV ids ("GHSA-xxxx-xxxx-xxxx", "CVE-2026-1234", "MAL-2026-1"): the only thing put into a request path. */
export const isVulnId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,6}$/.test(id) && id.length <= 64;

export interface OsvHit {
  id: string;
  pkg: string;
  version: string;
}

/** `results[i]` answers `queries[i]`. */
export function osvHits(queries: OsvQuery[], body: unknown): OsvHit[] {
  const results = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(results) || results.length !== queries.length) throw new Error('Unexpected reply from OSV');
  const out: OsvHit[] = [];
  const seen = new Set<string>();
  results.forEach((r, i) => {
    const vulns = (r as { vulns?: unknown } | null)?.vulns;
    if (!Array.isArray(vulns)) return;
    for (const v of vulns) {
      const id = (v as { id?: unknown } | null)?.id;
      const key = `${id}:${queries[i].package.name}@${queries[i].version}`;
      if (!isVulnId(id) || seen.has(key)) continue;
      seen.add(key);
      out.push({ id, pkg: queries[i].package.name, version: queries[i].version });
    }
  });
  return out;
}

const SEVERITIES: Severity[] = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'];

/** CVSS v3.x base score from its vector ("CVSS:3.1/AV:N/AC:L/…"); null for anything else (v2, v4). */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m: Record<string, string> = {};
  for (const part of vector.split('/').slice(1)) {
    const [k, v] = part.split(':');
    m[k] = v;
  }
  const changed = m.S === 'C';
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV];
  const ac = { L: 0.77, H: 0.44 }[m.AC];
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const ui = { N: 0.85, R: 0.62 }[m.UI];
  const cia = { H: 0.56, L: 0.22, N: 0 } as Record<string, number>;
  const [c, i, a] = [cia[m.C], cia[m.I], cia[m.A]];
  if ([av, ac, pr, ui, c, i, a].some((x) => x === undefined) || (m.S !== 'U' && m.S !== 'C')) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const expl = 8.22 * av! * ac! * pr! * ui!;
  // "Round up" of the specification: one decimal, on integers so 4.0 does not become 4.1.
  const up = (x: number) => Math.ceil(Math.round(x * 100000) / 10000) / 10;
  return up(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10));
}

export const severityOfScore = (s: number): Severity => (s >= 9 ? 'CRITICAL' : s >= 7 ? 'HIGH' : s >= 4 ? 'MODERATE' : s > 0 ? 'LOW' : 'UNKNOWN');

/** GitHub's rating when the advisory has one, else from the CVSS v3 vector, else unknown. */
export function severityOf(vuln: unknown): Severity {
  const v = (vuln ?? {}) as { id?: unknown; database_specific?: { severity?: unknown }; severity?: unknown };
  const named = str(v.database_specific?.severity, 20).toUpperCase();
  if (named === 'MEDIUM') return 'MODERATE';
  if ((SEVERITIES as string[]).includes(named)) return named as Severity;
  let best: number | null = null;
  for (const s of Array.isArray(v.severity) ? v.severity : []) {
    const score = cvss3Score(str((s as { score?: unknown } | null)?.score, 200));
    if (score !== null && (best === null || score > best)) best = score;
  }
  if (best !== null) return severityOfScore(best);
  // A package reported as malware: nothing to weigh.
  return typeof v.id === 'string' && v.id.startsWith('MAL-') ? 'CRITICAL' : 'UNKNOWN';
}

export const levelOfSeverity = (s: Severity): FindingLevel => (s === 'CRITICAL' || s === 'HIGH' ? 'high' : 'warn');

/** The lowest "fixed" version above the shipped one in the advisory's ranges for this package. */
export function fixedVersion(vuln: unknown, pkg: string, version: string): string | null {
  const affected = (vuln as { affected?: unknown } | null)?.affected;
  let best: string | null = null;
  for (const a of Array.isArray(affected) ? affected : []) {
    const p = (a as { package?: { name?: unknown; ecosystem?: unknown } } | null)?.package;
    if (p?.name !== pkg || p?.ecosystem !== 'npm') continue;
    for (const r of Array.isArray((a as { ranges?: unknown }).ranges) ? ((a as { ranges: unknown[] }).ranges) : []) {
      for (const e of Array.isArray((r as { events?: unknown } | null)?.events) ? (r as { events: unknown[] }).events : []) {
        const f = str((e as { fixed?: unknown } | null)?.fixed, 40);
        if (!f || !parseVersion(f) || compareVersions(f, version) <= 0) continue;
        if (best === null || compareVersions(f, best) < 0) best = f;
      }
    }
  }
  return best;
}

export const vulnUrl = (id: string) => `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;

/** A row for one hit; `detail` = the advisory (`/v1/vulns/<id>`), or null when it was not fetched. */
export function vulnFinding(hit: OsvHit, detail: unknown): Finding {
  const severity = detail ? severityOf(detail) : hit.id.startsWith('MAL-') ? 'CRITICAL' : 'UNKNOWN';
  const d = (detail ?? {}) as { summary?: unknown; details?: unknown };
  return {
    id: `vuln:${hit.id}:${hit.pkg}@${hit.version}`,
    kind: 'vuln',
    level: levelOfSeverity(severity),
    pkg: hit.pkg,
    version: hit.version,
    fixed: detail ? fixedVersion(detail, hit.pkg, hit.version) : null,
    severity,
    summary: str(d.summary, 200) || str(d.details, 200) || `Known vulnerability ${hit.id}: open the link for details.`,
    url: vulnUrl(hit.id),
  };
}

/** One row per package sent to OSV; `vulns` = distinct advisories for exactly that version. */
export function packageChecks(queries: OsvQuery[], hits: OsvHit[]): PackageCheck[] {
  const n = new Map<string, number>();
  for (const h of hits) n.set(`${h.pkg}@${h.version}`, (n.get(`${h.pkg}@${h.version}`) ?? 0) + 1);
  return queries.map((q) => ({ name: q.package.name, version: q.version, vulns: n.get(`${q.package.name}@${q.version}`) ?? 0 }));
}

export function sortFindings(list: Finding[]): Finding[] {
  const sev = (f: Finding) => (f.severity ? ['CRITICAL', 'HIGH', 'MODERATE', 'LOW', 'UNKNOWN'].indexOf(f.severity) : 5);
  return [...list].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || sev(a) - sev(b) || a.pkg.localeCompare(b.pkg) || a.id.localeCompare(b.id));
}

// ---- cache ------------------------------------------------------------------------------------------

/** A finding is about one shipped version: once the build ships another one, it is gone. */
export function stillShipped(findings: Finding[], deps: ShippedDeps): Finding[] {
  const shipped = new Set(deps.packages.map((p) => `${p.name}@${p.version}`));
  return findings.filter((f) => (f.pkg === 'electron' ? f.version === deps.electron : shipped.has(`${f.pkg}@${f.version}`)));
}

/** A summary describes one build: after an update it no longer says what runs, so it is dropped. */
export function sameBuild(s: CheckSummary, deps: ShippedDeps): boolean {
  if (s.electron && s.electron.version !== deps.electron) return false;
  if (!s.packages) return true;
  const now = osvQueries(deps);
  return s.packages.length === now.length && s.packages.every((p, i) => p.name === now[i].package.name && p.version === now[i].version);
}

const KINDS: FindingKind[] = ['vuln', 'electron-patch', 'electron-eol', 'electron-major'];
const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

/** A stored summary: the same checks as a fresh reply, every field typed and capped. */
export function parseSummary(raw: unknown): CheckSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const at = time(o.at);
  if (at === null) return null;
  const e = (o.electron && typeof o.electron === 'object' ? o.electron : null) as Record<string, unknown> | null;
  const electron: ElectronSummary | null =
    e && isShippedVersion(e.version)
      ? {
          version: e.version,
          latest: isReleaseVersion(e.latest) ? e.latest : null,
          eol: typeof e.eol === 'string' && Number.isFinite(daysUntil(e.eol, 0)) ? e.eol : null,
          supported: typeof e.supported === 'boolean' ? e.supported : null,
          newestMajor: typeof e.newestMajor === 'string' && /^\d{1,4}$/.test(e.newestMajor) ? e.newestMajor : null,
        }
      : null;
  let packages: PackageCheck[] | null = null;
  if (Array.isArray(o.packages)) {
    packages = [];
    for (const p of o.packages.slice(0, MAX_SUMMARY_PACKAGES)) {
      const r = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
      if (!isPackageName(r.name) || !isShippedVersion(r.version)) continue;
      const vulns = typeof r.vulns === 'number' && Number.isInteger(r.vulns) && r.vulns > 0 ? Math.min(r.vulns, 999) : 0;
      packages.push({ name: r.name, version: r.version, vulns });
    }
  }
  const ms = typeof o.ms === 'number' && Number.isFinite(o.ms) && o.ms > 0 ? Math.min(Math.round(o.ms), 3_600_000) : 0;
  return { at, ms, electron, electronError: str(o.electronError, 200) || null, packages, packagesError: str(o.packagesError, 200) || null };
}

/** update-check.json is only a file: take nothing from it that the UI would not accept from a check. */
export function parseStatus(raw: unknown): UpdateStatus {
  if (!raw || typeof raw !== 'object') return { ...NO_STATUS };
  const o = raw as Record<string, unknown>;
  const findings: Finding[] = [];
  for (const f of Array.isArray(o.findings) ? o.findings.slice(0, MAX_FINDINGS) : []) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const kind = KINDS.find((k) => k === r.kind);
    const level = (['high', 'warn', 'info'] as const).find((l) => l === r.level);
    const url = str(r.url, 300);
    if (!kind || !level || !isPackageName(r.pkg) || !str(r.id, 200) || !/^https:\/\/(osv\.dev|endoflife\.date|releases\.electronjs\.org)\//.test(`${url}/`)) continue;
    const severity = ([...SEVERITIES, 'UNKNOWN'] as Severity[]).find((s) => s === r.severity);
    findings.push({ id: str(r.id, 200), kind, level, pkg: r.pkg, version: str(r.version, 40), fixed: str(r.fixed, 40) || null, ...(severity ? { severity } : {}), summary: str(r.summary, 200), url });
  }
  return { lastChecked: time(o.lastChecked), lastError: str(o.lastError, 200) || null, lastAttempt: time(o.lastAttempt), checking: false, findings, summary: parseSummary(o.summary) };
}

/** What the shield counts: red and orange rows (a newer major alone stays quiet). */
export const alerting = (findings: Finding[]) => findings.filter((f) => f.level !== 'info');
