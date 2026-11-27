// Compare text (editor right-click): select → compare with previous selection, compare with the
// clipboard, swap / ignore whitespace / copy as patch, and the setting that hides it all.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { isolateGit } from './git-helpers';

isolateGit();

async function selectLines(page: Page, from: number, to: number) {
  await page.evaluate(
    ([a, b]) => {
      const v = (window as any).__secEdit.editor.getView();
      v.focus();
      v.dispatch({ selection: { anchor: v.state.doc.line(a).from, head: v.state.doc.line(b).to } });
    },
    [from, to],
  );
}
async function menu(page: Page, label: string) {
  await page.locator('.cm-content').click({ button: 'right', position: { x: 40, y: 8 } });
  const item = page.locator('.se-menu-item', { hasText: label });
  await expect(item).toBeVisible();
  return item;
}
const open = (page: Page, p: string) => page.evaluate((p) => (window as any).__secEdit.openFile(p), p);

test('select text for compare → compare with previous selection (across files): git diff, swap, ignore whitespace, copy as patch', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.write('left.ts', 'const a = 1;\nconst b = 2;\nfunction f() {\n  return a + b;\n}\n');
  await ws.write('right.ts', 'const a = 1;\nconst b = 3;\nfunction f() {\n\treturn a + b;\n}\nexport { f };\n');
  await ws.open(page);
  await open(page, 'left.ts');
  await expect(page.locator('.cm-content')).toContainText('const b = 2');
  await expect(await menu(page, 'Compare Text with Previous Selection')).toBeDisabled();
  await page.keyboard.press('Escape');

  await selectLines(page, 1, 5);
  await (await menu(page, 'Select Text for Compare')).click();
  await expect(page.locator('.se-toast')).toContainText('Selected for compare: left.ts · lines 1-5');

  await open(page, 'right.ts');
  await expect(page.locator('.cm-content')).toContainText('export { f }');
  await (await menu(page, 'Compare Text with Previous Selection')).click();
  const diff = page.locator('.se-git-diff');
  await expect(diff.locator('.se-git-diff-name')).toHaveText('Compare text');
  await expect(diff.locator('.se-git-diff-sub')).toContainText('left.ts · lines 1-5 ↔ right.ts');
  await expect(diff.locator('.se-git-diff-engine')).toContainText('git diff --histogram');
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −2');

  await diff.getByLabel('Ignore whitespace').check();
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −1'); // the tab-indented line is equal now
  await diff.getByRole('button', { name: /Swap sides/ }).click();
  await expect(diff.locator('.se-git-diff-sub')).toContainText('right.ts ↔ left.ts · lines 1-5');
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+1 −2');

  await diff.getByRole('button', { name: 'Copy as patch' }).click();
  const patch = await page.evaluate(() => navigator.clipboard.readText());
  expect(patch).toContain('--- a/right.ts\n+++ b/left.ts · lines 1-5');
  expect(patch).toContain('-export { f };');

  await page.keyboard.press('Escape');
  await expect(diff).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent())).toContain('export { f }'); // sources untouched
  await diff.waitFor({ state: 'detached' });
  await page.evaluate(() => localStorage.removeItem('sec-edit.compare.ignoreWhitespace'));
});

test('compare text with clipboard: the selection (or whole file) vs the clipboard', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.open(page);
  await open(page, 'code/app.ts');
  const content: string = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  await page.evaluate((t) => navigator.clipboard.writeText(t), content.replace(/\n/, '\nINSERTED FROM CLIPBOARD\n').replace(/\n/g, '\r\n'));
  await (await menu(page, 'Compare Text with Clipboard')).click();
  const diff = page.locator('.se-git-diff');
  await expect(diff.locator('.se-git-diff-sub')).toContainText('code/app.ts ↔ Clipboard');
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+1 −0'); // CRLF in the clipboard is not a change
  await diff.getByRole('radio', { name: 'Side by side' }).click();
  await expect(diff.locator('.cm-mergeView .cm-editor').nth(1)).toContainText('INSERTED FROM CLIPBOARD');
  await page.keyboard.press('Escape');

  // Tree menu: a whole file vs the clipboard.
  await page.evaluate(() => navigator.clipboard.writeText('totally different'));
  await page.locator('.se-tree-row[data-path="README.md"]').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Compare with Clipboard' }).click();
  await expect(page.locator('.se-git-diff .se-git-diff-sub')).toContainText('README.md ↔ Clipboard');
});

test('setting off: no compare items in the editor menu', async ({ page, ws }) => {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.backend.saveSettings({ 'compare.enabled': false }));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await open(page, 'README.md');
  await page.locator('.cm-content').click({ button: 'right', position: { x: 40, y: 8 } });
  await expect(page.locator('.se-menu')).toBeVisible();
  await expect(page.locator('.se-menu-item', { hasText: /Compare/ })).toHaveCount(0);
});
