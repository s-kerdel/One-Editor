// Git in browser mode (local server): tree marks, branch item, change bars + revert, diff view,
// and the Source control pane (stage, commit, push to a bare remote, branches, conflicts).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';
import { bareRemote, git, gitReady, initRepo, lastSubject, refreshGit } from './git-helpers';

const row = (page: import('@playwright/test').Page, p: string) => page.locator(`.se-tree-row[data-path="${p}"]`);

test.describe('git tier 1', () => {
  test('tree marks, folder dot, branch item + "Show changes"; nothing at all outside a repo', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.appendFileSync(path.join(ws.root, 'notes/kubernetes.md'), '\nedited\n');
    fs.writeFileSync(path.join(ws.root, 'notes/brand new.md'), 'new\n');
    await ws.open(page);
    await gitReady(page);

    await expect(row(page, 'notes')).toHaveClass(/se-git-has-changes/);
    await expect(row(page, 'notes').locator('.se-git-dot')).toBeVisible();
    await page.locator('.se-tree-row[data-path="notes"]').click(); // expand
    await expect(row(page, 'notes/kubernetes.md').locator('.se-git-letter')).toHaveText('M');
    await expect(row(page, 'notes/brand new.md').locator('.se-git-letter')).toHaveText('U');
    await expect(row(page, 'README.md').locator('.se-git-letter')).toHaveCount(0);
    // Marks never change the row height.
    expect((await row(page, 'notes/kubernetes.md').boundingBox())!.height).toBe((await row(page, 'README.md').boundingBox())!.height);

    const branch = page.getByTestId('git-branch');
    await expect(branch).toContainText('main');
    await expect(branch.locator('.se-git-branch-dirty')).toBeVisible();
    await branch.click();
    await page.locator('.se-menu-item', { hasText: 'Show changes (2)' }).click();
    await expect(page.locator('.se-git-banner')).toContainText('2 changed');
    await expect(page.locator('.se-tree-row')).toHaveCount(3); // notes/ + its two changed files
    await page.locator('.se-git-banner-btn').click();
    await expect(row(page, 'README.md')).toBeVisible();

    // A commit from a terminal clears the marks by itself (.git watcher → server event stream).
    git(ws.root, 'add', '-A');
    git(ws.root, 'commit', '-qm', 'outside');
    await expect(row(page, 'notes/kubernetes.md').locator('.se-git-letter')).toHaveCount(0, { timeout: 10000 });
    await expect(branch.locator('.se-git-branch-dirty')).toHaveCount(0);
  });

  test('not a repository: no marks, no branch item, a calm pane', async ({ page, ws }) => {
    await ws.open(page);
    await page.waitForFunction(() => (window as any).__secEditGit?.status.value != null, undefined, { timeout: 15000 });
    await expect(page.getByTestId('git-branch')).toHaveCount(0);
    await expect(page.locator('.se-git-letter, .se-git-dot')).toHaveCount(0);
    await page.locator('[data-panel="git"]').click();
    await expect(page.locator('.se-scm-empty')).toContainText('not a git repository');
  });

  test('change bars follow typing; a click opens the old lines; revert is one undo step', async ({ page, ws }) => {
    initRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    await expect(page.locator('.se-git-gutter')).toBeVisible();
    const original = await ws.read('code/app.ts');
    const firstLine = original.split('\n')[0];
    await page.locator('.cm-line').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' // changed');
    await expect(page.locator('.se-git-bar.se-git-modified')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await page.keyboard.type('const added = 1;');
    await expect(page.locator('.se-git-bar.se-git-modified')).toHaveCount(2); // modified + inserted line: one hunk

    await page.locator('.se-git-gutter .cm-gutterElement:has(.se-git-bar)').first().click();
    const peek = page.locator('.se-git-peek');
    await expect(peek).toBeVisible();
    await expect(peek.locator('.se-git-peek-line')).toHaveText([firstLine]);
    await peek.locator('.se-git-peek-btn.revert').click();
    await expect(peek).toHaveCount(0);
    await expect(page.locator('.se-git-bar')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent())).toBe(original);
    await page.keyboard.press('Control+z');
    expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent())).toContain('const added = 1;');
  });

  test('Markdown live view gets bars only for committed notes', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'untracked.md'), '# fresh\n');
    await ws.open(page);
    await gitReady(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('untracked.md'));
    await expect(page.locator('.cm-content')).toContainText('fresh');
    await expect(page.locator('.se-git-gutter')).toHaveCount(0);
    await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
    await expect(page.locator('.se-git-gutter')).toHaveCount(1);
    await page.locator('.cm-line').last().click();
    await page.keyboard.type('\nA new paragraph');
    await expect(page.locator('.se-git-bar.se-git-added')).toHaveCount(1);
  });

  test('diff with last commit: unified ↔ side by side, unsaved edits included, Esc closes', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'notes/kubernetes.md'), (await ws.read('notes/kubernetes.md')).replace(/\n/, '\nINSERTED LINE\n'));
    await ws.open(page);
    await gitReady(page);
    await page.locator('.se-tree-row[data-path="notes"]').click();
    await row(page, 'notes/kubernetes.md').click({ button: 'right' });
    await page.locator('.se-menu-item', { hasText: 'Diff with last commit' }).click();
    const diff = page.locator('.se-git-diff');
    await expect(diff.getByTestId('git-diff-stats')).toHaveText('+1 −0');
    await expect(diff.locator('.cm-content')).toContainText('INSERTED LINE');
    await diff.getByRole('radio', { name: 'Side by side' }).click();
    await expect(diff.locator('.cm-mergeView .cm-editor')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);
    // Reopen via the palette: the layout choice is remembered.
    await page.evaluate(() => (window as any).__secEdit.openFile('notes/kubernetes.md'));
    await page.keyboard.press('Control+Shift+P');
    await page.keyboard.type('Diff with last commit');
    await page.keyboard.press('Enter');
    await expect(page.locator('.se-git-diff .cm-mergeView')).toBeVisible();
  });
});

test.describe('source control pane', () => {
  test('stage, commit (Ctrl+Enter), publish + push to a bare remote', async ({ page, ws }) => {
    initRepo(ws.root);
    const remote = bareRemote(ws.root);
    fs.appendFileSync(path.join(ws.root, 'README.md'), '\nmore\n');
    fs.writeFileSync(path.join(ws.root, 'todo.md'), '- [ ] ship\n');
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await expect(scm.locator('[data-group="changes"] .se-scm-row')).toHaveCount(1);
    await expect(scm.locator('[data-group="untracked"] .se-scm-row')).toHaveCount(1);

    await scm.locator('.se-scm-row[data-path="README.md"]').hover();
    await scm.locator('.se-scm-row[data-path="README.md"] .stage').click();
    await expect(scm.locator('[data-group="staged"] .se-scm-row[data-path="README.md"]')).toBeVisible();
    await scm.locator('[data-group="staged"] .se-scm-row[data-path="README.md"]').hover();
    await scm.locator('[data-group="staged"] .se-scm-row[data-path="README.md"] .unstage').click();
    await expect(scm.locator('[data-group="staged"]')).toHaveCount(0);
    await scm.locator('[data-group="changes"] .se-scm-ghead').hover();
    await scm.locator('[data-group="changes"] .stage-all').click();
    await expect(scm.locator('[data-group="staged"] .se-scm-row')).toHaveCount(1);

    await scm.getByLabel('Commit message').fill('Update readme');
    await scm.getByLabel('Commit message').press('Control+Enter');
    await expect(scm.locator('[data-group="staged"]')).toHaveCount(0);
    expect(git(ws.root, 'log', '-1', '--format=%s').trim()).toBe('Update readme');
    await expect(scm.getByLabel('Commit message')).toHaveValue('');

    await scm.locator('.se-scm-push', { hasText: 'Publish' }).click();
    await expect(scm.locator('.se-scm-push')).toContainText('0', { timeout: 15000 });
    await expect.poll(() => lastSubject(remote)).toBe('Update readme');

    // "Nothing staged" → offer to stage everything, then commit & push.
    await scm.getByLabel('Commit message').fill('Add todo');
    page.once('dialog', () => {});
    await scm.locator('button', { hasText: 'Commit & push' }).click();
    await page.locator('.se-dialog button', { hasText: 'Stage all & commit' }).click();
    await expect.poll(() => lastSubject(remote), { timeout: 15000 }).toBe('Add todo');
  });

  test('discard always asks; untracked files go to the trash', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.writeFileSync(path.join(ws.root, 'README.md'), 'scribbles\n');
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    const r = scm.locator('[data-group="changes"] .se-scm-row[data-path="README.md"]');
    await r.hover();
    await r.locator('.discard').click();
    await expect(page.locator('.se-dialog')).toContainText('Discard changes in “README.md”?');
    await page.locator('.se-dialog button', { hasText: 'Cancel' }).click();
    expect(await ws.read('README.md')).toBe('scribbles\n');
    await r.hover();
    await r.locator('.discard').click();
    await page.locator('.se-dialog button', { hasText: 'Discard' }).click();
    await expect(scm.locator('.se-scm-clean')).toBeVisible();
    expect(await ws.read('README.md')).not.toBe('scribbles\n');
  });

  test('branches: create + switch (with a dirty-tree warning)', async ({ page, ws }) => {
    initRepo(ws.root);
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await scm.locator('[data-section="branches"] .se-scm-ghead').click();
    await expect(scm.locator('.se-scm-brow.current')).toContainText('main');
    await scm.locator('[data-section="branches"] .se-scm-ghead').hover();
    await scm.getByRole('button', { name: 'New branch' }).click();
    await page.locator('.se-dialog input').fill('feature/pane');
    await page.locator('.se-dialog button', { hasText: 'Create & switch' }).click();
    await expect(page.getByTestId('git-branch')).toContainText('feature/pane');
    await expect(scm.locator('.se-scm-brow.current')).toContainText('feature/pane');

    fs.appendFileSync(path.join(ws.root, 'README.md'), '\nwip\n');
    await refreshGit(page);
    await scm.locator('.se-scm-brow[data-branch="main"]').click();
    await expect(page.locator('.se-dialog')).toContainText('1 uncommitted change');
    await page.locator('.se-dialog button', { hasText: 'Switch' }).click();
    await expect(page.getByTestId('git-branch')).toContainText('main');
  });

  test('conflicts: highlighted in the editor, accept a side, mark resolved, commit the merge', async ({ page, ws }) => {
    initRepo(ws.root);
    git(ws.root, 'checkout', '-qb', 'other');
    fs.writeFileSync(path.join(ws.root, 'README.md'), 'theirs\n');
    git(ws.root, 'commit', '-qam', 'other');
    git(ws.root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(ws.root, 'README.md'), 'ours\n');
    git(ws.root, 'commit', '-qam', 'ours');
    try {
      git(ws.root, 'merge', '-q', 'other');
    } catch {}
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await expect(scm.locator('.se-scm-state')).toContainText('Merge in progress');
    const c = scm.locator('[data-group="conflicts"] .se-scm-row[data-path="README.md"]');
    await c.click(); // opens the file
    await expect(page.locator('.cm-line.se-git-cf-marker')).toHaveCount(3);
    await expect(page.locator('.cm-line.se-git-cf-ours')).toHaveText(['ours']);
    await expect(page.locator('.cm-line.se-git-cf-theirs')).toHaveText(['theirs']);
    await page.locator('.se-git-cf-btn.incoming').click();
    await expect(page.locator('.cm-line.se-git-cf-marker')).toHaveCount(0);
    await c.hover();
    await c.locator('.resolve').click();
    await expect(scm.locator('[data-group="conflicts"]')).toHaveCount(0);
    expect(await ws.read('README.md')).toBe('theirs\n');
    await scm.locator('.se-scm-commit-btn').click();
    await expect(scm.locator('.se-scm-state')).toHaveCount(0);
    expect(git(ws.root, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
  });

  test('history: commits, files per commit, a diff per file', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.appendFileSync(path.join(ws.root, 'README.md'), '\nsecond\n');
    git(ws.root, 'commit', '-qam', 'Second commit');
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await scm.locator('[data-section="history"] .se-scm-ghead').click();
    await expect(scm.locator('.se-scm-crow .se-scm-name')).toHaveText(['Second commit', 'initial']);
    await scm.locator('.se-scm-crow').first().click();
    await scm.locator('.se-scm-cfiles .se-scm-row', { hasText: 'README.md' }).click();
    await expect(page.locator('.se-git-diff').getByTestId('git-diff-stats')).toHaveText('+2 −0');
  });
});
