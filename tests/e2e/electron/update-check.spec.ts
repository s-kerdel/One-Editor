// "Security updates" in the real desktop app, against a local stub of the two services (never the internet):
// off by default = no automatic request at all; switch on → one check → shield + findings; the cache shows the
// shield at the next launch without a request; offline = quiet; "Check now" works with the switch off too and
// shows what was checked (summary); findings of versions no longer shipped go.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Stub {
  origin: string;
  seen: Seen[];
  /** Packages the batch answers with an advisory. */
  vulns: Record<string, string>;
  /** Newest patch the release list reports for the running major (null = the running version). */
  latest: string | null;
  close(): Promise<void>;
}

const ADVISORIES: Record<string, unknown> = {
  'GHSA-aaaa-bbbb-cccc': {
    id: 'GHSA-aaaa-bbbb-cccc',
    summary: 'Stub: sanitizer bypass',
    database_specific: { severity: 'HIGH' },
    affected: [{ package: { name: 'dompurify', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '999.0.0' }] }] }],
  },
  'GHSA-dddd-eeee-ffff': {
    id: 'GHSA-dddd-eeee-ffff',
    summary: 'Stub: slow regular expression',
    severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' }],
    affected: [{ package: { name: 'markdown-it', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] }],
  },
};

async function startStub(electron: string): Promise<Stub> {
  const major = electron.split('.')[0];
  const stub: Stub = { origin: '', seen: [], vulns: {}, latest: null, close: async () => {} };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      stub.seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (req.method === 'GET' && req.url === '/api/v1/products/electron/') {
        const latest = stub.latest ?? electron;
        return json({
          result: {
            releases: [
              { name: String(Number(major) + 1), isEol: false, eolFrom: '2099-01-01', latest: { name: `${Number(major) + 1}.0.0` } },
              { name: major, isEol: false, eolFrom: '2099-01-01', latest: { name: latest, link: `https://github.com/electron/electron/releases/tag/v${latest}` } },
            ],
          },
        });
      }
      if (req.method === 'POST' && req.url === '/v1/querybatch') {
        const queries: { package: { name: string } }[] = JSON.parse(body).queries;
        return json({ results: queries.map((q) => (stub.vulns[q.package.name] ? { vulns: [{ id: stub.vulns[q.package.name] }] } : {})) });
      }
      const id = req.method === 'GET' && req.url!.startsWith('/v1/vulns/') ? req.url!.slice('/v1/vulns/'.length) : '';
      if (ADVISORIES[id]) return json(ADVISORIES[id]);
      json({}, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise((r) => (server.closeAllConnections(), server.close(() => r())));
  return stub;
}

const ready = (page: Page) => page.waitForFunction(() => !!(window as any).__secEditUpdates, null, { timeout: 15000 });
const status = (page: Page) => page.evaluate(() => (window as any).__secEditUpdates.status());
const electronVersion = (app: ElectronApplication) => app.evaluate(() => process.versions.electron);
const shield = (page: Page) => page.locator('[data-testid="updates-shield"]');

async function openSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.locator('[data-nav="updates"]').click();
  await expect(page.locator('[data-testid="updates-settings"]')).toBeVisible();
}

/** The version is only known from a running app: the first launch of a test reads it, then the stub is built. */
async function versionOf(el: { launch: (args?: string[], o?: { env?: Record<string, string> }) => Promise<{ app: ElectronApplication }> }) {
  const { app } = await el.launch();
  const v = await electronVersion(app);
  await app.close();
  return v;
}

const writeUserData = (dir: string, file: string, data: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
};

test('off by default: no automatic request, no shield; switch on → check → shield and findings; cached for the next launch', async ({ el }) => {
  const version = await versionOf(el);
  const stub = await startStub(version);
  const [maj, min, pat] = version.split('.').map(Number);
  const newer = `${maj}.${min}.${pat + 1}`;
  stub.latest = newer;
  stub.vulns = { dompurify: 'GHSA-aaaa-bbbb-cccc', 'markdown-it': 'GHSA-dddd-eeee-ffff' };
  try {
    const env = { SEC_EDIT_TEST_UPDATE_API: stub.origin };
    const first = await el.launch([el.ws], { env });
    const page = first.page;
    await ready(page);
    await openSettings(page);
    const toggle = page.locator('[data-setting="updates.check"]');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-testid="updates-last-checked"]')).toHaveText('Automatic check off: nothing is sent until you click Check now.');
    await expect(page.locator('[data-testid="updates-check-now"]')).toBeEnabled();
    await expect(page.locator('[data-testid="updates-privacy"]')).toContainText('endoflife.date');
    await expect(page.locator('[data-testid="updates-privacy"]')).toContainText('api.osv.dev');
    // An automatic check, even asked directly: main refuses while it is off.
    const refused = await page.evaluate(() => (window as any).secEditBridge.updates.check(false));
    expect(refused).toMatchObject({ ok: false, error: { code: 'EDISABLED' } });
    await page.waitForTimeout(1500);
    expect(stub.seen).toEqual([]);
    await expect(shield(page)).toHaveCount(0);
    expect(fs.existsSync(path.join(el.userData, 'update-check.json'))).toBe(false);

    // Switch on: one check, right away.
    await toggle.click();
    await expect(page.locator('[data-testid="updates-last-checked"]')).toContainText('3 findings');
    expect(stub.seen.map((s) => `${s.method} ${s.url}`).sort()).toEqual(
      ['GET /api/v1/products/electron/', 'POST /v1/querybatch', 'GET /v1/vulns/GHSA-aaaa-bbbb-cccc', 'GET /v1/vulns/GHSA-dddd-eeee-ffff'].sort(),
    );
    // What left the app: a generic client, no cookie / referrer / origin, and a body of names + versions only.
    for (const s of stub.seen) {
      expect(s.headers['user-agent']).toBe('update-check');
      for (const h of ['cookie', 'referer', 'origin', 'authorization']) expect(s.headers[h], h).toBeUndefined();
    }
    const post = stub.seen.find((s) => s.method === 'POST')!;
    const sent = JSON.parse(post.body);
    expect(Object.keys(sent)).toEqual(['queries']);
    for (const q of sent.queries) {
      expect(Object.keys(q).sort()).toEqual(['package', 'version']);
      expect(Object.keys(q.package).sort()).toEqual(['ecosystem', 'name']);
    }
    const names: string[] = sent.queries.map((q: any) => `${q.package.name}@${q.version}`);
    expect(names[0]).toBe(`electron@${version}`);
    for (const n of ['node-pty', 'dompurify', 'preact', 'pdfjs-dist']) expect(names.some((x) => x.startsWith(`${n}@`)), n).toBe(true);
    expect(names.some((x) => /^(vitest|vite|esbuild|typescript)@/.test(x))).toBe(false);
    expect(post.body).not.toContain(el.ws);
    expect(post.body).not.toContain(el.userData);

    // Shield (red: one HIGH) → the findings.
    await page.keyboard.press('Escape');
    await expect(shield(page)).toHaveText('3');
    await expect(shield(page)).toHaveAttribute('data-level', 'high');
    // The very end of the status bar's corner (after MCP and the web server, when those are on).
    await expect(page.locator('.se-status > .se-status-corner:last-child > [data-testid="updates-shield"]:last-child')).toBeVisible();
    await shield(page).click();
    const dialog = page.locator('[data-testid="updates-findings"]');
    const rows = dialog.locator('[data-testid="updates-row"]');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toHaveAttribute('data-level', 'high');
    await expect(rows.nth(0)).toContainText('dompurify');
    await expect(rows.nth(0)).toContainText('→ 999.0.0');
    await expect(rows.nth(0)).toContainText('Known vulnerability · High');
    await expect(rows.nth(0)).toContainText('Stub: sanitizer bypass');
    await expect(rows.nth(1)).toHaveAttribute('data-level', 'warn');
    await expect(rows.nth(1)).toContainText('markdown-it');
    await expect(rows.nth(1)).toContainText('Moderate');
    await expect(rows.nth(1)).toContainText('no fixed version listed');
    await expect(rows.nth(2)).toHaveAttribute('data-kind', 'electron-patch');
    await expect(rows.nth(2)).toContainText(`${version} → ${newer}`);
    await expect(rows.nth(3)).toHaveAttribute('data-level', 'info');
    await expect(dialog.locator('[data-testid="updates-todo"]')).toContainText('update Electron and release');
    await expect(dialog).toContainText('may not affect One');
    // "Details" opens the advisory in the OS browser (stubbed).
    await first.app.evaluate(({ shell }) => {
      (globalThis as any).__opened = [];
      shell.openExternal = (async (u: string) => void (globalThis as any).__opened.push(u)) as typeof shell.openExternal;
    });
    await rows.nth(0).locator('[data-testid="updates-link"]').click();
    await expect.poll(() => first.app.evaluate(() => (globalThis as any).__opened)).toEqual(['https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc']);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await first.app.close();

    // Next launch: the shield comes from the cache; the check is not due, so nothing is requested.
    const before = stub.seen.length;
    const second = await el.launch([el.ws], { env });
    await ready(second.page);
    await expect(shield(second.page)).toHaveText('3');
    await second.page.waitForTimeout(1500);
    expect(stub.seen.length).toBe(before);

    // Switched off again: nothing is asked, and the last check's problems still show (the user decided:
    // a found problem keeps its shield, automatic check or not).
    await openSettings(second.page);
    await second.page.locator('[data-setting="updates.check"]').click();
    await second.page.keyboard.press('Escape');
    await expect(shield(second.page)).toHaveText('3');
    expect(stub.seen.length).toBe(before);
  } finally {
    await stub.close();
  }
});

test('offline: the launch check fails quietly; Settings says so', async ({ el }) => {
  const stub = await startStub('1.0.0');
  await stub.close(); // a port nothing listens on
  writeUserData(el.userData, 'settings.json', { 'updates.check': true });
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_UPDATE_API: stub.origin } });
  await ready(page);
  // Settled = failed and not checking: main's "changed" broadcasts may land after the invoke reply.
  await expect.poll(async () => { const s = await status(page); return !!s.lastError && !s.checking; }, { timeout: 20000 }).toBe(true);
  expect(await status(page)).toMatchObject({ lastChecked: null, findings: [], checking: false });
  await expect(shield(page)).toHaveCount(0);
  await expect(page.locator('.se-toast')).toHaveCount(0);
  await openSettings(page);
  await expect(page.locator('[data-testid="updates-last-checked"]')).toHaveAttribute('data-state', 'failed');
  await expect(page.locator('[data-testid="updates-last-checked"]')).toContainText('Last check failed');
  // The summary says what failed, half by half, in plain words.
  await expect(page.locator('[data-testid="updates-sum-electron"]')).toContainText('Not checked: endoflife.date failed (');
  await expect(page.locator('[data-testid="updates-sum-packages"]')).toContainText('Not checked: OSV.dev failed (');
  await expect(page.locator('[data-testid="updates-summary"]')).toContainText('Findings from the last complete check are kept');
});

test('"Check now" asks again although the last check is fresh; findings of versions no longer shipped are gone', async ({ el }) => {
  const version = await versionOf(el);
  const stub = await startStub(version);
  try {
    writeUserData(el.userData, 'settings.json', { 'updates.check': true });
    const stale = { kind: 'vuln', level: 'high', severity: 'HIGH', summary: 'Old build', url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc' };
    writeUserData(el.userData, 'update-check.json', {
      v: 1,
      lastChecked: Date.now() - 3600_000,
      lastAttempt: Date.now() - 3600_000,
      lastError: null,
      findings: [
        { ...stale, id: 'vuln:GHSA-aaaa-bbbb-cccc:dompurify@0.0.1', pkg: 'dompurify', version: '0.0.1', fixed: '0.0.2' },
        { id: 'electron-patch', kind: 'electron-patch', level: 'warn', pkg: 'electron', version: '1.0.0', fixed: '1.0.1', summary: 'Old Electron', url: 'https://releases.electronjs.org' },
      ],
    });
    const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_UPDATE_API: stub.origin } });
    await ready(page);
    await openSettings(page);
    await expect(page.locator('[data-testid="updates-last-checked"]')).toContainText('nothing found');
    expect((await status(page)).findings).toEqual([]);
    await page.waitForTimeout(1200);
    expect(stub.seen).toEqual([]); // checked an hour ago: not due

    await page.locator('[data-testid="updates-check-now"]').click();
    await expect.poll(() => stub.seen.length).toBe(2);
    await expect(page.locator('[data-testid="updates-check-now"]')).toBeEnabled();
    // Clean answer: only the newer major (info) — listed, but no shield.
    await expect(page.locator('[data-testid="updates-show"]')).toHaveText('Show findings (1)');
    await expect(page.locator('[data-testid="updates-last-checked"]')).toContainText('nothing found');
    await page.keyboard.press('Escape');
    await expect(shield(page)).toHaveCount(0);
    const saved = JSON.parse(fs.readFileSync(path.join(el.userData, 'update-check.json'), 'utf8'));
    expect(saved.findings.map((f: any) => f.id)).toEqual(['electron-major']);
    expect(Date.now() - saved.lastChecked).toBeLessThan(60_000);
  } finally {
    await stub.close();
  }
});

test('switch off: "Check now" still checks and shows what was checked; the automatic check stays refused; the summary survives a restart', async ({ el }) => {
  const version = await versionOf(el);
  const stub = await startStub(version);
  stub.vulns = { dompurify: 'GHSA-aaaa-bbbb-cccc' };
  try {
    const env = { SEC_EDIT_TEST_UPDATE_API: stub.origin };
    const first = await el.launch([el.ws], { env });
    const page = first.page;
    await ready(page);
    await page.waitForTimeout(1200);
    expect(stub.seen).toEqual([]); // off: nothing after launch
    expect(await page.evaluate(() => (window as any).secEditBridge.updates.check(false))).toMatchObject({ ok: false, error: { code: 'EDISABLED' } });
    expect(stub.seen).toEqual([]);

    await openSettings(page);
    const section = page.locator('[data-section="updates"]');
    await expect(section).toContainText('Check automatically every week');
    await expect(page.locator('[data-setting="updates.check"]')).toHaveAttribute('aria-checked', 'false');
    await page.locator('[data-testid="updates-check-now"]').click();
    await expect(page.locator('[data-testid="updates-last-checked"]')).toContainText('1 finding');
    expect(stub.seen.map((s) => `${s.method} ${s.url}`).sort()).toEqual(['GET /api/v1/products/electron/', 'POST /v1/querybatch', 'GET /v1/vulns/GHSA-aaaa-bbbb-cccc'].sort());
    for (const s of stub.seen) expect(s.headers['user-agent']).toBe('update-check');
    const sent = JSON.parse(stub.seen.find((s) => s.method === 'POST')!.body);
    expect(Object.keys(sent)).toEqual(['queries']);
    const n: number = sent.queries.length;
    expect(n).toBeGreaterThan(50);
    // Still off: the manual check did not switch anything on.
    await expect(page.locator('[data-setting="updates.check"]')).toHaveAttribute('aria-checked', 'false');

    // The summary: Electron line by line, the package count, sources and timing.
    const sum = page.locator('[data-testid="updates-summary"]');
    await expect(sum.locator('[data-testid="updates-sum-electron"]')).toContainText(`${version} (shipped)`);
    await expect(sum.locator('[data-testid="updates-sum-patch"]')).toContainText(`${version}: up to date`);
    await expect(sum.locator('[data-testid="updates-sum-patch"]')).toHaveAttribute('data-mark', 'ok');
    await expect(sum.locator('[data-testid="updates-sum-support"]')).toContainText('Supported until 2099-01-01');
    await expect(sum.locator('[data-testid="updates-sum-support"]')).toHaveAttribute('data-mark', 'ok');
    await expect(sum.locator('[data-testid="updates-sum-packages"]')).toContainText(`${n} packages checked against OSV.dev, 1 with known vulnerabilities`);
    await expect(sum.locator('[data-testid="updates-sum-packages"]')).toHaveAttribute('data-mark', 'high');
    await expect(sum.locator('[data-testid="updates-sum-sources"]')).toContainText('endoflife.date (Electron releases) · OSV.dev (known vulnerabilities)');
    await expect(sum.locator('[data-testid="updates-sum-time"]')).toContainText('took');
    // Every package, collapsed until asked; the finding first; a filter.
    const rows = sum.locator('[data-testid="updates-package"]');
    await expect(rows).toHaveCount(0);
    await sum.locator('[data-testid="updates-packages-toggle"]').click();
    await expect(rows).toHaveCount(n);
    await expect(rows.nth(0)).toHaveAttribute('data-mark', 'high');
    await expect(rows.nth(0)).toContainText('dompurify');
    await expect(rows.nth(0)).toContainText('GHSA-aaaa-bbbb-cccc · High · fixed in 999.0.0');
    await expect(rows.nth(1)).toContainText(`electron${version}OK`);
    await sum.locator('[data-testid="updates-packages-filter"]').fill('markdown-it');
    await expect(rows.first()).toContainText('markdown-it');
    for (const r of await rows.all()) await expect(r).toContainText(/^✓markdown-it.*OK$/);
    await sum.locator('[data-testid="updates-packages-filter"]').fill('dompurify@');
    await expect(rows).toHaveCount(1);

    // A manual check that finds a problem shows the shield too, with the automatic check off.
    await page.keyboard.press('Escape');
    await expect(shield(page)).toBeVisible();
    const saved = JSON.parse(fs.readFileSync(path.join(el.userData, 'update-check.json'), 'utf8'));
    expect(saved.summary.packages).toHaveLength(n);
    expect(saved.summary.electron.version).toBe(version);
    await first.app.close();

    // Next launch: the summary comes from the cache; off = nothing is asked.
    const before = stub.seen.length;
    const second = await el.launch([el.ws], { env });
    await ready(second.page);
    await openSettings(second.page);
    await expect(second.page.locator('[data-testid="updates-sum-packages"]')).toContainText(`${n} packages checked against OSV.dev, 1 with known vulnerabilities`);
    await expect(second.page.locator('[data-testid="updates-sum-electron"]')).toContainText(`${version} (shipped)`);
    await second.page.waitForTimeout(1200);
    expect(stub.seen.length).toBe(before);
  } finally {
    await stub.close();
  }
});
