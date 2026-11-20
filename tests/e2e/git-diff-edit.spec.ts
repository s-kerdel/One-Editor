// Editing in the diff view (browser mode): the working-copy side is the file's own document — typing
// marks its tab unsaved, Ctrl+S / autosave write it, a block can be reverted (and undone), a block
// ticked on unsaved edits saves first, and closing the diff keeps every edit. HEAD and History stay read-only.
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

async function openFromPane(page: Page, file = 'big.txt') {
  if (!(await page.getByTestId('scm').isVisible())) await page.locator('button[data-panel="git"]').click();
  await page.getByTestId('scm').locator(`.se-scm-row[data-path="${file}"] .se-scm-name`).click();
  const diff = page.locator('.se-git-diff');
  await expect(diff.locator('.cm-content').last()).toBeVisible();
  return diff;
}
/** Caret at the end of the working-copy line with this text. */
async function endOf(page: Page, text: string) {
  await page.locator('.se-git-diff .cm-line', { hasText: text }).last().click();
  await page.keyboard.press('End');
}
const dirtyTab = (page: Page, name: string) => page.locator('.se-tab.dirty', { hasText: name });

test.describe('edit in the diff view', () => {
  test('type in the working copy → tab unsaved → Ctrl+S writes the file, stats and blocks follow; revert a block, Ctrl+Z', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    const work = bigRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    const diff = await openFromPane(page);
    await expect(diff).toHaveAttribute('data-editable', 'true');
    await expect(diff.getByTestId('git-diff-editable')).toContainText('editable');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −2');
    await expect(diff.locator('.se-git-hunkbar')).toHaveCount(2);

    await endOf(page, 'line 5');
    await page.keyboard.type(' edited');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(1); // the file had no tab: the edit gave it one
    await expect(diff.getByTestId('git-diff-editable')).toContainText('unsaved edits');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −3'); // live
    expect(disk(ws.root)).toBe(work.join('\n') + '\n');

    await page.keyboard.press('Control+s');
    await expect.poll(() => disk(ws.root)).toContain('line 5 edited\n');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(0);
    await expect(diff.getByTestId('git-diff-editable')).not.toContainText('unsaved');
    await expect(diff.locator('.se-git-hunkbar')).toHaveCount(3); // git sees the saved file: lines 3, 5 and 25
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −3');
    await expect(diff.locator('.cm-content')).toBeFocused(); // the save kept the editor (cursor, undo history)

    // Revert the first block (line 3): the committed line is back, as an edit that Ctrl+Z undoes.
    const reverts = diff.locator('.se-git-revert');
    await expect(reverts).toHaveCount(3);
    await reverts.first().click();
    await expect(diff.locator('.cm-content')).not.toContainText('LINE 3');
    await expect(diff.locator('.cm-content')).toContainText('line 5 edited'); // the other blocks stay
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −2');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(1);
    await page.keyboard.press('Control+z');
    await expect(diff.locator('.cm-content')).toContainText('LINE 3');
    await expect(diff.locator('.cm-content')).toContainText('line 5 edited');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(0); // same text as on disk again
    expect(disk(ws.root)).toContain('LINE 3\n');

    // Ctrl+F7: the block at the cursor, from the keyboard.
    await endOf(page, 'LINE 25');
    await page.keyboard.press('Control+F7');
    await expect(diff.locator('.cm-content')).not.toContainText('LINE 25');
    await page.keyboard.press('Control+z');
    await expect(diff.locator('.cm-content')).toContainText('LINE 25');
  });

  test('side by side: only the working copy takes text, revert buttons between the editors; autosave applies', async ({ page, ws }) => {
    bigRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    const diff = await openFromPane(page);
    await diff.getByRole('radio', { name: 'Side by side' }).click();
    const a = diff.locator('.cm-merge-a .cm-content');
    const b = diff.locator('.cm-merge-b .cm-content');
    await expect(a).toHaveAttribute('aria-readonly', 'true');
    await expect(a).toHaveAttribute('contenteditable', 'false');
    await expect(b).toHaveAttribute('contenteditable', 'true');
    await expect(b).not.toHaveAttribute('aria-readonly', 'true');
    await a.locator('.cm-line', { hasText: 'line 4' }).click();
    await page.keyboard.type('nope');
    await expect(a).not.toContainText('nope');
    await expect(b).not.toContainText('nope');

    await b.locator('.cm-line', { hasText: 'line 26' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    // Autosave (on by default) writes it; git's blocks are read again.
    await expect.poll(() => disk(ws.root)).toContain('line 26 typed\n');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(0);
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+3 −3');
    await expect(b).toBeFocused();

    const reverts = diff.locator('.cm-merge-revert .se-git-revert');
    await expect(reverts).toHaveCount(2);
    await reverts.first().focus(); // keyboard reachable
    await page.keyboard.press('Enter');
    await expect(b).not.toContainText('LINE 3');
    await expect.poll(() => disk(ws.root)).not.toContain('LINE 3');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −2');
  });

  test('History and a deleted file are read-only', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.appendFileSync(path.join(ws.root, 'README.md'), '\nsecond\n');
    git(ws.root, 'commit', '-qam', 'Second commit');
    fs.rmSync(path.join(ws.root, 'notes/kubernetes.md'));
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await scm.locator('[data-section="history"] .se-scm-ghead').click();
    await scm.locator('.se-scm-crow').first().click();
    await scm.locator('.se-scm-cfiles .se-scm-row', { hasText: 'README.md' }).click();
    const diff = page.locator('.se-git-diff');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −0');
    await expect(diff).not.toHaveAttribute('data-editable', 'true');
    await expect(diff.getByTestId('git-diff-editable')).toHaveCount(0);
    await expect(diff.locator('.se-git-revert')).toHaveCount(0);
    await expect(diff.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
    await diff.locator('.cm-line', { hasText: 'second' }).click();
    await page.keyboard.type('nope');
    await expect(diff.locator('.cm-content')).not.toContainText('nope');
    expect(await ws.read('README.md')).not.toContain('nope');
    await page.keyboard.press('Escape');

    // Deleted in the folder: everything shows as removed, nothing to edit.
    await scm.locator('.se-scm-row[data-path="notes/kubernetes.md"] .se-scm-name').click();
    await expect(diff.locator('.cm-editor')).toHaveCount(1);
    await expect(diff).not.toHaveAttribute('data-editable', 'true');
    await expect(diff.locator('.se-git-revert')).toHaveCount(0);
  });

  test('edit, then tick "Include in commit" on that block → saved first, only that block staged', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    bigRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    const diff = await openFromPane(page);
    const bars = diff.locator('.se-git-hunkbar');
    await expect(bars).toHaveCount(2);
    await endOf(page, 'LINE 25');
    await page.keyboard.type('!');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(1);
    expect(disk(ws.root)).not.toContain('LINE 25!');

    await bars.nth(1).click();
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 25', '+LINE 25!']);
    expect(disk(ws.root)).toContain('LINE 25!\n');
    await expect(dirtyTab(page, 'big.txt')).toHaveCount(0);
    await expect(bars.nth(1).locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'true');
    await expect(bars.nth(0).locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'false');
    await expect(diff.locator('.se-git-diff-include')).toHaveAttribute('aria-checked', 'mixed');
    expect(changed(git(ws.root, 'diff', '-U0'))).toEqual(['-line 3', '+LINE 3']); // the other block stays out
  });

  test('"Diff with last commit": closing with unsaved edits loses nothing (the file keeps a dirty tab)', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    initRepo(ws.root);
    const before = (await ws.read('notes/kubernetes.md')).replace(/\n/, '\nINSERTED LINE\n');
    fs.writeFileSync(path.join(ws.root, 'notes/kubernetes.md'), before);
    await ws.open(page);
    await gitReady(page);
    await page.locator('.se-tree-row[data-path="notes"]').click();
    await page.locator('.se-tree-row[data-path="notes/kubernetes.md"]').click({ button: 'right' });
    await page.locator('.se-menu-item', { hasText: 'Diff with last commit' }).click();
    const diff = page.locator('.se-git-diff');
    await expect(diff).toHaveAttribute('data-editable', 'true');
    await expect(page.locator('.se-tab', { hasText: 'kubernetes.md' })).toHaveCount(0);
    await endOf(page, 'INSERTED LINE');
    await page.keyboard.type(' and more');
    await expect(dirtyTab(page, 'kubernetes.md')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);

    await expect(dirtyTab(page, 'kubernetes.md')).toHaveCount(1);
    expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent('notes/kubernetes.md'))).toContain('INSERTED LINE and more\n');
    expect(await ws.read('notes/kubernetes.md')).toBe(before); // not saved behind the user's back
    // The tab's own undo takes the diff's edit back; saving from the tab writes what is there.
    await page.evaluate(() => (window as any).__secEdit.openFile('notes/kubernetes.md'));
    await page.keyboard.press('Control+s');
    await expect.poll(() => ws.read('notes/kubernetes.md')).toContain('INSERTED LINE and more\n');
    await expect(dirtyTab(page, 'kubernetes.md')).toHaveCount(0);
  });

  test('an open tab and the diff are one document: edits show on both sides, CRLF stays CRLF', async ({ page, ws }) => {
    await ws.server.service.saveSettings({ autosave: false });
    fs.writeFileSync(path.join(ws.root, 'win.txt'), 'one\r\ntwo\r\nthree\r\n');
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'win.txt'), 'one\r\nTWO\r\nthree\r\n');
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('win.txt'));
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('Diff with last commit');
    await page.keyboard.press('Enter');
    const diff = page.locator('.se-git-diff');
    await expect(diff).toHaveAttribute('data-editable', 'true');
    await endOf(page, 'three');
    await page.keyboard.type(' 3');
    expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent('win.txt'))).toBe('one\nTWO\nthree 3\n');
    // A change made in the tab (here: through the editor API) shows up in the open diff.
    await page.evaluate(() => (window as any).__secEdit.editor.applyChanges('win.txt', [{ from: 0, to: 0, insert: 'zero\n' }]));
    await expect(diff.locator('.cm-content')).toContainText('zero');
    await page.keyboard.press('Control+s');
    await expect.poll(() => fs.readFileSync(path.join(ws.root, 'win.txt'), 'utf8')).toBe('zero\r\none\r\nTWO\r\nthree 3\r\n');
    // Find works in the diff; Esc closes the find bar first, then the diff.
    await page.keyboard.press('Control+f');
    await expect(diff.locator('.cm-search')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(diff.locator('.cm-search')).toHaveCount(0);
    await expect(diff).toHaveCount(1);
    await page.keyboard.press('Control+a');
    expect(await page.evaluate(() => getSelection()!.toString())).toContain('three 3');
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);
  });
});

test('compare text: a whole open file on the right can be edited; the clipboard / a selection cannot', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.server.service.saveSettings({ autosave: false });
  await ws.write('left.ts', 'const a = 1;\nconst b = 2;\n');
  await ws.write('right.ts', 'const a = 1;\nconst b = 3;\nexport {};\n');
  await ws.open(page);
  const open = (p: string) => page.evaluate((p) => (window as any).__secEdit.openFile(p), p);
  const menu = async (label: string) => {
    await page.locator('.cm-content').click({ button: 'right', position: { x: 40, y: 8 } });
    await page.locator('.se-menu-item', { hasText: label }).click();
  };
  await open('left.ts');
  await expect(page.locator('.cm-content')).toContainText('const b = 2');
  await page.evaluate(() => {
    const v = (window as any).__secEdit.editor.getView();
    v.focus();
    v.dispatch({ selection: { anchor: 0, head: v.state.doc.line(2).to } });
  });
  await menu('Select Text for Compare');
  await open('right.ts');
  await expect(page.locator('.cm-content')).toContainText('export {}');
  await menu('Compare Text with Previous Selection');
  const diff = page.locator('.se-git-diff');
  await expect(diff.locator('.se-git-diff-sub')).toContainText('left.ts · lines 1–2 ↔ right.ts');
  await expect(diff).toHaveAttribute('data-editable', 'true');
  await expect(diff.getByTestId('git-diff-stats')).toHaveText('+2 −1');
  await endOf(page, 'const b = 3');
  await page.keyboard.type(' // why');
  await expect(dirtyTab(page, 'right.ts')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent('right.ts'))).toContain('const b = 3; // why\n');
  await diff.getByRole('button', { name: 'Copy as patch' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('+const b = 3; // why');
  // Swapped: the right side is now a selection, not a file → read-only; the edit made so far stays
  // in the picture (and in right.ts's document).
  await diff.getByRole('button', { name: /Swap sides/ }).click();
  await expect(diff.locator('.se-git-diff-sub')).toContainText('right.ts ↔ left.ts · lines 1–2');
  await expect(diff.locator('.cm-content')).toHaveAttribute('aria-readonly', 'true');
  await expect(diff).not.toHaveAttribute('data-editable', 'true');
  await expect(diff.locator('.cm-deletedChunk')).toContainText('// why');
  expect(await ws.read('right.ts')).toBe('const a = 1;\nconst b = 3;\nexport {};\n');
});

test('screenshots: editable diff with revert controls, shelf / classic, dark / light (only with SEC_EDIT_DIFFEDIT_SHOTS=<dir>)', async ({ page, ws }) => {
  const out = process.env.SEC_EDIT_DIFFEDIT_SHOTS;
  test.skip(!out, 'set SEC_EDIT_DIFFEDIT_SHOTS=<dir> to write screenshots');
  await ws.server.service.saveSettings({ autosave: false });
  const lines = Array.from({ length: 40 }, (_, i) => `const value${i + 1} = ${i + 1};`);
  fs.writeFileSync(path.join(ws.root, 'big.ts'), lines.join('\n') + '\n');
  initRepo(ws.root);
  const work = [...lines];
  work[2] = 'const value3 = "changed";';
  work.splice(15, 0, 'const inserted = true;');
  work.splice(30, 1);
  fs.writeFileSync(path.join(ws.root, 'big.ts'), work.join('\n') + '\n');
  fs.mkdirSync(out!, { recursive: true });
  await page.setViewportSize({ width: 1300, height: 800 });
  await ws.open(page);
  await gitReady(page);
  for (const style of ['shelf', 'classic'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(([sidebarStyle, theme]) => {
        const a = (window as any).__secEdit;
        a.settings.value = { ...a.settings.value, sidebarStyle, theme };
        document.documentElement.dataset.theme = theme;
      }, [style, theme]);
      const diff = await openFromPane(page, 'big.ts');
      await diff.getByRole('radio', { name: 'Unified' }).click();
      await expect(diff.locator('.se-git-revert').first()).toBeVisible();
      if (style === 'shelf' && theme === 'dark') {
        await endOf(page, 'value5');
        await page.keyboard.type(' // typed in the diff');
      }
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out!, `${style}-${theme}-unified.png`) });
      await diff.getByRole('radio', { name: 'Side by side' }).click();
      await expect(diff.locator('.cm-merge-revert .se-git-revert').first()).toBeVisible();
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(out!, `${style}-${theme}-split.png`) });
      await page.keyboard.press('Escape');
    }
  }
});
