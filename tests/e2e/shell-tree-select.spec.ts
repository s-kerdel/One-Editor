// File tree multi-selection (browser mode): Ctrl / Shift clicks, Shift + arrows, Ctrl + A, Esc, and the actions
// that work on several rows — delete (one confirm), drag-move, open, copy paths — plus the selection menu.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

// Deletes go to a private "trash" (under .tmp/, via the configs' TMPDIR) instead of the real one.
process.env.SEC_EDIT_TRASH_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sec-edit-e2e-trash-'));

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const row = (page: Page, p: string) => page.locator(`.se-tree-row[data-path="${p}"]`);
const selected = (page: Page) => page.locator('.se-tree-row.selected').evaluateAll((els) => els.map((e) => e.getAttribute('data-path')));
const hint = (page: Page) => page.locator('.se-tree-sel');
const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
const state = (page: Page) =>
  page.evaluate(() => {
    const a = (window as any).__secEdit;
    return { active: a.activePath.value as string | null, tabs: a.tabs.value.map((t: any) => t.path) as string[] };
  });

// Visible rows once notes/ is open: code, deep, notes, notes/Daily notes.md, notes/kubernetes.md, notes/windows-crlf.md, README.md
async function boot(page: Page, ws: { open(p: Page): Promise<void> }) {
  page.on('pageerror', (e) => {
    throw e;
  });
  await ws.open(page);
  await row(page, 'notes').click();
  await expect(row(page, 'notes/kubernetes.md')).toBeVisible();
}

test('mouse: Ctrl + click toggles, Shift + click selects a range, a plain click selects one and opens it', async ({ page, ws }) => {
  await boot(page, ws);
  await expect(page.locator('.se-tree')).toHaveAttribute('aria-multiselectable', 'true');
  await row(page, 'notes/Daily notes.md').click();
  await expect.poll(async () => (await state(page)).active).toBe('notes/Daily notes.md');

  await row(page, 'README.md').click({ modifiers: [MOD] });
  await expect.poll(() => selected(page)).toEqual(['notes/Daily notes.md', 'README.md']);
  await expect(hint(page)).toHaveText('2 selected');
  await expect(row(page, 'README.md')).toHaveAttribute('aria-selected', 'true');
  await expect(row(page, 'notes/kubernetes.md')).toHaveAttribute('aria-selected', 'false');
  await expect(row(page, 'README.md')).toHaveClass(/focused/);
  expect((await state(page)).active).toBe('notes/Daily notes.md'); // modified clicks never open

  // Toggle off again; the anchor moves to the toggled row.
  await row(page, 'notes/Daily notes.md').click({ modifiers: [MOD] });
  await expect.poll(() => selected(page)).toEqual(['README.md']);
  await expect(hint(page)).toHaveCount(0);

  // Shift: anchor (Daily notes) … clicked row, replacing what was selected.
  await row(page, 'notes/windows-crlf.md').click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(['notes/Daily notes.md', 'notes/kubernetes.md', 'notes/windows-crlf.md']);
  // Shift again from the same anchor: upwards, over the folder.
  await row(page, 'notes').click({ modifiers: ['Shift'] });
  await expect.poll(() => selected(page)).toEqual(['notes', 'notes/Daily notes.md']);
  await expect(row(page, 'notes/kubernetes.md')).toBeVisible(); // a Shift click on a folder does not fold it
  // Ctrl + Shift adds a range.
  await row(page, 'README.md').click({ modifiers: [MOD, 'Shift'] });
  await expect.poll(() => selected(page)).toEqual(['notes', 'notes/Daily notes.md', 'notes/kubernetes.md', 'notes/windows-crlf.md', 'README.md']);
  await expect(hint(page)).toHaveText('5 selected');

  await row(page, 'notes/kubernetes.md').click();
  await expect.poll(() => selected(page)).toEqual(['notes/kubernetes.md']);
  await expect.poll(async () => (await state(page)).active).toBe('notes/kubernetes.md');
  await expect(hint(page)).toHaveCount(0);
});

test('keyboard: Shift + arrows extend, Esc goes back to the focused row, Ctrl + A, Enter opens the files', async ({ page, ws }) => {
  await boot(page, ws);
  await row(page, 'README.md').click();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(() => selected(page)).toEqual(['notes/kubernetes.md', 'notes/windows-crlf.md', 'README.md']);
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => selected(page)).toEqual(['notes/windows-crlf.md', 'README.md']);
  await expect(row(page, 'notes/windows-crlf.md')).toHaveClass(/focused/);
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toEqual(['notes/windows-crlf.md']);
  await expect(hint(page)).toHaveCount(0);
  await expect(page.locator('.se-tree')).toBeFocused(); // Esc with a selection does not leave the tree

  // A plain arrow moves the focus and drops the selection; the existing keys still work.
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => selected(page)).toEqual(['notes/windows-crlf.md', 'README.md']);
  await expect(row(page, 'README.md')).toHaveClass(/focused/);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selected(page)).toEqual(['notes/windows-crlf.md']);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => selected(page)).toEqual(['notes/kubernetes.md']);
  await page.keyboard.press('Shift+End');
  await expect.poll(() => selected(page)).toEqual(['notes/kubernetes.md', 'notes/windows-crlf.md', 'README.md']);

  await page.keyboard.press(`${MOD}+a`);
  await expect.poll(() => selected(page)).toHaveLength(7);
  await expect(hint(page)).toHaveText('7 selected');
  // Enter: every file among them opens in a tab (folders are skipped), the first one is shown.
  const before = (await state(page)).tabs;
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).active).toBe('notes/Daily notes.md');
  const after = (await state(page)).tabs;
  expect(after.filter((t) => !before.includes(t)).sort()).toEqual(['README.md', 'notes/Daily notes.md', 'notes/kubernetes.md', 'notes/windows-crlf.md'].filter((t) => !before.includes(t)).sort());
  await expect(page.locator('.cm-content')).toContainText('Daily notes');
});

test('delete: one confirm with the count and names, folders take selected children along', async ({ page, ws }) => {
  await boot(page, ws);
  await row(page, 'code').click(); // open code/ too
  await row(page, 'code/query.sql').click({ modifiers: [MOD] });
  await row(page, 'notes/kubernetes.md').click({ modifiers: [MOD] });
  await row(page, 'README.md').click({ modifiers: [MOD] });
  await expect(hint(page)).toHaveText('4 selected'); // code, code/query.sql, kubernetes, README
  await page.keyboard.press('Delete');
  const dialog = page.locator('.se-dialog');
  await expect(dialog.locator('.se-dialog-title')).toHaveText('Delete 3 items?'); // query.sql goes with code/
  await expect(dialog.locator('.se-dialog-msg')).toContainText('Folders go with everything in them');
  await expect(dialog.locator('.se-dialog-details li')).toHaveText(['code', 'notes/kubernetes.md', 'README.md']);
  await dialog.locator('.se-btn.danger').click();
  await expect.poll(() => [exists(ws.root, 'code'), exists(ws.root, 'notes/kubernetes.md'), exists(ws.root, 'README.md')]).toEqual([false, false, false]);
  expect(exists(ws.root, 'notes/Daily notes.md')).toBe(true);
  for (const p of ['code', 'kubernetes.md', 'README.md']) expect(fs.existsSync(path.join(process.env.SEC_EDIT_TRASH_DIR!, p))).toBe(true);
  await expect(row(page, 'README.md')).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0); // deleted rows left the selection
});

test('drag-move: a selected row drags the whole selection; a folder is never dropped into itself', async ({ page, ws }) => {
  await boot(page, ws);
  await row(page, 'notes/kubernetes.md').click();
  await row(page, 'README.md').click({ modifiers: [MOD] });
  await row(page, 'README.md').dragTo(row(page, 'code'));
  await expect.poll(() => [exists(ws.root, 'code/README.md'), exists(ws.root, 'code/kubernetes.md')]).toEqual([true, true]);
  expect([exists(ws.root, 'README.md'), exists(ws.root, 'notes/kubernetes.md')]).toEqual([false, false]);
  // The moved rows stay selected where they landed.
  await expect.poll(() => selected(page)).toEqual(['code/kubernetes.md', 'code/README.md']);

  // deep/ + a file, dropped onto deep/nested: refused as a whole, nothing moves.
  await row(page, 'deep').click();
  await expect(row(page, 'deep/nested')).toBeVisible();
  await row(page, 'notes/windows-crlf.md').click({ modifiers: [MOD] });
  await expect.poll(() => selected(page)).toEqual(['deep', 'notes/windows-crlf.md']);
  await row(page, 'notes/windows-crlf.md').dragTo(row(page, 'deep/nested'));
  await page.waitForTimeout(300); // a move would have landed by now
  expect([exists(ws.root, 'deep/nested/folder/Deep note.md'), exists(ws.root, 'notes/windows-crlf.md')]).toEqual([true, true]);
  // An unselected row drags alone.
  await row(page, 'notes/Daily notes.md').dragTo(row(page, 'deep/nested'));
  await expect.poll(() => exists(ws.root, 'deep/nested/Daily notes.md')).toBe(true);
  expect(exists(ws.root, 'notes/windows-crlf.md')).toBe(true);
});

test('selection menu: only multi-item actions; copy paths (relative and absolute); survives watcher events, prunes on collapse', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page, ws);
  await row(page, 'notes/kubernetes.md').click();
  await row(page, 'README.md').click({ modifiers: [MOD] });
  await row(page, 'notes/windows-crlf.md').click({ modifiers: [MOD] });

  await row(page, 'README.md').click({ button: 'right' });
  const items = page.locator('.se-menu-item .se-menu-label');
  await expect(items).toHaveText(['Open 3 files', 'Bookmark 3 items', 'Delete 3 items', 'Copy paths', 'Copy relative paths']);
  await page.locator('.se-menu-item', { hasText: 'Copy relative paths' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('notes/kubernetes.md\nnotes/windows-crlf.md\nREADME.md');
  await row(page, 'README.md').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: /^Copy paths$/ }).click();
  const root = await page.evaluate(() => (window as any).__secEdit.workspace.value.root as string);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(['notes/kubernetes.md', 'notes/windows-crlf.md', 'README.md'].map((p) => `${root.replace(/\/+$/, '')}/${p}`).join('\n'));

  // A file appearing on disk (watcher) re-renders the tree; the selection stays.
  await ws.write('new-from-disk.md', 'x');
  await expect(row(page, 'new-from-disk.md')).toBeVisible();
  await expect(hint(page)).toHaveText('3 selected');

  // Right-click outside the selection: that row alone, with its full single-item menu.
  await row(page, 'notes/Daily notes.md').click({ button: 'right' });
  await expect(items).toContainText(['Open', 'Rename', 'Delete', 'Copy path']);
  await page.keyboard.press('Escape');
  await expect.poll(() => selected(page)).toEqual(['notes/Daily notes.md']);

  // Collapsing a folder drops its rows from the selection.
  await row(page, 'notes/kubernetes.md').click();
  await row(page, 'README.md').click({ modifiers: [MOD] });
  await expect(hint(page)).toHaveText('2 selected');
  await page.getByRole('button', { name: 'Collapse all' }).click();
  await expect.poll(() => selected(page)).toEqual(['README.md']);
  await expect(hint(page)).toHaveCount(0);
});

test('classic sidebar: several selected rows are tinted, the focused one has a ring', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ sidebarStyle: 'classic' });
  await boot(page, ws);
  await row(page, 'notes/kubernetes.md').click();
  await row(page, 'README.md').click({ modifiers: [MOD] });
  await expect(hint(page)).toHaveText('2 selected');
  const look = (p: string) => row(page, p).evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ring: getComputedStyle(el).boxShadow }));
  const plain = await look('notes/windows-crlf.md');
  const sel = await look('notes/kubernetes.md'); // selected + the open file
  const focus = await look('README.md');
  expect(sel.bg).not.toBe(plain.bg);
  expect(focus.bg).toBe(sel.bg); // both selected: the same tint, the open file is not lighter
  expect(focus.ring).not.toBe('none');
});
