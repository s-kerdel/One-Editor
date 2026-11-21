// Bookmarks panel (browser mode): adding from the tree (one row, a multi-selection), a tab's menu, the palette and
// by dragging; opening; a folder's mini tree; reordering, naming and removing; following renames made in One and
// outside it; missing targets; storage in One's app data (never in the folder).
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const row = (page: Page, p: string) => page.locator(`.se-tree-row[data-path="${p}"]:not(.se-bm-sub)`);
const bm = (page: Page, p: string) => page.locator(`.se-bm-top[data-bm="${p}"]`);
const bmRows = (page: Page) => page.locator('.se-bm-top').evaluateAll((els) => els.map((e) => e.getAttribute('data-bm')));
const stored = (ws: WsFixture) => ws.server.service.bookmarks();
const storedPaths = async (ws: WsFixture) => (await stored(ws)).map((b) => b.path);
const pill = (page: Page, id: string) => page.locator(`.se-nav-btn[data-panel="${id}"]`);
const menuItem = (page: Page, label: string | RegExp) => page.locator('.se-menu-item', { hasText: label });

async function boot(page: Page, ws: WsFixture) {
  page.on('pageerror', (e) => {
    throw e;
  });
  await ws.open(page);
  await row(page, 'notes').click();
  await expect(row(page, 'notes/kubernetes.md')).toBeVisible();
}

test('add from the tree (one row, a selection), a tab, the palette; open a file; a folder unfolds; stored in app data', async ({ page, ws }) => {
  await boot(page, ws);
  const before = fs.readdirSync(ws.root).sort();

  await row(page, 'README.md').click({ button: 'right' });
  await menuItem(page, /^Bookmark$/).click();
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md']);

  // A selection: folders carry their selected children (topLevel), so kubernetes.md is not added on its own.
  await row(page, 'notes/kubernetes.md').click();
  await row(page, 'code').click({ modifiers: [MOD] });
  await row(page, 'notes').click({ modifiers: [MOD] });
  await expect(page.locator('.se-tree-sel')).toHaveText('3 selected');
  await row(page, 'notes').click({ button: 'right' });
  await menuItem(page, 'Bookmark 2 items').click();
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md', 'code', 'notes']);
  // Everything selected is bookmarked now: the menu offers the way back.
  await row(page, 'notes').click({ button: 'right' });
  await expect(menuItem(page, 'Remove 2 bookmarks')).toBeVisible();
  await page.keyboard.press('Escape');

  // A tab's menu.
  await row(page, 'notes/Daily notes.md').click();
  await page.locator('.se-tab[data-path="notes/Daily notes.md"]').click({ button: 'right' });
  await menuItem(page, /^Bookmark$/).click();
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md', 'code', 'notes', 'notes/Daily notes.md']);

  // The palette.
  await row(page, 'notes/windows-crlf.md').click();
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('bookmark current file');
  await expect(page.locator('.se-pal-item.selected')).toContainText('Bookmarks: Bookmark current file');
  await page.keyboard.press('Enter');
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md', 'code', 'notes', 'notes/Daily notes.md', 'notes/windows-crlf.md']);

  // The panel: 4th pill by default, rows in that order; a click opens a file, a folder unfolds inline.
  await expect(page.locator('.se-nav-btn')).toHaveCount(7);
  expect(await page.locator('.se-nav-btn').evaluateAll((els) => els.map((e) => e.getAttribute('data-panel')))).toEqual(['files', 'search', 'git', 'bookmarks', 'outline', 'backlinks', 'tags']);
  await pill(page, 'bookmarks').click();
  await expect.poll(() => bmRows(page)).toEqual(['README.md', 'code', 'notes', 'notes/Daily notes.md', 'notes/windows-crlf.md']);
  await expect(bm(page, 'notes/Daily notes.md').locator('.se-bm-hint')).toHaveText('notes');
  await bm(page, 'README.md').click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
  await expect(bm(page, 'README.md')).toHaveClass(/active/);
  await bm(page, 'notes').click();
  await expect(bm(page, 'notes')).toHaveAttribute('aria-expanded', 'true');
  const sub = page.locator('.se-bm-sub[data-path="notes/kubernetes.md"]');
  await expect(sub).toBeVisible();
  await sub.click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/kubernetes.md');

  // One file per folder in the app data folder; the folder itself is untouched.
  const dir = path.join(path.dirname(ws.root), 'config', 'bookmarks');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  expect(files).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')).items.map((b: { path: string }) => b.path)).toEqual(['README.md', 'code', 'notes', 'notes/Daily notes.md', 'notes/windows-crlf.md']);
  expect(fs.readdirSync(ws.root).sort()).toEqual(before);

  // Survives a reload.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'bookmarks');
  await expect.poll(() => bmRows(page)).toEqual(['README.md', 'code', 'notes', 'notes/Daily notes.md', 'notes/windows-crlf.md']);
});

test('drag: tree rows onto the pill, a tab into the panel, rows to reorder; name and remove a bookmark', async ({ page, ws }) => {
  await boot(page, ws);
  // Tree rows dropped on the Bookmarks pill (the list is not on screen).
  await row(page, 'README.md').dragTo(pill(page, 'bookmarks'));
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md']);
  await row(page, 'notes/kubernetes.md').dragTo(pill(page, 'bookmarks'));
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md', 'notes/kubernetes.md']);
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'files'); // a quick drop does not switch
  await expect(page.locator('.se-toast', { hasText: 'Bookmarked “kubernetes.md”' })).toBeVisible();

  // Resting on the pill while dragging opens the panel; the drop then lands at the pointed place.
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const from = await box('.se-tree-row[data-path="notes/windows-crlf.md"]');
  const on = await box('.se-nav-btn[data-panel="bookmarks"]');
  await page.mouse.move(from.x + 30, from.y + from.height / 2);
  await page.mouse.down();
  // One awaited move per step: Playwright's drag sends dragover on separate moves only.
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.move(on.x + on.width / 2, on.y + on.height / 2);
  await page.mouse.move(on.x + on.width / 2 + 1, on.y + on.height / 2);
  await expect(page.locator('.se-nav-btn[data-panel="bookmarks"]')).toHaveClass(/se-bm-pill-drop/);
  for (let i = 0; i < 12 && (await page.locator('.se-sidebar').getAttribute('data-panel')) !== 'bookmarks'; i++) {
    await page.mouse.move(on.x + on.width / 2 + (i % 2), on.y + on.height / 2);
    await page.waitForTimeout(100);
  }
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'bookmarks');
  const first = await box('.se-bm-top[data-bm="README.md"]');
  await page.mouse.move(first.x + 30, first.y + 4);
  await page.mouse.move(first.x + 31, first.y + 3);
  await page.mouse.up();
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/windows-crlf.md', 'README.md', 'notes/kubernetes.md']);
  await bm(page, 'notes/windows-crlf.md').click({ button: 'right' });
  await menuItem(page, 'Remove bookmark').click();
  await expect.poll(() => storedPaths(ws)).toEqual(['README.md', 'notes/kubernetes.md']);
  await pill(page, 'files').click();

  // A tab dropped in the panel, above the first bookmark.
  await row(page, 'notes/Daily notes.md').click();
  await pill(page, 'bookmarks').click();
  await expect.poll(() => bmRows(page)).toEqual(['README.md', 'notes/kubernetes.md']);
  await page.locator('.se-tab[data-path="notes/Daily notes.md"]').dragTo(bm(page, 'README.md'), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/Daily notes.md', 'README.md', 'notes/kubernetes.md']);

  // Reorder by dragging: kubernetes.md above README.md (upper half), then README.md to the end (below the last).
  await bm(page, 'notes/kubernetes.md').dragTo(bm(page, 'README.md'), { targetPosition: { x: 30, y: 3 } });
  await expect.poll(() => bmRows(page)).toEqual(['notes/Daily notes.md', 'notes/kubernetes.md', 'README.md']);
  await bm(page, 'notes/Daily notes.md').dragTo(bm(page, 'README.md'), { targetPosition: { x: 30, y: 20 } });
  await expect.poll(() => bmRows(page)).toEqual(['notes/kubernetes.md', 'README.md', 'notes/Daily notes.md']);
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/kubernetes.md', 'README.md', 'notes/Daily notes.md']);

  // Keyboard reorder (Alt+↑) on the focused row.
  await bm(page, 'notes/Daily notes.md').click();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/kubernetes.md', 'notes/Daily notes.md', 'README.md']);

  // A name for the bookmark (not the file).
  await bm(page, 'README.md').click({ button: 'right' });
  await menuItem(page, 'Rename bookmark…').click();
  const input = page.locator('.se-dialog input');
  await expect(input).toBeFocused();
  await input.fill('Start here');
  await page.keyboard.press('Enter');
  await expect(bm(page, 'README.md').locator('.se-tree-name')).toHaveText('Start here');
  await expect.poll(async () => (await stored(ws)).find((b) => b.path === 'README.md')?.label).toBe('Start here');
  expect(fs.existsSync(path.join(ws.root, 'README.md'))).toBe(true);
  await bm(page, 'README.md').click({ button: 'right' });
  await menuItem(page, 'Use the file name').click();
  await expect(bm(page, 'README.md').locator('.se-tree-name')).toHaveText('README');

  // Remove: the ✕ on hover, the menu, the Delete key.
  await bm(page, 'notes/kubernetes.md').hover();
  await bm(page, 'notes/kubernetes.md').locator('.se-bm-x').click();
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/Daily notes.md', 'README.md']);
  await bm(page, 'README.md').click({ button: 'right' });
  await menuItem(page, 'Remove bookmark').click();
  await expect.poll(() => storedPaths(ws)).toEqual(['notes/Daily notes.md']);
  await bm(page, 'notes/Daily notes.md').click();
  await page.keyboard.press('Delete');
  await expect.poll(() => storedPaths(ws)).toEqual([]);
  await expect(page.locator('.se-bm-empty')).toContainText('No bookmarks yet');
});

test('follows renames made in One and outside it; a missing target shows greyed with Remove', async ({ page, ws }) => {
  await boot(page, ws);
  await ws.server.service.bookmarks({ op: 'add', paths: ['notes', 'notes/kubernetes.md', 'README.md', 'code/query.sql'] });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await pill(page, 'bookmarks').click();
  await expect.poll(() => bmRows(page)).toEqual(['notes', 'notes/kubernetes.md', 'README.md', 'code/query.sql']);

  // In One: a file (F2 in the tree), then its folder (a drag-move).
  await pill(page, 'files').click();
  if (!(await row(page, 'notes/kubernetes.md').isVisible())) await row(page, 'notes').click(); // the session may have it open
  await row(page, 'notes/kubernetes.md').click();
  await page.keyboard.press('F2');
  await page.locator('.se-tree-input').fill('k8s.md');
  await page.keyboard.press('Enter');
  await expect.poll(() => storedPaths(ws)).toEqual(['notes', 'notes/k8s.md', 'README.md', 'code/query.sql']);
  await row(page, 'notes').dragTo(row(page, 'deep'));
  await expect.poll(() => storedPaths(ws)).toEqual(['deep/notes', 'deep/notes/k8s.md', 'README.md', 'code/query.sql']);

  // Outside One (the watcher sees unlink + add): a rename in place.
  fs.renameSync(path.join(ws.root, 'README.md'), path.join(ws.root, 'START.md'));
  await expect.poll(() => storedPaths(ws), { timeout: 10_000 }).toEqual(['deep/notes', 'deep/notes/k8s.md', 'START.md', 'code/query.sql']);

  // Deleted outside One: greyed, with its own Remove.
  fs.rmSync(path.join(ws.root, 'code', 'query.sql'));
  await pill(page, 'bookmarks').click();
  await expect(bm(page, 'code/query.sql')).toHaveClass(/missing/, { timeout: 10_000 });
  await expect(bm(page, 'START.md')).not.toHaveClass(/missing/);
  await bm(page, 'code/query.sql').click(); // nothing to open
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.tabs.value.map((t: any) => t.path))).not.toContain('code/query.sql');
  await bm(page, 'code/query.sql').locator('.se-bm-remove').click();
  await expect.poll(() => storedPaths(ws)).toEqual(['deep/notes', 'deep/notes/k8s.md', 'START.md']);
});
