// Real temporary repositories for the git service tests. They live inside the project (.tmp/git/unit),
// never in the system temp dir, and git runs with an isolated config (the developer's global
// core.autocrlf etc. must not change results).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.tmp/git/unit');
const GLOBAL_CFG = path.join(BASE, 'gitconfig');

export function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  fs.mkdirSync(BASE, { recursive: true });
  if (!fs.existsSync(GLOBAL_CFG)) fs.writeFileSync(GLOBAL_CFG, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: GLOBAL_CFG,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: BASE,
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

export async function tmpDir(prefix: string): Promise<string> {
  await fsp.mkdir(BASE, { recursive: true });
  return fsp.mkdtemp(path.join(BASE, `${prefix}-`));
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root: string, rel: string, content: string | Buffer) {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
}

/** New repo with the given files committed as the first commit (no files → no commit). */
export async function makeRepo(prefix: string, files: Record<string, string | Buffer> = {}): Promise<string> {
  const dir = await tmpDir(prefix);
  git(dir, 'init', '-q');
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  if (Object.keys(files).length) {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'init');
  }
  return dir;
}

export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
