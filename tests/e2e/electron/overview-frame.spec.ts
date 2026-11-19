// File overview (right column) with the integrated window frame: when it is open it holds the window's
// top-right corner, so the OS window controls sit over its top band. That band must drag the window,
// keep our content out from under the controls, and the controls must be painted in the colour under
// them (shelf: the backdrop; classic: the panel) — seamless, as over the tab strip when it is closed.
import { execFileSync, execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { connectXTest } from './xtest';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');
const hasImport = (() => {
  try {
    execFileSync('import', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Own X display per worker, so screen pixels belong to this test's window only. */
function privateDisplay(): string | null {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB) || !hasImport) return null;
  const d = `:${150 + test.info().parallelIndex}`;
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
/** Colour actually painted behind an element (first opaque background up the tree). */
const painted = (page: Page, sel: string) =>
  page.locator(sel).first().evaluate((el) => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return '';
  });

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: the open overview hosts the window controls — drag band, nothing underneath, seamless colour`, async ({ el }) => {
    const display = privateDisplay();
    await fsp.mkdir(el.userData, { recursive: true });
    await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ sidebarStyle: style, theme: 'dark' }));
    await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1100, height: 700 }));
    const { app, page } = await el.launch([el.ws], display ? { env: { DISPLAY: display } } : {});
    await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
    await expect(page.locator('.cm-content')).toContainText('Welcome');

    // Open it with the tab strip's button (no-drag, so it is clickable inside the title bar).
    expect(await region(page, '.se-ov-toggle')).toBe('no-drag');
    await page.locator('.se-ov-toggle').click();
    await expect(page.locator('.se-overview .se-ov-ol').first()).toBeVisible();

    const wco = await page.evaluate(() => (navigator as any).windowControlsOverlay.getTitlebarAreaRect().toJSON());
    const controlsX = wco.x + wco.width; // the OS controls start here
    const innerW = await page.evaluate(() => innerWidth);
    expect(controlsX).toBeLessThan(innerW);

    // The overview's top band is the title bar now: it drags, its sash and our buttons don't.
    expect(await region(page, '.se-overview .se-ov-head')).toBe('drag');
    expect(await region(page, '.se-overview > .se-sash')).toBe('no-drag');
    expect(await region(page, '.se-overview .se-ov-ol')).not.toBe('drag');
    // Nothing of ours under the controls: the file name ends left of them, the lists start below them.
    const name = await box(page, '.se-overview .se-ov-file');
    expect(name.right).toBeLessThanOrEqual(controlsX);
    const head = await box(page, '.se-overview .se-ov-head');
    const body = await box(page, '.se-overview .se-ov-body');
    expect(head.y).toBe(0);
    expect(head.height).toBeGreaterThanOrEqual(wco.height);
    expect(body.y).toBeGreaterThanOrEqual(wco.height);
    // The strip no longer reaches the controls, so it keeps no space free for them.
    expect(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).paddingRight)).toBe('0px');
    const card = await box(page, '.se-content');
    const col = await box(page, '.se-overview');
    expect(card.right).toBe(col.x);
    expect(col.right).toBe(innerW);

    // Controls painted in the colour under them…
    const under = hex(await painted(page, '.se-overview .se-ov-head'));
    await expect.poll(async () => (await mainOverlay(app))?.color).toBe(under);
    if (style === 'shelf') expect(under).toBe(hex(await painted(page, '.se-root')));
    // …and really on screen: the band left of the controls and the controls' own background match.
    if (display) {
      await page.waitForTimeout(300);
      expect(pixel(display, controlsX + 1, 1)).toBe(under);
      expect(pixel(display, controlsX - 3, 1)).toBe(under);
    }

    // Real pointer input (XTEST): a press on the band is the OS's (window move), the page never sees it;
    // the sash and the rows below still take theirs.
    const x = display ? await connectXTest(display).catch(() => null) : null;
    if (x) {
      try {
        await page.evaluate(() => {
          (window as any).__presses = [];
          addEventListener('pointerdown', (e) => (window as any).__presses.push(((e.target as Element).closest('[data-row]') ?? (e.target as Element).closest('[class]'))?.className ?? '?'), true);
        });
        const presses = () => page.evaluate(() => ((window as any).__presses as string[]).splice(0));
        await x.click(name.right + 4 < controlsX ? (name.right + controlsX) / 2 : name.x + 4, head.y + head.height / 2);
        expect(await presses()).toEqual([]);
        const row = await box(page, '.se-overview .se-ov-ol');
        await x.click(row.x + row.width / 2, row.y + row.height / 2);
        await expect.poll(() => page.evaluate(() => ((window as any).__presses as string[]).join())).toContain('se-ov-ol');
        await presses();
      } finally {
        x.close();
      }
    }

    // Closed again: the controls go back over the tab strip, in its colour.
    await page.keyboard.press('Control+Alt+b');
    await expect(page.locator('.se-overview')).toHaveCount(0);
    const strip = hex(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).backgroundColor));
    await expect.poll(async () => (await mainOverlay(app))?.color).toBe(strip);
    expect(parseFloat(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).paddingRight))).toBeGreaterThan(40);
  });
}
