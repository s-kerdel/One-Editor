// Zen mode in the desktop app. Full screen goes through main (main/zen-fullscreen.ts): leaving zen restores
// the window from before, a full screen the user already had stays, and the user leaving full screen keeps
// zen working. With the integrated window frame (Windows default, no OS title bar) and zen windowed, the tab
// strip still drags the window, nothing of ours sits under the window controls, and the strips / peeks click
// (no-drag) — also with real pointer input through the X server's hit-testing (drag regions swallow presses).
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { connectXTest } from './xtest';
import { appRegionReport } from '../frame-regions';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');

/** Own X display per worker: real input must not hit another test's window. */
function privateDisplay(): string | null {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB)) return null;
  const d = `:${170 + test.info().parallelIndex}`;
  execSync(`${XVFB} ${d}`, { stdio: 'ignore' });
  return d;
}
const hex = (c: string) => {
  const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c);
  return m ? '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('') : c.trim().toLowerCase();
};
const region = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (getComputedStyle(el) as any).webkitAppRegion as string);
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
const mainOverlay = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__secEditTitleBar ?? null);
const wco = (page: Page) => page.evaluate(() => (navigator as any).windowControlsOverlay.getTitlebarAreaRect().toJSON() as { x: number; y: number; width: number; height: number });
const win = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return { full: w.isFullScreen(), max: w.isMaximized(), bounds: w.getBounds() };
  });
const setFull = (app: ElectronApplication, on: boolean) => app.evaluate(({ BrowserWindow }, v) => BrowserWindow.getAllWindows()[0].setFullScreen(v), on);
const isZen = (page: Page) => page.evaluate(() => !!document.querySelector('.se-root.se-zen'));

async function setup(el: { userData: string }, settings: Record<string, unknown> = {}) {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ theme: 'dark', ...settings }));
  await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1100, height: 700 }));
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: windowed zen keeps the tab strip a drag band clear of the window controls; strips and peeks click (real pointer)`, async ({ el }) => {
    const display = privateDisplay();
    await setup(el, { sidebarStyle: style, 'zen.fullScreen': false });
    const { app, page } = await el.launch([el.ws], display ? { env: { DISPLAY: display } } : {});
    await expect(page.locator('.se-root.frame-integrated')).toBeVisible();
    await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
    await expect(page.locator('.cm-content')).toContainText('Welcome');
    await page.keyboard.press('Control+Alt+b'); // the overview gets its strip on the right, under the controls' corner
    await expect(page.locator('.se-overview')).toBeVisible();
    const stripHeight = (await mainOverlay(app))?.height;

    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-root.se-zen .se-zen-strip.right')).toBeVisible();
    expect((await win(app)).full).toBe(false);
    // The tab strip is still the title bar: it drags, its buttons do not; the strips are no drag area at all.
    expect(await region(page, '.se-topline')).toBe('drag');
    expect(await region(page, '.se-zen-strip.left')).toBe('none');
    expect(await region(page, '.se-tabbar [data-testid="zen-toggle"]')).toBe('no-drag');
    // Nothing of ours under the controls: the tab strip's last button ends left of them, the right strip's
    // button starts below them; the controls keep the strip's height and colour.
    const ctl = await wco(page);
    const controlsX = ctl.x + ctl.width;
    expect((await box(page, '.se-tabbar [data-testid="zen-toggle"]')).right).toBeLessThanOrEqual(controlsX - 4);
    expect((await box(page, '[data-testid="zen-strip-overview"]')).top).toBeGreaterThanOrEqual(ctl.height);
    expect((await mainOverlay(app))?.height).toBe(stripHeight);
    const strip = hex(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).backgroundColor));
    await expect.poll(async () => (await mainOverlay(app))?.color).toBe(strip);

    // Both peeks open: every point agrees with what is shown (no click stolen by the strip's drag region).
    await page.locator('.se-zen-strip.left [data-panel="files"]').click();
    await page.getByTestId('zen-strip-overview').click();
    await expect(page.locator('.se-sidebar.se-zen-peek')).toBeVisible();
    await expect(page.locator('.se-overview.se-zen-peek')).toBeVisible();
    const report = await appRegionReport(page);
    expect(report.regions.drag).toBeGreaterThan(0);
    expect(report.mismatches).toEqual([]);
    expect(report.leaks).toEqual([]);
    await page.locator('.cm-content').click();
    await expect(page.locator('.se-zen-peek')).toHaveCount(0);

    const x = display ? await connectXTest(display).catch(() => null) : null;
    if (x) {
      try {
        const center = async (sel: string) => {
          const b = await box(page, sel);
          return [b.x + b.width / 2, b.y + b.height / 2] as const;
        };
        await page.evaluate(() => {
          (window as any).__presses = [];
          addEventListener('pointerdown', (e) => (window as any).__presses.push((e.target as Element).closest('.se-zen-peek') ? 'peek' : 'page'), true);
        });
        const presses = () => page.evaluate(() => ((window as any).__presses as string[]).splice(0));
        // The empty end of the tab strip is the OS's (window move): the page never sees the press.
        const tab = await box(page, '.se-tab');
        const bar = await box(page, '.se-topline');
        await x.click(tab.right + 60, bar.y + bar.height / 2);
        expect(await presses()).toEqual([]);
        // The peek lies over the tab strip's band: a press there is the peek's, not a window move.
        await x.click(...(await center('.se-zen-strip.left [data-panel="files"]')));
        await expect(page.locator('.se-sidebar.se-zen-peek')).toBeVisible();
        const peek = await box(page, '.se-sidebar.se-zen-peek');
        await presses();
        await x.click(peek.right - 16, peek.y + 5);
        expect(await presses()).toEqual(['peek']);
        await expect(page.locator('.se-sidebar.se-zen-peek')).toBeVisible();
        // Back in the text folds it; the corner toggle leaves zen.
        await x.click(...(await center('.cm-content')));
        await expect(page.locator('.se-zen-peek')).toHaveCount(0);
        await x.click(...(await center('.se-zen-strip.left [data-testid="zen-toggle"]')));
        await expect.poll(() => isZen(page)).toBe(false);
      } finally {
        x.close();
      }
    } else {
      await page.locator('.se-zen-strip.left [data-testid="zen-toggle"]').click();
      await expect.poll(() => isZen(page)).toBe(false);
    }
    await expect(page.locator('.se-overview')).toBeVisible();
    await expect.poll(async () => (await mainOverlay(app))?.color).not.toBe(undefined);
  });
}

test('full screen: zen enters it and gives the window back; a full screen the user had stays; the user leaving it keeps zen', async ({ el }) => {
  await setup(el);
  const { app, page } = await el.launch([el.ws]);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  const before = await win(app);
  expect(before.full).toBe(false);

  await page.keyboard.press('Control+Alt+z');
  await expect.poll(async () => (await win(app)).full).toBe(true);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(async () => (await win(app)).full).toBe(false);
  await expect.poll(async () => (await win(app)).bounds).toEqual(before.bounds);

  // The user's own full screen (F11-like, the OS): zen ends without leaving it.
  await setFull(app, true);
  await expect.poll(async () => (await win(app)).full).toBe(true);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(true);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(false);
  await page.waitForTimeout(300);
  expect((await win(app)).full).toBe(true);
  await setFull(app, false);
  await expect.poll(async () => (await win(app)).full).toBe(false);

  // Zen's full screen left from outside: zen stays and works (strips, peek), leaving zen does not re-enter.
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(async () => (await win(app)).full).toBe(true);
  await setFull(app, false);
  await expect.poll(async () => (await win(app)).full).toBe(false);
  expect(await isZen(page)).toBe(true);
  await page.locator('.se-zen-strip.left [data-panel="files"]').click();
  await expect(page.locator('.se-zen-peek .se-tree-row').first()).toBeVisible();
  await expect(page.locator('.se-tabbar')).toBeVisible();
  await page.locator('.se-tabbar [data-testid="zen-toggle"]').click();
  await expect.poll(() => isZen(page)).toBe(false);
  await page.waitForTimeout(300);
  expect((await win(app)).full).toBe(false);
  await expect(page.locator('.se-sidebar:not(.se-zen-peek)')).toBeVisible();
});

test('zen survives a restart, before first paint, and goes full screen again; window-state keeps the size from before', async ({ el }) => {
  await setup(el);
  let { app, page } = await el.launch([el.ws]);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen')).toBeVisible();
  await expect.poll(async () => (await win(app)).full).toBe(true);
  await page.waitForTimeout(800); // the session + window-state saves (debounced)
  await app.close();
  const saved = JSON.parse(await fsp.readFile(path.join(el.userData, 'window-state.json'), 'utf8'));
  expect(saved).toMatchObject({ width: 1100, height: 700, maximized: false }); // zen's full screen is not "maximized"

  ({ app, page } = await el.launch([el.ws]));
  // theme-boot.js marked the skeleton before the app rendered; the first frame is zen with its strip.
  expect(await page.evaluate(() => document.documentElement.dataset.zen)).toBe('on');
  await expect(page.locator('.se-root.se-zen .se-zen-strip.left')).toBeVisible();
  await expect.poll(async () => (await win(app)).full).toBe(true);
  expect(await region(page, '.se-topline')).toBe('drag');
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-sidebar')).toBeVisible();
  await expect.poll(async () => (await win(app)).full).toBe(false);
  expect((await win(app)).bounds).toMatchObject({ width: 1100, height: 700 });
});
