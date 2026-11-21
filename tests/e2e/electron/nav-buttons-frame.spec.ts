// Back / forward buttons (nav/buttons.tsx) with the integrated window frame (desktop default: the tab strip
// is the title bar). The buttons sit at the strip's start, far from the window controls, and are no-drag
// as a whole cell (its padding would otherwise cover the sidebar sash's edge); a real press through the
// X server's hit-testing reaches them (drag regions swallow presses), and the strip's empty end still drags.
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { Page } from '@playwright/test';
import { test, expect, fs, path, type ElectronFixture } from './fixture';
import { connectXTest } from './xtest';
import { appRegionReport } from '../frame-regions';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');

/** Own X display per worker: real input must not hit another test's window. */
function privateDisplay(): string | null {
  if (process.platform !== 'linux' || !fs.existsSync(XVFB)) return null;
  const d = `:${195 + test.info().parallelIndex}`;
  execSync(`${XVFB} ${d}`, { stdio: 'ignore' });
  return d;
}

async function prepare(el: ElectronFixture, settings: Record<string, unknown>) {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ theme: 'dark', ...settings }));
  await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1200, height: 700 }));
}

const region = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => (getComputedStyle(el) as any).webkitAppRegion as string);
const box = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
const active = (page: Page) => page.evaluate(() => (window as any).__secEdit.activePath.value as string);

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: back / forward are clickable no-drag cells at the strip's start, clear of the window controls`, async ({ el }) => {
    const display = privateDisplay();
    await prepare(el, { sidebarStyle: style });
    const { page } = await el.launch([el.ws], display ? { env: { DISPLAY: display } } : {});
    await expect(page.locator('.se-root.frame-integrated')).toBeVisible();
    await page.waitForFunction(() => !!(window as any).__secEditNav);
    for (const f of ['README.md', 'notes/kubernetes.md']) {
      await page.evaluate((f) => (window as any).__secEdit.openFile(f), f);
      await expect.poll(() => active(page)).toBe(f);
      await page.waitForTimeout(450); // not one coalesced navigation
    }
    await expect(page.locator('.se-navbtns [aria-label="Go back"]')).toHaveAttribute('aria-disabled', 'false');

    // The strip still drags; the whole cell and both buttons do not.
    expect(await region(page, '.se-topline')).toBe('drag');
    for (const sel of ['.se-navbtns', '.se-navbtns [aria-label="Go back"]', '.se-navbtns [aria-label="Go forward"]']) expect(await region(page, sel), sel).toBe('no-drag');
    // At the strip's start, nowhere near the controls (they start at the WCO rect's right end).
    const wco = await page.evaluate(() => (navigator as any).windowControlsOverlay.getTitlebarAreaRect().toJSON() as DOMRect);
    const nav = await box(page, '.se-navbtns');
    const card = await box(page, '.se-content');
    expect(nav.x - card.x).toBeLessThanOrEqual(1);
    expect(nav.right).toBeLessThan(wco.x + wco.width - 200);
    // Every point agrees with what is shown — sidebar shown (its sash overlaps the card's edge) and hidden.
    for (const sidebar of [true, false]) {
      if (!sidebar) await page.keyboard.press('Control+Shift+b');
      await expect(page.locator('.se-sidebar')).toHaveCount(sidebar ? 1 : 0);
      const r = await appRegionReport(page);
      expect(r.regions.drag, `sidebar ${sidebar}`).toBeGreaterThan(0);
      expect(r.mismatches, `sidebar ${sidebar}`).toEqual([]);
      expect(r.leaks, `sidebar ${sidebar}`).toEqual([]);
    }
    if (style === 'shelf') expect(await page.locator('.se-topline').evaluate((e) => [...e.children].map((c) => c.classList[0]))).toEqual(['se-shelf-reveal', 'se-navbtns', 'se-tabbar']);
    await page.keyboard.press('Control+Shift+b');

    // Real pointer input: presses on the buttons reach the page and step; the strip's empty end drags.
    const x = display ? await connectXTest(display).catch(() => null) : null;
    test.skip(!x, 'needs the sudo-free Xvfb + XTEST (Linux)');
    try {
      await page.evaluate(() => {
        (window as any).__presses = [];
        addEventListener('pointerdown', (e) => (window as any).__presses.push((e.target as Element).closest('.se-navbtns') ? 'nav' : 'page'), true);
      });
      const presses = () => page.evaluate(() => ((window as any).__presses as string[]).splice(0));
      const at = async (sel: string) => {
        const b = await box(page, sel);
        return [b.x + b.width / 2, b.y + b.height / 2] as const;
      };
      await x!.click(...(await at('.se-navbtns [aria-label="Go back"]')));
      await expect.poll(() => active(page)).toBe('README.md');
      expect(await presses()).toEqual(['nav']);
      await expect(page.locator('.se-navbtns [aria-label="Go forward"]')).toHaveAttribute('aria-disabled', 'false');
      await x!.click(...(await at('.se-navbtns [aria-label="Go forward"]')));
      await expect.poll(() => active(page)).toBe('notes/kubernetes.md');
      expect(await presses()).toEqual(['nav']);
      // The cell's padding is ours too, not a window move: right of the forward button, and at its left
      // edge (where the sidebar's resize sash overlaps the card and takes the press).
      const cell = await box(page, '.se-navbtns');
      const f = await box(page, '.se-navbtns [aria-label="Go forward"]');
      await x!.click(f.right + 1, cell.y + cell.height / 2);
      expect(await presses()).toEqual(['nav']);
      await x!.click(cell.x + 1.5, cell.y + cell.height / 2);
      expect(await presses()).toHaveLength(1);
      // Right-click (X button 3) lists the places; the menu over the strip takes its clicks.
      const [bx, by] = await at('.se-navbtns [aria-label="Go back"]');
      await x!.move(bx, by);
      await x!.down(3);
      await x!.up(3);
      await expect(page.locator('.se-menu[role="menu"]')).toBeVisible();
      await x!.click(...(await at('.se-menu .se-menu-item')));
      await expect.poll(() => active(page)).toBe('README.md');
      await presses();
      // Empty strip end: the OS takes the press.
      const end = await box(page, '.se-tabs-end');
      expect(end.width).toBeGreaterThan(40);
      await x!.click(end.x + end.width / 2, end.y + end.height / 2);
      expect(await presses()).toEqual([]);
    } finally {
      x?.close();
    }
  });
}
