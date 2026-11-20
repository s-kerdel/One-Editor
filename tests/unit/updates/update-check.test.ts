import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  CHECK_INTERVAL_MS,
  MAX_DETAILS,
  UPDATE_CHECK_CHANNELS as CH,
  UPDATE_ENDPOINTS,
  UPDATE_HOSTS,
  alerting,
  compareVersions,
  cvss3Score,
  daysUntil,
  electronFindings,
  fixedVersion,
  isAllowedUpdateUrl,
  isCheckDue,
  isVulnId,
  osvHits,
  osvQueries,
  parseStatus,
  severityOf,
  sortFindings,
  stillShipped,
  vulnFinding,
  type Finding,
  type ShippedDeps,
  type UpdateStatus,
} from '../../../src/shared/update-check';
import { UpdateCheckService, parseShipped, registerUpdateCheckIpc, type FetchInit, type UpdateCheckDeps } from '../../../src/main/update-check';
import { updateCheckBridge } from '../../../src/main/update-check-bridge';
// @ts-expect-error plain .mjs build script
import { shippedDeps } from '../../../scripts/shipped-deps.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00Z');

/** endoflife.date `products/electron` (shape as verified against the live API). */
const eol = (o: { latest45?: string; eolFrom?: string; isEol?: boolean; majors?: string[] } = {}) => ({
  schema_version: '1.2.0',
  result: {
    name: 'electron',
    releases: (o.majors ?? ['46', '45', '44']).map((name) => ({
      name,
      isEol: name === '45' ? (o.isEol ?? false) : false,
      eolFrom: name === '45' ? (o.eolFrom ?? '2027-04-27') : '2027-06-30',
      latest: { name: name === '45' ? (o.latest45 ?? '45.4.1') : `${name}.0.2`, date: '2026-11-10', link: `https://github.com/electron/electron/releases/tag/v${name === '45' ? (o.latest45 ?? '45.4.1') : `${name}.0.2`}` },
    })),
  },
});

const GHSA = {
  id: 'GHSA-aaaa-bbbb-cccc',
  summary: 'DOMPurify allows  mutation XSS\nin some cases',
  aliases: ['CVE-2026-1111'],
  database_specific: { severity: 'HIGH' },
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N' }],
  affected: [
    { package: { name: 'dompurify', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '2.5.9' }] }] },
    { package: { name: 'dompurify', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '3.0.0' }, { fixed: '3.4.19' }] }] },
    { package: { name: 'other', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '9.9.9' }] }] },
  ],
};

const DEPS: ShippedDeps = { electron: '45.4.1', packages: [{ name: 'dompurify', version: '3.4.18' }, { name: 'markdown-it', version: '15.0.3' }, { name: '@codemirror/view', version: '6.43.15' }] };

describe('host allowlist', () => {
  it('is exactly the two hosts, https, default port', () => {
    expect([...UPDATE_HOSTS].sort()).toEqual(['api.osv.dev', 'endoflife.date']);
    expect(Object.values(UPDATE_ENDPOINTS).every((u) => isAllowedUpdateUrl(`${u}/x`))).toBe(true);
    expect(isAllowedUpdateUrl('https://endoflife.date/api/v1/products/electron/')).toBe(true);
    expect(isAllowedUpdateUrl('https://api.osv.dev/v1/querybatch')).toBe(true);
    for (const bad of [
      'http://api.osv.dev/v1/querybatch',
      'https://osv.dev/v1/querybatch',
      'https://api.osv.dev.evil.example/v1/querybatch',
      'https://evil.example/?x=api.osv.dev',
      'https://api.osv.dev:8443/v1/querybatch',
      'https://user:pw@api.osv.dev/v1/querybatch',
      'https://api.osv.dev@evil.example/',
      'https://ENDOFLIFE.date.evil/',
      'file:///etc/passwd',
      'not a url',
      '',
    ])
      expect(isAllowedUpdateUrl(bad), bad).toBe(false);
  });
});

describe('versions', () => {
  it('compares numerically, prerelease below its release', () => {
    expect(compareVersions('45.4.2', '45.4.1')).toBeGreaterThan(0);
    expect(compareVersions('45.10.0', '45.9.9')).toBeGreaterThan(0);
    expect(compareVersions('45.4.1', '45.4.1')).toBe(0);
    expect(compareVersions('v45.4.1', '45.4.1')).toBe(0);
    expect(compareVersions('44.9.9', '45.0.0')).toBeLessThan(0);
    expect(compareVersions('46.0.0-beta.2', '46.0.0')).toBeLessThan(0);
    expect(compareVersions('46.0.0-beta.10', '46.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('garbage', '1.0.0')).toBeLessThan(0);
  });
});

describe('schedule', () => {
  it('never when switched off', () => {
    expect(isCheckDue(false, null, NOW)).toBe(false);
    expect(isCheckDue(false, NOW - 30 * DAY, NOW)).toBe(false);
  });
  it('due when never checked or a week old; not before', () => {
    expect(isCheckDue(true, null, NOW)).toBe(true);
    expect(isCheckDue(true, NOW - CHECK_INTERVAL_MS, NOW)).toBe(true);
    expect(isCheckDue(true, NOW - CHECK_INTERVAL_MS + 1, NOW)).toBe(false);
    expect(isCheckDue(true, NOW - DAY, NOW)).toBe(false);
    expect(isCheckDue(true, NOW + DAY, NOW)).toBe(true); // clock was set back
  });
});

describe('Electron: patch, end of support, newer major', () => {
  const ids = (f: Finding[]) => f.map((x) => `${x.id}:${x.level}`);
  it('newest patch, far from end of support: only the newer major (info)', () => {
    const f = electronFindings(eol(), '45.4.1', NOW);
    expect(ids(f)).toEqual(['electron-major:info']);
    expect(f[0].summary).toContain('Electron 46');
    expect(alerting(f)).toEqual([]);
  });
  it('a newer patch of the same major is a warning with both versions', () => {
    const [p] = electronFindings(eol({ latest45: '45.4.3' }), '45.4.1', NOW);
    expect(p).toMatchObject({ id: 'electron-patch', level: 'warn', pkg: 'electron', version: '45.4.1', fixed: '45.4.3', url: 'https://releases.electronjs.org/release/v45.4.3' });
    expect(electronFindings(eol({ latest45: '45.4.0' }), '45.4.1', NOW).some((x) => x.id === 'electron-patch')).toBe(false);
  });
  it('the link is built from the version, never taken from the reply', () => {
    const body = eol({ latest45: '45.4.3' });
    body.result.releases[1].latest.link = 'https://evil.example/x';
    expect(electronFindings(body, '45.4.1', NOW)[0].url).toBe('https://releases.electronjs.org/release/v45.4.3');
  });
  it('end of support: quiet at 46 days, warns at 45, on the day and after', () => {
    const at = (days: number) => new Date(NOW + days * DAY).toISOString().slice(0, 10);
    const eolRow = (eolFrom: string, isEol = false) => electronFindings(eol({ eolFrom, isEol }), '45.4.1', NOW).find((x) => x.id === 'electron-eol');
    expect(daysUntil(at(46), NOW)).toBe(46);
    expect(eolRow(at(47))).toBeUndefined();
    expect(eolRow(at(46))).toBeUndefined();
    expect(eolRow(at(45))).toMatchObject({ level: 'warn' });
    expect(eolRow(at(45))!.summary).toContain('45 days');
    expect(eolRow(at(1))!.summary).toContain('1 day)');
    expect(eolRow(at(0))!.summary).toContain('out of support');
    expect(eolRow(at(-30))!.summary).toContain('out of support since');
    expect(eolRow(at(200), true)!.summary).toContain('out of support');
  });
  it('unknown major or no newer one: nothing; a wrong shape is an error', () => {
    expect(electronFindings(eol({ majors: ['45', '44'] }), '45.4.1', NOW)).toEqual([]);
    expect(electronFindings(eol({ majors: ['44'] }), '45.4.1', NOW)).toEqual([]);
    expect(() => electronFindings({ result: {} }, '45.4.1', NOW)).toThrow(/Unexpected reply/);
    expect(() => electronFindings(null, '45.4.1', NOW)).toThrow();
  });
});

describe('OSV: queries, hits, severity, fixed version', () => {
  it('sends names and versions only, Electron first, no duplicates', () => {
    const q = osvQueries({ electron: '45.4.1', packages: [...DEPS.packages, DEPS.packages[0], { name: 'electron', version: '1.0.0' }, { name: '../x', version: '1.0.0' }, { name: 'ok', version: 'nope' }] });
    expect(q).toEqual([
      { package: { name: 'electron', ecosystem: 'npm' }, version: '45.4.1' },
      { package: { name: 'dompurify', ecosystem: 'npm' }, version: '3.4.18' },
      { package: { name: 'markdown-it', ecosystem: 'npm' }, version: '15.0.3' },
      { package: { name: '@codemirror/view', ecosystem: 'npm' }, version: '6.43.15' },
    ]);
    // The whole request body: nothing but these keys.
    expect(Object.keys(JSON.parse(JSON.stringify({ queries: q })))).toEqual(['queries']);
  });
  it('maps results to packages by position', () => {
    const q = osvQueries(DEPS);
    const hits = osvHits(q, { results: [{}, { vulns: [{ id: 'GHSA-aaaa-bbbb-cccc', modified: 'x' }, { id: 'GHSA-aaaa-bbbb-cccc' }, { id: '../../etc' }] }, { vulns: [] }, { vulns: [{ id: 'CVE-2026-2222' }] }] });
    expect(hits).toEqual([
      { id: 'GHSA-aaaa-bbbb-cccc', pkg: 'dompurify', version: '3.4.18' },
      { id: 'CVE-2026-2222', pkg: '@codemirror/view', version: '6.43.15' },
    ]);
    expect(() => osvHits(q, { results: [{}] })).toThrow(/Unexpected reply/);
    expect(() => osvHits(q, {})).toThrow(/Unexpected reply/);
  });
  it('accepts advisory ids only', () => {
    for (const ok of ['GHSA-aaaa-bbbb-cccc', 'CVE-2026-1234', 'MAL-2026-1', 'PYSEC-2021-12']) expect(isVulnId(ok), ok).toBe(true);
    for (const bad of ['', 'x', '../x', 'GHSA/../x', 'GHSA-aaaa?x=1', 'a'.repeat(80), 5, null]) expect(isVulnId(bad), String(bad)).toBe(false);
  });
  it('CVSS v3 base scores match the specification examples', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3Score('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(cvss3Score('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H')).toBe(7.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N')).toBe(3.7);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    expect(cvss3Score('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvss3Score('CVSS:3.1/AV:X')).toBeNull();
  });
  it('severity: GitHub rating first, then CVSS, then unknown; malware is critical', () => {
    expect(severityOf(GHSA)).toBe('HIGH');
    expect(severityOf({ database_specific: { severity: 'moderate' } })).toBe('MODERATE');
    expect(severityOf({ database_specific: { severity: 'MEDIUM' } })).toBe('MODERATE');
    expect(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })).toBe('CRITICAL');
    expect(severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N' }] })).toBe('LOW');
    expect(severityOf({ severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/AV:N' }] })).toBe('UNKNOWN');
    expect(severityOf({ id: 'MAL-2026-7' })).toBe('CRITICAL');
    expect(severityOf(null)).toBe('UNKNOWN');
  });
  it('fixed version: the lowest fix above the shipped version, for this package', () => {
    expect(fixedVersion(GHSA, 'dompurify', '3.4.18')).toBe('3.4.19');
    expect(fixedVersion(GHSA, 'dompurify', '2.0.0')).toBe('2.5.9');
    expect(fixedVersion(GHSA, 'dompurify', '4.0.0')).toBeNull();
    expect(fixedVersion(GHSA, 'markdown-it', '1.0.0')).toBeNull();
    expect(fixedVersion({}, 'dompurify', '1.0.0')).toBeNull();
  });
  it('a row: level from severity, one-line summary, osv.dev link', () => {
    const hit = { id: 'GHSA-aaaa-bbbb-cccc', pkg: 'dompurify', version: '3.4.18' };
    expect(vulnFinding(hit, GHSA)).toEqual({
      id: 'vuln:GHSA-aaaa-bbbb-cccc:dompurify@3.4.18',
      kind: 'vuln',
      level: 'high',
      pkg: 'dompurify',
      version: '3.4.18',
      fixed: '3.4.19',
      severity: 'HIGH',
      summary: 'DOMPurify allows mutation XSS in some cases',
      url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
    });
    expect(vulnFinding(hit, { ...GHSA, database_specific: { severity: 'LOW' } }).level).toBe('warn');
    // Details not fetched (cap / failure): still a row, orange, with the link.
    expect(vulnFinding(hit, null)).toMatchObject({ level: 'warn', severity: 'UNKNOWN', fixed: null, url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc' });
    expect(vulnFinding(hit, { summary: 'x'.repeat(500) }).summary.length).toBe(200);
  });
  it('sorts red, orange, info', () => {
    const f = (id: string, level: Finding['level'], severity?: Finding['severity']): Finding => ({ id, kind: 'vuln', level, pkg: 'p', version: '1.0.0', fixed: null, severity, summary: '', url: 'https://osv.dev/vulnerability/x' });
    expect(sortFindings([f('i', 'info'), f('m', 'warn', 'MODERATE'), f('h', 'high', 'HIGH'), f('c', 'high', 'CRITICAL')]).map((x) => x.id)).toEqual(['c', 'h', 'm', 'i']);
  });
});

describe('cache', () => {
  const finding = vulnFinding({ id: 'GHSA-aaaa-bbbb-cccc', pkg: 'dompurify', version: '3.4.18' }, GHSA);
  it('findings go away when the build ships another version', () => {
    const el = electronFindings(eol({ latest45: '45.4.3' }), '45.4.1', NOW);
    expect(stillShipped([finding, ...el], DEPS)).toHaveLength(1 + el.length);
    expect(stillShipped([finding, ...el], { electron: '45.4.3', packages: [{ name: 'dompurify', version: '3.4.19' }] })).toEqual([]);
    expect(stillShipped([finding, ...el], { electron: '45.4.1', packages: [] })).toEqual(el);
  });
  it('a damaged or doctored file gives a clean status', () => {
    expect(parseStatus(null)).toEqual({ lastChecked: null, lastError: null, lastAttempt: null, checking: false, findings: [] });
    expect(parseStatus('x').findings).toEqual([]);
    const s = parseStatus({
      lastChecked: NOW,
      lastAttempt: 'x',
      lastError: 5,
      checking: true,
      findings: [finding, { ...finding, url: 'javascript:alert(1)' }, { ...finding, url: 'https://evil.example/' }, { ...finding, level: 'boom' }, { ...finding, pkg: '<img>' }, null, 7],
    });
    expect(s).toEqual({ lastChecked: NOW, lastError: null, lastAttempt: null, checking: false, findings: [finding] });
  });
});

describe('shipped dependency list (build time)', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0' },
      'node_modules/electron': { version: '45.4.1', dev: true },
      'node_modules/vitest': { version: '5.1.1', dev: true },
      'node_modules/preact': { version: '11.2.0' },
      'node_modules/@codemirror/view': { version: '6.43.15' },
      'node_modules/mermaid': { version: '12.3.0' },
      'node_modules/mermaid/node_modules/katex': { version: '0.18.10' },
      'node_modules/katex': { version: '0.19.1' },
      'node_modules/node-pty': { version: '1.1.0' },
      'node_modules/@napi-rs/canvas': { version: '1.1.1', optional: true },
      'node_modules/@types/trusted-types': { version: '2.0.7', devOptional: true },
      'node_modules/linked': { resolved: '../linked', link: true },
      'node_modules/a/node_modules/preact': { version: '11.2.0' },
    },
  };
  it('production + transitive, exact versions, no dev-only packages, sorted and unique', () => {
    expect(shippedDeps(lock)).toEqual({
      electron: '45.4.1',
      packages: [
        { name: '@codemirror/view', version: '6.43.15' },
        { name: '@napi-rs/canvas', version: '1.1.1' },
        { name: '@types/trusted-types', version: '2.0.7' },
        { name: 'katex', version: '0.18.10' },
        { name: 'katex', version: '0.19.1' },
        { name: 'mermaid', version: '12.3.0' },
        { name: 'node-pty', version: '1.1.0' },
        { name: 'preact', version: '11.2.0' },
      ],
    });
    expect(() => shippedDeps({})).toThrow(/packages/);
    expect(() => shippedDeps({ packages: { 'node_modules/preact': { version: '1.0.0' } } })).toThrow(/electron/);
  });
  it('the real lockfile: every direct dependency is in it, Electron matches, nothing but names + versions', () => {
    const root = path.resolve(__dirname, '../../..');
    const real = shippedDeps(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const names = new Set(real.packages.map((p: { name: string }) => p.name));
    for (const d of Object.keys(pkg.dependencies)) expect(names.has(d), d).toBe(true);
    for (const d of ['vitest', 'vite', 'esbuild', '@playwright/test', 'typescript', 'electron']) expect(names.has(d), d).toBe(false);
    expect(real.electron).toMatch(/^\d+\.\d+\.\d+$/);
    for (const p of real.packages) expect(Object.keys(p)).toEqual(['name', 'version']);
    // Every entry survives the app's own validation (nothing is silently dropped from a check).
    expect(parseShipped(real, real.electron).packages).toEqual(real.packages);
    expect(osvQueries(parseShipped(real, real.electron))).toHaveLength(real.packages.length + 1);
  });
  it('the app drops odd entries instead of sending them', () => {
    expect(parseShipped({ packages: [{ name: 'ok', version: '1.2.3' }, { name: 'C:\\Users\\me', version: '1.0.0' }, { name: 'x', version: '1.0.0 /home/me' }, null, 'x'] }, '45.4.1')).toEqual({ electron: '45.4.1', packages: [{ name: 'ok', version: '1.2.3' }] });
    expect(parseShipped(null, '45.4.1')).toEqual({ electron: '45.4.1', packages: [] });
  });
});

// ---- the service (main) with an injected fetch: never the network ----------------------------------

interface Call {
  url: string;
  init: FetchInit;
}

function setup(o: { enabled?: boolean; state?: unknown; eolBody?: unknown; batch?: (queries: { package: { name: string }; version: string }[]) => unknown; vuln?: (id: string) => unknown; fail?: (url: string) => boolean; shipped?: unknown } = {}) {
  const calls: Call[] = [];
  const events: UpdateStatus[] = [];
  const written: unknown[] = [];
  const flags = { enabled: o.enabled ?? true, now: NOW, state: o.state ?? null as unknown, offline: false };
  const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
  const deps: UpdateCheckDeps = {
    isEnabled: () => flags.enabled,
    electronVersion: '45.4.1',
    shipped: () => ('shipped' in o ? o.shipped : { electron: '45.3.4', packages: DEPS.packages }),
    endpoints: UPDATE_ENDPOINTS,
    allow: (u) => isAllowedUpdateUrl(u),
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (flags.offline || o.fail?.(url)) throw new TypeError('net::ERR_INTERNET_DISCONNECTED');
      if (url === 'https://endoflife.date/api/v1/products/electron/') return json(o.eolBody ?? eol());
      if (url === 'https://api.osv.dev/v1/querybatch') {
        const queries = JSON.parse(init.body!).queries;
        return json(o.batch ? o.batch(queries) : { results: queries.map(() => ({})) });
      }
      if (url.startsWith('https://api.osv.dev/v1/vulns/')) return json(o.vuln ? o.vuln(decodeURIComponent(url.slice('https://api.osv.dev/v1/vulns/'.length))) : GHSA);
      return json({}, 404);
    },
    readState: async () => flags.state,
    writeState: async (s) => {
      written.push(s);
      flags.state = s;
    },
    onChange: (s) => events.push(s),
    now: () => flags.now,
  };
  return { svc: new UpdateCheckService(deps), calls, events, written, flags, deps };
}

const dompurifyHit = (queries: { package: { name: string } }[]) => ({ results: queries.map((q) => (q.package.name === 'dompurify' ? { vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] } : {})) });

describe('UpdateCheckService', () => {
  it('switched off: refuses, and nothing is fetched — not even on "Check now"', async () => {
    const t = setup({ enabled: false });
    await expect(t.svc.check(true)).rejects.toMatchObject({ code: 'EDISABLED' });
    await expect(t.svc.check(false)).rejects.toMatchObject({ code: 'EDISABLED' });
    expect(await t.svc.status()).toMatchObject({ lastChecked: null, findings: [] });
    expect(t.calls).toEqual([]);
    expect(t.written).toEqual([]);
  });

  it('a check: one GET, one POST with names + versions only, one GET per advisory; the result is cached', async () => {
    const t = setup({ eolBody: eol({ latest45: '45.4.3' }), batch: dompurifyHit });
    const s = await t.svc.check(false);
    expect(t.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'GET https://endoflife.date/api/v1/products/electron/',
      'POST https://api.osv.dev/v1/querybatch',
      'GET https://api.osv.dev/v1/vulns/GHSA-aaaa-bbbb-cccc',
    ]);
    // Everything that leaves: no query strings, no extra headers, and this exact body (the running Electron, not the list's).
    for (const c of t.calls) {
      expect(new URL(c.url).search).toBe('');
      expect(Object.keys(c.init.headers).sort()).toEqual(c.init.method === 'POST' ? ['accept', 'content-type'] : ['accept']);
    }
    expect(JSON.parse(t.calls[1].init.body!)).toEqual({ queries: osvQueries(DEPS) });
    expect(t.calls[0].init.body).toBeUndefined();
    expect(s.findings.map((f) => `${f.level} ${f.pkg} ${f.version} → ${f.fixed}`)).toEqual(['high dompurify 3.4.18 → 3.4.19', 'warn electron 45.4.1 → 45.4.3', 'info electron 45.4.1 → null']);
    expect(s).toMatchObject({ lastChecked: NOW, lastAttempt: NOW, lastError: null, checking: false });
    expect(t.written).toHaveLength(1);
    expect(t.written[0]).toMatchObject({ v: 1, lastChecked: NOW, lastError: null });
    expect(t.written[0]).not.toHaveProperty('checking');
    // main → renderer: "checking", then the result.
    expect(t.events.map((e) => e.checking)).toEqual([true, false]);

    // A new process reads the cache: same findings, no request.
    const again = setup({ state: t.flags.state });
    expect((await again.svc.status()).findings).toEqual(s.findings);
    expect(again.calls).toEqual([]);
  });

  it('automatic checks are a week apart; "Check now" always goes', async () => {
    const t = setup();
    await t.svc.check(false);
    expect(t.calls).toHaveLength(2);
    t.flags.now = NOW + 6 * DAY;
    await t.svc.check(false);
    expect(t.calls).toHaveLength(2);
    await t.svc.check(true);
    expect(t.calls).toHaveLength(4);
    t.flags.now += 7 * DAY;
    await t.svc.check(false);
    expect(t.calls).toHaveLength(6);
  });

  it('two checks at once share one run', async () => {
    const t = setup();
    const [a, b] = await Promise.all([t.svc.check(true), t.svc.check(true)]);
    expect(a.lastChecked).toBe(b.lastChecked);
    expect(t.calls).toHaveLength(2);
  });

  it('offline: quiet failure, the previous findings and date stay, the next launch tries again', async () => {
    const t = setup({ batch: dompurifyHit });
    await t.svc.check(true);
    t.flags.offline = true;
    t.flags.now = NOW + 8 * DAY;
    const s = await t.svc.check(false);
    expect(s.lastChecked).toBe(NOW);
    expect(s.lastAttempt).toBe(NOW + 8 * DAY);
    expect(s.lastError).toBe('Could not reach the update services (offline?)');
    expect(s.findings.map((f) => f.pkg)).toEqual(['dompurify', 'electron']);
    expect(isCheckDue(true, s.lastChecked, t.flags.now)).toBe(true);
  });

  it('one service down: the other half still updates, the check counts as failed', async () => {
    const t = setup({ eolBody: eol({ latest45: '45.4.3' }), fail: (u) => u.includes('osv.dev') });
    const s = await t.svc.check(true);
    expect(s.findings.map((f) => f.id)).toEqual(['electron-patch', 'electron-major']);
    expect(s.lastChecked).toBeNull();
    expect(s.lastError).toBeTruthy();
  });

  it('an error answer or a wrong body is a failed check, never a crash', async () => {
    const t = setup({ eolBody: { nope: true }, batch: () => ({ results: 'x' }) });
    const s = await t.svc.check(true);
    expect(s.lastError).toMatch(/Unexpected reply/);
    expect(s.findings).toEqual([]);
  });

  it('caps the detail requests; hits beyond the cap and failed details still get a row', async () => {
    const many = Array.from({ length: MAX_DETAILS + 5 }, (_, i) => ({ id: `GHSA-aaaa-bbbb-${String(i).padStart(4, '0')}` }));
    const t = setup({ batch: (q) => ({ results: q.map((x) => (x.package.name === 'dompurify' ? { vulns: many } : {})) }), fail: (u) => u.endsWith('-0003') });
    const s = await t.svc.check(true);
    expect(t.calls.filter((c) => c.url.includes('/v1/vulns/'))).toHaveLength(MAX_DETAILS);
    const rows = s.findings.filter((f) => f.kind === 'vuln');
    expect(rows).toHaveLength(MAX_DETAILS + 5);
    expect(rows.filter((f) => f.severity === 'UNKNOWN')).toHaveLength(6);
    expect(s.lastError).toBeNull();
  });

  it('refuses a URL outside the allowlist before any request', async () => {
    const t = setup();
    (t.deps as { endpoints: unknown }).endpoints = { eol: 'https://evil.example', osv: 'http://api.osv.dev' };
    const s = await t.svc.check(true);
    expect(t.calls).toEqual([]);
    expect(s.lastError).toBe('Host not allowed');
  });

  it('findings of the cache disappear when the build ships fixed versions', async () => {
    const t = setup({ eolBody: eol({ latest45: '45.4.3' }), batch: dompurifyHit });
    await t.svc.check(true);
    const rebuilt = setup({ state: t.flags.state, shipped: { packages: [{ name: 'dompurify', version: '3.4.19' }] } });
    (rebuilt.deps as { electronVersion: string }).electronVersion = '45.4.3';
    expect((await rebuilt.svc.status()).findings).toEqual([]);
    expect(rebuilt.calls).toEqual([]);
  });

  it('a build without the list still checks Electron', async () => {
    const t = setup({ shipped: null });
    await t.svc.check(true);
    expect(JSON.parse(t.calls[1].init.body!)).toEqual({ queries: [{ package: { name: 'electron', ecosystem: 'npm' }, version: '45.4.1' }] });
  });
});

describe('IPC + preload bridge', () => {
  function wire(trusted: boolean, enabled = true) {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const t = setup({ enabled });
    registerUpdateCheckIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, t.svc, { isTrusted: () => trusted });
    const listeners: ((e: unknown, p: unknown) => void)[] = [];
    const sent: unknown[][] = [];
    const bridge = updateCheckBridge({
      invoke: async (ch, ...args) => (sent.push([ch, ...args]), handlers.get(ch)!({}, ...args)),
      on: (_ch, fn) => listeners.push(fn),
      removeListener: (_ch, fn) => listeners.splice(listeners.indexOf(fn), 1),
    });
    return { ...t, handlers, bridge, sent, listeners };
  }

  it('registers exactly two handlers; an untrusted sender gets nothing and causes no request', async () => {
    const w = wire(false);
    expect([...w.handlers.keys()].sort()).toEqual([CH.check, CH.status].sort());
    expect(await w.bridge.status()).toEqual({ ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } });
    expect(await w.bridge.check(true)).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    expect(w.calls).toEqual([]);
  });

  it('the bridge passes one boolean; anything else is not "force"', async () => {
    const w = wire(true);
    expect(await w.bridge.status()).toMatchObject({ ok: true, result: { lastChecked: null } });
    await w.bridge.check('yes' as unknown as boolean);
    await w.bridge.check({ force: true } as unknown as boolean);
    expect(w.sent.slice(1)).toEqual([[CH.check, false], [CH.check, false]]);
    expect(w.calls).toHaveLength(2); // the first was due (never checked), the second was not
    expect(await w.bridge.check(true)).toMatchObject({ ok: true, result: { lastChecked: NOW } });
    expect(w.calls).toHaveLength(4);
    // main validates too: a non-boolean straight on the channel is not a forced check.
    await w.handlers.get(CH.check)!({}, 'true');
    expect(w.calls).toHaveLength(4);
  });

  it('switched off: an error reply, no request', async () => {
    const w = wire(true, false);
    expect(await w.bridge.check(true)).toEqual({ ok: false, error: { code: 'EDISABLED', message: 'Security update checks are switched off' } });
    expect(w.calls).toEqual([]);
  });

  it('onChange subscribes and unsubscribes', () => {
    const w = wire(true);
    const got: unknown[] = [];
    const off = w.bridge.onChange((s) => got.push(s));
    w.listeners[0]({}, { lastChecked: 1 });
    off();
    expect(got).toEqual([{ lastChecked: 1 }]);
    expect(w.listeners).toHaveLength(0);
  });
});
