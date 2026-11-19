// Refresh must be visually stable: the static skeleton matches the real UI (colour + geometry), and
// once the UI is in, nothing in the sidebar moves (no lazy parts popping in a frame later).
import { test, expect } from './harness';
import type { Page } from '@playwright/test';

const KEY = ['.se-activity', '.se-sidebar', '.se-content', '.se-shelf-head', '.se-jump', '.se-nav', '.se-panel-head', '.se-filter', '.se-tree', '.se-tree-row', '.se-shelf-foot', '.se-tabbar', '.se-status', '.se-overview', '.se-ov-head', '.se-ov-body'];

async function bootWithStyle(page: Page, ws: any, style: 'shelf' | 'classic', overview = false) {
  await ws.server.service.saveSettings({ sidebarStyle: style });
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await expect(page.locator('.cm-content')).toContainText('Daily notes');
  if (overview) {
    await page.keyboard.press('Control+Alt+b'); // file overview column, saved with the session
    await expect(page.locator('.se-overview .se-ov-ol').first()).toBeVisible();
  }
  await page.waitForTimeout(300); // session + localStorage hints (theme, style, sidebar width) written
}

for (const style of ['shelf', 'classic'] as const) for (const ov of [false, true]) {
  const name = `${style}${ov ? ' + file overview' : ''}`;
  test(`${name}: skeleton backdrop and card match the real UI`, async ({ page, ws }) => {
    await bootWithStyle(page, ws, style, ov);
    // Hold the app bundle so the skeleton stays on screen.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      await gate;
      await route.continue();
    });
    const nav = page.reload();
    await page.waitForSelector('.sk-main', { state: 'attached' });
    const skel = await page.evaluate(() => {
      const r = document.querySelector('.sk-main')!.getBoundingClientRect();
      const o = document.querySelector('.sk-ov')!.getBoundingClientRect();
      return { bg: getComputedStyle(document.body).backgroundColor, card: [r.x, r.y, r.width, r.height], ov: o.width ? [o.x, o.y, o.width, o.height] : null };
    });
    release();
    await nav;
    await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
    const real = await page.evaluate(() => {
      const r = document.querySelector('.se-content')!.getBoundingClientRect();
      const o = document.querySelector('.se-overview')?.getBoundingClientRect();
      return { bg: getComputedStyle(document.querySelector('.se-root')!).backgroundColor, card: [r.x, r.y, r.width, r.height], ov: o ? [o.x, o.y, o.width, o.height] : null };
    });
    expect(real.bg).toBe(skel.bg);
    // The file overview column: in the skeleton exactly where (and as wide as) it is drawn — or in neither.
    if (ov) expect(real.ov!.slice(0, 3)).toEqual(skel.ov!.slice(0, 3));
    else expect([real.ov, skel.ov]).toEqual([null, null]);
    // classic: the skeleton has a separate status-bar row; the real content area ends above it
    expect(real.card.slice(0, 3)).toEqual(skel.card.slice(0, 3));
    expect(Math.abs(real.card[3] - skel.card[3]) <= (style === 'classic' ? 24 : 0)).toBe(true);
  });

  test(`${name}: nothing in the sidebar moves after the first real frame`, async ({ page, ws }) => {
    await bootWithStyle(page, ws, style, ov);
    await page.addInitScript((sel: string[]) => {
      const frames: Record<string, string>[] = [];
      const t0 = performance.now();
      const tick = () => {
        if (document.querySelector('.se-root')) {
          const snap: Record<string, string> = {};
          for (const s of sel) {
            const el = document.querySelector(s);
            if (el) {
              const r = el.getBoundingClientRect();
              snap[s] = `${r.x},${r.y},${r.width},${r.height}`;
            }
          }
          frames.push(snap);
        }
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as any).__frames = frames;
    }, KEY);
    await page.reload();
    await page.waitForTimeout(1700);
    const frames: Record<string, string>[] = await page.evaluate(() => (window as any).__frames);
    expect(frames.length).toBeGreaterThan(5);
    const first = frames[0];
    // Everything the style shows is present in the very first frame…
    for (const s of [...(style === 'classic' ? ['.se-activity', '.se-panel-head', '.se-filter'] : ['.se-shelf-head', '.se-jump', '.se-nav', '.se-shelf-foot']), ...(ov ? ['.se-overview', '.se-ov-head', '.se-ov-body'] : [])]) {
      expect(first[s], `${s} missing in the first frame`).toBeTruthy();
    }
    // …and never moves or resizes afterwards.
    const moved = frames.flatMap((f, i) => Object.keys(first).filter((k) => f[k] !== first[k]).map((k) => `frame ${i}: ${k} ${first[k]} → ${f[k]}`));
    expect(moved).toEqual([]);
  });
}
