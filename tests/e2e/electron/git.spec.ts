// Git in the real Electron app (IPC + the main-process .git watcher): tree marks, branch item, change
// bars + revert, diff view, and the Source control pane (commit, push to a bare remote, branch switch,
// conflict resolve, auth hand-off into the integrated terminal — typed, never run).
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { bareRemote, git, initRepo, isolateGit, lastSubject } from '../git-helpers';

isolateGit();
const gitEnv = () => ({ GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL!, GIT_CONFIG_NOSYSTEM: '1' });
const gitReady = (page: Page) => page.waitForFunction(() => (window as any).__secEditGit?.status.value?.ok === true, undefined, { timeout: 20000 });
const row = (page: Page, p: string) => page.locator(`.se-tree-row[data-path="${p}"]`);
const termText = (page: Page) => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/ /g, ' '));

async function launch(el: Parameters<Parameters<typeof test>[2]>[0]['el']) {
  const home = path.join(el.tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
  return el.launch([el.ws], { env: { ...gitEnv(), SHELL: '/bin/bash', HOME: home } });
}

test('marks, branch item, change bars + revert, diff view; an outside commit refreshes over IPC', async ({ el }) => {
  initRepo(el.ws);
  fs.appendFileSync(path.join(el.ws, 'notes/kubernetes.md'), '\nedited\n');
  const { page } = await launch(el);
  await gitReady(page);
  await expect(row(page, 'notes').locator('.se-git-dot')).toBeVisible();
  await expect(page.getByTestId('git-branch')).toContainText('main');

  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await page.locator('.cm-line').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' // edit');
  await expect(page.locator('.se-git-bar.se-git-modified')).toHaveCount(1);
  await page.locator('.se-git-gutter .cm-gutterElement:has(.se-git-bar)').first().click();
  await page.locator('.se-git-peek-btn.revert').click();
  await expect(page.locator('.se-git-bar')).toHaveCount(0);

  await page.evaluate(() => (window as any).__secEdit.openFile('notes/kubernetes.md'));
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('Diff with last commit');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-git-diff').getByTestId('git-diff-stats')).toHaveText('+2 −0');
  await page.keyboard.press('Escape');

  git(el.ws, 'commit', '-qam', 'from a terminal');
  await expect(page.getByTestId('git-branch').locator('.se-git-branch-dirty')).toHaveCount(0, { timeout: 10000 });
  await expect(row(page, 'notes').locator('.se-git-dot')).toHaveCount(0);
});

test('pane: commit + publish to a bare remote, switch branch, resolve a conflict', async ({ el }) => {
  initRepo(el.ws);
  const remote = bareRemote(el.ws);
  git(el.ws, 'checkout', '-qb', 'other');
  fs.writeFileSync(path.join(el.ws, 'code/query.sql'), 'select 2;\n');
  git(el.ws, 'commit', '-qam', 'other side');
  git(el.ws, 'checkout', '-q', 'main');
  fs.appendFileSync(path.join(el.ws, 'README.md'), '\nmore\n');
  const { page } = await launch(el);
  await gitReady(page);
  await page.keyboard.press('Control+Shift+G');
  const scm = page.getByTestId('scm');
  await expect(scm.locator('[data-group="changes"] .se-scm-row[data-path="README.md"]')).toBeVisible();
  await scm.getByLabel('Commit message').fill('Readme');
  page.once('dialog', () => {});
  await scm.locator('.se-scm-commit-btn').click();
  await page.locator('.se-dialog button', { hasText: 'Stage all & commit' }).click();
  await expect.poll(() => git(el.ws, 'log', '-1', '--format=%s').trim()).toBe('Readme');
  await scm.locator('.se-scm-push', { hasText: 'Publish' }).click();
  await expect.poll(() => lastSubject(remote), { timeout: 15000 }).toBe('Readme');

  // Branch switch.
  await scm.locator('[data-section="branches"] .se-scm-toggle').click();
  await scm.locator('.se-scm-brow[data-branch="other"]').click();
  await expect(page.getByTestId('git-branch')).toContainText('other');
  await scm.locator('.se-scm-brow[data-branch="main"]').click();
  await expect(page.getByTestId('git-branch')).toContainText('main');

  // Conflict: main and other both changed query.sql.
  fs.writeFileSync(path.join(el.ws, 'code/query.sql'), 'select 1;\n');
  git(el.ws, 'commit', '-qam', 'main side');
  try {
    git(el.ws, 'merge', '-q', 'other');
  } catch {}
  await expect(scm.locator('.se-scm-state')).toContainText('Merge in progress', { timeout: 10000 });
  await scm.locator('[data-group="conflicts"] .se-scm-row[data-path="code/query.sql"]').click();
  await expect(page.locator('.cm-line.se-git-cf-marker')).toHaveCount(3);
  await page.locator('.se-git-cf-btn.current').click();
  await page.keyboard.press('Control+s');
  const c = scm.locator('[data-group="conflicts"] .se-scm-row[data-path="code/query.sql"]');
  await c.hover();
  await c.locator('.resolve').click();
  await scm.locator('.se-scm-commit-btn').click();
  await expect(scm.locator('.se-scm-state')).toHaveCount(0);
  expect(fs.readFileSync(path.join(el.ws, 'code/query.sql'), 'utf8')).toBe('select 1;\n');
});

test('auth needed: the error offers the integrated terminal with the command typed, not run', async ({ el }) => {
  const server = http.createServer((_q, res) => res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    initRepo(el.ws);
    git(el.ws, 'remote', 'add', 'origin', `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/r.git`);
    const { page } = await launch(el);
    await gitReady(page);
    await page.locator('[data-panel="git"]').click();
    const scm = page.getByTestId('scm');
    await scm.locator('.se-scm-push', { hasText: 'Publish' }).click();
    const box = scm.locator('.se-scm-error');
    await expect(box).toContainText(/could not read Username|terminal prompts disabled|Authentication/i, { timeout: 15000 });
    await box.getByRole('button', { name: 'Open in terminal' }).click();
    await expect(page.getByTestId('terminal-panel')).toBeVisible();
    await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$ git push -u origin main');
    await page.waitForTimeout(800);
    expect(await termText(page)).not.toMatch(/Username for|fatal:/); // typed, never executed
  } finally {
    server.close();
  }
});
