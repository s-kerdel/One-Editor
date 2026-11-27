// Choose what to commit, backend: zero-context diff parsing, block composition, patch construction, and
// real `git apply --cached` round trips (stage one block of several, unstage restores the index exactly)
// with CRLF, no newline at the end, renames, a workspace inside a repository, stale picks, the RPC.
// Temp repositories live in .tmp/scm/unit (inside the project) with an isolated git config.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitService } from '../../../src/backend/git';
import { BackendService } from '../../../src/backend/service';
import { buildPatch, composeBlocks, hunksForPicks, invertHunk, parseFileRecord, parseZeroDiff, quotePath, type ZeroHunk } from '../../../src/backend/git-hunks';
import type { GitFileHunks, GitHunk } from '../../../src/shared/git';

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.tmp/scm/unit');
const CFG = path.join(BASE, 'gitconfig');

function env(): NodeJS.ProcessEnv {
  fs.mkdirSync(BASE, { recursive: true });
  if (!fs.existsSync(CFG)) fs.writeFileSync(CFG, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  return { ...process.env, GIT_CONFIG_GLOBAL: CFG, GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: BASE };
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const blob = (cwd: string, rev: string) => execFileSync('git', ['cat-file', 'blob', rev], { cwd, env: env() });
const write = (root: string, rel: string, content: string | Buffer) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
async function repo(prefix: string, files: Record<string, string | Buffer>): Promise<string> {
  await fsp.mkdir(BASE, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(BASE, `${prefix}-`));
  git(dir, 'init', '-q');
  for (const [rel, c] of Object.entries(files)) write(dir, rel, c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

const services: Array<{ dispose(): void }> = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));
const svc = (root: string) => {
  const s = new GitService(root, { env: env() });
  services.push(s);
  return s;
};
const blocks = (r: GitFileHunks): GitHunk[] => {
  if (r.mode !== 'hunks') throw new Error(`whole-file: ${r.reason}`);
  return r.hunks;
};
const pick = (h: GitHunk, include: boolean) => ({ a0: h.a0, a1: h.a1, b0: h.b0, b1: h.b1, include });
const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1));

const hunk = (o: Partial<ZeroHunk>): ZeroHunk => ({ oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, del: [], add: [], delNoEol: false, addNoEol: false, ...o });

describe('parsing and composing (pure)', () => {
  it('reads zero-context hunks driven by their counts, with no-newline markers; binary; refuses context', () => {
    const d = ['diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f', '@@ -2 +2 @@ x', '--- not a header', '+++ neither', '@@ -5,0 +6,2 @@', '+new', '+new2', '@@ -9,2 +10,0 @@', '-gone', '-gone2', '@@ -12 +12 @@', '-last', '\\ No newline at end of file', '+last!', '\\ No newline at end of file', ''].join('\n');
    const p = parseZeroDiff(d);
    expect(p).toMatchObject({ binary: false });
    const h = (p as { hunks: ZeroHunk[] }).hunks;
    expect(h.map((x) => [x.oldStart, x.oldCount, x.newStart, x.newCount])).toEqual([
      [1, 1, 1, 1],
      [5, 0, 5, 2],
      [8, 2, 10, 0],
      [11, 1, 11, 1],
    ]);
    expect(h[0]).toMatchObject({ del: ['-- not a header'], add: ['++ neither'] });
    expect(h[3]).toMatchObject({ del: ['last'], add: ['last!'], delNoEol: true, addNoEol: true });
    expect(parseZeroDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n')).toEqual({ binary: true });
    expect(parseZeroDiff('@@ -1,2 +1,2 @@\n a\n-b\n+c\n')).toBeNull();
    expect(parseZeroDiff('')).toEqual({ binary: false, hunks: [] });
  });

  it('composes HEAD → index and index → work hunks into blocks with exact ranges and states', () => {
    // staged: line 2 changed, 2 lines inserted after 10; unstaged: index line 13 (= HEAD 11) deleted,
    // and index line 2 (the staged one) changed again.
    const S = [hunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }), hunk({ oldStart: 10, oldCount: 0, newStart: 10, newCount: 2 })];
    const U = [hunk({ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }), hunk({ oldStart: 13, oldCount: 1, newStart: 13, newCount: 0 })];
    const b = composeBlocks(S, U);
    expect(b.map(({ a0, a1, b0, b1, state }) => ({ a0, a1, b0, b1, state }))).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2, state: 'mixed' },
      { a0: 10, a1: 10, b0: 10, b1: 12, state: 'staged' },
      { a0: 11, a1: 12, b0: 13, b1: 13, state: 'unstaged' },
    ]);
    // Touching index ranges are one block (they show as one change).
    const t = composeBlocks([hunk({ oldStart: 3, oldCount: 0, newStart: 3, newCount: 2 })], [hunk({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 })]);
    expect(t.map(({ a0, a1, b0, b1, state }) => ({ a0, a1, b0, b1, state }))).toEqual([{ a0: 3, a1: 4, b0: 3, b1: 6, state: 'mixed' }]);
    expect(hunksForPicks(b, [{ a0: 1, a1: 2, b0: 1, b1: 2, include: false }, { a0: 0, a1: 1, b0: 0, b1: 1, include: true }])).toMatchObject({ missing: 1, hunks: [invertHunk(S[0])] });
  });

  it('builds a patch for any subset: new starts recomputed from the hunks in it; names quoted like git', () => {
    const ins = hunk({ oldStart: 4, oldCount: 0, newStart: 9, newCount: 2, add: ['x', 'y'] });
    const mod = hunk({ oldStart: 20, oldCount: 1, newStart: 30, newCount: 1, del: ['a\r'], add: ['b\r'] });
    const del = hunk({ oldStart: 40, oldCount: 3, newStart: 55, newCount: 0, del: ['1', '2', '3'] });
    expect(buildPatch('d/f.txt', [mod, ins, del]).toString('latin1')).toBe(
      ['diff --git a/d/f.txt b/d/f.txt', '--- a/d/f.txt', '+++ b/d/f.txt', '@@ -4,0 +5,2 @@', '+x', '+y', '@@ -21,1 +23,1 @@', '-a\r', '+b\r', '@@ -41,3 +42,0 @@', '-1', '-2', '-3', ''].join('\n'),
    );
    expect(quotePath('a/plain name.md')).toBe('a/plain name.md');
    expect(quotePath('a/q"t\\b\t.md')).toBe('"a/q\\"t\\\\b\\t.md"');
    // Non-ASCII names go in as UTF-8, contents byte for byte.
    const p = buildPatch('ünï.md', [hunk({ oldStart: 0, oldCount: 1, newStart: 0, newCount: 1, del: ['\xe9'], add: ['\xff'] })]);
    expect(p.includes(Buffer.from('a/ünï.md', 'utf8'))).toBe(true);
    expect(p.subarray(p.length - 4)).toEqual(Buffer.from([0x0a, 0x2b, 0xff, 0x0a]));
  });

  it('reads the status record of one file (renames carry their source)', () => {
    const out = ['1 .M N... 100644 100644 100644 a a x.md', '2 RM N... 100644 100644 100644 a b R90 dir/new name.md', 'dir/old.md', '? u.md', ''].join('\0');
    expect(parseFileRecord(out, 'dir/new name.md')).toEqual({ kind: '2', xy: 'RM', sub: 'N...', modes: ['100644', '100644', '100644'], orig: 'dir/old.md' });
    expect(parseFileRecord(out, 'x.md')).toMatchObject({ kind: '1', xy: '.M' });
    expect(parseFileRecord(out, 'u.md')).toMatchObject({ kind: '?' });
    expect(parseFileRecord(out, 'dir/old.md')).toBeNull();
  });
});

describe('stage / unstage blocks with git apply --cached', () => {
  it('one block of three goes in alone; unstaging restores the index exactly; several in one call', async () => {
    const head = lines(20);
    const dir = await repo('three', { 'f.txt': head.join('\n') + '\n' });
    const work = [...head];
    work[1] = 'line 2 changed';
    work.splice(10, 0, 'inserted A', 'inserted B'); // after line 10
    work.splice(19, 1); // HEAD line 18
    write(dir, 'f.txt', work.join('\n') + '\n');
    const g = svc(dir);
    const r = await g.hunks('f.txt');
    const b = blocks(r);
    expect(b).toEqual([
      { a0: 1, a1: 2, b0: 1, b1: 2, state: 'unstaged' },
      { a0: 10, a1: 10, b0: 10, b1: 12, state: 'unstaged' },
      { a0: 17, a1: 18, b0: 19, b1: 19, state: 'unstaged' },
    ]);
    expect(r).toMatchObject({ head: head.join('\n') + '\n', work: work.join('\n') + '\n' });

    expect(await g.stageHunks('f.txt', [pick(b[1], true)])).toMatchObject({ ok: true });
    expect(git(dir, 'diff', '--cached', '-U0').split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual(['+inserted A', '+inserted B']);
    expect(git(dir, 'diff', '-U0').split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual(['-line 2', '+line 2 changed', '-line 18']);
    expect(blocks(await g.hunks('f.txt')).map((h) => h.state)).toEqual(['unstaged', 'staged', 'unstaged']);

    expect(await g.stageHunks('f.txt', [pick(b[1], false)])).toMatchObject({ ok: true });
    expect(git(dir, 'rev-parse', ':f.txt')).toBe(git(dir, 'rev-parse', 'HEAD:f.txt'));

    // First and last together (one git apply); the ranges from before still name them.
    expect(await g.stageHunks('f.txt', [pick(b[2], true), pick(b[0], true)])).toMatchObject({ ok: true });
    const expected = [...head];
    expected[1] = 'line 2 changed';
    expected.splice(17, 1);
    expect(blob(dir, ':f.txt').toString()).toBe(expected.join('\n') + '\n');
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(work.join('\n') + '\n'); // never the working tree
  });

  it('a block edited again after staging is partly staged; including it stages all of it', async () => {
    const dir = await repo('mixed', { 'f.txt': lines(8).join('\n') + '\n' });
    const g = svc(dir);
    write(dir, 'f.txt', lines(8, (i) => (i === 3 ? 'three' : `line ${i}`)).join('\n') + '\n');
    git(dir, 'add', 'f.txt');
    write(dir, 'f.txt', lines(8, (i) => (i === 3 ? 'THREE' : i === 4 ? 'four' : `line ${i}`)).join('\n') + '\n');
    const [b] = blocks(await g.hunks('f.txt'));
    expect(b).toEqual({ a0: 2, a1: 4, b0: 2, b1: 4, state: 'mixed' });
    expect(await g.stageHunks('f.txt', [pick(b, true)])).toMatchObject({ ok: true });
    expect(git(dir, 'diff').trim()).toBe('');
    expect(blocks(await g.hunks('f.txt'))).toEqual([{ ...b, state: 'staged' }]);
  });

  it('CRLF stored in the index: line ends survive both ways', async () => {
    const head = lines(10).join('\r\n') + '\r\n';
    const dir = await repo('crlf', { 'w.txt': head });
    const work = lines(10, (i) => (i === 2 ? 'two' : i === 9 ? 'nine' : `line ${i}`)).join('\r\n') + '\r\n';
    write(dir, 'w.txt', work);
    const g = svc(dir);
    const b = blocks(await g.hunks('w.txt'));
    expect(b).toHaveLength(2);
    expect(await g.stageHunks('w.txt', [pick(b[1], true)])).toMatchObject({ ok: true });
    const idx = blob(dir, ':w.txt').toString('latin1');
    expect(idx).toBe(lines(10, (i) => (i === 9 ? 'nine' : `line ${i}`)).join('\r\n') + '\r\n');
    expect(await g.stageHunks('w.txt', [pick(b[1], false)])).toMatchObject({ ok: true });
    expect(blob(dir, ':w.txt').toString('latin1')).toBe(head);
  });

  it('eol=crlf attribute: LF in the index, CRLF on disk; staging one block leaves exactly the other', async () => {
    const dir = await repo('eol', { '.gitattributes': '*.txt text eol=crlf\n', 'w.txt': lines(10).join('\r\n') + '\r\n' });
    expect(blob(dir, 'HEAD:w.txt').includes(0x0d)).toBe(false);
    write(dir, 'w.txt', lines(10, (i) => (i === 2 ? 'two' : i === 9 ? 'nine' : `line ${i}`)).join('\r\n') + '\r\n');
    const g = svc(dir);
    const r = await g.hunks('w.txt');
    const b = blocks(r);
    expect(r).toMatchObject({ work: lines(10, (i) => (i === 2 ? 'two' : i === 9 ? 'nine' : `line ${i}`)).join('\n') + '\n' });
    expect(await g.stageHunks('w.txt', [pick(b[0], true)])).toMatchObject({ ok: true });
    expect(blob(dir, ':w.txt').toString()).toBe(lines(10, (i) => (i === 2 ? 'two' : `line ${i}`)).join('\n') + '\n');
    expect(git(dir, 'diff', '-U0').split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual(['-line 9', '+nine']);
  });

  it('no newline at the end: the last line, and adding the newline, stage on their own', async () => {
    const dir = await repo('eof', { 'n.txt': 'a\nb\nc' });
    write(dir, 'n.txt', 'A\nb\nc\nd');
    const g = svc(dir);
    const b = blocks(await g.hunks('n.txt'));
    expect(b.map((h) => [h.a0, h.a1, h.b0, h.b1])).toEqual([
      [0, 1, 0, 1],
      [2, 3, 2, 4],
    ]);
    expect(await g.stageHunks('n.txt', [pick(b[1], true)])).toMatchObject({ ok: true });
    expect(blob(dir, ':n.txt').toString()).toBe('a\nb\nc\nd');
    expect(await g.stageHunks('n.txt', [pick(b[0], true)])).toMatchObject({ ok: true });
    expect(blob(dir, ':n.txt').toString()).toBe('A\nb\nc\nd');
    expect(await g.stageHunks('n.txt', [pick(b[1], false)])).toMatchObject({ ok: true });
    expect(blob(dir, ':n.txt').toString()).toBe('A\nb\nc');
    // Only the final newline added.
    git(dir, 'reset', '-q');
    write(dir, 'n.txt', 'a\nb\nc\n');
    const [nl] = blocks(await g.hunks('n.txt'));
    expect(await g.stageHunks('n.txt', [pick(nl, true)])).toMatchObject({ ok: true });
    expect(blob(dir, ':n.txt').toString()).toBe('a\nb\nc\n');
    expect(await g.stageHunks('n.txt', [pick(nl, false)])).toMatchObject({ ok: true });
    expect(blob(dir, ':n.txt').toString()).toBe('a\nb\nc');
  });

  it('a staged rename: blocks against the old name; staging / unstaging content keeps the rename', async () => {
    const dir = await repo('rename', { 'old name.txt': lines(20).join('\n') + '\n' });
    git(dir, 'mv', 'old name.txt', 'new name.txt');
    write(dir, 'new name.txt', lines(20, (i) => (i === 5 ? 'five' : `line ${i}`)).join('\n') + '\n');
    git(dir, 'add', 'new name.txt');
    write(dir, 'new name.txt', lines(20, (i) => (i === 5 ? 'five' : i === 15 ? 'fifteen' : `line ${i}`)).join('\n') + '\n');
    const g = svc(dir);
    expect(await g.hunks('new name.txt')).toEqual({ mode: 'file', reason: 'added' }); // the source is needed to see the rename
    const r = await g.hunks('new name.txt', 'old name.txt');
    const b = blocks(r);
    expect(r).toMatchObject({ head: lines(20).join('\n') + '\n' });
    expect(b.map((h) => [h.a0, h.state])).toEqual([
      [4, 'staged'],
      [14, 'unstaged'],
    ]);
    expect(await g.stageHunks('new name.txt', [pick(b[1], true)], 'old name.txt')).toMatchObject({ ok: true });
    expect(await g.stageHunks('new name.txt', [pick(b[0], false)], 'old name.txt')).toMatchObject({ ok: true });
    expect(blob(dir, ':new name.txt').toString()).toBe(lines(20, (i) => (i === 15 ? 'fifteen' : `line ${i}`)).join('\n') + '\n');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('RM "old name.txt" -> "new name.txt"');
  });

  it('whole-file only: untracked, added, deleted, binary', async () => {
    const dir = await repo('whole', { 'del.txt': 'x\n', 'bin.dat': Buffer.from([0, 1, 2, 10]) });
    write(dir, 'new.txt', 'n\n');
    write(dir, 'added.txt', 'a\n');
    git(dir, 'add', 'added.txt');
    fs.rmSync(path.join(dir, 'del.txt'));
    write(dir, 'bin.dat', Buffer.from([0, 1, 3, 10]));
    const g = svc(dir);
    expect(await g.hunks('new.txt')).toEqual({ mode: 'file', reason: 'untracked' });
    expect(await g.hunks('added.txt')).toEqual({ mode: 'file', reason: 'added' });
    expect(await g.hunks('del.txt')).toEqual({ mode: 'file', reason: 'deleted' });
    expect(await g.hunks('bin.dat')).toEqual({ mode: 'file', reason: 'binary' });
    expect(await g.stageHunks('new.txt', [{ a0: 0, a1: 0, b0: 0, b1: 1, include: true }])).toMatchObject({ ok: false });
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('added.txt');
  });

  it('a workspace inside a repository (prefix), stale picks refused, garbage input rejected', async () => {
    const dir = await repo('prefix', { 'docs/a.txt': lines(10).join('\n') + '\n' });
    write(dir, 'docs/a.txt', lines(10, (i) => (i === 3 ? 'three' : i === 8 ? 'eight' : `line ${i}`)).join('\n') + '\n');
    const g = svc(path.join(dir, 'docs'));
    const b = blocks(await g.hunks('a.txt'));
    expect(await g.stageHunks('a.txt', [pick(b[1], true)])).toMatchObject({ ok: true });
    expect(git(dir, 'diff', '--cached', '-U0').split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual(['-line 8', '+eight']);
    // The file changed after the view was built: the pick names no block any more.
    write(dir, 'docs/a.txt', lines(10, (i) => (i === 3 ? 'three!' : i === 8 ? 'eight' : `line ${i}`)).join('\n') + '\n');
    const before = git(dir, 'rev-parse', ':docs/a.txt');
    expect(await g.stageHunks('a.txt', [{ ...pick(b[0], true), b1: 7 }])).toMatchObject({ ok: false, message: expect.stringMatching(/changed meanwhile/) });
    expect(git(dir, 'rev-parse', ':docs/a.txt')).toBe(before);
    await expect(g.stageHunks('a.txt', [{ a0: -1, a1: 0, b0: 0, b1: 0, include: true }])).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.stageHunks('a.txt', 'all')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await g.hunks('../outside.txt')).toEqual({ mode: 'file', reason: 'unchanged' }); // clamped to the workspace, like every path
  });

  it('through the RPC dispatcher', async () => {
    const dir = await repo('rpc', { 'a.md': lines(6).join('\n') + '\n' });
    write(dir, 'a.md', lines(6, (i) => (i === 1 ? 'one' : i === 6 ? 'six' : `line ${i}`)).join('\n') + '\n');
    const cfg = await fsp.mkdtemp(path.join(BASE, 'rpc-cfg-'));
    const s = new BackendService(cfg, { confirmTrust: async () => true }, {}, { env: env() });
    services.push(s);
    await s.openWorkspace(dir);
    await s.git('trust'); // the user's "Trust" in the Source control panel: no git runs without it
    const r = (await s.git('hunks', 'a.md')) as GitFileHunks;
    const b = blocks(r);
    expect(await s.git('stageHunks', 'a.md', [pick(b[0], true)])).toMatchObject({ ok: true });
    expect(blocks((await s.git('hunks', 'a.md')) as GitFileHunks).map((h) => h.state)).toEqual(['staged', 'unstaged']);
    await expect(s.git('stageHunks', 'a.md', [{ nope: 1 }])).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

// The work file is read after git looked at it: a link swapped in there meanwhile must not be followed out of the
// folder. A wrapper around git does the swap right after the last git call hunks() makes (cat-file).
describe.skipIf(process.platform === 'win32')('hunks() reads the work file inside the folder only', () => {
  it('a link swapped in after git looked is not followed (no outside text reaches the page)', async () => {
    const dir = await repo('swap', { 'a.txt': lines(5).join('\n') + '\n' });
    write(dir, 'a.txt', lines(5, (i) => (i === 3 ? 'changed' : `line ${i}`)).join('\n') + '\n');
    const outside = await fsp.mkdtemp(path.join(BASE, 'outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'line 1\nline 2\nSECRET\nline 4\nline 5\n');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const flag = path.join(outside, 'armed');
    const wrapper = path.join(outside, 'git-wrap.sh');
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\n"${real}" "$@"; rc=$?\ncase " $* " in *" cat-file "*) if [ -f "${flag}" ]; then rm -f "${flag}" "${dir}/a.txt"; ln -s "${outside}/secret.txt" "${dir}/a.txt"; fi;; esac\nexit $rc\n`,
      { mode: 0o755 },
    );
    const s = new GitService(dir, { env: env(), gitPath: wrapper });
    services.push(s);
    expect((await s.hunks('a.txt')).mode).toBe('hunks'); // the wrapper itself is a working git
    fs.writeFileSync(flag, '');
    const r = await s.hunks('a.txt');
    expect(fs.lstatSync(path.join(dir, 'a.txt')).isSymbolicLink(), 'the swap happened').toBe(true);
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(r).toEqual({ mode: 'file', reason: 'unavailable' });
  });
});
