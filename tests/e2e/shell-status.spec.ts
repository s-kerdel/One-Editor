// Status bar: the folder item opens a folder menu; the open file's path is a clickable breadcrumb.
import { test, expect } from './harness';

test('status bar folder: switch / reveal / copy path menu (opens above the bar)', async ({ page, ws, context }) => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const other = path.join(path.dirname(ws.root), 'notes-archive');
  await fs.mkdir(other, { recursive: true });
  await ws.server.service.openWorkspace(other);
  await ws.server.service.openWorkspace(ws.root); // recent: [workspace, notes-archive]
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.open(page);

  const btn = page.getByTestId('status-folder');
  await expect(btn).toHaveText(/workspace/);
  await btn.click();
  const menu = page.locator('.se-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.se-menu-item', { hasText: 'Copy folder path' })).toBeVisible();
  await expect(menu.locator('.se-menu-item', { hasText: 'Open folder…' })).toBeVisible();
  await expect(menu.locator('.se-menu-item', { hasText: 'notes-archive' })).toBeVisible();
  // The menu sits above the status bar, not off-screen below it.
  const m = (await menu.boundingBox())!;
  const b = (await btn.boundingBox())!;
  expect(m.y + m.height).toBeLessThanOrEqual(b.y + 1);

  await menu.locator('.se-menu-item', { hasText: 'Copy folder path' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(ws.root);
});

test('status bar breadcrumb: folder crumb reveals + expands it in the tree, file crumb reveals the file', async ({ page, ws }) => {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('deep/nested/folder/Deep note.md'));
  const crumbs = page.locator('.se-status-crumbs .se-crumb');
  await expect(crumbs).toHaveText(['deep', 'nested', 'folder', 'Deep note']);

  // Collapse everything, then navigate via the crumb.
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await crumbs.nth(1).click();
  const row = page.locator('.se-tree-row[data-path="deep/nested"]');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.se-tree-row[data-path="deep/nested/folder"]')).toBeVisible();

  await crumbs.nth(3).click();
  await expect(page.locator('.se-tree-row[data-path="deep/nested/folder/Deep note.md"]')).toHaveAttribute('aria-selected', 'true');
});

test('right-click a folder → Open as project; empty tree area → Open parent folder as project', async ({ page, ws }) => {
  await ws.open(page);
  await page.locator('.se-tree-row[data-path="code"]').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Open as project' }).click();
  await expect(page.getByTestId('workspace-name')).toHaveText('code');
  await expect(page.locator('.se-tree-row[data-path="UserController.php"]')).toBeVisible();

  // Back up one level from the empty part of the tree.
  const tree = page.locator('.se-tree');
  const box = (await tree.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20, { button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Open parent folder as project' }).click();
  await expect(page.getByTestId('workspace-name')).toHaveText('workspace');
  await expect(page.locator('.se-tree-row[data-path="code"]')).toBeVisible();
});
