// Indexing reads: what is skipped (git-ignored, lockfiles, minified, too big), the parallel reader
// returns exactly what the in-thread reader returns, and the persistent cache makes a warm start
// read only changed files — and survives corruption.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Workspace } from '../../../src/backend/workspace';
import { IgnoreStack, isLockfile, isMinified } from '../../../src/backend/gitignore';
import { SearchEngine } from '../../../src/search/engine';
import type { FileData } from '../../../src/shared/api';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-index-pass');

async function all(ws: Workspace, maxBytes = 64 * 1024): Promise<FileData[]> {
  await ws.listTree();
  const out: FileData[] = [];
  let cursor: string | null = null;
  do {
    const p = await ws.readAllTextPage({ cursor, maxBytes });
    out.push(...p.files);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}
const strip = (f: FileData) => ({ path: f.path, content: f.content, eol: f.eol, bom: f.bom, encoding: f.encoding });

let dir: string;
let cacheDir: string;
const write = (rel: string, text: string | Buffer) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

beforeEach(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  cacheDir = path.join(path.dirname(dir), `${path.basename(dir)}-cache`);
  for (let i = 0; i < 120; i++) write(`notes/n${i}.md`, `# Note ${i}\n\nrollback ${i}\r\n`);
  write('README.md', '# Readme\n');
  write('src/app.ts', 'export const x = 1;\n');
  write('crlf.txt', 'a\r\nb\r\n');
  write('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# bom\n')]));
  write('utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('wide text\n', 'utf16le')]));
  write('binary.json', Buffer.from([0x7b, 0, 1, 2, 3]));
  // Skipped by default:
  write('package-lock.json', '{"lockfileVersion": 3}\n');
  write('sub/composer.lock', '{}\n');
  write('public/app.min.js', 'var a=1;');
  write('public/app.js.map', '{"version":3}');
  write('.gitignore', 'coverage/\n*.log\n/out/\n!keep.log\n');
  write('coverage/index.html', '<html>coverage</html>');
  write('debug.log', 'noise');
  write('keep.log', 'kept');
  write('out/gen.js', 'gen');
  write('nested/out/real.md', 'not root out → indexed');
  write('nested/.gitignore', 'secret.md\n');
  write('nested/secret.md', 'ignored by nested rule');
  write('big.txt', 'x'.repeat(40 * 1024));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(cacheDir, { recursive: true, force: true });
});

describe('index filters', () => {
  it('skips git-ignored, lockfiles, minified bundles and maps; the tree still lists them', async () => {
    const ws = new Workspace(dir, { watchMode: 'poll', index: { maxFileBytes: 32 * 1024 } });
    const feed = await all(ws);
    const paths = feed.map((f) => f.path);
    // Lockfiles, minified bundles/maps and git-ignored files are never in the index, not even by name.
    for (const p of ['package-lock.json', 'sub/composer.lock', 'public/app.min.js', 'public/app.js.map', 'coverage/index.html', 'debug.log', 'out/gen.js', 'nested/secret.md']) expect(paths, p).not.toContain(p);
    // A text-named file whose content can't be indexed (oversized, or binary/NUL) is a name-only entry:
    // present, findable by name / path / ext, but its content is never read (empty + binary flag).
    for (const p of ['big.txt', 'binary.json']) {
      expect(paths, p).toContain(p);
      const f = feed.find((x) => x.path === p)!;
      expect(f.content, p).toBe('');
      expect(f.binary, p).toBe(true);
    }
    for (const p of ['README.md', 'keep.log', 'nested/out/real.md', 'notes/n0.md', 'src/app.ts']) expect(paths, p).toContain(p);
    const tree = JSON.stringify(await ws.listTree());
    for (const p of ['package-lock.json', 'coverage', 'debug.log', 'app.min.js']) expect(tree).toContain(p);
    expect(ws.isIndexSkipped('coverage/index.html')).toBe(true);
    expect(ws.isIndexSkipped('README.md')).toBe(false);
    ws.dispose();
  });

  it('every filter can be turned off', async () => {
    const ws = new Workspace(dir, { watchMode: 'poll', index: { respectGitignore: false, skipLockfiles: false, skipMinified: false } });
    const paths = (await all(ws)).map((f) => f.path);
    for (const p of ['package-lock.json', 'public/app.min.js', 'coverage/index.html', 'debug.log', 'nested/secret.md', 'big.txt']) expect(paths, p).toContain(p);
    expect(paths).not.toContain('public/app.js.map'); // never a text extension
    ws.dispose();
  });

  it('name filters', () => {
    expect(['package-lock.json', 'YARN.LOCK', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum'].every(isLockfile)).toBe(true);
    expect(isLockfile('lock.md')).toBe(false);
    expect(['a.min.js', 'a.min.css', 'x.js.map', 'b.min.mjs'].every(isMinified)).toBe(true);
    expect(isMinified('admin.js')).toBe(false);
  });
});

describe('gitignore semantics match git', () => {
  const PATTERNS = ['*.log', '!important.log', 'build/', '/root-only.txt', 'docs/**/draft.md', '**/tmp', 'a/**', 'x?z.md', '[ab]c.md', 'deep/nested/', '\\#hash.md', 'spaced\\ ', 'logs/*.txt', '!logs/keep.txt'];
  const PATHS = ['a.log', 'important.log', 'sub/b.log', 'build/x.md', 'sub/build/y.md', 'build.md', 'root-only.txt', 'sub/root-only.txt', 'docs/draft.md', 'docs/a/b/draft.md', 'tmp/t.md', 'z/tmp/t.md', 'a/b/c.md', 'xyz.md', 'xz.md', 'ac.md', 'cc.md', 'deep/nested/f.md', 'q/deep/nested/f.md', '#hash.md', 'logs/a.txt', 'logs/keep.txt', 'logs/sub/a.txt'];
  const gitOk = (() => {
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!gitOk)('agrees with `git check-ignore` on a sample', async () => {
    const repo = await fsp.mkdtemp(path.join(TMP, 'repo-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP } });
      fs.writeFileSync(path.join(repo, '.gitignore'), PATTERNS.join('\n') + '\n');
      // Without a global excludes file (the developer's own must not influence the comparison).
      // Exit code 1 = nothing ignored: read stdout either way.
      const r = spawnSync('git', ['-c', 'core.excludesFile=/dev/null', 'check-ignore', '--no-index', '--stdin'], { cwd: repo, input: PATHS.join('\n'), encoding: 'utf8', env: { ...process.env, GIT_CEILING_DIRECTORIES: TMP } });
      const ignoredByGit = new Set(String(r.stdout ?? '').split('\n').filter(Boolean));
      expect(ignoredByGit.size).toBeGreaterThan(5);
      const stack = new IgnoreStack(false);
      stack.add('', PATTERNS.join('\n'));
      for (const p of PATHS) expect(stack.ignored(p), p).toBe(ignoredByGit.has(p));
    } finally {
      await fsp.rm(repo, { recursive: true, force: true });
    }
  });
});

describe('parallel reader + persistent cache', () => {
  it('threads return exactly what the in-thread reader returns', async () => {
    const a = new Workspace(dir, { watchMode: 'poll', readThreads: 0 });
    const b = new Workspace(dir, { watchMode: 'poll', readThreads: 3 });
    expect((await all(b)).map(strip)).toEqual((await all(a)).map(strip));
    a.dispose();
    b.dispose();
  });

  it('a warm start stats unchanged files and reads only what changed', async () => {
    const cold = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    const first = await all(cold);
    // binary.json is now a name-only entry (read once to find it unindexable), so reads == feed size.
    expect(cold.lastPass).toMatchObject({ read: first.length, cached: 0 });
    await cold.lastPass!.written;
    cold.dispose();
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.bin'))).toHaveLength(1);

    // Restart with nothing changed: nothing opened, same data, cache left alone.
    const warm = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    expect((await all(warm)).map(strip)).toEqual(first.map(strip));
    expect(warm.lastPass).toMatchObject({ read: 0 });
    warm.dispose();

    // One edit, one new file, one deletion: two reads; the deleted file is gone from the result.
    write('notes/n3.md', '# Note 3 changed — longer now\n');
    write('notes/new.md', '# brand new\n');
    fs.rmSync(path.join(dir, 'notes/n7.md'));
    const again = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    const third = await all(again);
    expect(again.lastPass).toMatchObject({ read: 2 });
    await again.lastPass!.written;
    again.dispose();
    const fresh = new Workspace(dir, { watchMode: 'poll', readThreads: 0 });
    expect(third.map(strip)).toEqual((await all(fresh)).map(strip));
    fresh.dispose();
    expect(third.find((f) => f.path === 'notes/n3.md')?.content).toContain('changed');
    expect(third.some((f) => f.path === 'notes/n7.md')).toBe(false);

    // The cache written after the change is used by the next start.
    const fourth = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    await all(fourth);
    expect(fourth.lastPass).toMatchObject({ read: 0 });
    fourth.dispose();
  });

  it('a corrupt or truncated cache is ignored (full read, correct data)', async () => {
    const ws = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    const want = (await all(ws)).map(strip);
    await ws.lastPass!.written;
    ws.dispose();
    const file = path.join(cacheDir, fs.readdirSync(cacheDir).find((f) => f.endsWith('.bin'))!);
    const buf = fs.readFileSync(file);
    for (const bad of [buf.subarray(0, buf.length >> 1), Buffer.concat([buf.subarray(0, 40), Buffer.from('garbage'), buf.subarray(47)]), Buffer.alloc(0)]) {
      fs.writeFileSync(file, bad);
      const w = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
      expect((await all(w)).map(strip)).toEqual(want);
      expect(w.lastPass!.read).toBeGreaterThan(100);
      await w.lastPass!.written;
      w.dispose();
    }
  });

  it('the cache lives in the cache folder, never in the workspace', async () => {
    const ws = new Workspace(dir, { watchMode: 'poll', cacheDir, readThreads: 2 });
    const before = (await fsp.readdir(dir)).sort();
    await all(ws);
    await ws.lastPass!.written;
    ws.dispose();
    expect((await fsp.readdir(dir)).sort()).toEqual(before);
  });
});

describe('name-only files (binary / unknown name) reach the search engine', () => {
  // A real PDF / PNG cannot be content-indexed, but must still be findable by name / path / ext.
  // A git-ignored PDF must never appear at all. Its content is never read.
  let box: string;
  const put = (rel: string, data: string | Buffer) => {
    const abs = path.join(box, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  };
  beforeEach(async () => {
    await fsp.mkdir(TMP, { recursive: true });
    box = await fsp.mkdtemp(path.join(TMP, 'nameonly-'));
    put('report.pdf', Buffer.from('%PDF-1.4\n\u0000\u0001 binary bytes \u0000\n'));
    put('notes/photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    put('notes/a.md', '# Alpha\nrelease notes\n');
    put('.gitignore', 'secret.pdf\n');
    put('secret.pdf', Buffer.from('%PDF secret\u0000\n'));
  });
  afterEach(async () => {
    await fsp.rm(box, { recursive: true, force: true });
  });

  it('feed: name-only entries present, ignored absent, content never read', async () => {
    const ws = new Workspace(box, { watchMode: 'poll' });
    const feed = await all(ws);
    const paths = feed.map((f) => f.path);
    expect(paths).toContain('report.pdf');
    expect(paths).toContain('notes/photo.png');
    expect(paths).toContain('notes/a.md');
    expect(paths).not.toContain('secret.pdf'); // git-ignored: never in the index, not even by name
    for (const p of ['report.pdf', 'notes/photo.png']) {
      const f = feed.find((x) => x.path === p)!;
      expect(f.content).toBe('');
      expect(f.binary).toBe(true);
    }
    ws.dispose();
  });

  it('engine finds them by ext / file / path / name term, never by content', async () => {
    const ws = new Workspace(box, { watchMode: 'poll' });
    const e = new SearchEngine();
    e.reset((await all(ws)).map((f) => ({ path: f.path, content: f.content, mtime: f.mtime })));
    const q = (s: string) => e.search(s).results.map((x) => x.path).sort();
    expect(q('ext:pdf')).toEqual(['report.pdf']);
    expect(q('file:report')).toEqual(['report.pdf']);
    expect(q('path:notes')).toEqual(['notes/a.md', 'notes/photo.png']);
    expect(q('report')).toEqual(['report.pdf']); // plain name term → path match
    expect(q('photo')).toEqual(['notes/photo.png']);
    expect(q('binary')).toEqual([]); // the PDF's bytes were never indexed
    expect(q('release')).toEqual(['notes/a.md']);
    expect(q('report -ext:pdf')).toEqual([]); // negated filter drops the name-only hit
    ws.dispose();
  });
});
