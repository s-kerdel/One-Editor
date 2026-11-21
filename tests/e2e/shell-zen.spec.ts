// Zen mode (View: Toggle zen mode, Ctrl+Alt+Z; app/zen.tsx): full screen, tabs stay, the sidebar and the
// file overview (if it was open) fold into strips; a strip click / a panel shortcut shows the panel as a
// peek over the text that closes when you go back to the editor; status bar optional; leaving restores the
// layout from before; it survives a reload with the skeleton and the first frame already in zen.
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';
import { appRegionReport, forceIntegratedFrame } from './frame-regions';

const isZen = (page: Page) => page.evaluate(() => document.querySelector('.se-root')!.classList.contains('se-zen'));
const full = (page: Page) => page.evaluate(() => !!document.fullscreenElement);
const layout = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__secEdit;
    const w = document.querySelector('.se-sidebar')?.getBoundingClientRect().width ?? 0;
    return { sidebar: s.sidebarVisible.value, panel: s.sidebarPanel.value, width: Math.round(w), overview: !!document.querySelector('.se-overview'), terminal: !!document.querySelector('[data-testid="terminal-panel"]'), tabs: !!document.querySelector('.se-tabbar'), status: !!document.querySelector('.se-status') };
  });
const textX = (page: Page) => page.locator('.cm-content').evaluate((e) => Math.round(e.getBoundingClientRect().x));

async function openNote(page: Page, ws: WsFixture) {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await expect(page.locator('.cm-content')).toBeVisible();
}

async function runFromPalette(page: Page, query: string) {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('.se-palette-input')).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.locator('.se-palette-list [aria-selected="true"]')).toContainText(query, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

async function setStyle(page: Page, style: 'shelf' | 'classic') {
  if (style === 'shelf') return;
  await page.keyboard.press('Control+,');
  await page.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-root.ui-classic .se-activity')).toBeVisible();
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: the corner button enters zen (full screen, tabs, strips); peeks; leaving restores the layout`, async ({ page, ws }) => {
    await openNote(page, ws);
    await setStyle(page, style);
    // A layout worth restoring: Search panel, file overview and the bottom panel open.
    await page.keyboard.press('Control+Shift+f');
    await expect(page.locator('.se-sidebar[data-panel="search"]')).toBeVisible();
    await page.keyboard.press('Control+Alt+b');
    await page.keyboard.press('Control+`');
    await expect(page.locator('.se-overview')).toBeVisible();
    await expect(page.locator('[data-testid="terminal-panel"]')).toBeVisible();
    await page.evaluate(() => (window as any).__secEdit.editor.focus());
    const before = await layout(page);

    // The zen toggle sits in the bottom-left corner: shelf foot / classic icon bar, with the shortcut.
    const corner = page.locator(style === 'shelf' ? '.se-shelf-foot [data-testid="zen-toggle"]' : '.se-activity [data-testid="zen-toggle"]');
    await expect(corner).toHaveAttribute('title', 'Zen mode (Ctrl+Alt+Z)');
    if (style === 'shelf') expect(await page.locator('.se-shelf-foot > *').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim()))).toEqual(['New note', 'Zen mode', 'Toggle theme', 'Settings']);
    await corner.click();
    await expect(page.locator('.se-root.se-zen')).toBeVisible();
    await expect.poll(() => full(page)).toBe(true);
    // Tabs stay; sidebar + overview are strips; terminal, status bar and classic's icon bar are gone.
    await expect(page.locator('.se-tabbar')).toBeVisible();
    for (const sel of ['.se-sidebar', '.se-overview', '.se-status', '[data-testid="terminal-panel"]', '.se-activity', '.se-shelf-head']) await expect(page.locator(sel), sel).toHaveCount(0);
    const left = page.locator('.se-zen-strip.left');
    await expect(left.locator('[data-panel="files"]')).toBeVisible();
    await expect(left.locator('[data-panel="search"]')).toHaveAttribute('title', 'Search (Ctrl+Shift+F)');
    await expect(page.locator('.se-zen-strip.right [data-testid="zen-strip-overview"]')).toBeVisible();
    // The same control, still bottom left (the strip's foot), now leaves zen.
    const stripToggle = left.locator('[data-testid="zen-toggle"]');
    await expect(stripToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(stripToggle).toHaveAttribute('title', 'Leave zen mode (Ctrl+Alt+Z)');
    const vh = page.viewportSize()!.height;
    expect((await stripToggle.boundingBox())!.y).toBeGreaterThan(vh - 60);
    expect((await stripToggle.boundingBox())!.x).toBeLessThan(10);

    // Peek: a strip click shows the panel over the text (the text does not move); back in the text folds it.
    const x0 = await textX(page);
    await left.locator('[data-panel="files"]').click();
    const peek = page.locator('.se-sidebar.se-zen-peek[data-panel="files"]');
    await expect(peek.locator('.se-tree-row').first()).toBeVisible();
    expect(await textX(page)).toBe(x0);
    await expect(left.locator('[data-panel="files"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('.cm-content').click();
    await expect(peek).toHaveCount(0);
    // A panel shortcut peeks too; Esc in it goes back to the text.
    await page.keyboard.press('Control+Shift+f');
    await expect(page.locator('.se-sidebar.se-zen-peek[data-panel="search"] input').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.se-zen-peek')).toHaveCount(0);
    // The overview strip peeks the overview on the right; clicking its icon again folds it.
    await page.getByTestId('zen-strip-overview').click();
    await expect(page.locator('.se-overview.se-zen-peek')).toBeVisible();
    expect(await textX(page)).toBe(x0);
    await page.getByTestId('zen-strip-overview').click();
    await expect(page.locator('.se-overview')).toHaveCount(0);
    // Overlays still work: palette, settings.
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.se-palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await isZen(page)).toBe(true);

    // Leave with the strip's toggle (a peek open meanwhile): exactly the layout from before, window again.
    await left.locator('[data-panel="files"]').click();
    await stripToggle.click();
    await expect.poll(() => isZen(page)).toBe(false);
    expect(await layout(page)).toEqual(before);
    await expect.poll(() => full(page)).toBe(false);
    if (style === 'classic') await expect(page.locator('.se-activity')).toBeVisible();

    // Enter by command, leave with the tab strip's button (top right).
    await runFromPalette(page, 'toggle zen mode');
    await expect.poll(() => isZen(page)).toBe(true);
    await page.locator('.se-tabbar [data-testid="zen-toggle"]').click();
    await expect.poll(() => isZen(page)).toBe(false);
    expect(await layout(page)).toEqual(before);
  });
}

test('full screen: left from outside, zen stays and works; leaving zen then leaves the window alone; the option turns it off', async ({ page, ws }) => {
  await openNote(page, ws);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => full(page)).toBe(true);
  // Esc / F11 / the OS: the page leaves full screen without us.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => full(page)).toBe(false);
  expect(await isZen(page)).toBe(true);
  await page.locator('.se-zen-strip [data-panel="files"]').click();
  await expect(page.locator('.se-zen-peek .se-tree-row').first()).toBeVisible();
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(false);
  await expect(page.locator('.se-tabbar')).toBeVisible();
  await expect(page.locator('.se-sidebar:not(.se-zen-peek)')).toBeVisible();

  // Already full screen before zen (the user's own): it stays when zen ends.
  await page.evaluate(() => document.documentElement.requestFullscreen()); // evaluate counts as a user gesture
  await expect.poll(() => full(page)).toBe(true);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(true);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(false);
  expect(await full(page)).toBe(true);
  await page.evaluate(() => document.exitFullscreen());

  // Settings → Zen mode → Full screen off: zen in the window.
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings').locator('[data-setting="zen.fullScreen"]').click();
  await page.keyboard.press('Escape');
  await expect.poll(async () => ((await ws.server.service.getSettings()) as any)['zen.fullScreen']).toBe(false);
  await page.keyboard.press('Control+Alt+z');
  await expect.poll(() => isZen(page)).toBe(true);
  await page.waitForTimeout(200);
  expect(await full(page)).toBe(false);
});

test('a stored "Keep the file tree" (zen before the strips) is ignored; "Keep the status bar" applies at once, also in zen', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ 'zen.keepFileTree': true } as any);
  await openNote(page, ws);
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-zen-strip.left')).toBeVisible();
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  await expect(page.locator('.se-status')).toHaveCount(0);
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg.locator('[data-setting="zen.keepFileTree"]')).toHaveCount(0);
  await dlg.locator('[data-setting="zen.keepStatusBar"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-status')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.zen)).toBe('on status');
  await page.keyboard.press('Control+,');
  await dlg.locator('[data-reset="zen.keepStatusBar"]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-status')).toHaveCount(0);
});

test('the status bar has no sidebar button any more; the shelf head, the tab strip cell and Ctrl+Shift+B still toggle it', async ({ page, ws }) => {
  await openNote(page, ws);
  await expect(page.locator('.se-status')).toBeVisible();
  await expect(page.locator('.se-status .se-status-sidebar, .se-status [aria-label="Toggle sidebar"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.locator('.se-sidebar')).toBeVisible();
  await page.keyboard.press('Control+Shift+B');
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
});

test('integrated frame: a peek over the tab strip never sits under its drag region; nothing clickable is stolen', async ({ page, ws }) => {
  await openNote(page, ws);
  await forceIntegratedFrame(page);
  await page.keyboard.press('Control+Alt+b'); // the overview gets a strip too
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-zen-strip.right')).toBeVisible();
  await page.locator('.se-zen-strip [data-panel="files"]').click();
  await page.getByTestId('zen-strip-overview').click();
  await expect(page.locator('.se-sidebar.se-zen-peek')).toBeVisible();
  await expect(page.locator('.se-overview.se-zen-peek')).toBeVisible();
  const r = await appRegionReport(page);
  expect(r.regions.drag).toBeGreaterThan(0);
  expect(r.mismatches).toEqual([]);
  expect(r.leaks).toEqual([]);
});

/** Reloads while holding the app bundle back, runs `probe` on the bare skeleton, then lets the app boot. */
async function reloadProbingSkeleton<T>(page: Page, probe: () => T): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  const nav = page.reload();
  await page.waitForSelector('.sk-main', { state: 'attached' });
  const out = await page.evaluate(probe);
  release();
  await nav;
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await page.unroute(/\/assets\/index-[^/]+\.js$/);
  return out;
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: zen survives a reload without a flash: skeleton and first frame already have the strips`, async ({ page, ws }) => {
    await openNote(page, ws);
    await setStyle(page, style);
    await page.keyboard.press('Control+Alt+b');
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-root.se-zen')).toBeVisible();
    await page.locator('.se-zen-strip [data-panel="files"]').click(); // a peek is open at the reload
    await expect.poll(async () => !!((await ws.server.service.getSession()) as any)?.zen).toBe(true);
    const real = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { left: Math.round(box('.se-zen-strip.left').width), right: Math.round(box('.se-zen-strip.right').width), card: Math.round(box('.se-content').x) };
    });
    // The first .se-root the app inserts (before any paint of it) must already be zen, with its strips.
    await page.addInitScript(() => {
      const w = window as any;
      new MutationObserver((_, obs) => {
        const r = document.querySelector('.se-root');
        if (r && w.__firstRoot === undefined) {
          w.__firstRoot = { cls: r.className, strips: r.querySelectorAll('.se-zen-strip').length, peek: r.querySelectorAll('.se-zen-peek').length };
          obs.disconnect();
        }
      }).observe(document, { childList: true, subtree: true });
    });
    const skel = await reloadProbingSkeleton(page, () => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return { zen: document.documentElement.dataset.zen, left: Math.round(box('.sk-side').width), right: Math.round(box('.sk-ov').width), card: Math.round(box('.sk-main').x), rows: getComputedStyle(document.querySelector('.sk-rows')!).display };
    });
    expect(skel).toEqual({ zen: 'on ov', left: real.left, right: real.right, card: real.card, rows: 'none' });
    expect(await page.evaluate(() => (window as any).__firstRoot)).toEqual({ cls: expect.stringContaining('se-zen'), strips: 2, peek: 0 });
    await expect(page.locator('.se-zen-peek')).toHaveCount(0); // a peek is never restored
    // Leaving still restores the layout from before zen (sidebar on Files, overview).
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-sidebar[data-panel="files"]')).toBeVisible();
    await expect(page.locator('.se-overview')).toBeVisible();
  });
}
