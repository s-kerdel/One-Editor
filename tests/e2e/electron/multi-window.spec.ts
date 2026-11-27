// Several windows, one per folder, in one app: second launches route folders / files / nothing; Ctrl+Shift+N; a folder
// opened from a window that has one gets its own window (or the window that has it); MCP, web server and settings are
// shared and live in every window; each window serves its own folder's files (app://sec-edit/__ws/<key>/).
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwH4QBEfcD/ePF9e8AAAAASUVORK5CYII=';
const SINGLE = { SEC_EDIT_SINGLE_INSTANCE: '1' };

/** A folder next to the fixture workspace, with a note and an image. */
async function folder(tmp: string, name: string, png = PNG_2x1): Promise<string> {
  const dir = path.join(tmp, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'note.md'), `# ${name}\n`);
  await fsp.writeFile(path.join(dir, 'pixel.png'), Buffer.from(png, 'base64'));
  return dir;
}

/** The folder of a booted window ('' = start screen), null while it boots (or once it is gone). */
const rootOf = (p: Page) =>
  p.evaluate(() => (document.documentElement.dataset.ready === 'true' ? ((window as any).__secEdit.workspace.value?.root ?? '') : null)).catch(() => null);

/** Every booted window's folder, sorted ('' = start screen). */
async function roots(app: ElectronApplication): Promise<string[]> {
  const out: string[] = [];
  for (const p of app.windows()) {
    if (p.isClosed()) continue;
    const r = await rootOf(p);
    if (r !== null) out.push(r);
  }
  return out.sort();
}

async function pageOf(app: ElectronApplication, root: string): Promise<Page> {
  let found: Page | null = null;
  await expect
    .poll(async () => {
      for (const p of app.windows()) if (!p.isClosed() && (await rootOf(p)) === root) return !!(found = p);
      return false;
    })
    .toBe(true);
  return found!;
}

const windowCount = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** A second launch with these paths: it hands them to the running app and exits. */
async function secondLaunch(userData: string, args: string[]) {
  const electronBin = (await import('electron')).default as unknown as string;
  const child = spawn(electronBin, ['--disable-gpu', process.env.SEC_EDIT_ELECTRON_APP!, ...args], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', SEC_EDIT_TEST: '1', SEC_EDIT_USER_DATA: userData, ...SINGLE },
    stdio: 'ignore',
  });
  expect(await new Promise<number | null>((r) => child.on('exit', r))).toBe(0);
}

async function runCommand(page: Page, text: string, id: string) {
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type(text);
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', id);
  await page.keyboard.press('Enter');
}

/** Folder switcher (shelf head) → a recent folder by name; `shift`: Shift+click (a new window). */
async function openRecent(page: Page, name: string, o: { shift?: boolean } = {}) {
  await page.locator('[aria-label="Switch folder"]').click();
  await page.locator('.se-menu-item', { hasText: name }).click({ modifiers: o.shift ? ['Shift'] : [] });
}

test('second launches: a folder gets its window (new, or the one that has it), a file its folder’s window, no path a start screen', async ({ el }) => {
  const b = await folder(el.tmp, 'beta');
  const { app } = await el.launch([el.ws], { env: SINGLE });
  await expect.poll(() => roots(app)).toEqual([el.ws]);

  await secondLaunch(el.userData, [b]);
  await expect.poll(() => roots(app)).toEqual([el.ws, b].sort());

  // The same folder again: its window comes to the front, no new one.
  await secondLaunch(el.userData, [el.ws]);
  // A file inside B: a tab in B's window (routing runs in order, so A's launch was handled before this one).
  await secondLaunch(el.userData, [path.join(b, 'note.md')]);
  const pb = await pageOf(app, b);
  await expect(pb.locator('.se-tab.active')).toContainText('note.md');
  expect(await pb.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('note.md');
  expect(await windowCount(app)).toBe(2);
  expect(await roots(app)).toEqual([el.ws, b].sort());

  // No path (Windows: Shift+click on the taskbar button): a new window with the start screen.
  await secondLaunch(el.userData, []);
  await expect.poll(() => roots(app)).toEqual(['', el.ws, b].sort());
  const empty = await pageOf(app, '');
  await expect(empty.locator('[data-testid="welcome"]')).toBeVisible();
});

test('Ctrl+Shift+N opens a start screen that lists it; a folder switches this window, Shift+click opens a new one; a folder open elsewhere only brings that window up', async ({ el }) => {
  const b = await folder(el.tmp, 'beta');
  const c = await folder(el.tmp, 'gamma');
  const d = await folder(el.tmp, 'delta');
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'recent.json'), JSON.stringify([b, c, d]));
  const { app, page } = await el.launch([el.ws]);

  const opened = app.waitForEvent('window');
  await page.keyboard.press('Control+Shift+n');
  const fresh = await opened;
  await fresh.waitForSelector('html[data-ready="true"]');
  expect(await rootOf(fresh)).toBe('');
  await expect(fresh.locator('[data-testid="welcome"]')).toBeVisible();
  // The start screen lists the shortcut right after "New note".
  const labels = await fresh.locator('.se-shortcuts li > span:first-child').allTextContents();
  expect(labels.indexOf('New window')).toBe(labels.indexOf('New note') + 1);
  expect(await roots(app)).toEqual(['', el.ws].sort());

  // Empty window: a recent folder opens in place.
  await fresh.locator('.se-recent-item', { hasText: 'gamma' }).click();
  await expect.poll(() => rootOf(fresh)).toBe(c);
  expect(await windowCount(app)).toBe(2);

  // A window with a folder, Shift+click: a new window; this one keeps its folder.
  await expect(async () => {
    await fresh.locator('[aria-label="Switch folder"]').click();
    expect(await fresh.locator('.se-menu-item', { hasText: 'beta' }).getAttribute('title')).toBe('Shift+click: open in a new window');
  }).toPass();
  await fresh.keyboard.press('Escape');
  await openRecent(fresh, 'beta', { shift: true });
  await expect.poll(() => roots(app)).toEqual([el.ws, b, c].sort());
  expect(await rootOf(fresh)).toBe(c);

  // Plain click: this window switches to the folder (no new window).
  await openRecent(fresh, 'delta');
  await expect.poll(() => rootOf(fresh)).toBe(d);
  expect(await windowCount(app)).toBe(3);
  expect(await roots(app)).toEqual([el.ws, b, d].sort());

  // A folder another window has open: that window is brought up, plain or Shift; nothing new opens, nothing moves.
  const pb = await pageOf(app, b);
  await openRecent(pb, 'workspace');
  await openRecent(pb, 'workspace', { shift: true });
  // …and the page cannot open it in place either.
  const direct = await pb.evaluate((p) => (window as any).__secEdit.backend.openWorkspace(p).then(() => 'opened', (e: { code?: string }) => e.code), el.ws);
  expect(direct).toBe('EBUSY');
  expect(await windowCount(app)).toBe(3);
  expect(await roots(app)).toEqual([el.ws, b, d].sort());
});

test('a folder being opened, or another spelling of an open one, belongs to that window: never two windows for it', async ({ el }) => {
  const x = await folder(el.tmp, 'xray');
  const y = await folder(el.tmp, 'yankee');
  const link = path.join(el.tmp, 'link-to-workspace');
  await fsp.symlink(el.ws, link, 'dir');
  const { app, page: w1 } = await el.launch([el.ws], { env: SINGLE });
  const emptyWindow = async () => {
    const opened = app.waitForEvent('window');
    await w1.evaluate(() => (window as any).secEditBridge.newWindow());
    const p = await opened;
    await p.waitForSelector('html[data-ready="true"]');
    return p;
  };
  const w2 = await emptyWindow();
  const w3 = await emptyWindow();
  await app.evaluate((_e, ps) => ps.forEach((p) => (globalThis as any).__secEditVouch(p)), [x, y, link]); // stands in for the dialog
  const ask = (p: Page, abs: string) => p.evaluate((a) => (window as any).secEditBridge.openFolderWindow(a), abs);
  const open = (p: Page, abs: string) => p.evaluate((a) => (window as any).__secEdit.backend.openWorkspace(a).then((w: { root: string }) => w.root, (e: { code?: string }) => e.code), abs);

  // W2 may open X here; before its own open has even started, X already counts as W2's.
  expect(await ask(w2, x)).toBe('here');
  expect(await ask(w3, x)).toBe('focused');
  expect(await open(w3, x)).toBe('EBUSY');
  expect(await open(w2, x)).toBe(x);

  // A window told 'here' for Y but not opening it yet (it may still cancel on "Save changes?"): a launch of Y opens its
  // own window, and that window's late open then finds Y taken. Never two windows for Y.
  expect(await ask(w3, y)).toBe('here');
  await secondLaunch(el.userData, [y]);
  expect(await open(w3, y)).toBe('EBUSY'); // decided in turn: after the launch was routed
  expect(await windowCount(app)).toBe(4);
  const wy = await pageOf(app, y);

  // A link to the folder W1 has open is that folder (the gate judges real paths, so does routing).
  await app.evaluate((_e, p) => (globalThis as any).__secEditVouch(p), link);
  expect(await ask(w3, link)).toBe('focused');
  expect(await open(w3, link)).toBe('EBUSY');
  await secondLaunch(el.userData, [link]);
  expect(await ask(w3, link)).toBe('focused'); // in turn: after the launch was routed
  expect(await windowCount(app)).toBe(4);
  // What each window's backend has open (the raw RPC above leaves the renderer's own state alone).
  const opened = async (p: Page) => (await p.evaluate(() => (window as any).__secEdit.backend.getWorkspace()))?.root ?? '';
  expect([await opened(w1), await opened(w2), await opened(w3), await opened(wy)]).toEqual([el.ws, x, '', y]);
});

test('shared across windows: web server and MCP status, settings; each window serves its own folder; closing one stops its server', async ({ el }) => {
  await fsp.writeFile(path.join(el.ws, 'pixel.png'), Buffer.from(PNG_1x1, 'base64'));
  const b = await folder(el.tmp, 'beta');
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'recent.json'), JSON.stringify([b]));
  const { app, page: pa } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow' } });
  await openRecent(pa, 'beta', { shift: true });
  const pb = await pageOf(app, b);

  // Images: each window from its own folder, through its own key.
  const image = async (p: Page) => {
    await p.locator('.se-tree-row', { hasText: 'pixel.png' }).click();
    const img = p.locator('.se-viewer-img');
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
    return { width: await img.evaluate((i: HTMLImageElement) => i.naturalWidth), src: (await img.getAttribute('src'))! };
  };
  const ia = await image(pa);
  const ib = await image(pb);
  expect(ia.width).toBe(1);
  expect(ib.width).toBe(2);
  const key = (src: string) => /^app:\/\/sec-edit\/__ws\/([0-9a-f]{32})\/pixel\.png$/.exec(src)?.[1];
  expect(key(ia.src)).toBeTruthy();
  expect(key(ib.src)).toBeTruthy();
  expect(key(ia.src)).not.toBe(key(ib.src));

  // Web server: started in A, every window shows it serving A; B cannot start one for itself meanwhile.
  const ws = (p: Page) => p.evaluate(() => (window as any).__secEditWebServer?.status() ?? null);
  const start = (p: Page) => p.evaluate(() => (window as any).secEditBridge.webServer.start({ port: null, access: 'local' }));
  await runCommand(pa, 'start web server', 'webServer.start');
  await expect(pa.locator('[data-testid="webserver-pill"]')).toBeVisible();
  await pa.keyboard.press('Escape');
  await expect.poll(async () => (await ws(pb))?.state).toBe('running');
  expect((await ws(pb)).root).toBe(el.ws);
  await expect(pb.locator('[data-testid="webserver-pill"]')).toBeVisible();
  const busy = await start(pb);
  expect(busy).toMatchObject({ ok: false, error: { code: 'EBUSY' } });
  expect(busy.error.message).toContain(el.ws);
  // Stopped from B (any window can), then started for B.
  await runCommand(pb, 'stop web server', 'webServer.stop');
  await expect.poll(async () => (await ws(pa))?.state).toBe('stopped');
  expect(await start(pb)).toMatchObject({ ok: true, result: { state: 'running', root: b } });
  await expect.poll(async () => (await ws(pa))?.root).toBe(b);
  const pid = (await app.evaluate(() => (globalThis as any).__secEditWebServer?.pid as number | undefined))!;
  expect(pid).toBeTruthy();

  // MCP: turned on in A, B's panel follows live.
  await pb.keyboard.press('Control+,');
  await pb.locator('[data-nav="mcp"]').click();
  await expect(pb.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
  await pa.keyboard.press('Control+,');
  await pa.locator('[data-nav="mcp"]').click();
  await pa.locator('[data-testid="mcp-enable"]').click();
  await expect(pa.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'yes');
  await expect(pb.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'yes');
  await pa.keyboard.press('Escape');
  await pb.keyboard.press('Escape');

  // A setting changed in A reaches B (settings.json watch of B's backend → settings:changed).
  const theme = (p: Page) => p.evaluate(() => (window as any).__secEdit.settings.value.theme);
  expect(await theme(pb)).toBe('dark');
  await runCommand(pa, 'toggle dark light theme', 'theme.toggle');
  await expect.poll(() => theme(pa)).toBe('light');
  await expect.poll(() => theme(pb)).toBe('light');
  await expect(pb.locator('html')).toHaveAttribute('data-theme', 'light');

  // Closing B: its server stops (no window has its folder any more); A keeps working.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /beta/.test(w.getTitle()))!.close());
  await expect.poll(() => windowCount(app)).toBe(1);
  await expect.poll(async () => (await ws(pa))?.state).toBe('stopped');
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await expect.poll(alive).toBe(false);
  await expect(pa.locator('.se-toast', { hasText: 'Closing its folder stopped the web server.' })).toBeVisible();
  await pa.locator('.se-tree-row', { hasText: 'README' }).click();
  await expect(pa.locator('.cm-content')).toContainText('Welcome');
  expect(fs.existsSync(path.join(el.userData, 'mcp.json'))).toBe(true);
});
