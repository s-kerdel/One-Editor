// GitService against real repositories created with the system git.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitService } from '../../../src/backend/git';
import type { GitEntry, GitStatus, GitStatusResult } from '../../../src/shared/git';
import { BASE, git, makeRepo, testEnv, tmpDir, until, write } from './helpers';

const services: GitService[] = [];
const svc = (root: string, extra: ConstructorParameters<typeof GitService>[1] = {}) => {
  const s = new GitService(root, { env: testEnv(), watchDebounceMs: 40, ...extra });
  services.push(s);
  return s;
};
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

function ok(r: GitStatusResult): GitStatus {
  if (!r.ok) throw new Error(`git unavailable: ${r.reason} ${r.message ?? ''}`);
  return r;
}
const byPath = (entries: GitEntry[]) => Object.fromEntries(entries.map((e) => [e.path, e]));

describe('git status', () => {
  it('clean repository: branch, oid, no entries', async () => {
    const dir = await makeRepo('clean', { 'a.md': 'hello\n' });
    const s = ok(await svc(dir).status());
    expect(s.branch).toMatchObject({ head: 'main', detached: false, upstream: null, ahead: 0, behind: 0 });
    expect(s.branch.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(s.entries).toEqual([]);
    expect(s.prefix).toBe('');
  });

  it('modified, untracked, staged, deleted, renamed, ignored', async () => {
    const dir = await makeRepo('mixed', { 'mod.md': 'a\n', 'gone.md': 'x\n', 'old name.md': 'rename me\n', '.gitignore': '*.log\nbuild/\n', 'keep/k.md': 'k\n' });
    write(dir, 'mod.md', 'a\nb\n');
    write(dir, 'new.md', 'new\n');
    write(dir, 'fresh/inner/n.md', 'n\n'); // untracked folder → one entry
    write(dir, 'staged.md', 's\n');
    git(dir, 'add', 'staged.md');
    fs.rmSync(path.join(dir, 'gone.md'));
    git(dir, 'mv', 'old name.md', 'new name.md');
    write(dir, 'debug.log', 'log\n');
    write(dir, 'build/out.js', '1\n');
    const e = byPath(ok(await svc(dir).status()).entries);
    expect(e['mod.md']).toMatchObject({ state: 'modified', unstaged: true, staged: false });
    expect(e['new.md']).toMatchObject({ state: 'untracked' });
    expect(e['fresh']).toMatchObject({ state: 'untracked', dir: true });
    expect(e['fresh/inner/n.md']).toBeUndefined();
    expect(e['staged.md']).toMatchObject({ state: 'added', staged: true });
    expect(e['gone.md']).toMatchObject({ state: 'deleted' });
    expect(e['new name.md']).toMatchObject({ state: 'renamed', from: 'old name.md' });
    expect(e['debug.log']).toMatchObject({ state: 'ignored' });
    expect(e['build']).toMatchObject({ state: 'ignored', dir: true });
    expect(e['keep/k.md']).toBeUndefined();
  });

  it('merge conflict', async () => {
    const dir = await makeRepo('conflict', { 'c.md': 'base\n' });
    git(dir, 'checkout', '-qb', 'other');
    write(dir, 'c.md', 'theirs\n');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'c.md', 'ours\n');
    git(dir, 'commit', '-qam', 'ours');
    try {
      git(dir, 'merge', '-q', 'other');
    } catch {}
    const e = byPath(ok(await svc(dir).status()).entries);
    expect(e['c.md'].state).toBe('conflicted');
  });

  it('unicode and space paths come back raw (core.quotepath off, -z)', async () => {
    const dir = await makeRepo('unicode', { 'ünï cødé/ä b.md': 'x\n', 'emoji 🚀.md': 'y\n' });
    write(dir, 'ünï cødé/ä b.md', 'changed\n');
    write(dir, 'emoji 🚀.md', 'changed\n');
    write(dir, '日本語 new.md', 'n\n');
    const e = byPath(ok(await svc(dir).status()).entries);
    expect(e['ünï cødé/ä b.md'].state).toBe('modified');
    expect(e['emoji 🚀.md'].state).toBe('modified');
    expect(e['日本語 new.md'].state).toBe('untracked');
    expect((await svc(dir).headFile('ünï cødé/ä b.md')).content).toBe('x\n');
  });

  it('detached HEAD', async () => {
    const dir = await makeRepo('detached', { 'a.md': '1\n' });
    write(dir, 'a.md', '2\n');
    git(dir, 'commit', '-qam', 'two');
    git(dir, 'checkout', '-q', '--detach', 'HEAD~1');
    const s = ok(await svc(dir).status());
    expect(s.branch).toMatchObject({ detached: true, head: null });
    expect(s.branch.oid).toBe(git(dir, 'rev-parse', 'HEAD').trim());
  });

  it('repository without commits', async () => {
    const dir = await makeRepo('initial');
    write(dir, 'a.md', 'x\n');
    const s = ok(await svc(dir).status());
    expect(s.branch).toMatchObject({ head: 'main', oid: null });
    expect(byPath(s.entries)['a.md'].state).toBe('untracked');
    expect(await svc(dir).headFile('a.md')).toEqual({ content: null, oid: null });
  });

  it('ahead / behind its upstream', async () => {
    const dir = await makeRepo('ab', { 'a.md': '1\n' });
    const remote = await tmpDir('ab-remote');
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const other = await tmpDir('ab-other');
    git(other, 'clone', '-q', remote, '.');
    write(other, 'b.md', 'b\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'remote side');
    git(other, 'push', '-q');
    write(dir, 'c.md', 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'local side');
    git(dir, 'fetch', '-q');
    const s = ok(await svc(dir).status());
    expect(s.branch).toMatchObject({ head: 'main', upstream: 'origin/main', ahead: 1, behind: 1 });
  });

  it('workspace in a subfolder of the repo: prefix, relative paths, outside changes dropped', async () => {
    const dir = await makeRepo('subws', { 'docs/a.md': 'a\n', 'docs/deep/b.md': 'b\n', 'src/x.ts': 'x\n' });
    write(dir, 'docs/a.md', 'a2\n');
    write(dir, 'src/x.ts', 'x2\n');
    write(dir, 'docs/new.md', 'n\n');
    git(dir, 'mv', 'src/x.ts', 'docs/moved.ts');
    const g = svc(path.join(dir, 'docs'));
    const s = ok(await g.status());
    expect(s.prefix).toBe('docs/');
    const e = byPath(s.entries);
    expect(Object.keys(e).sort()).toEqual(['a.md', 'moved.ts', 'new.md']);
    expect(e['moved.ts']).toMatchObject({ state: 'added' }); // its source is outside the workspace pathspec
    expect((await g.headFile('a.md')).content).toBe('a\n');
    expect((await g.headFile('deep/b.md')).content).toBe('b\n');
    // `..` cannot climb out of the workspace: it collapses inside (docs/src/x.ts, not src/x.ts).
    expect((await g.headFile('../src/x.ts')).content).toBeNull();
  });

  it('a workspace that is entirely untracked inside a repo', async () => {
    const dir = await makeRepo('untrackedws', { 'a.md': 'a\n' });
    write(dir, 'notes/n.md', 'n\n');
    const s = ok(await svc(path.join(dir, 'notes')).status());
    expect(s.entries).toEqual([{ path: '', state: 'untracked', dir: true }]);
  });

  it('submodule shows as one entry', async () => {
    const lib = await makeRepo('sublib', { 'lib.md': 'l\n' });
    const dir = await makeRepo('super', { 'a.md': 'a\n' });
    git(dir, 'submodule', '-q', 'add', lib, 'vendor/lib');
    git(dir, 'commit', '-qm', 'add sub');
    const inner = path.join(dir, 'vendor/lib');
    write(inner, 'lib.md', 'l2\n');
    git(inner, 'commit', '-qam', 'inner change');
    write(inner, 'scratch.md', 'dirty\n'); // dirty submodule content is not walked
    const e = ok(await svc(dir).status()).entries;
    expect(e).toEqual([expect.objectContaining({ path: 'vendor/lib', state: 'modified', submodule: true })]);
  });

  it('is not fooled by inherited GIT_DIR / GIT_WORK_TREE', async () => {
    const a = await makeRepo('envA', { 'a.md': 'a\n' });
    const b = await makeRepo('envB', { 'b.md': 'b\n' });
    write(b, 'b.md', 'changed\n');
    const s = ok(await svc(a, { env: testEnv({ GIT_DIR: path.join(b, '.git'), GIT_WORK_TREE: b }) }).status());
    expect(s.entries).toEqual([]);
  });

  it('shares concurrent calls (no spawn storm)', async () => {
    const dir = await makeRepo('coalesce', { 'a.md': 'a\n' });
    const g = svc(dir);
    const all = await Promise.all(Array.from({ length: 10 }, () => g.status()));
    expect(all.every((r) => r.ok)).toBe(true);
    // first run + at most one follow-up run
    expect(new Set(all).size).toBeLessThanOrEqual(2);
  });
});

describe('git unavailable', () => {
  it('no git executable → no-git', async () => {
    const dir = await makeRepo('nogit', { 'a.md': 'a\n' });
    const g = svc(dir, { gitPath: path.join(BASE, 'definitely-not-git') });
    expect(await g.status()).toMatchObject({ ok: false, reason: 'no-git', repoLikely: true });
    expect(await g.headFile('a.md')).toEqual({ content: null, oid: null });
    const plain = await tmpDir('nogit-plain');
    expect(await svc(plain, { gitPath: path.join(BASE, 'definitely-not-git') }).status()).toEqual({ ok: false, reason: 'no-git' });
  });

  it('plain folder → no-repo, then a repo once `git init` ran (re-checked)', async () => {
    const dir = await tmpDir('plain');
    write(dir, 'a.md', 'a\n');
    const g = svc(dir);
    expect(await g.status()).toMatchObject({ ok: false, reason: 'no-repo' });
    git(dir, 'init', '-q');
    g.invalidate();
    expect((await g.status()).ok).toBe(true);
  });
});

describe('headFile (content at HEAD)', () => {
  it('reads HEAD, LF-normalised; untracked → null; validates paths and revisions', async () => {
    const dir = await makeRepo('head', { 'a.md': 'one\ntwo\n' });
    write(dir, 'a.md', 'one\nTWO\n');
    write(dir, 'u.md', 'u\n');
    const g = svc(dir);
    const head = await g.headFile('a.md');
    expect(head.content).toBe('one\ntwo\n');
    expect(head.oid).toBe(git(dir, 'rev-parse', 'HEAD').trim());
    expect((await g.headFile('a.md', head.oid!)).content).toBe('one\ntwo\n');
    expect((await g.headFile('u.md')).content).toBeNull();
    await expect(g.headFile(42 as unknown as string)).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.headFile('a\nb.md')).rejects.toMatchObject({ code: 'EINVAL' }); // would break the batch protocol
    await expect(g.headFile('a.md', '--output=/tmp/x')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.headFile('a.md', 'HEAD~1')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.headFile('')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('CRLF: autocrlf=true work tree compares equal to the LF blob; CRLF blobs come back LF', async () => {
    const dir = await makeRepo('crlf', { 'lf.md': 'a\nb\n' });
    git(dir, 'config', 'core.autocrlf', 'true');
    fs.rmSync(path.join(dir, 'lf.md'));
    git(dir, 'checkout', '--', 'lf.md'); // what a Windows checkout looks like
    const disk = fs.readFileSync(path.join(dir, 'lf.md'), 'utf8');
    expect(disk).toBe('a\r\nb\r\n');
    const g = svc(dir);
    expect(ok(await g.status()).entries).toEqual([]);
    // The editor's buffer is the LF-normalised disk text: identical to the HEAD content → no change bars.
    expect((await g.headFile('lf.md')).content).toBe(disk.replace(/\r\n/g, '\n'));
    // A file committed with CRLF (autocrlf off) is still handed to the renderer LF-normalised.
    git(dir, 'config', 'core.autocrlf', 'false');
    write(dir, 'crlf.md', 'x\r\ny\r\n');
    git(dir, 'add', 'crlf.md');
    git(dir, 'commit', '-qm', 'crlf');
    expect((await g.headFile('crlf.md')).content).toBe('x\ny\n');
  });

  it('decodes like the editor: BOM stripped, UTF-16, binary and LFS pointers refused', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hé\r\nllo\r\n', 'utf16le')]);
    const dir = await makeRepo('enc', {
      'bom.md': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom\n')]),
      'w.ps1': utf16,
      'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1, 2, 3]),
      'big.psd': 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12345\n',
    });
    const g = svc(dir);
    expect((await g.headFile('bom.md')).content).toBe('bom\n');
    expect((await g.headFile('w.ps1')).content).toBe('hé\nllo\n');
    expect(await g.headFile('img.png')).toMatchObject({ content: null, binary: true });
    expect(await g.headFile('big.psd')).toMatchObject({ content: null, lfs: true });
  });

  it('refuses blobs over the size cap', async () => {
    const dir = await makeRepo('bigblob', { 'big.txt': 'x'.repeat(9 * 1024 * 1024) });
    expect(await svc(dir).headFile('big.txt')).toMatchObject({ content: null, tooLarge: true });
  });

  it('case-insensitive platforms find the committed spelling', async () => {
    const dir = await makeRepo('case', { 'Notes/Todo.md': 'todo\n' });
    // darwin rules: POSIX paths, case-insensitive lookups (the tree may say notes/todo.md).
    expect((await svc(dir, { platform: 'darwin' }).headFile('notes/todo.md')).content).toBe('todo\n');
    expect((await svc(dir, { platform: 'linux' }).headFile('notes/todo.md')).content).toBeNull();
  });
});

describe('diff', () => {
  it('unified diff against HEAD, without external diff or textconv', async () => {
    const dir = await makeRepo('diff', { 'a.md': 'one\ntwo\n' });
    const marker = path.join(dir, '..', `${path.basename(dir)}-extdiff`);
    git(dir, 'config', 'diff.external', `touch ${marker}`);
    write(dir, 'a.md', 'one\n2\n');
    const out = await svc(dir).diff('a.md');
    expect(out).toContain('-two\n+2\n');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('never runs repository-supplied programs', () => {
  it('ignores a hostile core.fsmonitor and clean filter from .git/config', async () => {
    const dir = await makeRepo('hostile', { 'a.txt': 'a\n', '.gitattributes': '*.txt filter=evil\n' });
    const marker = path.join(dir, '..', `${path.basename(dir)}-pwned`);
    const script = path.join(dir, '..', `${path.basename(dir)}-evil.sh`);
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', script);
    git(dir, 'config', 'filter.evil.clean', script);
    git(dir, 'config', 'filter.evil.required', 'true');
    // Same size, new mtime: git has to re-hash the file → it would run the clean filter.
    const f = path.join(dir, 'a.txt');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const g = svc(dir);
    const s = ok(await g.status());
    expect(s.entries).toEqual([]);
    await g.diff('a.txt');
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('filter drivers a folder brings along never run on a read', () => {
  /** Committed a.txt with filter=<name>, then a new mtime: git must re-hash it → it would run the clean filter. */
  async function filtered(prefix: string, name: string) {
    const dir = await makeRepo(prefix, { 'a.txt': 'a\n', '.gitattributes': `*.txt filter=${name}\n` });
    const marker = path.join(dir, '..', `${path.basename(dir)}-pwned`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 'a.txt'), later, later);
    return { dir, marker };
  }
  async function readEverything(dir: string) {
    const g = svc(dir);
    const s = ok(await g.status());
    await g.diff('a.txt');
    await g.hunks('a.txt', null);
    await g.refreshIndex();
    return s;
  }

  it('a value that starts like Git LFS and goes on with a shell command', async () => {
    const { dir, marker } = await filtered('lfs-lookalike', 'lfs');
    git(dir, 'config', 'filter.lfs.clean', `git-lfs clean -- %f; touch '${marker}'; cat`);
    git(dir, 'config', 'filter.lfs.process', `git-lfs filter-process; touch '${marker}'`);
    git(dir, 'config', 'filter.lfs.required', 'true');
    expect((await readEverything(dir)).entries).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a driver defined in the worktree config (extensions.worktreeConfig)', async () => {
    const { dir, marker } = await filtered('worktree-config', 'evil');
    git(dir, 'config', 'extensions.worktreeConfig', 'true');
    git(dir, 'config', '--worktree', 'filter.evil.clean', `touch '${marker}'; cat`);
    git(dir, 'config', '--worktree', 'filter.evil.required', 'true');
    expect((await readEverything(dir)).entries).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a driver defined in an included file', async () => {
    const { dir, marker } = await filtered('included-config', 'evil');
    fs.writeFileSync(path.join(dir, '.git', 'extra.cfg'), `[filter "evil"]\n\tclean = "touch '${marker}'; cat"\n\tsmudge = cat\n`);
    git(dir, 'config', 'include.path', 'extra.cfg');
    expect((await readEverything(dir)).entries).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('canonical Git LFS stays configured: without git-lfs installed the file simply passes unfiltered', async () => {
    const { dir } = await filtered('lfs-canonical', 'lfs');
    git(dir, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
    git(dir, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    git(dir, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    // The "is git-lfs there?" probe must not run an `lfs` alias the folder defines.
    const marker = path.join(dir, '..', `${path.basename(dir)}-pwned`);
    git(dir, 'config', 'alias.lfs', `!touch '${marker}'`);
    const s = await readEverything(dir);
    expect(s.ok).toBe(true);
    expect(s.entries.filter((e) => e.path !== 'a.txt')).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('watching .git', () => {
  it('fires on commit and checkout in a terminal, not on our own status runs', async () => {
    const dir = await makeRepo('watch', { 'a.md': 'a\n' });
    const g = svc(dir);
    let n = 0;
    g.onChange(() => n++);
    await ok(await g.status()); // discovery (+ watchers armed)
    await new Promise((r) => setTimeout(r, 200));
    await g.status();
    await g.status();
    await new Promise((r) => setTimeout(r, 250));
    expect(n).toBe(0);
    write(dir, 'b.md', 'b\n');
    git(dir, 'add', 'b.md');
    git(dir, 'commit', '-qm', 'b');
    await until(() => n > 0);
    const after = n;
    git(dir, 'checkout', '-qb', 'feature');
    await until(() => n > after);
    expect(ok(await g.status()).branch.head).toBe('feature');
  });

  it('notices `git init` in a plain folder', async () => {
    const dir = await tmpDir('watchinit');
    const g = svc(dir);
    let n = 0;
    g.onChange(() => n++);
    expect((await g.status()).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    git(dir, 'init', '-q');
    await until(() => n > 0);
    expect((await g.status()).ok).toBe(true);
  });
});

describe('big repository', () => {
  it('status of ~10k files stays fast (one spawn)', async () => {
    const dir = await tmpDir('big');
    git(dir, 'init', '-q');
    for (let d = 0; d < 100; d++) {
      const sub = path.join(dir, `dir${d}`);
      fs.mkdirSync(sub);
      for (let f = 0; f < 100; f++) fs.writeFileSync(path.join(sub, `file${f}.md`), `# ${d}/${f}\n`);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'big');
    for (let i = 0; i < 20; i++) fs.appendFileSync(path.join(dir, `dir${i}`, 'file1.md'), 'edit\n');
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `dir${i}`, `new${i}.md`), 'new\n');
    const g = svc(dir);
    await g.status(); // warm (discovery, index refresh in memory)
    const t0 = performance.now();
    const s = ok(await g.status());
    const ms = performance.now() - t0;
    console.log(`[git perf] status 10k files: ${ms.toFixed(0)} ms wall, git ${s.ms} ms, ${s.entries.length} entries`);
    expect(s.entries.length).toBe(40);
    expect(ms).toBeLessThan(2000);
  }, 120_000);
});
