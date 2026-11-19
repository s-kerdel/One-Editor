// Two sidebar styles: "shelf" (default, notes-app) and "classic" (IDE-like activity bar).
import { test, expect } from './harness';
import type { Page } from '@playwright/test';

const setting = (page: Page) => page.evaluate(() => (window as any).__secEdit.settings.value.sidebarStyle);

test('shelf is the default: workspace card, jump pill, panel pills, footer, editor card', async ({ page, ws }) => {
  await ws.open(page);
  expect(await setting(page)).toBe('shelf');
  await expect(page.locator('.se-root.ui-shelf')).toBeVisible();
  await expect(page.locator('.se-activity')).toHaveCount(0);
  await expect(page.getByTestId('workspace-name')).toHaveText('workspace');
  await expect(page.locator('.se-nav-btn')).toHaveCount(6); // files, search, git, outline, backlinks, tags
  await expect(page.locator('.se-nav-btn.active')).toHaveAttribute('data-panel', 'files');
  // The status bar lives inside the editor card.
  await expect(page.locator('.se-content .se-status')).toHaveCount(1);

  // Jump pill opens quick open.
  await page.getByRole('button', { name: /Jump to/ }).click();
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.press('Escape');

  // Recent section appears once something was opened.
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await expect(page.locator('.se-shelf-recent-row', { hasText: 'README' })).toBeVisible();

  // Pills switch panels without collapsing; the active pill shows its label.
  await page.locator('.se-nav-btn[data-panel="search"]').click();
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search');
  await expect(page.locator('.se-nav-btn.active .se-nav-label')).toHaveText('Search');
  await page.locator('.se-nav-btn[data-panel="search"]').click();
  await expect(page.locator('.se-sidebar')).toBeVisible();

  // Footer: new note.
  await page.locator('.se-nav-btn[data-panel="files"]').click();
  await page.locator('.se-new-note').click();
  await expect(page.locator('.se-tree-input')).toBeFocused();
});

test('switch to classic in Settings: activity bar, dense tree, persisted across reloads', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  await dlg.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
  await page.keyboard.press('Escape');

  await expect(page.locator('.se-root.ui-classic')).toBeVisible();
  await expect(page.locator('.se-activity-btn[data-panel="files"]')).toBeVisible();
  await expect(page.locator('.se-nav-btn')).toHaveCount(0);
  await expect(page.locator('.se-panel-title')).toHaveText('workspace');
  await expect(page.getByLabel('Filter files')).toBeVisible(); // classic: filter always shown
  const rowH = await page.locator('.se-tree-row').first().evaluate((el) => el.getBoundingClientRect().height);
  expect(rowH).toBe(24);
  // Status bar spans the window again (outside the editor area).
  await expect(page.locator('.se-content .se-status')).toHaveCount(0);
  await expect(page.locator('.se-root > .se-status')).toHaveCount(1);

  // IDE convention: clicking the open panel collapses the sidebar.
  await page.locator('.se-activity-btn[data-panel="files"]').click();
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  await page.locator('.se-activity-btn[data-panel="search"]').click();
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search');

  await expect.poll(async () => (await ws.server.service.getSettings()).sidebarStyle).toBe('classic');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'classic'); // skeleton style for next launch
  await expect(page.locator('.se-activity')).toBeVisible();

  // And back via the command palette.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('sidebar style');
  await expect(page.getByRole('dialog').getByText(/Switch sidebar style/)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-root.ui-shelf')).toBeVisible();
  await expect(page.locator('.se-activity')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-ui', 'shelf');
});

test('classic: open another project from the sidebar (folder name menu + activity bar button)', async ({ page, ws }) => {
  // A second project that is in the recent list.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const other = path.join(path.dirname(ws.root), 'other-project');
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(path.join(other, 'hello.md'), '# Hello from the other project\n');
  await ws.server.service.openWorkspace(other);
  await ws.server.service.openWorkspace(ws.root); // recent = [workspace, other-project]
  await ws.server.service.saveSettings({ sidebarStyle: 'classic' });
  await ws.open(page);
  await expect(page.locator('.se-root.ui-classic')).toBeVisible();

  // 1) Folder name in the Files header opens the switcher.
  await page.locator('.se-classic-ws').click();
  await expect(page.locator('.se-menu-item', { hasText: 'Open folder…' })).toBeVisible();
  await page.locator('.se-menu-item', { hasText: 'other-project' }).click();
  await expect(page.locator('.se-panel-title')).toHaveText('other-project');
  await expect(page.locator('.se-tree-row', { hasText: 'hello' })).toBeVisible();

  // 2) The activity-bar folder button offers the way back.
  await page.getByTestId('classic-switch-folder').click();
  // Match the label only: recent items also show their parent folder as a hint.
  await page.locator('.se-menu-item').filter({ has: page.locator('.se-menu-label', { hasText: /^workspace$/ }) }).click();
  await expect(page.locator('.se-panel-title')).toHaveText('workspace');
});

test('icons keep their size when lazy feature styles arrive after boot', async ({ page, ws }) => {
  await ws.open(page);
  const size = () => page.getByTestId('open-settings').locator('svg').evaluate((el) => el.getBoundingClientRect().width);
  const before = await size();
  // Search (and its stylesheet) loads on idle after boot.
  await page.waitForFunction(() => (window as any).__secEditSearch?.status?.value === 'ready', null, { timeout: 15000 });
  await page.waitForTimeout(200);
  expect(await size()).toBe(before);
  expect(before).toBe(16);
});
