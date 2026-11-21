// "Security updates" (main process): the opt-in check for a newer Electron patch, end of support and
// known vulnerabilities in what this build ships.
//  - "Check now" (manual: one boolean from our own page) always goes: the user clicked. The automatic
//    check (once after launch, the 7-day rule) needs the setting on, read here, never the page's word.
//  - Two hosts only (shared/update-check.ts UPDATE_HOSTS); every URL is checked before it is fetched.
//  - Sent: GET endoflife.date (nothing about this app) and POST api.osv.dev with package names + versions
//    from dist/main/shipped-deps.json. No ids, no paths, no cookies; main.ts gives it a session of its own.
//  - No timer: the renderer asks once after launch (and on "Check now"); failures are quiet.
//  - The result (findings + a summary of what was checked) is cached in <app data>/update-check.json,
//    so the shield and the Settings panel show at launch without a request.
// No electron import: main.ts injects fetch / files (unit-testable).
import {
  EOL_PATH,
  MAX_DETAILS,
  MAX_FINDINGS,
  OSV_BATCH_PATH,
  OSV_VULN_PATH,
  UPDATE_CHECK_CHANNELS as CH,
  electronFindingsOf,
  electronSummary,
  isCheckDue,
  isPackageName,
  isShippedVersion,
  osvHits,
  osvQueries,
  packageChecks,
  parseStatus,
  sameBuild,
  sortFindings,
  stillShipped,
  vulnFinding,
  type CheckSummary,
  type Finding,
  type ShippedDeps,
  type UpdateReply,
  type UpdateStatus,
} from '../shared/update-check';

export interface FetchInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}
export interface ResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface UpdateCheckDeps {
  /** The setting `updates.check` (automatic checks) as main reads it (never the page's word). */
  isEnabled(): Promise<boolean> | boolean;
  electronVersion: string;
  /** dist/main/shipped-deps.json, parsed; null when the build has none (then only Electron is checked). */
  shipped(): Promise<unknown> | unknown;
  endpoints: { eol: string; osv: string };
  /** The host allowlist (production: isAllowedUpdateUrl). */
  allow(url: string): boolean;
  fetch(url: string, init: FetchInit): Promise<ResponseLike>;
  readState(): Promise<unknown>;
  writeState(s: unknown): Promise<void>;
  onChange(s: UpdateStatus): void;
  now?(): number;
  timeoutMs?: number;
}

export class UpdateCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 4 * 1024 * 1024;
const DETAIL_PARALLEL = 4;

/** Validates the build's dependency list; anything odd in it is left out rather than sent. */
export function parseShipped(raw: unknown, electron: string): ShippedDeps {
  const list = (raw as { packages?: unknown } | null)?.packages;
  const packages: ShippedDeps['packages'] = [];
  for (const p of Array.isArray(list) ? list : []) {
    const { name, version } = (p ?? {}) as { name?: unknown; version?: unknown };
    if (isPackageName(name) && isShippedVersion(version)) packages.push({ name, version });
  }
  // The Electron that runs, not the one the list was written for.
  return { electron, packages };
}

/** Short, for Settings: never a URL with parameters, never a stack. */
function reason(err: unknown): string {
  const e = err as { name?: string; message?: string } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'No answer in time';
  if (err instanceof UpdateCheckError) return err.message;
  return /^Unexpected reply/.test(e?.message ?? '') ? e!.message! : 'Could not reach the update services (offline?)';
}

export class UpdateCheckService {
  private s: UpdateStatus | null = null;
  private deps_: ShippedDeps | null = null;
  private running: Promise<UpdateStatus> | null = null;

  constructor(private readonly deps: UpdateCheckDeps) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async shipped(): Promise<ShippedDeps> {
    if (!this.deps_) {
      let raw: unknown = null;
      try {
        raw = await this.deps.shipped();
      } catch {}
      this.deps_ = parseShipped(raw, this.deps.electronVersion);
    }
    return this.deps_;
  }

  /** The cached result, minus findings about versions this build no longer ships. No request. */
  async status(): Promise<UpdateStatus> {
    if (!this.s) {
      let raw: unknown = null;
      try {
        raw = await this.deps.readState();
      } catch {}
      const s = parseStatus(raw);
      const deps = await this.shipped();
      this.s ??= { ...s, findings: stillShipped(s.findings, deps), summary: s.summary && sameBuild(s.summary, deps) ? s.summary : null };
    }
    return { ...this.s, checking: !!this.running, findings: this.s.findings.map((f) => ({ ...f })), summary: this.s.summary && structuredClone(this.s.summary) };
  }

  /**
   * `manual` = "Check now": always goes, whatever the setting (the user clicked; it sends what an automatic
   * check sends). Otherwise automatic: refused while the setting is off, and only when a week has passed.
   * One at a time.
   */
  async check(manual: unknown): Promise<UpdateStatus> {
    const isManual = manual === true;
    if (!isManual && !(await this.deps.isEnabled())) throw new UpdateCheckError('EDISABLED', 'Automatic security update checks are switched off');
    const cur = await this.status();
    if (this.running) return this.running;
    if (!isManual && !isCheckDue(true, cur.lastChecked, this.now())) return cur;
    this.running = this.run().finally(() => (this.running = null));
    this.deps.onChange(await this.status());
    const done = await this.running;
    this.deps.onChange(done);
    return done;
  }

  private async run(): Promise<UpdateStatus> {
    const prev = this.s!;
    const deps = await this.shipped();
    const now = this.now();
    // The two halves are independent: when one fails, its previous rows stay and the other still updates.
    const [electron, libs] = await Promise.allSettled([this.checkElectron(deps.electron, now), this.checkLibraries(deps)]);
    const failed = [electron, libs].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    const keep = (vuln: boolean) => prev.findings.filter((f) => (f.kind === 'vuln') === vuln);
    const findings = sortFindings([...(electron.status === 'fulfilled' ? electron.value.findings : keep(false)), ...(libs.status === 'fulfilled' ? libs.value.findings : keep(true))]).slice(0, MAX_FINDINGS);
    // What this attempt looked at, for Settings. Local only: never sent anywhere.
    const summary: CheckSummary = {
      at: now,
      ms: Math.max(0, this.now() - now),
      electron: electron.status === 'fulfilled' ? electron.value.summary : null,
      electronError: electron.status === 'rejected' ? reason(electron.reason) : null,
      packages: libs.status === 'fulfilled' ? libs.value.packages : null,
      packagesError: libs.status === 'rejected' ? reason(libs.reason) : null,
    };
    this.s = { lastChecked: failed ? prev.lastChecked : now, lastAttempt: now, lastError: failed ? reason(failed.reason) : null, checking: false, findings, summary };
    try {
      const { checking: _c, ...file } = this.s;
      await this.deps.writeState({ v: 1, ...file });
    } catch {}
    return { ...this.s, findings: findings.map((f) => ({ ...f })), summary: structuredClone(summary) };
  }

  private async json(url: string, body?: unknown): Promise<unknown> {
    if (!this.deps.allow(url)) throw new UpdateCheckError('EACCES', 'Host not allowed');
    const res = await this.deps.fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
    });
    if (!res.ok) throw new UpdateCheckError('EIO', `The update service answered ${Number(res.status) || 0}`);
    if (Number(res.headers?.get('content-length') ?? 0) > MAX_BODY) throw new Error('Unexpected reply (too large)');
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('Unexpected reply (too large)');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Unexpected reply (not JSON)');
    }
  }

  private async checkElectron(running: string, now: number) {
    const summary = electronSummary(await this.json(this.deps.endpoints.eol + EOL_PATH), running, now);
    return { summary, findings: electronFindingsOf(summary, now) };
  }

  private async checkLibraries(deps: ShippedDeps): Promise<{ packages: CheckSummary['packages']; findings: Finding[] }> {
    const queries = osvQueries(deps);
    const hits = osvHits(queries, await this.json(this.deps.endpoints.osv + OSV_BATCH_PATH, { queries }));
    // One detail request per advisory (it may hit several packages), capped; a failed one still gives a row.
    const ids = [...new Set(hits.map((h) => h.id))].slice(0, MAX_DETAILS);
    const details = new Map<string, unknown>();
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          details.set(id, await this.json(this.deps.endpoints.osv + OSV_VULN_PATH + encodeURIComponent(id)));
        } catch {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(DETAIL_PARALLEL, ids.length) }, worker));
    return { packages: packageChecks(queries, hits), findings: hits.map((h) => vulnFinding(h, details.get(h.id) ?? null)) };
  }
}

interface IpcLike {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void;
}

/** updates:* handlers: our own UI only; `check` takes one boolean (true = "Check now"). */
export function registerUpdateCheckIpc(ipc: IpcLike, svc: UpdateCheckService, o: { isTrusted: (e: unknown) => boolean }): void {
  const denied: UpdateReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
  const guard = (fn: (...a: unknown[]) => Promise<UpdateStatus>) => async (e: unknown, ...a: unknown[]): Promise<UpdateReply<UpdateStatus>> => {
    if (!o.isTrusted(e)) return denied;
    try {
      return { ok: true, result: await fn(...a) };
    } catch (err) {
      return err instanceof UpdateCheckError ? { ok: false, error: { code: err.code, message: err.message } } : { ok: false, error: { code: 'EIO', message: 'Update check error' } };
    }
  };
  ipc.handle(CH.status, guard(() => svc.status()));
  ipc.handle(CH.check, guard((manual) => svc.check(manual === true)));
}
