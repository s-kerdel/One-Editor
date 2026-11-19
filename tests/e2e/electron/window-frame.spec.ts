// Window frame (Settings → Appearance → Window frame), in the real Electron app.
// Integrated (default): no OS title bar — the tab strip is the title bar and the OS draws min/max/close
// over its right end (Window Controls Overlay). Native: the OS title bar, as before.
// Tests that need REAL pointer input or screen pixels run on a private Xvfb display per worker, so no
// other test's window is in the way; X input goes through the window's hit-testing (drag regions).
import { execFileSync, execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path, type ElectronFixture } from './fixture';
import { connectXTest, type XPointer } from './xtest';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');
const hasImport = (() => {
  try {
    execFileSync('import', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Own X display for this worker (real input + screen pixels must not hit another test's window). */
function privateDisplay(): string | null {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB)) return null;
  const d = `:${130 + test.info().parallelIndex}`;
  execSync(`${XVFB} ${d}`, { stdio: 'ignore' });
  return d;
}

/** Settings + a fixed window at the screen's top-left (no window manager under Xvfb: it stays there). */
async function prepare(el: ElectronFixture, settings: Record<string, unknown>, width = 1100) {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify(settings));
  await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width, height: 700 }));
}

async function openTabs(page: Page) {
  for (const f of ['README.md', 'notes/kubernetes.md', 'notes/Daily notes.md']) await page.evaluate((f) => (window as any).__secEdit.openFile(f), f);
  await expect(page.locator('.se-tab')).toHaveCount(3);
  await expect(page.locator('.se-modes')).toBeVisible();
}

const region = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (getComputedStyle(el) as any).webkitAppRegion as string);
const rect = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
  });
const wco = (page: Page) =>
  page.evaluate(() => {
    const o = (navigator as any).windowControlsOverlay;
    return { visible: !!o?.visible, rect: o?.getTitlebarAreaRect().toJSON() as { x: number; y: number; width: number; height: number } | undefined };
  });
const mainOverlay = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__secEditTitleBar ?? null);
/** What the controls should look like: the strip's own computed colours (no second palette). */
const stripLook = (page: Page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.se-tabbar')!;
    const cs = getComputedStyle(bar);
    const hex = (c: string) => {
      const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c);
      return m ? '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('') : c.trim().toLowerCase();
    };
    return { color: hex(cs.backgroundColor), symbolColor: hex(cs.getPropertyValue('--text-muted')), height: Math.round(bar.getBoundingClientRect().height - parseFloat(cs.borderBottomWidth)) };
  });

/** Screen pixel as #rrggbb (ImageMagick `import` reads the X server: includes the native controls). */
function pixel(display: string, x: number, y: number): string {
  const out = execFileSync('import', ['-display', display, '-window', 'root', '-crop', `1x1+${Math.round(x)}+${Math.round(y)}`, 'txt:-'], { encoding: 'utf8' });
  return ('#' + (/#([0-9A-F]{6})/i.exec(out)?.[1] ?? '')).toLowerCase();
}

/** Records which element got each pointerdown (a press on a drag region never reaches the page). */
async function trackPresses(page: Page) {
  await page.evaluate(() => {
    (window as any).__presses = [];
    addEventListener('pointerdown', (e) => (window as any).__presses.push((e.target as Element).closest('[class]')?.className ?? '?'), true);
  });
  return () => page.evaluate(() => ((window as any).__presses as string[]).splice(0));
}

async function realPointer(display: string | null): Promise<XPointer | null> {
  if (!display) return null;
  return connectXTest(display).catch(() => null);
}

test('integrated by default: frameless window, controls overlay, the tab strip is the title bar', async ({ el }) => {
  await prepare(el, {});
  const { app, page } = await el.launch();
  await openTabs(page);
  // Main created the window without the OS title bar…
  const opts = await app.evaluate(() => (globalThis as any).__secEditWindowOptions);
  expect(opts.frame).toBe('integrated');
  if (process.platform !== 'darwin') expect(opts).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: expect.any(Number) } });
  // …Chromium really shows the controls overlay, and the renderer styles by that actual frame.
  const w = await wco(page);
  expect(w.visible).toBe(true);
  expect(await page.evaluate(() => (window as any).secEditBridge.frame)).toBe('integrated');
  await expect(page.locator('.se-root')).toHaveClass(/frame-integrated/);
  await expect(page.locator('html')).toHaveAttribute('data-frame', 'integrated');
  // Drag regions: the strip (and the band above the workspace switcher) drag; everything clickable is no-drag.
  expect(await region(page, '.se-topline')).toBe('drag');
  expect(await region(page, '.se-shelf-head')).toBe('drag');
  for (const sel of ['.se-tab', '.se-tab-close', '.se-modes', '.se-mode', '.se-width-btn', '.se-ws', '.se-shelf-head .se-icon-btn', '.se-sash']) expect(await region(page, sel), sel).toBe('no-drag');
  expect(await region(page, '.se-tabs')).toBe('drag'); // app-region inherits: the tab list's empty end drags
  // Nothing of ours sits under the controls: the view modes end left of them.
  const ctl = w.rect!.x + w.rect!.width; // the controls start here
  const innerW = await page.evaluate(() => innerWidth);
  expect(ctl).toBeLessThan(innerW);
  for (const m of await page.locator('.se-mode').all()) {
    const r = await m.boundingBox();
    expect(r!.x + r!.width).toBeLessThanOrEqual(ctl - 4);
    await expect(m).toBeVisible();
  }
  // Shelf: the card meets the window's top-right corner (no rounded corner hidden behind the controls).
  const card = await rect(page, '.se-content');
  expect(card.y).toBe(0);
  expect(card.right).toBe(innerW);
  expect(await page.locator('.se-content').evaluate((e) => getComputedStyle(e).borderTopRightRadius)).toBe('0px');
  // Overlay = the strip under it: colour, glyph colour (muted text) and the strip's height above its rule.
  const look = await stripLook(page);
  expect(await mainOverlay(app)).toEqual(look);
  expect(w.rect!.height).toBe(look.height);
  // The window title still says what is open (taskbar / Alt-Tab).
  await expect(page).toHaveTitle(/Daily notes\.md — workspace — sec-edit/);
});

test('real pointer input: tabs and buttons click, empty strip space drags, drops still land', async ({ el }) => {
  const display = privateDisplay();
  test.skip(!display, 'needs the sudo-free Xvfb (Linux)');
  // Wide enough that three tabs + the view controls (incl. the file overview toggle) leave empty strip to drag.
  await prepare(el, { theme: 'dark' }, 1200);
  const { app, page } = await el.launch([el.ws], { env: { DISPLAY: display! } });
  await openTabs(page);
  const x = await realPointer(display);
  test.skip(!x, 'XTEST unavailable');
  try {
    const presses = await trackPresses(page);
    const at = async (sel: string) => {
      const r = await rect(page, sel);
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
    };
    // A tab is no-drag: the press reaches it and activates it.
    let p = await at('.se-tab[data-path="README.md"]');
    await x!.click(p.x, p.y);
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
    expect((await presses()).join()).toContain('se-tab');
    // The strip's empty end is a drag region: the OS takes the press (window move), the page never sees it.
    const tabs = await rect(page, '.se-tabs');
    const last = await rect(page, '.se-tab:last-child');
    const empty = { x: (last.right + tabs.right) / 2, y: tabs.y + tabs.h / 2 };
    expect(tabs.right - last.right).toBeGreaterThan(40);
    await x!.click(empty.x, empty.y);
    expect(await presses()).toEqual([]);
    // Double-click there is the OS's (maximize); it must never reach our tab double-click-to-close.
    await x!.click(empty.x, empty.y, { count: 2 });
    expect(await presses()).toEqual([]);
    await expect(page.locator('.se-tab')).toHaveCount(3);
    // The view-mode buttons next to the controls click.
    p = await at('.se-mode[data-mode="source"]');
    await x!.click(p.x, p.y);
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.settings.value.viewMode)).toBe('source');
    expect((await presses()).length).toBe(1);
    // The band above the workspace switcher drags too.
    await x!.click(60, 3);
    expect(await presses()).toEqual([]);
    // Overlays above the strip take their clicks (backdrop click closes the palette).
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.se-overlay')).toBeVisible();
    await x!.click(empty.x, empty.y);
    await expect(page.locator('.se-overlay')).toHaveCount(0);
    // Drag regions take no drops: a tab dragged to the strip's empty end must still move there.
    const from = await at('.se-tab[data-path="README.md"]');
    await x!.move(from.x, from.y);
    await x!.down();
    for (let i = 1; i <= 12; i++) await x!.move(from.x + ((empty.x - from.x) * i) / 12, from.y);
    await x!.move(empty.x + 2, empty.y); // a couple of positions at the target: XDND answers each one asynchronously
    await x!.move(empty.x + 4, empty.y);
    await page.waitForTimeout(150);
    await x!.up();
    await expect.poll(() => page.evaluate(() => (window as any).__secEdit.tabs.value.map((t: any) => t.path).at(-1))).toBe('README.md');
    expect(await page.evaluate(() => document.documentElement.classList.contains('se-dragging'))).toBe(false);
    // The controls really are drawn in the strip's colour, seamlessly (screen pixels left/right of their edge).
    if (hasImport) {
      const w = await wco(page);
      const edge = w.rect!.x + w.rect!.width;
      const { color } = await stripLook(page);
      expect(pixel(display!, edge - 3, 3)).toBe(color);
      expect(pixel(display!, edge + 3, 3)).toBe(color);
    }
  } finally {
    x?.close();
  }
  void app;
});

test('the overlay’s own close button goes through the unsaved-changes flow', async ({ el }) => {
  const display = privateDisplay();
  test.skip(!display, 'needs the sudo-free Xvfb (Linux)');
  await prepare(el, { autosave: false });
  const { app, page } = await el.launch([el.ws], { env: { DISPLAY: display! } });
  const x = await realPointer(display);
  test.skip(!x, 'XTEST unavailable');
  try {
    await page.locator('.se-tree-row', { hasText: 'README' }).click();
    await page.locator('.cm-content').click();
    await page.keyboard.type('close-button ');
    // The controls fill the overlay right of the titlebar area; close is the last one (Linux draws ~38 px per button).
    const w = await wco(page);
    const innerW = await page.evaluate(() => innerWidth);
    await x!.click(innerW - (innerW - (w.rect!.x + w.rect!.width)) / 6, w.rect!.height / 2);
    const dlg = page.locator('.se-dialog');
    await expect(dlg).toContainText('Save changes');
    const closed = app.waitForEvent('close');
    await dlg.locator('.se-btn', { hasText: 'Save' }).last().click();
    await closed;
    expect(await fsp.readFile(path.join(el.ws, 'README.md'), 'utf8')).toContain('close-button') // trailing space trimmed on save;
  } finally {
    x?.close();
  }
});

test('overlay follows theme (also the OS switching), density, zoom and sidebar style', async ({ el }) => {
  await prepare(el, { theme: 'dark' });
  const { app, page } = await el.launch();
  await openTabs(page);
  /** Once the strip shows `color` (CSS updates may lag a theme source change), main's overlay matches it. */
  const synced = async (color?: string) => {
    if (color) await expect.poll(async () => (await stripLook(page)).color).toBe(color);
    const want = await stripLook(page);
    await expect.poll(() => mainOverlay(app)).toEqual(want);
    return want;
  };
  expect((await synced()).color).toBe('#16181c');
  await page.getByLabel('Toggle theme').click(); // → light
  expect(await synced()).toMatchObject({ color: '#f6f6f5', symbolColor: '#5f6670' });
  // Settings: density changes the strip's height, so the controls' height follows.
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="uiDensity"] [data-value="compact"]').click();
  expect((await synced()).height).toBe(33);
  await page.locator('[data-setting="uiDensity"] [data-value="spacious"]').click();
  expect((await synced()).height).toBe(41);
  // Theme "System": follows the OS, live. (Playwright pins prefers-color-scheme, so the OS switch is
  // emulated at that same media query — exactly what the renderer listens to.)
  await page.locator('[data-setting="theme"] [data-value="system"]').click();
  await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system'); // main applied the setting
  await page.emulateMedia({ colorScheme: 'dark' }); // the OS goes dark
  await synced('#16181c');
  await page.emulateMedia({ colorScheme: 'light' }); // …and light again
  await synced('#f6f6f5');
  // Accent never recolours the strip; classic keeps the same strip colours.
  await page.locator('[data-setting="accentColor"] [data-value="#22c55e"]').click();
  await page.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
  await expect(page.locator('.se-root')).toHaveClass(/ui-classic/);
  expect((await synced()).color).toBe('#f6f6f5');
  await page.keyboard.press('Escape');
  // Zoom: the overlay height is in window units (CSS px × zoom).
  await page.keyboard.press('Control+=');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.settings.value.zoom)).toBe(1.1);
  const z = await stripLook(page);
  await expect.poll(async () => (await mainOverlay(app))?.height).toBe(Math.round(z.height * 1.1));
  // The last measured look is remembered for the next launch's first paint.
  await page.waitForTimeout(700);
  const saved = JSON.parse(await fsp.readFile(path.join(el.userData, 'window-state.json'), 'utf8'));
  expect(saved.titleBar.light).toEqual({ color: '#f6f6f5', symbolColor: '#5f6670' });
  expect(saved.titleBar.dark).toEqual({ color: '#16181c', symbolColor: '#8f96a3' });
});

test('overlay IPC is validated: junk from the page never reaches the window', async ({ el }) => {
  await prepare(el, {});
  const { app, page } = await el.launch();
  const before = await mainOverlay(app);
  await page.evaluate(() => {
    const b = (window as any).secEditBridge;
    b.setTitleBarOverlay({ color: 'red', symbolColor: '#ffffff', height: 30 });
    b.setTitleBarOverlay({ color: '#ff0000', symbolColor: '#ffffff', height: 99999 });
    b.setTitleBarOverlay(null);
  });
  await page.waitForTimeout(300);
  expect(await mainOverlay(app)).toEqual(before);
});

test('classic style: strip reserved and draggable, activity bar + Files header drag, their buttons click', async ({ el }) => {
  const display = privateDisplay();
  await prepare(el, { sidebarStyle: 'classic' });
  const { app, page } = await el.launch([el.ws], display ? { env: { DISPLAY: display } } : {});
  await openTabs(page);
  expect((await wco(page)).visible).toBe(true);
  for (const sel of ['.se-topline', '.se-activity', '.se-panel-head']) expect(await region(page, sel), sel).toBe('drag');
  for (const sel of ['.se-activity-btn', '.se-classic-ws', '.se-panel-head .se-icon-btn', '.se-tab', '.se-mode']) expect(await region(page, sel), sel).toBe('no-drag');
  const w = await wco(page);
  const modes = await rect(page, '.se-modes');
  expect(modes.right).toBeLessThanOrEqual(w.rect!.x + w.rect!.width - 4);
  expect(await mainOverlay(app)).toEqual(await stripLook(page));
  // Classic was flush already: the card keeps no margin.
  expect((await rect(page, '.se-content')).y).toBe(0);
  const x = await realPointer(display);
  if (x) {
    try {
      const presses = await trackPresses(page);
      const btn = await rect(page, '.se-activity-btn[data-panel="search"]');
      await x.click(btn.x + btn.w / 2, btn.y + btn.h / 2);
      await expect.poll(() => page.evaluate(() => (window as any).__secEdit.sidebarPanel.value)).toBe('search');
      const spacer = await rect(page, '.se-activity-spacer');
      await presses();
      await x.click(spacer.x + spacer.w / 2, spacer.y + spacer.h / 2);
      expect(await presses()).toEqual([]);
    } finally {
      x.close();
    }
  }
});

test('windowFrame: native → the OS title bar and today’s layout', async ({ el }) => {
  for (const style of ['shelf', 'classic'] as const) {
    await prepare(el, { windowFrame: 'native', sidebarStyle: style });
    const { app, page } = await el.launch();
    await openTabs(page);
    expect(await app.evaluate(() => (globalThis as any).__secEditWindowOptions)).toEqual({ frame: 'native' });
    expect(await mainOverlay(app)).toBeNull();
    expect((await wco(page)).visible).toBe(false);
    expect(await page.evaluate(() => (window as any).secEditBridge.frame)).toBe('native');
    await expect(page.locator('.se-root')).not.toHaveClass(/frame-integrated/);
    expect(await page.locator('html').getAttribute('data-frame')).toBeNull();
    expect(await region(page, '.se-topline')).toBe('none');
    // Today's look: the shelf card floats with its 8px margin; nothing reserved at the strip's end.
    expect((await rect(page, '.se-content')).y).toBe(style === 'shelf' ? 8 : 0);
    expect(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).paddingRight)).toBe('0px');
    await app.close();
  }
});

test('Restart now: goes through the unsaved-changes flow, then comes back with the new frame', async ({ el }) => {
  await prepare(el, { autosave: false });
  const launch = () => el.launch([el.ws], { env: { SEC_EDIT_TEST_RELAUNCH: '1' } });
  const { app, page, stdout } = await launch();
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('restart-safe ');
  const notice = page.getByTestId('restart-notice');
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="windowFrame"] [data-value="native"]').click();
  await expect(notice).toBeVisible();
  // Back to what the window has → nothing to restart for.
  await page.locator('[data-setting="windowFrame"] [data-value="integrated"]').click();
  await expect(notice).toHaveCount(0);
  await page.locator('[data-setting="windowFrame"] [data-value="native"]').click();
  // Restart → the normal close flow asks about the unsaved note first; Cancel cancels the restart.
  await page.getByTestId('restart-now').click();
  const dlg = page.locator('.se-dialog');
  await expect(dlg).toContainText('Save changes');
  await dlg.locator('.se-btn', { hasText: 'Cancel' }).click();
  await expect(dlg).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(stdout.join('')).not.toContain('[sec-edit:relaunch]');
  // Second try: Save → the note is written, the setting is on disk, and the app relaunches.
  await page.keyboard.press('Control+,');
  await expect(notice).toBeVisible();
  const exited = new Promise<void>((r) => app.process().once('exit', () => r()));
  await page.getByTestId('restart-now').click();
  await dlg.locator('.se-btn', { hasText: 'Save' }).last().click();
  await exited;
  expect(stdout.join('')).toContain('[sec-edit:relaunch]');
  expect(await fsp.readFile(path.join(el.ws, 'README.md'), 'utf8')).toContain('restart-safe') // trailing space trimmed on save;
  expect(JSON.parse(await fsp.readFile(path.join(el.userData, 'settings.json'), 'utf8')).windowFrame).toBe('native');
  // The relaunched app (same profile) has the native frame.
  const next = await launch();
  expect(await next.page.evaluate(() => (window as any).secEditBridge.frame)).toBe('native');
  expect((await wco(next.page)).visible).toBe(false);
});
