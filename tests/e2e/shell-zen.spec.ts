// Zen mode (View: Toggle zen mode, Ctrl+Alt+Z; app/zen.tsx): only the text — no sidebar, overview,
// bottom panels, tab strip, status bar or activity bar; overlays keep working; leaving restores the
// layout from before; it survives a reload with the skeleton and the first frame already in zen.
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const CHROME = ['.se-sidebar', '.se-overview', '.se-tabbar', '.se-status', '[data-testid="terminal-panel"]', '.se-activity', '.se-shelf-head'];
const isZen = (page: Page) => page.evaluate(() => document.querySelector('.se-root')!.classList.contains('se-zen'));
const layout = (page: Page) =>
  page.evaluate(() => {
    const s = (window as any).__secEdit;
    const w = document.querySelector('.se-sidebar')?.getBoundingClientRect().width ?? 0;
    return { sidebar: s.sidebarVisible.value, panel: s.sidebarPanel.value, width: Math.round(w), overview: !!document.querySelector('.se-overview'), terminal: !!document.querySelector('[data-testid="terminal-panel"]'), tabs: !!document.querySelector('.se-tabbar'), status: !!document.querySelector('.se-status') };
  });

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
  test(`${style}: key and command toggle zen; the text stays centred, overlays work, leaving restores the layout`, async ({ page, ws }) => {
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

    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-root.se-zen')).toBeVisible();
    for (const sel of CHROME) await expect(page.locator(sel), sel).toHaveCount(0);
    await expect(page.locator('.se-zen-bar')).toBeVisible();
    // The text column is centred in the window, at the content width.
    const col = await page.locator('.cm-content').boundingBox();
    const vw = page.viewportSize()!.width;
    expect(Math.abs(col!.x + col!.width / 2 - vw / 2)).toBeLessThan(8);
    expect(col!.width).toBeLessThanOrEqual(861);
    // Overlays: in-file find, palette, quick open, settings.
    await page.evaluate(() => (window as any).__secEdit.editor.focus());
    await page.keyboard.press('Control+f');
    await expect(page.locator('.cm-search input[name=search]')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.cm-search')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+P');
    await expect(page.locator('.se-palette')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+p');
    await expect(page.locator('.se-palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('settings')).toHaveCount(0);
    expect(await isZen(page)).toBe(true);

    // Leave by command: exactly the layout from before (panel, width, overview, terminal, tabs, status bar).
    await runFromPalette(page, 'toggle zen mode');
    await expect.poll(() => isZen(page)).toBe(false);
    expect(await layout(page)).toEqual(before);
    if (style === 'classic') await expect(page.locator('.se-activity')).toBeVisible();

    // Enter by command, leave with the hover control (mouse users).
    await runFromPalette(page, 'toggle zen mode');
    await expect.poll(() => isZen(page)).toBe(true);
    const exit = page.getByTestId('zen-exit');
    await page.mouse.move(vw / 2, 400); // over the text: the control stays out of sight
    await expect(exit).toHaveCSS('opacity', '0');
    await page.locator('.se-zen-bar').hover();
    await expect(exit).toHaveCSS('opacity', '1');
    await exit.click();
    await expect.poll(() => isZen(page)).toBe(false);
    expect(await layout(page)).toEqual(before);
  });
}

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

test('zen survives a reload without a flash: the skeleton and the first app frame are already zen', async ({ page, ws }) => {
  await openNote(page, ws);
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen')).toBeVisible();
  await expect.poll(async () => !!((await ws.server.service.getSession()) as any)?.zen).toBe(true);
  // The first .se-root the app inserts (before any paint of it) must already carry the zen class.
  await page.addInitScript(() => {
    const w = window as any;
    new MutationObserver((_, obs) => {
      const r = document.querySelector('.se-root');
      if (r && w.__firstRoot === undefined) {
        w.__firstRoot = r.className;
        obs.disconnect();
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const skel = await reloadProbingSkeleton(page, () => {
    const main = getComputedStyle(document.querySelector('.sk-main')!);
    return { zen: document.documentElement.dataset.zen, side: getComputedStyle(document.querySelector('.sk-side')!).display, band: main.backgroundImage, margin: main.marginTop };
  });
  // Skeleton: no sidebar, no tab strip / status bar bands, flush to the window.
  expect(skel).toEqual({ zen: 'on', side: 'none', band: 'none', margin: '0px' });
  expect(await page.evaluate(() => (window as any).__firstRoot)).toContain('se-zen');
  for (const sel of CHROME) await expect(page.locator(sel), sel).toHaveCount(0);
  // Leaving still restores the layout from before zen (sidebar on Files).
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-sidebar[data-panel="files"]')).toBeVisible();
  await expect(page.locator('.se-tabbar')).toBeVisible();
});

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: "Keep the file tree" / "Keep the status bar" apply at once, also while in zen`, async ({ page, ws }) => {
    await openNote(page, ws);
    await setStyle(page, style);
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-sidebar')).toHaveCount(0);
    await page.keyboard.press('Control+,');
    const dlg = page.getByTestId('settings');
    await dlg.locator('[data-setting="zen.keepFileTree"]').click();
    await dlg.locator('[data-setting="zen.keepStatusBar"]').click();
    await page.keyboard.press('Escape');
    // A calm tree: just the Files panel, no shelf head / footer / activity bar; the status bar stays.
    await expect(page.locator('.se-sidebar[data-panel="files"] .se-tree-row').first()).toBeVisible();
    for (const sel of ['.se-shelf-head', '.se-shelf-foot', '.se-activity', '.se-tabbar']) await expect(page.locator(sel), sel).toHaveCount(0);
    await expect(page.locator('.se-status')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.dataset.zen)).toBe('on status');
    // Off and on again from zen itself.
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-tabbar')).toBeVisible();
    await page.keyboard.press('Control+Alt+z');
    await expect(page.locator('.se-sidebar .se-tree-row').first()).toBeVisible();
    await expect(page.locator('.se-status')).toBeVisible();
    // Defaults again: both hidden.
    await page.keyboard.press('Control+,');
    await dlg.locator('[data-reset="zen.keepFileTree"]').click();
    await dlg.locator('[data-reset="zen.keepStatusBar"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.se-sidebar')).toHaveCount(0);
    await expect(page.locator('.se-status')).toHaveCount(0);
  });
}
