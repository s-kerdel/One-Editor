// "Diff with last commit" (tree / tab menu, palette, status bar) is the same view as a click on a
// Source control row: a box per changed block plus the file's own box. Ticking one block stages only it;
// unsaved edits are saved first; a new file never offers the item.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { git, gitReady, initRepo } from './git-helpers';

const changed = (out: string) => out.split('\n').filter((l) => /^[-+](?![-+]{2} )/.test(l));
const LINES = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

/** big.txt: 30 committed lines, lines 3 and 25 changed in the folder. */
function bigRepo(root: string) {
  fs.writeFileSync(path.join(root, 'big.txt'), LINES.join('\n') + '\n');
  initRepo(root);
  const work = [...LINES];
  work[2] = 'LINE 3';
  work[24] = 'LINE 25';
  fs.writeFileSync(path.join(root, 'big.txt'), work.join('\n') + '\n');
  return work;
}
const disk = (root: string) => fs.readFileSync(path.join(root, 'big.txt'), 'utf8');
async function fromTree(page: Page, file: string) {
  await page.locator(`.se-tree-row[data-path="${file}"]`).click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Diff with last commit' }).click();
  return page.locator('.se-git-diff');
}

test.describe('Diff with last commit: the commit boxes', () => {
  test('tree menu → tick one block → only that block is staged; the file box follows; the pane shows the same', async ({ page, ws }) => {
    const work = bigRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    const diff = await fromTree(page, 'big.txt');
    await expect(diff).toHaveAttribute('data-editable', 'true');
    const bars = diff.locator('.se-git-hunkbar');
    await expect(bars).toHaveCount(2);
    await expect(bars.locator('[role="checkbox"][aria-checked="false"]')).toHaveCount(2);
    await expect(bars.first().locator('.se-check')).toHaveCSS('width', '14px'); // the box's style comes with the view, not with the pane
    const file = diff.locator('.se-git-diff-include');
    await expect(file).toHaveAttribute('aria-checked', 'false');

    await bars.nth(1).click();
    await expect(bars.nth(1).locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 25', '+LINE 25']);
    await expect(bars.nth(0).locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'false');
    await expect(file).toHaveAttribute('aria-checked', 'mixed');
    expect(disk(ws.root)).toBe(work.join('\n') + '\n'); // staging never changes the file

    // The file's own box: everything in, then everything out.
    await file.click();
    await expect(file).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 3', '+LINE 3', '-line 25', '+LINE 25']);
    await expect(bars.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(2);
    await file.click();
    await expect.poll(() => git(ws.root, 'diff', '--cached').trim()).toBe('');
    await bars.nth(0).click();
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 3', '+LINE 3']);
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);

    // The Source control pane reads the same index: the row is partly ticked.
    await page.locator('[data-panel="git"]').click();
    await expect(page.getByTestId('scm').locator('.se-scm-row[data-path="big.txt"] [role="checkbox"]')).toHaveAttribute('aria-checked', 'mixed');
  });

  test('palette, with unsaved edits: ticking a block saves first, then stages just that block', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    bigRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('big.txt'));
    await expect(page.locator('.cm-content')).toContainText('LINE 3');
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('Diff with last commit');
    await page.keyboard.press('Enter');
    const diff = page.locator('.se-git-diff');
    const bars = diff.locator('.se-git-hunkbar');
    await expect(bars).toHaveCount(2);

    await page.locator('.se-git-diff .cm-line', { hasText: "line 5" }).last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await expect(diff.getByTestId('git-diff-editable')).toContainText('unsaved edits');
    expect(disk(ws.root)).not.toContain('typed');

    await bars.nth(0).click(); // LINE 3
    await expect.poll(() => disk(ws.root)).toContain('line 5 typed\n');
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 3', '+LINE 3']);
    await expect(bars).toHaveCount(3); // the typed line is a block of its own now, not in the commit
    await expect(bars.locator('[role="checkbox"][aria-checked="true"]')).toHaveCount(1);
  });

  test('a file with only unsaved edits: no blocks yet, they appear with the save, in the same view', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    fs.writeFileSync(path.join(ws.root, 'big.txt'), LINES.join('\n') + '\n');
    initRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('big.txt'));
    await expect(page.locator('.cm-content')).toContainText('line 1');
    await page.evaluate(() => (window as any).__secEdit.editor.applyChanges('big.txt', [{ from: 0, to: 0, insert: 'zero\n' }]));
    await page.locator('.se-tab', { hasText: 'big.txt' }).click({ button: 'right' });
    await page.locator('.se-menu-item', { hasText: 'Diff with last commit' }).click();
    const diff = page.locator('.se-git-diff');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+1 −0');
    await expect(diff.locator('.se-git-diff-sub')).toContainText('blocks to pick appear once saved');
    await expect(diff.locator('.se-git-hunkbar')).toHaveCount(0);

    await page.keyboard.press('Control+s');
    await expect.poll(() => disk(ws.root)).toContain('zero\n');
    const bars = diff.locator('.se-git-hunkbar');
    await expect(bars).toHaveCount(1);
    await expect(diff.locator('.se-git-diff-include')).toHaveAttribute('aria-checked', 'false');
    await bars.first().click();
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['+zero']);
    await expect(diff.locator('.se-git-diff-include')).toHaveAttribute('aria-checked', 'true');
  });

  test('no changes: the plain "No changes" view without boxes; a new file has no such item', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'new.md'), '# new\n');
    await ws.open(page);
    await gitReady(page);
    const diff = await fromTree(page, 'README.md');
    await expect(diff.getByTestId('git-diff-empty')).toContainText('No changes since the last commit');
    await expect(diff.locator('.se-git-diff-include')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator('.se-tree-row[data-path="new.md"]').click({ button: 'right' });
    await expect(page.locator('.se-menu')).toBeVisible();
    await expect(page.locator('.se-menu-item', { hasText: 'Diff with last commit' })).toHaveCount(0);
  });
});
