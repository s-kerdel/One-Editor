// Choose what to commit (browser mode): boxes in the Source control pane are the git index — tick 2 of
// 3 files and only those are committed; keyboard (Up / Down, Space); a single block staged from the diff
// view makes the file "partly" ticked and the commit holds just that block.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';
import { git, gitReady, initRepo } from './git-helpers';

const changed = (out: string) => out.split('\n').filter((l) => /^[-+](?![-+]{2} )/.test(l));

test.describe('choose what to commit', () => {
  test('tick 2 of 3 files (mouse + Space on a focused row) → only those 2 are committed', async ({ page, ws }) => {
    initRepo(ws.root);
    fs.appendFileSync(path.join(ws.root, 'README.md'), '\nmore\n');
    fs.appendFileSync(path.join(ws.root, 'notes/kubernetes.md'), '\nnot this one\n');
    fs.writeFileSync(path.join(ws.root, 'new.md'), '# new\n');
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    const row = (p: string) => scm.locator(`.se-scm-row[data-path="${p}"]`);
    await expect(scm.locator('[data-group="changes"] .se-scm-row')).toHaveCount(3);

    await row('README.md').locator('[role="checkbox"]').click();
    await expect(row('README.md').locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'true');
    // Keyboard: Up / Down move between rows, Space toggles the focused one.
    await row('README.md').focus();
    await page.keyboard.press('ArrowDown');
    await expect(row('notes/kubernetes.md')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row('new.md')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(row('new.md').locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.se-git-diff')).toHaveCount(0); // Space never opens the diff
    await expect(scm.getByTestId('scm-selected')).toHaveText('2 of 3 selected');
    await expect(scm.locator('.se-scm-commit-btn')).toHaveText('Commit 2 files');

    await scm.getByLabel('Commit message').fill('Two of three');
    await scm.getByLabel('Commit message').press('Control+Enter');
    await expect.poll(() => git(ws.root, 'log', '-1', '--format=%s').trim()).toBe('Two of three');
    expect(git(ws.root, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['README.md', 'new.md']);
    expect(git(ws.root, 'status', '--porcelain').trim()).toBe('M notes/kubernetes.md');
    await expect(scm.locator('[data-group="changes"] .se-scm-row')).toHaveCount(1);
    await expect(row('notes/kubernetes.md').locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'false');
  });

  test('one block from the diff view → the file is partly ticked → the commit holds only that block', async ({ page, ws }) => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(path.join(ws.root, 'big.txt'), lines.join('\n') + '\n');
    initRepo(ws.root);
    const work = [...lines];
    work[2] = 'LINE 3';
    work[24] = 'LINE 25';
    fs.writeFileSync(path.join(ws.root, 'big.txt'), work.join('\n') + '\n');
    await ws.open(page);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    const box = scm.locator('.se-scm-row[data-path="big.txt"] [role="checkbox"]');
    await scm.locator('.se-scm-row[data-path="big.txt"] .se-scm-name').click(); // the row opens the diff

    const diff = page.locator('.se-git-diff');
    const bars = diff.locator('.se-git-hunkbar');
    await expect(bars).toHaveCount(2);
    await expect(bars.locator('[role="checkbox"][aria-checked="false"]')).toHaveCount(2);
    await bars.nth(1).click();
    await expect(bars.nth(1).locator('[role="checkbox"]')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => changed(git(ws.root, 'diff', '--cached', '-U0'))).toEqual(['-line 25', '+LINE 25']);
    await expect(box).toHaveAttribute('aria-checked', 'mixed');
    await expect(diff.locator('.se-git-diff-include')).toHaveAttribute('aria-checked', 'mixed');
    // Unticking puts the index back exactly; ticking again.
    await bars.nth(1).locator('[role="checkbox"]').press('Space');
    await expect.poll(() => git(ws.root, 'diff', '--cached').trim()).toBe('');
    await expect(box).toHaveAttribute('aria-checked', 'false');
    await bars.nth(1).click();
    await expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(fs.readFileSync(path.join(ws.root, 'big.txt'), 'utf8')).toBe(work.join('\n') + '\n'); // the file itself never changes
    await page.keyboard.press('Escape');
    await expect(diff).toHaveCount(0);

    await expect(scm.getByTestId('scm-selected')).toHaveText('1 of 1 selected');
    await scm.getByLabel('Commit message').fill('Only line 25');
    await scm.locator('.se-scm-commit-btn').click();
    await expect.poll(() => git(ws.root, 'log', '-1', '--format=%s').trim()).toBe('Only line 25');
    expect(changed(git(ws.root, 'show', '-U0', '--format=', 'HEAD'))).toEqual(['-line 25', '+LINE 25']);
    expect(changed(git(ws.root, 'diff', '-U0'))).toEqual(['-line 3', '+LINE 3']);
    await expect(box).toHaveAttribute('aria-checked', 'false');
  });
});

test('screenshots: pane + diff view, shelf / classic, dark / light (only with SEC_EDIT_SCM_SHOTS=<dir>)', async ({ page, ws }) => {
  const out = process.env.SEC_EDIT_SCM_SHOTS;
  test.skip(!out, 'set SEC_EDIT_SCM_SHOTS=<dir> to write screenshots');
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  fs.writeFileSync(path.join(ws.root, 'big.txt'), lines.join('\n') + '\n');
  initRepo(ws.root);
  const work = [...lines];
  work[2] = 'LINE 3 changed';
  work.splice(15, 0, 'inserted line');
  work.splice(30, 1);
  fs.writeFileSync(path.join(ws.root, 'big.txt'), work.join('\n') + '\n');
  fs.appendFileSync(path.join(ws.root, 'README.md'), '\nmore\n');
  git(ws.root, 'add', 'README.md');
  fs.appendFileSync(path.join(ws.root, 'notes/kubernetes.md'), '\nedited\n');
  fs.writeFileSync(path.join(ws.root, 'new idea.md'), '# idea\n');
  await page.setViewportSize({ width: 1300, height: 800 });
  await ws.open(page);
  await gitReady(page);
  await page.locator('[data-panel="git"]').click();
  const scm = page.getByTestId('scm');
  await scm.locator('.se-scm-row[data-path="big.txt"] .se-scm-name').click();
  await page.locator('.se-git-hunkbar').nth(1).click();
  await expect(scm.locator('.se-scm-row[data-path="big.txt"] [role="checkbox"]')).toHaveAttribute('aria-checked', 'mixed');
  await page.keyboard.press('Escape');
  for (const style of ['shelf', 'classic'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(([sidebarStyle, theme]) => {
        const a = (window as any).__secEdit;
        a.settings.value = { ...a.settings.value, sidebarStyle, theme };
        document.documentElement.dataset.theme = theme;
      }, [style, theme]);
      await page.waitForTimeout(150);
      await scm.locator('.se-scm-row[data-path="README.md"]').focus();
      await page.screenshot({ path: path.join(out!, `${style}-${theme}-pane.png`) });
      await scm.locator('.se-scm-row[data-path="big.txt"] .se-scm-name').click();
      await expect(page.locator('.se-git-hunkbar')).toHaveCount(3);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out!, `${style}-${theme}-diff.png`) });
      await page.locator('.se-git-diff').getByRole('radio', { name: 'Side by side' }).click();
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(out!, `${style}-${theme}-split.png`) });
      await page.locator('.se-git-diff').getByRole('radio', { name: 'Unified' }).click();
      await page.keyboard.press('Escape');
    }
  }
});
