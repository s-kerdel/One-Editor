// Sidebar menu customisation (browser mode): Settings → Appearance → Sidebar menu (drag, Alt+↑/↓ and buttons,
// hide, at least one entry, reset), the pills' / classic icons' right-click menu (Hide …, Customize sidebar…),
// a hidden panel opened by its shortcut, and no jump at startup (the first frame already has the final bar).
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const DEFAULT = ['files', 'search', 'git', 'bookmarks', 'outline', 'backlinks', 'tags'];
const bar = (page: Page, sel = '.se-nav-btn') => page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute('data-panel')));
const pref = async (ws: WsFixture) => (await ws.server.service.getSettings())['sidebar.panels'] ?? null;
const entries = (page: Page) => page.locator('.se-sbm-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-panel')));
const entry = (page: Page, id: string) => page.locator(`.se-sbm-item[data-panel="${id}"]`);
const menuItem = (page: Page, label: string | RegExp) => page.locator('.se-menu-item', { hasText: label });

async function boot(page: Page, ws: WsFixture) {
  page.on('pageerror', (e) => {
    throw e;
  });
  await ws.open(page);
}

test('right-click a pill: Hide, at least one stays; Customize opens the setting; Settings reorder by keyboard, buttons and drag; hide; reset', async ({ page, ws }) => {
  await boot(page, ws);
  expect(await bar(page)).toEqual(DEFAULT);

  await page.locator('.se-nav-btn[data-panel="tags"]').click({ button: 'right' });
  await menuItem(page, 'Hide Tags').click();
  await expect.poll(() => bar(page)).toEqual(DEFAULT.filter((x) => x !== 'tags'));
  await expect.poll(() => pref(ws)).toEqual({ order: DEFAULT, hidden: ['tags'] });

  // Hiding the shown panel from its own pill moves to the first one left (else it would stay while open).
  await page.locator('.se-nav-btn[data-panel="files"]').click({ button: 'right' });
  await menuItem(page, 'Hide Files').click();
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search');
  await expect.poll(() => bar(page)).toEqual(['search', 'git', 'bookmarks', 'outline', 'backlinks']);

  await page.locator('.se-nav-btn[data-panel="git"]').click({ button: 'right' });
  await menuItem(page, 'Customize sidebar…').click();
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('[data-row="sidebar.panels"]')).toBeInViewport();
  await expect(entry(page, 'files')).toBeFocused();
  expect(await entries(page)).toEqual(DEFAULT);
  await expect(entry(page, 'files').locator('input[type=checkbox]')).not.toBeChecked();

  // Keyboard: ↓ walks the entries, Alt+↓ / Alt+↑ move the focused one (focus stays on it).
  await page.keyboard.press('ArrowDown');
  await expect(entry(page, 'search')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => entries(page)).toEqual(['files', 'git', 'search', 'bookmarks', 'outline', 'backlinks', 'tags']);
  await expect(entry(page, 'search')).toBeFocused();
  await page.keyboard.press('Alt+ArrowDown');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => entries(page)).toEqual(['search', 'files', 'git', 'bookmarks', 'outline', 'backlinks', 'tags']);
  // The bar follows live.
  await expect.poll(() => bar(page)).toEqual(['search', 'git', 'bookmarks', 'outline', 'backlinks']);

  // Buttons.
  await entry(page, 'tags').getByRole('button', { name: 'Move Tags up' }).click();
  await expect.poll(() => entries(page)).toEqual(['search', 'files', 'git', 'bookmarks', 'outline', 'tags', 'backlinks']);
  await expect(entry(page, 'search').getByRole('button', { name: 'Move Search up' })).toBeDisabled();

  // Drag by the handle: Bookmarks onto the upper half of Search → first.
  await entry(page, 'bookmarks').locator('.se-sbm-grip').dragTo(entry(page, 'search'), { targetPosition: { x: 40, y: 4 } });
  await expect.poll(() => entries(page)).toEqual(['bookmarks', 'search', 'files', 'git', 'outline', 'tags', 'backlinks']);
  await expect.poll(() => pref(ws)).toEqual({ order: ['bookmarks', 'search', 'files', 'git', 'outline', 'tags', 'backlinks'], hidden: ['tags', 'files'] });

  // Show / hide with the checkbox; the last shown entry cannot be hidden.
  await entry(page, 'tags').locator('input[type=checkbox]').check();
  for (const id of ['bookmarks', 'search', 'git', 'outline', 'tags']) await entry(page, id).locator('input[type=checkbox]').uncheck();
  await expect(entry(page, 'backlinks').locator('input[type=checkbox]')).toBeDisabled();
  await expect.poll(async () => ((await pref(ws)) as { hidden: string[] }).hidden.sort()).toEqual(['bookmarks', 'files', 'git', 'outline', 'search', 'tags']);

  // Reset: nothing stored, default bar.
  await page.getByTestId('sidebar-menu-reset').click();
  await expect.poll(() => pref(ws)).toBeNull();
  await expect.poll(() => entries(page)).toEqual(DEFAULT);
  await expect(page.getByTestId('sidebar-menu-reset')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect.poll(() => bar(page)).toEqual(DEFAULT);
});

test('a hidden panel opens with its shortcut and the palette, and shows in the bar only while open', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ 'sidebar.panels': { order: DEFAULT, hidden: ['bookmarks', 'files'] } });
  await boot(page, ws);
  // The default panel (Files) is hidden but shown, so it is in the bar.
  expect(await bar(page)).toEqual(['files', 'search', 'git', 'outline', 'backlinks', 'tags']);
  await page.locator('.se-nav-btn[data-panel="search"]').click();
  await expect.poll(() => bar(page)).toEqual(['search', 'git', 'outline', 'backlinks', 'tags']);

  await page.keyboard.press('Control+Alt+k');
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'bookmarks');
  await expect.poll(() => bar(page)).toEqual(['search', 'git', 'bookmarks', 'outline', 'backlinks', 'tags']);
  await expect(page.locator('.se-nav-btn[data-panel="bookmarks"]')).toHaveClass(/active/);
  await page.locator('.se-nav-btn[data-panel="git"]').click();
  await expect.poll(() => bar(page)).toEqual(['search', 'git', 'outline', 'backlinks', 'tags']);

  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('view: show files');
  await expect(page.locator('.se-pal-item.selected')).toContainText('View: Show Files');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'files');
  await expect.poll(() => bar(page)).toEqual(['files', 'search', 'git', 'outline', 'backlinks', 'tags']);
});

test('no jump at startup: the first frame has the saved order, the hidden set and the saved (hidden) panel', async ({ page, ws }) => {
  const order = ['tags', 'git', 'search', 'files', 'bookmarks', 'outline', 'backlinks'];
  await ws.server.service.saveSettings({ 'sidebar.panels': { order, hidden: ['search', 'outline'] } });
  await boot(page, ws);
  // Leave the hidden Outline panel open (by its shortcut), so it is restored at the next launch.
  await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'outline');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.sidebarPanel.value)).toBe('outline');
  await page.waitForTimeout(400); // the session save is debounced

  // Every distinct bar the page ever shows, from the very first frame on (a MutationObserver runs before paint).
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as any).__bars = seen;
    new MutationObserver(() => {
      const nav = document.querySelector('.se-nav');
      if (!nav) return;
      const ids = [...nav.querySelectorAll('[data-panel]')].map((b) => b.getAttribute('data-panel')).join(',');
      if (seen[seen.length - 1] !== ids) seen.push(ids);
    }).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForTimeout(300);
  const bars = await page.evaluate(() => (window as any).__bars as string[]);
  expect(bars).toEqual(['tags,git,files,bookmarks,outline,backlinks']);
  await expect(page.locator('.se-nav-btn[data-panel="outline"]')).toHaveClass(/active/);

  // Classic: the icon bar is in the same order, and has the same right-click menu.
  await ws.server.service.saveSettings({ sidebarStyle: 'classic' });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  expect(await bar(page, '.se-activity-btn[data-panel]')).toEqual(['tags', 'git', 'files', 'bookmarks', 'outline', 'backlinks']);
  await page.locator('.se-activity-btn[data-panel="git"]').click({ button: 'right' });
  await menuItem(page, 'Hide Git').click();
  await expect.poll(() => bar(page, '.se-activity-btn[data-panel]')).toEqual(['tags', 'files', 'bookmarks', 'outline', 'backlinks']);
});
