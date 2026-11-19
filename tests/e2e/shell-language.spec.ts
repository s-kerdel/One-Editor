// Status bar language mode: searchable picker, per-file override kept in the session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

process.env.SEC_EDIT_TRASH_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sec-edit-e2e-trash-'));

const row = (page: Page, name: string) => page.locator('.se-tree-row', { hasText: name }).first();
const overrides = async (ws: WsFixture) => ((await ws.server.service.getSession()) as any)?.languageOverrides ?? {};
/** What the editor reports, when it implements the optional language API. */
const editorLang = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.editor?.getLanguage?.(x)?.id ?? null, p);
const hasEditorApi = (page: Page) => page.evaluate(() => typeof (window as any).__secEdit.editor?.setLanguage === 'function');

async function open(page: Page, ws: WsFixture, file: string) {
  await ws.open(page);
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), file);
  await expect(page.locator('.se-tab.active')).toContainText(file.split('/').pop()!);
  await expect(page.locator('.cm-content')).toBeVisible();
}

test('clicking the language opens a searchable, keyboard-driven picker anchored to it', async ({ page, ws }) => {
  await open(page, ws, 'code/query.sql');
  const lang = page.getByTestId('language');
  await expect(lang).toHaveText('SQL');
  await lang.click();
  const picker = page.getByTestId('picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('input')).toBeFocused();
  // Hangs right above the status bar item, inside the window.
  await page.waitForTimeout(200); // pop-in animation
  const [p, a] = await page.evaluate(() => [document.querySelector('[data-testid="picker"]')!.getBoundingClientRect(), document.querySelector('[data-testid="language"]')!.getBoundingClientRect()].map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })));
  expect(a.top - p.bottom).toBeGreaterThanOrEqual(2);
  expect(a.top - p.bottom).toBeLessThanOrEqual(12);
  expect(p.right).toBeLessThanOrEqual(1360);
  expect(Math.abs(p.right - a.right)).toBeLessThanOrEqual(12);
  expect(p.top).toBeGreaterThan(0);

  const options = picker.locator('[role="option"]');
  await expect(options.nth(0)).toContainText('Auto-detect');
  await expect(options.nth(0)).toContainText('by extension');
  await expect(options.nth(1)).toHaveText('Plain text');
  // Every language CodeMirror can highlight is offered; ones without a grammar are not.
  const names = await options.allTextContents();
  for (const n of ['Markdown', 'PHP', 'TypeScript', 'JSON', 'Python', 'YAML', 'Shell']) expect(names.some((x) => x.startsWith(n)), n).toBe(true);
  expect(names.some((x) => x.startsWith('Mermaid'))).toBe(false);
  expect(names.length).toBeGreaterThan(30);
  // Not overridden yet → auto-detect is the checked one.
  await expect(picker.locator('[aria-checked="true"]')).toContainText('Auto-detect');

  // Type to filter, arrows to move, Enter to pick.
  await page.keyboard.type('script');
  await expect(options).toHaveText([/^JavaScript/, /^TypeScript/]);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown'); // wraps
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(lang).toHaveText('TypeScript');
  await expect(page.locator('.cm-content')).toBeFocused();
  if (await hasEditorApi(page)) expect(await editorLang(page, 'code/query.sql')).toBe('typescript');
  await expect.poll(() => overrides(ws)).toEqual({ 'code/query.sql': 'typescript' });

  // Reopen: the override is the checked entry; Escape closes without changing anything.
  await lang.click();
  await expect(picker.locator('[aria-checked="true"]')).toContainText('TypeScript');
  await page.keyboard.type('zzzz');
  await expect(picker).toContainText('No match');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(lang).toHaveText('TypeScript');
  // Click outside closes too.
  await lang.click();
  await expect(picker).toBeVisible();
  await page.mouse.click(600, 300);
  await expect(picker).toHaveCount(0);

  // Plain text via mouse, then back to auto-detect.
  await lang.click();
  await picker.locator('[role="option"]', { hasText: 'Plain text' }).click();
  await expect(lang).toHaveText('Plain text');
  await expect.poll(() => overrides(ws)).toEqual({ 'code/query.sql': 'text' });
  await lang.click();
  await picker.locator('[role="option"]', { hasText: 'Auto-detect' }).click();
  await expect(lang).toHaveText('SQL');
  await expect.poll(() => overrides(ws)).toEqual({});
});

test('override is per file, survives a reload, and is re-applied when the doc opens', async ({ page, ws }) => {
  await open(page, ws, 'code/app.ts');
  // Palette command instead of the status bar.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('change language mode');
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('picker');
  await expect(picker).toBeVisible();
  await expect(picker).toHaveClass(/centered/);
  await page.keyboard.type('json');
  await page.keyboard.press('Enter');
  const lang = page.getByTestId('language');
  await expect(lang).toHaveText('JSON');
  // Another file keeps its own language.
  await page.evaluate(() => (window as any).__secEdit.openFile('code/UserController.php'));
  await expect(lang).toHaveText('PHP');
  await page.locator('.se-tab', { hasText: 'app.ts' }).click();
  await expect(lang).toHaveText('JSON');
  await expect.poll(() => overrides(ws)).toEqual({ 'code/app.ts': 'json' });
  await page.waitForTimeout(350);

  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await expect(page.locator('.se-tab.active')).toContainText('app.ts');
  await expect(lang).toHaveText('JSON');
  if (await hasEditorApi(page)) await expect.poll(() => editorLang(page, 'code/app.ts')).toBe('json');
  // Close and reopen the tab: still applied.
  await page.keyboard.press('Control+w');
  await expect(page.locator('.se-tab', { hasText: 'app.ts' })).toHaveCount(0);
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(lang).toHaveText('JSON');
  if (await hasEditorApi(page)) await expect.poll(() => editorLang(page, 'code/app.ts')).toBe('json');
});

test('override moves with a rename and is dropped when the file is deleted', async ({ page, ws }) => {
  await open(page, ws, 'README.md');
  const lang = page.getByTestId('language');
  await expect(lang).toHaveText('Markdown');
  await lang.click();
  await page.keyboard.type('yaml');
  await page.keyboard.press('Enter');
  await expect(lang).toHaveText('YAML');
  await expect.poll(() => overrides(ws)).toEqual({ 'README.md': 'yaml' });
  // A Markdown file shown as another language is a code view: no view modes, no width button.
  await expect(page.locator('.se-modes')).toHaveCount(0);
  await expect(page.getByTestId('content-width')).toHaveCount(0);

  await row(page, 'README').click();
  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  await page.locator('.se-tree-input').fill('INTRO.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-tab.active')).toContainText('INTRO.md');
  await expect.poll(() => overrides(ws)).toEqual({ 'INTRO.md': 'yaml' });
  await expect(lang).toHaveText('YAML');

  await row(page, 'INTRO').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Delete' }).click();
  await page.locator('.se-dialog .se-btn.danger').click();
  await expect(page.locator('.se-tab', { hasText: 'INTRO.md' })).toHaveCount(0);
  await expect.poll(() => overrides(ws)).toEqual({});
});
