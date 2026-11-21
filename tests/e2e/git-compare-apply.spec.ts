// Compare: apply a block to the other side, both directions. Only a side that IS a workspace file takes
// text (its own document: unsaved dot, Ctrl+S, Ctrl+Z); the clipboard, a selection and the last commit
// are sources only, so no control ever points at them.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { gitReady, initRepo, isolateGit } from './git-helpers';

isolateGit();

const LEFT = 'alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\n';
const RIGHT = 'alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\nTHETA\niota\n';
const open = (page: Page, p: string) => page.evaluate((p) => (window as any).__secEdit.openFile(p), p);
const content = (page: Page, p: string) => page.evaluate((p) => (window as any).__secEdit.editor.getContent(p) as string, p);
const dirtyTab = (page: Page, name: string) => page.locator('.se-tab.dirty', { hasText: name });
async function menu(page: Page, label: string) {
  await page.locator('.cm-content').first().click({ button: 'right', position: { x: 40, y: 8 } });
  const item = page.locator('.se-menu-item', { hasText: label });
  await expect(item).toBeVisible();
  await item.click();
}
/** left.txt (remembered as a whole file) ↔ right.txt (the active tab). */
async function compareFiles(page: Page, layout: 'split' | 'unified') {
  await page.evaluate((l) => localStorage.setItem('sec-edit.git.diffLayout', l), layout);
  await open(page, 'left.txt');
  await expect(page.locator('.cm-content')).toContainText('alpha');
  await menu(page, 'Select Text for Compare');
  await open(page, 'right.txt');
  await expect(page.locator('.cm-content')).toContainText('BETA');
  await menu(page, 'Compare Text with Previous Selection');
  const diff = page.locator('.se-git-diff');
  await expect(diff.locator('.se-git-diff-sub')).toContainText('left.txt ↔ right.txt');
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −2');
  return diff;
}
const to = (diff: ReturnType<Page['locator']>, side: 'a' | 'b') => diff.locator(`.se-git-revert[data-to="${side}"]`);

test.describe('compare: apply a block to the other side', () => {
  test.beforeEach(async ({ ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    await ws.write('left.txt', LEFT);
    await ws.write('right.txt', RIGHT);
  });

  test('side by side, two workspace files: arrows both ways; both documents change, Ctrl+Z restores, Ctrl+S saves', async ({ page, ws }) => {
    await ws.open(page);
    const diff = await compareFiles(page, 'split');
    await expect(diff).toHaveAttribute('data-apply', 'ab');
    await expect(diff.getByTestId('git-diff-editable')).toContainText('both sides editable');
    await expect(to(diff, 'a')).toHaveCount(2);
    await expect(to(diff, 'b')).toHaveCount(2);
    await expect(to(diff, 'a').first()).toHaveAttribute('aria-label', 'Apply this block to left.txt (the left side)');
    await expect(to(diff, 'b').first()).toHaveAttribute('aria-label', 'Apply this block to right.txt (the right side)');
    const [left, right] = [diff.locator('.cm-mergeView .cm-editor').nth(0), diff.locator('.cm-mergeView .cm-editor').nth(1)];

    // Right → left: BETA goes into left.txt (a background tab), and only there.
    await to(diff, 'a').first().click();
    await expect(left.locator('.cm-content')).toContainText('BETA');
    expect(await content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    expect(await content(page, 'right.txt')).toBe(RIGHT);
    await expect(dirtyTab(page, 'left.txt')).toHaveCount(1);
    await expect(dirtyTab(page, 'right.txt')).toHaveCount(0);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −1'); // the block list follows, live
    await expect(to(diff, 'a')).toHaveCount(1);
    await expect(diff.getByTestId('git-diff-editable')).toContainText('unsaved edits');

    // Left → right: the remaining block (theta ↔ THETA + iota) takes the left side's lines.
    await to(diff, 'b').first().click();
    await expect(right.locator('.cm-content')).not.toContainText('THETA');
    expect(await content(page, 'right.txt')).toBe(RIGHT.replace('THETA\niota\n', 'theta\n'));
    await expect(dirtyTab(page, 'right.txt')).toHaveCount(1);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+0 −0');
    await expect(diff.locator('.se-git-revert')).toHaveCount(0);
    expect(await content(page, 'left.txt')).toBe(await content(page, 'right.txt'));
    expect(await ws.read('left.txt')).toBe(LEFT); // nothing saved behind the user's back
    expect(await ws.read('right.txt')).toBe(RIGHT);

    // Ctrl+Z: the side that just changed (right), then the left one after a click into it.
    await page.keyboard.press('Control+z');
    await expect(right.locator('.cm-content')).toContainText('THETA');
    expect(await content(page, 'right.txt')).toBe(RIGHT);
    await expect(dirtyTab(page, 'right.txt')).toHaveCount(0);
    await left.locator('.cm-line', { hasText: 'alpha' }).click();
    await page.keyboard.press('Control+z');
    expect(await content(page, 'left.txt')).toBe(LEFT);
    await expect(dirtyTab(page, 'left.txt')).toHaveCount(0);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −2');
    await expect(to(diff, 'a')).toHaveCount(2);

    // Keyboard: F7 to the block, Ctrl+Shift+F7 = to the left; typing on the left works too. Ctrl+S saves both.
    await right.locator('.cm-line', { hasText: 'alpha' }).click();
    await page.keyboard.press('F7');
    await page.keyboard.press('Control+Shift+F7');
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await right.locator('.cm-line', { hasText: 'gamma' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Control+s');
    await expect.poll(() => ws.read('left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await expect.poll(() => ws.read('right.txt')).toBe(RIGHT.replace('gamma', 'gamma!'));
    await expect(page.locator('.se-tab.dirty')).toHaveCount(0);

    // Closing the compare loses nothing.
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);
    expect(await content(page, 'right.txt')).toBe(RIGHT.replace('gamma', 'gamma!'));
  });

  test('unified: "Apply to ‹name›" each way on the block; Ctrl+Z walks back over both files', async ({ page, ws }) => {
    await ws.open(page);
    const diff = await compareFiles(page, 'unified');
    await expect(to(diff, 'a')).toHaveText(['Apply to left.txt', 'Apply to left.txt']);
    await expect(to(diff, 'b')).toHaveText(['Apply to right.txt', 'Apply to right.txt']);

    await to(diff, 'a').first().click(); // BETA → left.txt
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await expect(dirtyTab(page, 'left.txt')).toHaveCount(1);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −1');
    await to(diff, 'b').first().click(); // theta → right.txt
    await expect.poll(() => content(page, 'right.txt')).toBe(RIGHT.replace('THETA\niota\n', 'theta\n'));
    await expect(dirtyTab(page, 'right.txt')).toHaveCount(1);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+0 −0');

    await page.keyboard.press('Control+z'); // newest first: the right file
    await expect.poll(() => content(page, 'right.txt')).toBe(RIGHT);
    expect(await content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await page.keyboard.press('Control+z'); // then the left file
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT);
    await expect(page.locator('.se-tab.dirty')).toHaveCount(0);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −2');
    await page.keyboard.press('Control+y');
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));

    // Switching the layout keeps the edits and the controls.
    await diff.getByRole('radio', { name: 'Side by side' }).click();
    await expect(to(diff, 'a')).toHaveCount(1);
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(0).locator('.cm-content')).toContainText('BETA');
    await page.evaluate(() => localStorage.removeItem('sec-edit.git.diffLayout'));
  });

  test('swap sides and ignore whitespace: the controls follow; whitespace mode switches them off and says why', async ({ page, ws }) => {
    await ws.open(page);
    const diff = await compareFiles(page, 'split');
    await to(diff, 'a').first().click();
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await diff.getByRole('button', { name: /Swap sides/ }).click();
    await expect(diff.locator('.se-git-diff-sub')).toContainText('right.txt ↔ left.txt');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+1 −2');
    await expect(to(diff, 'a').first()).toHaveAttribute('aria-label', 'Apply this block to right.txt (the left side)');
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(1).locator('.cm-content')).toContainText('BETA'); // the edit came along

    await diff.getByLabel('Ignore whitespace').check();
    await expect(diff.locator('.se-git-revert[aria-disabled="true"]')).toHaveCount(2);
    await expect(diff.locator('.se-git-revert').first()).toHaveAttribute('title', /Switch off “Ignore whitespace”/);
    await expect(diff.getByTestId('git-diff-editable')).toHaveCount(0);
    const before = await content(page, 'left.txt');
    await diff.locator('.se-git-revert').first().click({ force: true }); // switched off: nothing happens
    await page.keyboard.press('Control+F7');
    expect(await content(page, 'left.txt')).toBe(before);
    await diff.getByLabel('Ignore whitespace').uncheck();
    await expect(diff.locator('.se-git-revert[aria-disabled="true"]')).toHaveCount(0);
    await expect(to(diff, 'b')).toHaveCount(1);
    await page.evaluate(() => (localStorage.removeItem('sec-edit.compare.ignoreWhitespace'), localStorage.removeItem('sec-edit.git.diffLayout')));
  });

  test('a file that has no tab: it is a target too, and gets its tab with the first block', async ({ page, ws }) => {
    await ws.open(page);
    await page.evaluate(() => localStorage.setItem('sec-edit.git.diffLayout', 'split'));
    await open(page, 'left.txt');
    await expect(page.locator('.cm-content')).toContainText('alpha');
    await menu(page, 'Select Text for Compare');
    await open(page, 'right.txt');
    await page.evaluate(() => (window as any).__secEdit.closeTab('left.txt'));
    await expect(page.locator('.se-tab', { hasText: 'left.txt' })).toHaveCount(0);
    await menu(page, 'Compare Text with Previous Selection');
    const diff = page.locator('.se-git-diff');
    await expect(to(diff, 'a')).toHaveCount(2); // read from disk: still exactly the file
    await to(diff, 'a').first().click();
    await expect(dirtyTab(page, 'left.txt')).toHaveCount(1);
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await page.evaluate(() => localStorage.removeItem('sec-edit.git.diffLayout'));
  });

  test('read-only sources: no control towards the clipboard, a selection or the last commit', async ({ page, ws, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    fs.writeFileSync(path.join(ws.root, 'left.txt'), LEFT);
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'left.txt'), LEFT.replace('beta', 'BETA'));
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => localStorage.setItem('sec-edit.git.diffLayout', 'split'));

    // File (left) ↔ clipboard (right): blocks only go left, the clipboard side takes no text.
    await open(page, 'left.txt');
    await expect(page.locator('.cm-content')).toContainText('BETA');
    await page.evaluate((t) => navigator.clipboard.writeText(t), RIGHT.replace(/\n/g, '\r\n'));
    await menu(page, 'Compare Text with Clipboard');
    const diff = page.locator('.se-git-diff');
    await expect(diff.locator('.se-git-diff-sub')).toContainText('left.txt ↔ Clipboard');
    await expect(diff).toHaveAttribute('data-apply', 'a');
    await expect(to(diff, 'a')).toHaveCount(1);
    await expect(to(diff, 'b')).toHaveCount(0);
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(1).locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
    await expect(diff.getByTestId('git-diff-editable')).toContainText('left side editable');
    await page.keyboard.press('Control+F7'); // "to the right" has no target
    await to(diff, 'a').first().click(); // THETA + iota from a CRLF clipboard: LF in the document
    await expect.poll(() => content(page, 'left.txt')).toBe(RIGHT);
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(1).locator('.cm-content')).toContainText('THETA');
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    // Unified: the same single direction.
    await diff.getByRole('radio', { name: 'Unified' }).click();
    await expect(to(diff, 'a')).toHaveText(['Apply to left.txt']);
    await expect(to(diff, 'b')).toHaveCount(0);
    await to(diff, 'a').first().click();
    await expect.poll(() => content(page, 'left.txt')).toBe(RIGHT);
    await page.keyboard.press('Control+z');
    await expect.poll(() => content(page, 'left.txt')).toBe(LEFT.replace('beta', 'BETA'));
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);
    await page.evaluate(() => localStorage.setItem('sec-edit.git.diffLayout', 'split'));

    // A selection (left) ↔ the clipboard (right): nothing can be applied at all.
    await page.evaluate(() => {
      const v = (window as any).__secEdit.editor.getView();
      v.focus();
      v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(4).to } });
    });
    await menu(page, 'Compare Text with Clipboard');
    await expect(diff.locator('.se-git-diff-sub')).toContainText('left.txt · lines 1–4 ↔ Clipboard');
    await expect(diff.locator('.cm-mergeView .cm-editor')).toHaveCount(2);
    await expect(diff.locator('.se-git-revert')).toHaveCount(0);
    await expect(diff).not.toHaveAttribute('data-apply', /./);
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);

    // Diff with last commit: one control per block, towards the working copy only ("Revert").
    await page.locator('.se-tab', { hasText: 'left.txt' }).click({ button: 'right' });
    await page.locator('.se-menu-item', { hasText: 'Diff with last commit' }).click();
    await expect(diff).toHaveAttribute('data-apply', 'b');
    await expect(to(diff, 'b')).toHaveCount(1);
    await expect(to(diff, 'a')).toHaveCount(0);
    await expect(to(diff, 'b').first()).toHaveAttribute('aria-label', 'Revert this block: put the old lines back');
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(0).locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
    await page.keyboard.press('Control+Shift+F7'); // never writes to the commit side
    await expect(diff.locator('.cm-mergeView .cm-editor').nth(0).locator('.cm-content')).toContainText('beta');
    await page.evaluate(() => localStorage.removeItem('sec-edit.git.diffLayout'));
  });
});
