// Zen mode with the integrated window frame (Windows default, no OS title bar): the tab strip is gone,
// so its empty band must still drag the window, keep the OS window controls free (`--wco-right`), keep
// them in the colour under them at the same height, and "Exit zen" must click (no-drag) — also with
// real pointer input through the X server's hit-testing (drag regions swallow presses).
import { execFileSync, execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { connectXTest } from './xtest';
import { appRegionReport } from '../frame-regions';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');
const hasImport = (() => {
  try {
    execFileSync('import', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Own X display per worker: real input + screen pixels must not hit another test's window. */
function privateDisplay(): string | null {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB)) return null;
  const d = `:${170 + test.info().parallelIndex}`;
  execSync(`${XVFB} ${d}`, { stdio: 'ignore' });
  return d;
}
const pixel = (display: string, x: number, y: number) => {
  const out = execFileSync('import', ['-display', display, '-window', 'root', '-crop', `1x1+${Math.round(x)}+${Math.round(y)}`, 'txt:-'], { encoding: 'utf8' });
  return ('#' + (/#([0-9A-F]{6})/i.exec(out)?.[1] ?? '')).toLowerCase();
};
const hex = (c: string) => {
  const m = /rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(c);
  return m ? '#' + m.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('') : c.trim().toLowerCase();
};
const region = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (getComputedStyle(el) as any).webkitAppRegion as string);
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
const mainOverlay = (app: ElectronApplication) => app.evaluate(() => (globalThis as any).__secEditTitleBar ?? null);
const wco = (page: Page) => page.evaluate(() => (navigator as any).windowControlsOverlay.getTitlebarAreaRect().toJSON() as { x: number; y: number; width: number; height: number });
const painted = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return '';
  });

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: zen keeps a drag band clear of the window controls; Exit zen clicks; real pointer input`, async ({ el }) => {
    const display = privateDisplay();
    await fsp.mkdir(el.userData, { recursive: true });
    await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ sidebarStyle: style, theme: 'dark' }));
    await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1100, height: 700 }));
    const { app, page } = await el.launch([el.ws], display ? { env: { DISPLAY: display } } : {});
    await expect(page.locator('.se-root.frame-integrated')).toBeVisible();
    await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
    await expect(page.locator('.cm-content')).toContainText('Welcome');
    const stripHeight = (await mainOverlay(app))?.height;
    expect(stripHeight).toBeGreaterThan(20);

    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-root.se-zen .se-zen-bar')).toBeVisible();
    await expect(page.locator('.se-tabbar')).toHaveCount(0);

    // The band is the title bar now: it drags, "Exit zen" does not; the window really has drag regions
    // and every point agrees with what is shown there.
    expect(await region(page, '.se-topline')).toBe('drag');
    expect(await region(page, '.se-zen-exit')).toBe('no-drag');
    const report = await appRegionReport(page);
    expect(report.regions.drag).toBeGreaterThan(0);
    expect(report.mismatches).toEqual([]);
    expect(report.leaks).toEqual([]);

    // Nothing of ours under the controls: the exit control ends left of them, the text starts below them.
    const ctl = await wco(page);
    const controlsX = ctl.x + ctl.width;
    const exit = await box(page, '.se-zen-exit');
    expect(exit.right).toBeLessThanOrEqual(controlsX - 4);
    const bar = await box(page, '.se-topline');
    expect(bar.y).toBe(0);
    expect(bar.height).toBeGreaterThanOrEqual(ctl.height);
    expect((await box(page, '.se-editor-area')).y).toBeGreaterThanOrEqual(ctl.height);
    // Same height as with the tab strip (the controls keep their size), painted like the band.
    const under = hex(await painted(page, '.se-zen-bar'));
    expect(under).toBe(hex(await painted(page, '.se-editor-area')));
    await expect.poll(async () => (await mainOverlay(app))?.color).toBe(under);
    expect((await mainOverlay(app))?.height).toBe(stripHeight);
    if (display && hasImport) {
      await page.waitForTimeout(300);
      expect(pixel(display, controlsX + 1, 2)).toBe(under);
      expect(pixel(display, controlsX - 3, 2)).toBe(under);
    }

    const x = display ? await connectXTest(display).catch(() => null) : null;
    if (x) {
      try {
        await page.evaluate(() => {
          (window as any).__presses = [];
          addEventListener('pointerdown', (e) => (window as any).__presses.push((e.target as Element).closest('[class]')?.className ?? '?'), true);
        });
        const presses = () => page.evaluate(() => ((window as any).__presses as string[]).splice(0));
        // A press on the empty band is the OS's (window move): the page never sees it.
        await x.click(bar.x + 200, bar.y + bar.height / 2);
        expect(await presses()).toEqual([]);
        // Hover reveals "Exit zen"; a real click reaches it and leaves zen.
        await x.move(exit.x + exit.width / 2, exit.y + exit.height / 2);
        await expect(page.getByTestId('zen-exit')).toHaveCSS('opacity', '1');
        await x.click(exit.x + exit.width / 2, exit.y + exit.height / 2);
        await expect(page.locator('.se-root.se-zen')).toHaveCount(0);
      } finally {
        x.close();
      }
    } else {
      await page.getByTestId('zen-exit').click();
      await expect(page.locator('.se-root.se-zen')).toHaveCount(0);
    }
    // Back to the tab strip: controls over it again, in its colour.
    await expect(page.locator('.se-tabbar')).toBeVisible();
    const strip = hex(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).backgroundColor));
    await expect.poll(async () => (await mainOverlay(app))?.color).toBe(strip);
  });
}

test('zen survives a restart in the desktop app, before first paint', async ({ el }) => {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1100, height: 700 }));
  let { app, page } = await el.launch([el.ws]);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen')).toBeVisible();
  await page.waitForTimeout(600); // the session save (debounced)
  await app.close();
  ({ app, page } = await el.launch([el.ws]));
  // theme-boot.js marked the skeleton before the app rendered; the first frame is zen.
  expect(await page.evaluate(() => document.documentElement.dataset.zen)).toBe('on');
  await expect(page.locator('.se-root.se-zen .se-zen-bar')).toBeVisible();
  expect(await region(page, '.se-topline')).toBe('drag');
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-tabbar')).toBeVisible();
  await expect(page.locator('.se-sidebar')).toBeVisible();
});
