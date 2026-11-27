// Git trust: a repository the user has not trusted gets no git at all (the server refuses), the Source
// control panel asks; trust comes from the desktop app only (the browser server refuses it), "Stop
// trusting this folder" switches it off again.
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './harness';
import { git, gitReady, isolateGit, trustRepo } from './git-helpers';

const row = (page: import('@playwright/test').Page, p: string) => page.locator(`.se-tree-row[data-path="${p}"]`);

test('untrusted repository: no marks, no branch, no change bars → panel prompt → Trust → git appears → revoke', async ({ page, ws }) => {
  // A repository as it arrives from someone else: never trusted here (no initRepo helper on purpose),
  // with a filter that would run on the first status.
  isolateGit();
  const marker = path.join(path.dirname(ws.root), 'pwned');
  git(ws.root, 'init', '-q');
  fs.writeFileSync(path.join(ws.root, '.gitattributes'), '*.md filter=evil\n');
  git(ws.root, 'add', '-A');
  git(ws.root, 'commit', '-qm', 'initial');
  git(ws.root, 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
  fs.appendFileSync(path.join(ws.root, 'README.md'), '\nedited\n');
  fs.writeFileSync(path.join(ws.root, 'new.md'), 'new\n');

  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditGit?.status.value?.reason === 'untrusted', undefined, { timeout: 15000 });
  // Nothing of git shows: no letters, no branch item, no change bars — only the quiet status item.
  await expect(page.locator('.se-git-letter, .se-git-dot')).toHaveCount(0);
  await expect(page.getByTestId('git-branch')).toHaveCount(0);
  await row(page, 'README.md').click();
  await expect(page.locator('.cm-content')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(page.locator('.se-git-bar')).toHaveCount(0);
  const off = page.getByTestId('git-untrusted');
  await expect(off).toHaveText('Git: not trusted');
  // The server refuses whatever the page asks for.
  const direct = await page.evaluate(async () => {
    const b = (window as any).__secEdit.backend;
    const code = (p: Promise<unknown>) => p.then((r) => r, (e: { code?: string }) => e.code);
    return { status: await b.git('status', { fresh: true }), stage: await code(b.git('stage', ['README.md'])), commit: await code(b.git('commit', { message: 'x' })), log: await code(b.git('log', {})), head: await b.git('headFile', 'README.md') };
  });
  expect(direct).toEqual({ status: { ok: false, reason: 'untrusted', repoLikely: true }, stage: 'EACCES', commit: 'EACCES', log: 'EACCES', head: { content: null, oid: null } });
  expect(fs.existsSync(marker)).toBe(false);

  // The status item opens the panel. Browser mode cannot grant trust: no Trust button, a note says where.
  await off.click();
  const prompt = page.getByTestId('git-trust');
  await expect(prompt).toContainText('This folder is a git repository.');
  await expect(page.getByTestId('git-trust-desktop')).toHaveText('Trust this folder in the desktop app (Source control).');
  await expect(page.getByTestId('git-trust-yes')).toHaveCount(0);
  await expect(page.getByTestId('scm')).toHaveCount(0);
  expect(fs.existsSync(marker)).toBe(false);

  // A page never grants trust (the folder's .git/config could run programs): only the desktop app's own
  // dialog does. Here the desktop's answer is written the way it would be, then the page looks again.
  const trustFile = path.join(path.dirname(ws.root), 'config', 'git-trust.json');
  expect(await page.evaluate(() => (window as any).__secEdit.backend.git('trust').then(() => 'ok', (e: { code?: string }) => e.code))).toBe('ENOTSUP');
  expect(fs.existsSync(trustFile) ? JSON.parse(fs.readFileSync(trustFile, 'utf8')).trusted : []).toEqual([]);
  expect(fs.existsSync(marker)).toBe(false);
  trustRepo(ws.root, path.dirname(trustFile));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');

  // Trusted: status, marks, branch item and the pane are there (remembered on the server, not in the page).
  await gitReady(page);
  await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'git'));
  await expect(page.getByTestId('scm')).toBeVisible();
  await expect(page.getByTestId('git-branch')).toContainText('main');
  await expect(page.getByTestId('git-untrusted')).toHaveCount(0);
  await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'files'));
  await expect(row(page, 'new.md').locator('.se-git-letter')).toHaveText('U');
  expect(JSON.parse(fs.readFileSync(trustFile, 'utf8')).trusted).toEqual([fs.realpathSync(ws.root)]);
  expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => /trust/i.test(k)))).toEqual([]);
  // A reload keeps it.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await gitReady(page);

  // Revoke from the panel's menu: git is off again, at once.
  await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'git'));
  await page.getByTestId('scm-more').click();
  await page.locator('.se-menu-item', { hasText: 'Stop trusting this folder' }).click();
  await page.locator('.se-dialog .se-btn', { hasText: 'Stop trusting' }).click();
  await expect(page.getByTestId('git-trust')).toBeVisible();
  await expect(page.getByTestId('git-untrusted')).toBeVisible();
  await expect(page.getByTestId('git-branch')).toHaveCount(0);
  expect(JSON.parse(fs.readFileSync(trustFile, 'utf8')).trusted).toEqual([]);
  expect(await page.evaluate(() => (window as any).__secEdit.backend.git('stage', ['README.md']).then(() => 'ok', (e: { code?: string }) => e.code))).toBe('EACCES');
});

test('a plain folder is not asked anything: "not a git repository" as before', async ({ page, ws }) => {
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditGit?.status.value?.ok === false, undefined, { timeout: 15000 });
  await expect(page.getByTestId('git-untrusted')).toHaveCount(0);
  await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'git'));
  await expect(page.locator('.se-scm-empty')).toContainText('This folder is not a git repository.');
  await expect(page.getByTestId('git-trust')).toHaveCount(0);
});
