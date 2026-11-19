// Launch must be visually stable in the real window too, with the integrated frame (no OS title bar):
// the window colour = the first paint, the static skeleton already has the integrated layout (card in
// the top-right corner), and once the UI is in, nothing moves. Browser-mode twin: ../launch-stability.spec.ts.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

const KEY = ['.se-activity', '.se-sidebar', '.se-content', '.se-shelf-head', '.se-jump', '.se-nav', '.se-panel-head', '.se-filter', '.se-tree', '.se-tree-row', '.se-shelf-foot', '.se-tabbar', '.se-status', '.se-overview', '.se-ov-head'];

for (const style of ['shelf', 'classic'] as const) for (const ov of [false, true]) {
  // With the file overview open (Ctrl+Alt+B) the right column holds the window's top-right corner:
  // the strip ends at the card and the controls sit over the overview's top band instead.
  test(`${style}${ov ? ' + file overview' : ''} + integrated frame: skeleton = real layout, window colour = first paint, nothing moves`, async ({ el }) => {
    await fsp.mkdir(el.userData, { recursive: true });
    await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ sidebarStyle: style }));
    const { app, page } = await el.launch();
    await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
    await expect(page.locator('.cm-content')).toContainText('Daily notes');
    if (ov) {
      await page.keyboard.press('Control+Alt+b');
      await expect(page.locator('.se-overview .se-ov-ol').first()).toBeVisible();
    }
    await page.waitForTimeout(300); // session + localStorage hints (theme, style, sidebar width) written
    expect(await page.evaluate(() => (window as any).secEditBridge.frame)).toBe('integrated');

    await page.addInitScript((sel: string[]) => {
      const w = window as any;
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      };
      // The skeleton is on screen until boot() has its backend round-trip, i.e. well after DOMContentLoaded.
      document.addEventListener('DOMContentLoaded', () => {
        const ovBox = box(document.querySelector('.sk-ov'));
        w.__skel = { card: box(document.querySelector('.sk-main')), ov: ovBox && ovBox[2] ? ovBox : null, bg: getComputedStyle(document.body).backgroundColor, frame: document.documentElement.dataset.frame };
      });
      const frames: Record<string, string>[] = [];
      const t0 = performance.now();
      const tick = () => {
        if (document.querySelector('.se-root')) {
          const snap: Record<string, string> = {};
          for (const s of sel) {
            const b = box(document.querySelector(s));
            if (b) snap[s] = b.join(',');
          }
          // Space kept free for the window controls: there from the first frame, never changing.
          const bar = document.querySelector('.se-tabbar');
          if (bar) snap['controls reserve'] = getComputedStyle(bar).paddingRight;
          const ovHead = document.querySelector('.se-overview .se-ov-head');
          if (ovHead) snap['overview controls reserve'] = getComputedStyle(ovHead).paddingRight;
          frames.push(snap);
        }
        if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      w.__frames = frames;
    }, KEY);
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
    await page.waitForTimeout(1700);

    const skel = await page.evaluate(() => (window as any).__skel);
    const real = await page.evaluate(() => {
      const r = document.querySelector('.se-content')!.getBoundingClientRect();
      const o = document.querySelector('.se-overview')?.getBoundingClientRect();
      return { card: [r.x, r.y, r.width, r.height], ov: o ? [o.x, o.y, o.width, o.height] : null, bg: getComputedStyle(document.querySelector('.se-root')!).backgroundColor, innerW: innerWidth };
    });
    expect(skel.frame).toBe('integrated');
    // Skeleton card = real card (shelf: flush with the window's top + right edge).
    expect(real.card.slice(0, 3)).toEqual(skel.card.slice(0, 3));
    expect(Math.abs(real.card[3] - skel.card[3]) <= (style === 'classic' ? 24 : 0)).toBe(true);
    expect(real.card[1]).toBe(0);
    if (!ov) {
      expect(real.card[0] + real.card[2]).toBe(real.innerW);
      expect([real.ov, skel.ov]).toEqual([null, null]);
    } else {
      // card | overview, the overview flush with the window's top-right corner — in the skeleton too
      expect(real.ov!.slice(0, 3)).toEqual(skel.ov!.slice(0, 3));
      expect(real.ov![1]).toBe(0);
      expect(real.ov![0] + real.ov![2]).toBe(real.innerW);
      expect(real.card[0] + real.card[2]).toBe(real.ov![0]);
    }
    // Window backgroundColor (shown before any paint) = the page backdrop = the skeleton backdrop.
    expect(real.bg).toBe(skel.bg);
    const winBg = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
    const hex = (rgb: string) => '#' + rgb.match(/\d+/g)!.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('');
    expect(winBg.toLowerCase()).toBe(hex(real.bg));

    const frames: Record<string, string>[] = await page.evaluate(() => (window as any).__frames);
    expect(frames.length).toBeGreaterThan(5);
    const first = frames[0];
    if (ov) {
      // The strip no longer reaches the controls; the overview's top band keeps them free instead.
      expect(parseFloat(first['controls reserve'])).toBe(0);
      expect(parseFloat(first['overview controls reserve'])).toBeGreaterThan(40);
      // …and the OS paints the controls in the colour of what is under them.
      const tb = await app.evaluate(() => (globalThis as any).__secEditTitleBar ?? null);
      const under = await page.evaluate(() => {
        for (let e: Element | null = document.querySelector('.se-overview .se-ov-head'); e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
        }
        return '';
      });
      expect(tb?.color).toBe(hex(under));
    } else expect(parseFloat(first['controls reserve'])).toBeGreaterThan(40);
    for (const s of [...(style === 'classic' ? ['.se-activity', '.se-panel-head', '.se-filter', '.se-tabbar'] : ['.se-shelf-head', '.se-jump', '.se-nav', '.se-shelf-foot', '.se-tabbar']), ...(ov ? ['.se-overview', '.se-ov-head'] : [])]) {
      expect(first[s], `${s} missing in the first frame`).toBeTruthy();
    }
    const moved = frames.flatMap((f, i) => Object.keys(first).filter((k) => f[k] !== first[k]).map((k) => `frame ${i}: ${k} ${first[k]} → ${f[k]}`));
    expect(moved).toEqual([]);
  });
}
