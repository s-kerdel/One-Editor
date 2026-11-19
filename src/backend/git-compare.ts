// "Compare text": two arbitrary texts diffed by git's own algorithm (`git diff --no-index --histogram`).
// The texts go to a private temp folder under the app's user data (never the workspace) and are deleted
// right after. Needs a git executable, not a repository.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitTextDiff, GitTextHunk } from '../shared/git';
import { BackendFailure } from './errors';
import { run } from './git';
import { toLf } from './textcodec';

/** Per side (UTF-8 bytes). */
export const COMPARE_MAX_BYTES = 5 * 1024 * 1024;
const T_COMPARE = 20_000;

/**
 * Exact changed blocks from a unified diff (`@@ -a,b +c,d @@` hunks with context): each run of
 * -/+ lines becomes one block, 0-based line numbers. "\ No newline at end of file" lines are skipped.
 */
export function parsePatchHunks(patch: string): GitTextHunk[] {
  const out: GitTextHunk[] = [];
  const lines = patch.split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i++]);
    if (!m) continue;
    // A count of 0 means the start number is the line *before* the (empty) range.
    let a = Number(m[2] ?? '1') === 0 ? Number(m[1]) : Number(m[1]) - 1;
    let b = Number(m[4] ?? '1') === 0 ? Number(m[3]) : Number(m[3]) - 1;
    let block: GitTextHunk | null = null;
    const flush = () => {
      if (block && (block.oldCount || block.newCount)) out.push(block);
      block = null;
    };
    for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
      const l = lines[i];
      const c = l[0];
      if (c === '-' || c === '+') {
        block ??= { oldStart: a, oldCount: 0, newStart: b, newCount: 0 };
        if (c === '-') (block.oldCount++, a++);
        else (block.newCount++, b++);
      } else if (c === '\\') continue;
      else if (c === ' ' || l === '') {
        flush();
        a++;
        b++;
      } else break; // next file header
    }
    flush();
  }
  return out;
}

export interface CompareRunner {
  git: string;
  env: NodeJS.ProcessEnv;
  /** Private folder for the temp files (the app's user-data temp dir). */
  tmpRoot: string;
}

const textArg = (v: unknown, side: string): string => {
  if (typeof v !== 'string') throw new BackendFailure('EINVAL', `${side} text must be a string`);
  if (Buffer.byteLength(v, 'utf8') > COMPARE_MAX_BYTES) throw new BackendFailure('ETOOBIG', `Too large to compare (more than ${COMPARE_MAX_BYTES / 1048576} MB)`);
  return toLf(v);
};

/**
 * `git diff --no-index --histogram` of two texts. Exit code 1 means "they differ" (not an error).
 * Returns `engine: 'none'` (caller falls back to its built-in diff) when git cannot do it.
 */
export async function diffTexts(r: CompareRunner | null, a: unknown, b: unknown, opts: unknown): Promise<GitTextDiff> {
  const left = textArg(a, 'Left');
  const right = textArg(b, 'Right');
  const ignoreWhitespace = !!(opts && typeof opts === 'object' && (opts as { ignoreWhitespace?: unknown }).ignoreWhitespace === true);
  if (!r) return { engine: 'none', reason: 'git was not found' };
  if (left === right) return { engine: 'git', hunks: [], patch: '' };
  const dir = path.join(r.tmpRoot, `compare-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await Promise.all([fsp.writeFile(path.join(dir, 'a'), left, 'utf8'), fsp.writeFile(path.join(dir, 'b'), right, 'utf8')]);
    // Relative names "a" / "b": no temp path ever shows up in the patch. The ceiling keeps git from
    // picking up a repository (and its attributes / config) above the temp folder.
    const args = ['-c', 'core.quotepath=off', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--histogram', '--text', '-U3'];
    if (ignoreWhitespace) args.push('--ignore-all-space');
    args.push('--', 'a', 'b');
    const res = await run(r.git, args, { cwd: dir, env: { ...r.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) }, timeoutMs: T_COMPARE, maxBytes: 4 * COMPARE_MAX_BYTES });
    if (res.error || res.timedOut || res.overflow) return { engine: 'none', reason: res.timedOut ? 'git took too long' : res.overflow ? 'the diff is too large' : (res.error?.message ?? 'git failed') };
    if (res.code !== 0 && res.code !== 1) return { engine: 'none', reason: res.stderr.split('\n')[0] || `git exited with ${res.code}` };
    const patch = toLf(res.stdout.toString('utf8'));
    return { engine: 'git', hunks: parsePatchHunks(patch), patch };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
