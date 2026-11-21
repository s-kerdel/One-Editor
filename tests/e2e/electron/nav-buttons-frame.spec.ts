// Back / forward buttons (nav/buttons.tsx) with the integrated window frame (desktop default: the tab strip
// is the title bar). The buttons sit at the status bar's far left (← → │ folder · crumbs), not in the strip:
// the strip is just the tabs again (the show-sidebar cell first while the shelf is hidden). A real press
// through the X server's hit-testing reaches them, the right-click list opens upwards inside the window,
// and the strip's empty end still drags.
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
const strip = (page: Page) => page.locator('.se-topline').evaluate((e) => [...e.children].map((c) => c.classList[0]));
const BACK = '.se-status .se-navbtns [aria-label="Go back"]';
const FWD = '.se-status .se-navbtns [aria-label="Go forward"]';

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: back / forward sit at the status bar's left, before a rule; the strip has none; real clicks and an upward list`, async ({ el }) => {
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
    await expect(page.locator(BACK)).toHaveAttribute('aria-disabled', 'false');

    // Far left of the status bar (classic: the window-wide one), then the rule, then the folder button.
    if (style === 'classic') await expect(page.locator('.se-root > .se-status .se-navbtns')).toBeVisible();
    const g = await page.locator('.se-status').evaluate((bar) => {
      const r = (e: Element) => e.getBoundingClientRect().toJSON() as DOMRect;
      const nav = bar.querySelector('.se-navbtns')!;
      return {
        first: bar.firstElementChild!.className,
        bar: r(bar),
        nav: r(nav),
        f: r(nav.querySelector('[aria-label="Go forward"]')!),
        folder: r(bar.querySelector('.se-status-ws')!),
        rule: getComputedStyle(nav, '::after').width,
        winH: innerHeight,
      };
    });
    expect(g.first).toBe('se-navbtns');
    expect(g.nav.x - g.bar.x).toBeLessThanOrEqual(8);
    expect(g.rule).toBe('1px');
    expect(g.nav.right - g.f.right).toBeGreaterThanOrEqual(5);
    expect(g.folder.x).toBeGreaterThanOrEqual(g.nav.right);
    expect(g.bar.bottom).toBeLessThanOrEqual(g.winH);
    // The strip is the tabs (and the show-sidebar cell): nothing reserved for arrows. It still drags.
    expect(await strip(page)).toEqual(['se-tabbar']);
    expect(await region(page, '.se-topline')).toBe('drag');
    // Every point agrees with what is shown — sidebar shown (its sash overlaps the card's edge) and hidden.
    for (const sidebar of [true, false]) {
      if (!sidebar) await page.keyboard.press('Control+Shift+b');
      await expect(page.locator('.se-sidebar')).toHaveCount(sidebar ? 1 : 0);
      const r = await appRegionReport(page);
      expect(r.regions.drag, `sidebar ${sidebar}`).toBeGreaterThan(0);
      expect(r.mismatches, `sidebar ${sidebar}`).toEqual([]);
      expect(r.leaks, `sidebar ${sidebar}`).toEqual([]);
    }
    expect(await strip(page)).toEqual(style === 'shelf' ? ['se-shelf-reveal', 'se-tabbar'] : ['se-tabbar']);
    if (style === 'shelf') expect(Math.abs((await box(page, '.se-shelf-reveal')).right - (await box(page, '.se-tabbar')).x)).toBeLessThan(0.5);
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
      await x!.click(...(await at(BACK)));
      await expect.poll(() => active(page)).toBe('README.md');
      expect(await presses()).toEqual(['nav']);
      await expect(page.locator(FWD)).toHaveAttribute('aria-disabled', 'false');
      await x!.click(...(await at(FWD)));
      await expect.poll(() => active(page)).toBe('notes/kubernetes.md');
      expect(await presses()).toEqual(['nav']);
      // Right-click (X button 3) lists the places upwards: over the button, inside the window.
      const [bx, by] = await at(BACK);
      await x!.move(bx, by);
      await x!.down(3);
      await x!.up(3);
      await expect(page.locator('.se-menu[role="menu"]')).toBeVisible();
      const [btn, m] = [await box(page, BACK), await box(page, '.se-menu')];
      expect(m.bottom).toBeLessThanOrEqual(btn.y);
      expect(m.y).toBeGreaterThanOrEqual(0);
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
