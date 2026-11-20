// "Start web server" in the real desktop app: browser mode for the open folder as a child process.
// Start → info shows the address → the link works only with its token (header only: no cookie, no token
// in the page or a URL the browser is started with) → stop closes the port; quitting
// (or a crash) leaves no orphan; LAN warns first and lists the addresses; a dead child shows its error.
import net from 'node:net';
import os from 'node:os';
import { chromium, type ElectronApplication, type Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { lanAddresses } from '../../../src/main/web-server';

const ready = (page: Page) => page.waitForFunction(() => !!(window as any).__secEditWebServer, null, { timeout: 15000 });
const pidOf = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__secEditWebServer?.pid as number | undefined);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const status = (page: Page) => page.evaluate(() => (window as any).__secEditWebServer.status());
const refused = (url: string) => fetch(url).then(() => false, () => true);

async function runCommand(page: Page, text: string, id: string) {
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type(text);
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', id);
  await page.keyboard.press('Enter');
}

async function openBrowserModeSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.locator('[data-nav="webserver"]').click();
  await expect(page.locator('[data-testid="webserver-settings"]')).toBeVisible();
}

test('start from the palette: info shows the address, the link needs its token, stop closes the port', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  await ready(page);
  await expect(page.locator('[data-testid="webserver-pill"]')).toHaveCount(0);
  expect(await pidOf(app)).toBeUndefined(); // never started on its own

  await runCommand(page, 'start web server', 'webServer.start');
  const info = page.locator('[data-testid="webserver-info"]');
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Running');
  await expect(info.locator('[data-testid="webserver-folder"]')).toHaveText(el.ws);
  await expect(info.locator('[data-testid="webserver-access"]')).toContainText('This computer only');
  await expect(info.locator('[data-testid="webserver-limits"]')).toContainText('No terminal');
  await expect(info).toContainText('Opening another folder stops it');
  const origin = (await info.locator('[data-testid="webserver-url"]').textContent())!;
  expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  // Shown without the key; "Copy link" copies the full link. Read from the page's clipboard call, not the
  // X clipboard (shared by parallel workers on one display: another test could overwrite it).
  await page.evaluate(() => {
    (window as any).__copied = [];
    navigator.clipboard.writeText = async (t: string) => void (window as any).__copied.push(t);
  });
  await info.locator('[data-testid="webserver-copy"]').click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied.length)).toBe(1);
  const url: string = await page.evaluate(() => (window as any).__copied[0]);
  expect(url).toMatch(/\?token=[a-f0-9]{32,}$/);
  expect(url).toBe((await status(page)).urls[0].url);
  expect(url.startsWith(origin)).toBe(true);
  const token = url.split('token=')[1];
  expect(await info.textContent()).not.toContain(token);

  // The page itself is a static shell: no key in it, no cookie (cookies ignore ports) — with or without the link.
  for (const u of [url, origin]) {
    const res = await fetch(u);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain(token);
  }
  // No data without the key — and the key only counts in its header, never in a URL.
  const listTree = (headers: Record<string, string> = {}) => fetch(`${origin}api/rpc/listTree`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"args":[]}' });
  expect((await listTree()).status).toBe(403);
  expect((await fetch(`${origin}api/rpc/listTree?token=${token}`, { method: 'POST', body: '{"args":[]}' })).status).toBe(403);
  expect((await fetch(`${origin}api/file?path=README.md`)).status).toBe(403);
  expect((await fetch(`${origin}api/file?path=README.md&token=${token}`)).status).toBe(403);
  expect((await fetch(`${origin}api/events?token=${token}`)).status).toBe(403);
  expect((await (await listTree({ 'x-sec-edit-token': token })).json()).ok).toBe(true);

  // "Open" hands the OS browser (stubbed here) a one-time launch link, not the key: a command line is
  // visible to other processes. The code works once.
  await app.evaluate(({ shell }) => {
    (globalThis as any).__opened = [];
    shell.openExternal = (async (u: string) => void (globalThis as any).__opened.push(u)) as typeof shell.openExternal;
  });
  await info.locator('[data-testid="webserver-open"]').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened.length)).toBe(1);
  const opened: string = await app.evaluate(() => (globalThis as any).__opened[0]);
  expect(opened).toMatch(new RegExp(`^${origin.replace(/[.]/g, '\\.')}\\?launch=[a-f0-9]{32}$`));
  const redeem = () => fetch(`${origin}api/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: opened.split('launch=')[1] }) });
  expect((await (await redeem()).json()).token).toBe(token);
  expect((await redeem()).status).toBe(403);
  // A page cannot make main open anything else.
  expect(await page.evaluate(() => (window as any).secEditBridge.webServer.open('https://example.com/'))).toMatchObject({ ok: false, error: { code: 'EACCES' } });

  await info.locator('.se-btn', { hasText: 'Close' }).click();
  const pill = page.locator('[data-testid="webserver-pill"]');
  await expect(pill).toHaveText(`:${new URL(origin).port}`);
  await pill.click();
  await expect(info).toBeVisible();
  const pid = (await pidOf(app))!;
  expect(alive(pid)).toBe(true);
  await info.locator('[data-testid="webserver-stop"]').click();
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Stopped');
  await expect(pill).toHaveCount(0);
  await expect.poll(() => refused(origin)).toBe(true);
  await expect.poll(() => alive(pid)).toBe(false);
});

test('quitting the app ends the server process (no orphan)', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  await ready(page);
  await openBrowserModeSettings(page);
  const panel = page.locator('[data-testid="webserver-settings"]');
  await panel.locator('[data-testid="webserver-start"]').click();
  await expect(panel.locator('[data-testid="webserver-state"]')).toHaveText('Running');
  const origin = (await panel.locator('[data-testid="webserver-url"]').textContent())!;
  const pid = (await pidOf(app))!;
  expect(alive(pid)).toBe(true);
  await app.close();
  await expect.poll(() => alive(pid), { timeout: 10000 }).toBe(false);
  expect(await refused(origin)).toBe(true);
});

test('a crashed app leaves no server behind either (the child notices the closed IPC channel)', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  await ready(page);
  await runCommand(page, 'start web server', 'webServer.start');
  await expect(page.locator('[data-testid="webserver-pill"]')).toBeVisible();
  const pid = (await pidOf(app))!;
  process.kill(app.process().pid!, 'SIGKILL');
  await expect.poll(() => alive(pid), { timeout: 10000 }).toBe(false);
});

test('LAN: warns before starting, then lists the network addresses', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  await ready(page);
  await openBrowserModeSettings(page);
  await page.locator('[data-setting="webserver.access"] [data-value="lan"]').click();
  const panel = page.locator('[data-testid="webserver-settings"]');
  const dlg = page.locator('.se-dialog[role="alertdialog"]');

  await panel.locator('[data-testid="webserver-start"]').click();
  await expect(dlg).toContainText('Anyone on your network with the link can read, change and delete the files in this folder (git included)');
  await expect(dlg).toContainText('Nothing outside this folder.');
  await dlg.locator('.se-btn', { hasText: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  expect(await pidOf(app)).toBeUndefined(); // cancelled: nothing started
  await expect(panel.locator('[data-testid="webserver-state"]')).toHaveText('Stopped');

  await panel.locator('[data-testid="webserver-start"]').click();
  await dlg.locator('.se-btn', { hasText: 'Start on network' }).click();
  await expect(panel.locator('[data-testid="webserver-state"]')).toHaveText('Running');
  const s = await status(page);
  expect(s.access).toBe('lan');
  const expected = lanAddresses(os.networkInterfaces()).map((a) => `http://${a}:${s.port}/`);
  await expect(panel.locator('[data-testid="webserver-url"]')).toHaveText([`http://127.0.0.1:${s.port}/`, ...expected]);
  if (!expected.length) await expect(panel).toContainText('No network address found');
  // Bound to every interface: loopback still works, still only with the token — and only for this folder.
  const local = s.urls[0];
  const key = local.url.split('token=')[1];
  expect((await fetch(local.url)).status).toBe(200);
  const rpc = (method: string, args: unknown[], headers: Record<string, string> = {}) =>
    fetch(`${local.origin}api/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ args }) }).then(async (r) => ({ status: r.status, body: r.status === 200 ? await r.json() : null }));
  expect((await rpc('listTree', [])).status).toBe(403);
  expect((await rpc('listTree', [], { 'x-sec-edit-token': key })).body.ok).toBe(true);
  expect((await rpc('openWorkspace', [path.dirname(el.ws)], { 'x-sec-edit-token': key })).body.error.code).toBe('EACCES');
  expect((await rpc('recentWorkspaces', [], { 'x-sec-edit-token': key })).body.result).toEqual([]);
  await expect(page.locator('[data-testid="webserver-pill"]')).toHaveAttribute('data-access', 'lan');
  await panel.locator('[data-testid="webserver-stop"]').click();
  await expect(panel.locator('[data-testid="webserver-state"]')).toHaveText('Stopped');
});

test('a dead server shows its error; a taken port says so; another folder stops it', async ({ el }) => {
  const other = path.join(el.tmp, 'other');
  fs.mkdirSync(other);
  const { app, page } = await el.launch([el.ws]);
  await ready(page);
  await runCommand(page, 'start web server', 'webServer.start');
  await expect(page.locator('[data-testid="webserver-pill"]')).toBeVisible();
  await page.keyboard.press('Escape');

  // The child dies on its own → toast + the error in the info dialog.
  process.kill((await pidOf(app))!, 'SIGKILL');
  await expect(page.locator('.se-toast', { hasText: 'Web server stopped' })).toBeVisible();
  await expect(page.locator('[data-testid="webserver-pill"]')).toHaveCount(0);
  await runCommand(page, 'web server show info', 'webServer.info');
  await expect(page.locator('[data-testid="webserver-error"]')).toContainText('stopped unexpectedly (signal SIGKILL)');
  await page.keyboard.press('Escape');

  // A fixed port that is taken: the message names it.
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const port = (blocker.address() as net.AddressInfo).port;
  await openBrowserModeSettings(page);
  await page.locator('#set-webserver-port').fill(String(port));
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.settings.value['webserver.port'])).toBe(port);
  await page.locator('[data-testid="webserver-settings"] [data-testid="webserver-start"]').click();
  await expect(page.locator('[data-testid="webserver-settings"] [data-testid="webserver-error"]')).toHaveText(`Port ${port} is in use`);
  blocker.close();

  // Automatic port again, start, then open another folder: the server goes with the old one.
  await page.locator('#set-webserver-port').fill('');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.settings.value['webserver.port'] ?? null)).toBe(null);
  await page.locator('[data-testid="webserver-settings"] [data-testid="webserver-start"]').click();
  await expect(page.locator('[data-testid="webserver-settings"] [data-testid="webserver-state"]')).toHaveText('Running');
  const pid = (await pidOf(app))!;
  await page.keyboard.press('Escape');
  // The page may only open what main saw itself (dialog, launch args, drop, recents): asked out of the blue
  // it is refused, and the server keeps running.
  const denied = await page.evaluate((p) => (window as any).__secEdit.backend.openWorkspace(p).then(() => 'opened', (e: { code?: string }) => e.code), other);
  expect(denied).toBe('EACCES');
  expect((await status(page)).state).toBe('running');
  await app.evaluate((_e, p) => (globalThis as any).__secEditVouch(p), other); // stands in for the folder dialog
  await page.evaluate((p) => (window as any).__secEdit.backend.openWorkspace(p), other);
  await expect(page.locator('.se-toast', { hasText: 'Opening another folder stopped the web server.' })).toBeVisible();
  await expect.poll(() => alive(pid)).toBe(false);
  expect((await status(page)).state).toBe('stopped');
});

test('desktop and a browser tab on the same folder keep their own open tabs (reloads, restarts)', async ({ el }) => {
  const tabs = (p: Page) => p.evaluate(() => (window as any).__secEdit.tabs.value.map((t: { path: string }) => t.path));
  const sessions = path.join(el.userData, 'sessions');
  const sessionText = (web: boolean) => {
    const f = fs.existsSync(sessions) && fs.readdirSync(sessions).find((n) => n.endsWith(web ? '@web.json' : '.json') && web === n.includes('@web'));
    return f ? fs.readFileSync(path.join(sessions, f), 'utf8') : '';
  };
  let { app, page } = await el.launch([el.ws]);
  await ready(page);
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await expect.poll(() => tabs(page)).toEqual(['README.md']);
  await expect.poll(() => sessionText(false)).toContain('"README.md"');

  await runCommand(page, 'start web server', 'webServer.start');
  await expect(page.locator('[data-testid="webserver-pill"]')).toBeVisible();
  await page.keyboard.press('Escape');
  const browser = await chromium.launch();
  try {
    let tab = await browser.newPage();
    await tab.goto((await status(page)).urls[0].url);
    await tab.waitForSelector('html[data-ready="true"]');
    // First visit: the desktop's tabs as a starting point…
    expect(await tabs(tab)).toEqual(['README.md']);
    await tab.evaluate(async () => {
      const a = (window as any).__secEdit;
      await a.openFile('notes/kubernetes.md');
      await a.closeTab('README.md');
    });
    await expect.poll(() => tabs(tab)).toEqual(['notes/kubernetes.md']);
    await expect.poll(() => sessionText(true)).toContain('kubernetes.md');
    // …never written back: the desktop keeps README, also after a reload.
    expect(sessionText(false)).not.toContain('kubernetes');
    await tab.reload();
    await tab.waitForSelector('html[data-ready="true"]');
    expect(await tabs(tab)).toEqual(['notes/kubernetes.md']);
    expect(await tabs(page)).toEqual(['README.md']);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    expect(await tabs(page)).toEqual(['README.md']);

    // Restart the desktop app: each side still has its own.
    await app.close();
    ({ app, page } = await el.launch([el.ws]));
    await ready(page);
    expect(await tabs(page)).toEqual(['README.md']);
    await runCommand(page, 'start web server', 'webServer.start');
    await expect(page.locator('[data-testid="webserver-pill"]')).toBeVisible();
    tab = await browser.newPage();
    await tab.goto((await status(page)).urls[0].url);
    await tab.waitForSelector('html[data-ready="true"]');
    expect(await tabs(tab)).toEqual(['notes/kubernetes.md']);
  } finally {
    await browser.close();
  }
});

test('desktop and a browser tab share settings: both changes survive, each sees the other without a restart', async ({ el }) => {
  const { page } = await el.launch([el.ws]);
  await ready(page);
  await runCommand(page, 'start web server', 'webServer.start');
  await expect(page.locator('[data-testid="webserver-pill"]')).toBeVisible();
  await page.keyboard.press('Escape');
  const browser = await chromium.launch();
  try {
    const tab = await browser.newPage();
    await tab.goto((await status(page)).urls[0].url);
    await tab.waitForSelector('html[data-ready="true"]');
    // Live sync is wired by the idle Popups chunk on both sides.
    await expect.poll(() => tab.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/Popups-[\w-]+\.js$/.test(e.name)))).toBe(true);
    const setting = (p: Page, k: string) => p.evaluate((key) => (window as any).__secEdit.settings.value[key], k);

    // At the same time: the desktop turns word wrap off (Settings), the browser switches the theme (palette).
    await page.keyboard.press('Control+,');
    await Promise.all([page.locator('[data-setting="wordWrap"]').click(), runCommand(tab, 'toggle dark light theme', 'theme.toggle')]);
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(el.userData, 'settings.json'), 'utf8'))).toMatchObject({ wordWrap: false, theme: 'light' });
    // Each side applies the other's change live (no restart, no reload).
    await expect.poll(() => setting(page, 'theme')).toBe('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => setting(tab, 'wordWrap')).toBe(false);
    expect(await setting(tab, 'theme')).toBe('light');
    expect(await setting(page, 'wordWrap')).toBe(false);
  } finally {
    await browser.close();
  }
});

test('the folder keeps its port; when it is taken, the info says browser state starts empty', async ({ el }) => {
  const { page } = await el.launch([el.ws]);
  await ready(page);
  const info = page.locator('[data-testid="webserver-info"]');
  await runCommand(page, 'start web server', 'webServer.start');
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Running');
  const port = (await status(page)).port as number;
  await expect(info.locator('[data-testid="webserver-port-busy"]')).toHaveCount(0);
  await info.locator('[data-testid="webserver-stop"]').click();
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Stopped');
  // Started again: the same port (same origin → the browser keeps this folder's state).
  await info.locator('[data-testid="webserver-start"]').click();
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Running');
  expect((await status(page)).port).toBe(port);
  await info.locator('[data-testid="webserver-stop"]').click();
  await expect(info.locator('[data-testid="webserver-state"]')).toHaveText('Stopped');

  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.once('error', () => r()).listen(port, '127.0.0.1', () => r())); // EADDRINUSE: taken anyway
  try {
    await info.locator('[data-testid="webserver-start"]').click();
    await expect(info.locator('[data-testid="webserver-port-busy"]')).toHaveText(`Port ${port} was busy — browser state for this folder starts empty.`);
    expect((await status(page)).port).not.toBe(port);
  } finally {
    blocker.close();
  }
});
