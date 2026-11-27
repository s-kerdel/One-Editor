// A binary file opened as text ("Open as text anyway") is read only: typing and edit keys change nothing,
// the tab never turns dirty, closing it asks nothing, the banner says what it is, "Back to viewer" shows
// the card again, "Load all" keeps the cursor, and a binary .md gets no reading view.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

// NUL bytes in the first 8 KB = binary for the backend.
const SMALL = Buffer.concat([Buffer.from('PK header zebrastripe\n'), Buffer.from([0, 0, 0, 1, 2]), Buffer.from('\nsecond line\n')]);

const content = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.editor.getContent(x) as string | undefined, p);
const dirty = (page: Page, p: string) => page.evaluate((x) => !!(window as any).__secEdit.docs.get(x)?.dirty.value, p);

async function openAsText(page: Page, name: string) {
  await page.locator('.se-tree-row', { hasText: name }).click();
  const card = page.locator('.se-viewer-binary');
  await expect(card).toContainText('is a binary file');
  await card.getByRole('button', { name: 'Open as text anyway' }).click();
  await expect(page.locator('[data-banner="read-only"]')).toBeVisible();
}

test('shown as text: read only, never dirty, closes without a prompt, Back to viewer', async ({ page, ws }) => {
  await fsp.writeFile(path.join(ws.root, 'blob.bin'), SMALL);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  await openAsText(page, 'blob.bin');

  const banner = page.locator('[data-banner="read-only"]');
  await expect(banner).toContainText('Read only · binary file shown as text');
  await expect(banner.getByRole('button', { name: /Load all/ })).toHaveCount(0); // small file: all of it is shown
  await expect(page.locator('.cm-content')).toContainText('zebrastripe');
  await expect(page.locator('.se-save-state[data-state="readonly"]')).toHaveText('Read only');
  await expect(page.locator('.se-tab.active')).toHaveAttribute('data-readonly', 'true');
  const before = await content(page, 'blob.bin');

  // Typing and every edit key do nothing; the cursor still moves.
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await expect(page.locator('.se-status-item[title="Line, column"]')).toContainText('Ln 4');
  await page.keyboard.type('typed!');
  for (const k of ['Enter', 'Backspace', 'Tab', 'Delete', 'Control+z', 'Control+a', 'Control+x', 'Control+v']) await page.keyboard.press(k);
  expect(await content(page, 'blob.bin')).toBe(before);
  expect(await dirty(page, 'blob.bin')).toBe(false);
  await expect(page.locator('.se-tab.dirty')).toHaveCount(0);

  // Find works; replace is not offered. Reading view is not available (Ctrl+E does nothing).
  await page.keyboard.press('Control+f');
  await expect(page.locator('.cm-search input[name=search]')).toBeVisible();
  await expect(page.locator('.cm-search input[name=replace]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+e');
  await expect(page.locator('.se-editor-area')).toHaveClass(/mode-source/);

  // Back to viewer: the card again, no banner, no text kept.
  await banner.getByRole('button', { name: 'Back to viewer' }).click();
  await expect(page.locator('.se-viewer-binary')).toBeVisible();
  await expect(banner).toHaveCount(0);
  expect(await content(page, 'blob.bin')).toBeUndefined();

  // Again as text, then close the tab: no "Save changes?".
  await page.locator('.se-viewer-binary').getByRole('button', { name: 'Open as text anyway' }).click();
  await expect(banner).toBeVisible();
  await page.locator('.cm-content').click();
  await page.keyboard.type('more typing');
  await page.locator('.se-tab[data-path="blob.bin"]').getByRole('button', { name: 'Close blob.bin' }).click();
  await expect(page.locator('.se-tab[data-path="blob.bin"]')).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0); // the "Save changes?" ask
  expect(await fsp.readFile(path.join(ws.root, 'blob.bin'))).toEqual(SMALL); // untouched on disk
  expect(errors).toEqual([]);
});

test('a big binary file: the first 2 MB, Load all keeps the cursor and stays read only', async ({ page, ws }) => {
  const big = Buffer.alloc(2_400_000, 0x41);
  for (let i = 99; i < big.length; i += 100) big[i] = 0x0a;
  big[5] = 0;
  await fsp.writeFile(path.join(ws.root, 'big.bin'), big);
  await ws.open(page);
  await openAsText(page, 'big.bin');

  const banner = page.locator('[data-banner="read-only"]');
  await expect(banner).toContainText('first 2 MB of 2.3 MB');
  expect((await content(page, 'big.bin'))?.length).toBe(2 * 1024 * 1024);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown');
  const ln = page.locator('.se-status-item[title="Line, column"]');
  await expect(ln).toContainText('Ln 4');

  await banner.getByRole('button', { name: 'Load all (2.3 MB)' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Load 2.3 MB' }).click();
  await expect(banner).not.toContainText('first 2 MB');
  await expect(banner.getByRole('button', { name: /Load all/ })).toHaveCount(0);
  await expect.poll(async () => (await content(page, 'big.bin'))?.length).toBe(big.length);
  await expect(ln).toContainText('Ln 4');
  expect(await dirty(page, 'big.bin')).toBe(false);
});

test('a binary .md shown as text is plain text: no reading view, split or Markdown toolbar', async ({ page, ws }) => {
  await fsp.writeFile(path.join(ws.root, 'weird.md'), Buffer.concat([Buffer.from('# Looks like a note\n'), Buffer.from([0, 0, 0]), Buffer.from('\n- item\n')]));
  await ws.open(page);
  await openAsText(page, 'weird.md');
  await expect(page.locator('.cm-editor.se-codefile')).toBeVisible();
  await expect(page.locator('.se-modes')).toHaveCount(0);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+e');
  await page.keyboard.press('Control+\\');
  await expect(page.locator('.se-editor-area')).toHaveClass(/mode-source/);
  await expect(page.locator('.se-preview-host')).toBeHidden();
});
