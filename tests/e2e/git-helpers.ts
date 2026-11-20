// Git E2E helpers: turn the per-test workspace copy into a repository with an isolated git config
// (the developer's global autocrlf / hooks / signing must not change results).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

const TMP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tmp/git/e2e');
const CFG = path.join(TMP, 'gitconfig');

/** Isolate git for this worker: the in-process server inherits process.env. */
export function isolateGit() {
  fs.mkdirSync(TMP, { recursive: true });
  if (!fs.existsSync(CFG)) fs.writeFileSync(CFG, '[user]\n\tname = E2E\n\temail = e2e@example.com\n[init]\n\tdefaultBranch = main\n[pull]\n\trebase = false\n');
  process.env.GIT_CONFIG_GLOBAL = CFG;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_CONFIG_GLOBAL: CFG, GIT_CONFIG_NOSYSTEM: '1' } });
}

/**
 * Stands in for the user's "Trust" in the Source control panel (the app runs no git in a folder
 * without it — src/backend/git-trust.ts): records the folder in the test's own app-data folder. The
 * harnesses put that next to the workspace copy (`config` for the browser server, `userData` for Electron).
 */
export function trustRepo(root: string, appData?: string) {
  const real = fs.realpathSync(root);
  const dirs = appData ? [appData] : [path.join(path.dirname(root), 'config'), path.join(path.dirname(root), 'userData')];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'git-trust.json');
    let cur: { trusted?: string[]; legacy?: string[] } = {};
    try {
      cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    fs.writeFileSync(file, JSON.stringify({ version: 1, trusted: [...new Set([...(cur.trusted ?? []), real])], legacy: cur.legacy ?? [] }));
  }
}

/** `git init` + commit everything in the workspace copy (and trust it, as its user would have). */
export function initRepo(root: string) {
  isolateGit();
  trustRepo(root);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'initial');
}

export function bareRemote(root: string): string {
  const remote = path.join(path.dirname(root), 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  return remote;
}

/** Waits until the lazy git chunk is in and the first status says "repository". */
export async function gitReady(page: Page) {
  await page.waitForFunction(() => (window as any).__secEditGit?.status.value?.ok === true, undefined, { timeout: 15000 });
}

export async function refreshGit(page: Page) {
  await page.evaluate(() => (window as any).__secEditGit.refreshNow());
}

/** Subject of a branch's last commit in a (bare) repo, '' while it does not exist yet (for polling). */
export function lastSubject(repo: string, ref = 'main'): string {
  try {
    return git(repo, 'log', '-1', '--format=%s', ref).trim();
  } catch {
    return '';
  }
}
