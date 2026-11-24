// Shell E2E (browser mode): file tree ops, tabs, view modes, settings, external changes, keyboard flows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

// Deletes go to a private "trash" instead of the real ~/.local/share/Trash.
process.env.SEC_EDIT_TRASH_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sec-edit-e2e-trash-'));

const row = (page: Page, name: string) => page.locator('.se-tree-row', { hasText: name }).first();
const tab = (page: Page, name: string) => page.locator('.se-tab', { hasText: name });
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
const app = (page: Page) => page.evaluate(() => {
  const a = (window as any).__secEdit;
  return { active: a.activePath.value as string | null, tabs: a.tabs.value.map((t: any) => t.path) as string[], mode: a.settings.value.viewMode as string };
});

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

test('new note via Mod-n: created, opened, named inline, then typing goes into it', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click();
  await page.keyboard.press('Control+n');
  await expect.poll(() => exists(ws.root, 'untitled-1.md')).toBe(true);
  const input = page.locator('.se-tree-input');
  await expect(input).toBeFocused();
  await expect(tab(page, 'untitled-1.md')).toBeVisible();
  await page.keyboard.type('Meeting notes');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists(ws.root, 'Meeting notes.md')).toBe(true);
  expect(exists(ws.root, 'untitled-1.md')).toBe(false);
  await expect(tab(page, 'Meeting notes.md')).toBeVisible();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.type('Agenda');
  await expect.poll(() => ws.read('Meeting notes.md'), { timeout: 5000 }).toContain('Agenda');
});

test('new note from the shelf: the tree selection wins over the active file, even when the editor has focus', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click(); // active file: README.md at the root
  await expect.poll(async () => (await app(page)).active).toBe('README.md');
  await row(page, 'notes').click(); // tree selection: the notes folder (tree now focused)
  await page.locator('.cm-content').click(); // focus moves to the editor; selection stays on notes
  await page.locator('.se-new-note').click();
  await expect.poll(() => exists(ws.root, 'notes/untitled-1.md')).toBe(true);
  expect(exists(ws.root, 'untitled-1.md')).toBe(false); // NOT next to the active README
  await page.locator('.se-tree-input').press('Enter');
});

test('context menu → New file …: picker with popular extensions first, creates with the stem pre-selected', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'New file …' }).click();
  const picker = page.getByTestId('picker');
  await expect(picker).toBeVisible();
  // The fixture's code extensions (.php/.sql/.ts, one file each) are pinned on top with their counts; notes never rank.
  await expect(picker.locator('.se-picker-item').first()).toContainText('.php');
  await expect(picker.locator('.se-picker-item').first()).toContainText('1 file in this project');
  await expect(picker.locator('.se-picker-item', { hasText: '.md' })).toHaveCount(0);
  await page.keyboard.type('json');
  await page.keyboard.press('Enter');
  const input = page.locator('.se-tree-input');
  await expect(input).toBeFocused();
  expect(await input.evaluate((el) => {
    const i = el as HTMLInputElement;
    return [i.value, i.selectionStart, i.selectionEnd];
  })).toEqual(['untitled-1.json', 0, 10]);
  await page.keyboard.type('data');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists(ws.root, 'data.json')).toBe(true);
  expect(exists(ws.root, 'untitled-1.json')).toBe(false);
  await expect(tab(page, 'data.json')).toBeVisible();
});

test('create folder + file inline, rename with F2, delete to trash', async ({ page, ws }) => {
  await ws.open(page);
  await page.getByRole('button', { name: 'New folder' }).click();
  await page.locator('.se-tree-input').fill('projects');
  await page.keyboard.press('Enter');
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'projects'))).toBe(true);

  // Context menu → New note inside the folder, with an invalid name first.
  await row(page, 'projects').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'New folder' }).click();
  await page.locator('.se-tree-input').fill('bad:name');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-tree-error')).toBeVisible();
  await page.keyboard.press('Escape');

  await row(page, 'README').click();
  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  await expect(page.locator('.se-tree-input')).toBeFocused();
  await page.locator('.se-tree-input').fill('INTRO.md');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists(ws.root, 'INTRO.md')).toBe(true);
  expect(exists(ws.root, 'README.md')).toBe(false);
  await expect(tab(page, 'INTRO.md')).toBeVisible(); // the open tab followed the rename
  expect((await app(page)).active).toBe('INTRO.md');

  await row(page, 'INTRO').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Delete' }).click();
  await page.locator('.se-dialog .se-btn.danger').click();
  await expect.poll(() => exists(ws.root, 'INTRO.md')).toBe(false);
  expect(fs.existsSync(path.join(process.env.SEC_EDIT_TRASH_DIR!, 'INTRO.md'))).toBe(true);
  await expect(tab(page, 'INTRO.md')).toHaveCount(0);
  await expect(row(page, 'INTRO')).toHaveCount(0);
});

test('drag a file onto a folder moves it', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').dragTo(row(page, 'code'));
  await expect.poll(() => exists(ws.root, 'code/README.md')).toBe(true);
  expect(exists(ws.root, 'README.md')).toBe(false);
});

test('filter box narrows the tree; keyboard opens the first match', async ({ page, ws }) => {
  await ws.open(page);
  await page.getByRole('button', { name: 'Show file filter' }).click(); // the filter is a toggle in the Files header
  await expect(page.getByLabel('Filter files')).toBeFocused();
  await page.getByLabel('Filter files').fill('kuber');
  await expect(page.locator('.se-tree-row.file')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await app(page)).active).toBe('notes/kubernetes.md');
  await page.getByLabel('Filter files').fill('');
  await expect(row(page, 'README')).toBeVisible();
});

test('tabs: middle-click close, close others, Ctrl-Tab MRU, reorder by drag', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click();
  await row(page, 'code').click();
  await row(page, 'app.ts').click();
  await row(page, 'query.sql').click();
  await expect.poll(async () => (await app(page)).tabs).toEqual(['README.md', 'code/app.ts', 'code/query.sql']);

  // MRU: query.sql (current) → app.ts
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await expect(page.locator('.se-switcher')).toBeVisible();
  await page.keyboard.up('Control');
  await expect.poll(async () => (await app(page)).active).toBe('code/app.ts');

  await tab(page, 'README.md').dragTo(tab(page, 'query.sql'), { targetPosition: { x: 60, y: 10 } });
  await expect.poll(async () => (await app(page)).tabs).toEqual(['code/app.ts', 'README.md', 'code/query.sql']);

  await tab(page, 'query.sql').click({ button: 'middle' });
  await expect(tab(page, 'query.sql')).toHaveCount(0);

  await tab(page, 'README.md').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Close others' }).click();
  await expect.poll(async () => (await app(page)).tabs).toEqual(['README.md']);
});

test('view modes: Mod-e, Mod-\\, switch buttons; split divider resizes', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click();
  await expect(page.locator('.se-tab.active')).toContainText('README');
  await page.keyboard.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-preview')).toBeVisible();
  await expect(page.locator('.se-preview-host')).toContainText('Welcome');
  await page.keyboard.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-live')).toBeVisible();
  await page.keyboard.press('Control+\\');
  await expect(page.locator('.se-editor-area.mode-split')).toBeVisible();
  const sash = page.locator('.se-split-sash');
  const box = (await page.locator('.se-editor-panes').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + 200, { steps: 4 });
  await page.mouse.up();
  const ed = (await page.locator('.se-editor-host').boundingBox())!;
  expect(ed.width / box.width).toBeLessThan(0.4);
  await expect(sash).toBeVisible();
  await page.locator('.se-mode[data-mode="source"]').click();
  await expect.poll(async () => (await app(page)).mode).toBe('source');
  await expect.poll(async () => (await ws.server.service.getSettings()).viewMode).toBe('source');
});

test('settings overlay: theme switches live and persists; toggles save', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  await dlg.locator('.se-seg-btn[data-value="light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  // The editor card turns white; the shelf backdrop behind the sidebar is a warm grey by design.
  const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.se-content')!).backgroundColor);
  expect(bg).toBe('rgb(255, 255, 255)');
  await dlg.locator('[data-setting="markdownLineNumbers"]').click();
  await dlg.locator('#set-font-size').fill('18');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect.poll(async () => (await ws.server.service.getSettings()).fontSize).toBe(18);
  const saved = await ws.server.service.getSettings();
  expect(saved).toMatchObject({ theme: 'light', markdownLineNumbers: false });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('external change reloads a clean doc; dirty doc gets a non-blocking conflict banner', async ({ page, ws }) => {
  await ws.open(page);
  await ws.server.service.saveSettings({ autosave: false });
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await row(page, 'README').click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  await ws.write('README.md', '# Changed outside\n');
  await expect(page.locator('.cm-content')).toContainText('Changed outside');
  await expect(page.locator('.se-banner')).toHaveCount(0);

  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nmy edit');
  await ws.write('README.md', '# Changed again\n');
  await expect(page.locator('.se-banner')).toContainText('changed on disk');
  await page.locator('.se-banner .se-btn', { hasText: 'Keep mine' }).click();
  await expect(page.locator('.se-banner')).toHaveCount(0);
  await expect.poll(() => ws.read('README.md')).toContain('my edit');
});

test('status bar: language, CRLF shown and toggled, word count', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'notes').click();
  await row(page, 'windows-crlf').click();
  await expect(page.getByTestId('eol')).toHaveText('CRLF');
  await expect(page.getByTestId('language')).toHaveText('Markdown');
  await expect(page.getByTestId('word-count')).toContainText('words');
  await page.getByTestId('eol').click();
  await expect(page.getByTestId('eol')).toHaveText('LF');
  await expect.poll(() => ws.read('notes/windows-crlf.md')).not.toContain('\r\n');
  await row(page, 'code').click();
  await row(page, 'query.sql').click();
  await expect(page.getByTestId('language')).toHaveText('SQL');
  await expect(page.getByTestId('word-count')).toHaveCount(0);
});

test('sidebar: toggle with Mod-Shift-b, resize persists in session, panels switch', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+Shift+B');
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+B');
  await expect(page.locator('.se-sidebar')).toBeVisible();
  const sb = (await page.locator('.se-sidebar').boundingBox())!;
  await page.mouse.move(sb.x + sb.width, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width + 80, sb.y + 300, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await ws.server.service.getSession()).sidebarWidth).toBeGreaterThan(sb.width + 40);
  await page.locator('.se-nav-btn[data-panel="search"]').click();
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search');
  await expect(page.locator('.se-nav-btn[data-panel="search"]')).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  // While hidden, the tab strip offers a way back to the same panel.
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(page.locator('.se-sidebar')).toHaveAttribute('data-panel', 'search');
});

test('session restore: tabs and active file come back after reload', async ({ page, ws }) => {
  await ws.open(page);
  await row(page, 'README').click();
  await row(page, 'code').click();
  await row(page, 'app.ts').click();
  await page.waitForTimeout(400); // session save is debounced
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect.poll(async () => app(page)).toMatchObject({ tabs: ['README.md', 'code/app.ts'], active: 'code/app.ts' });
  await expect(page.locator('.se-tree-row.active')).toContainText('app.ts'); // auto-revealed
});
