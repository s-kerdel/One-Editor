// readAllTextPage: same files + order as readAllText, bounded pages, a cursor that survives changes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../../src/backend/workspace';
import { BackendService } from '../../../src/backend/service';
import type { FileData, TextPage } from '../../../src/shared/api';
import { tmpRoot } from './helpers';

let dir: string;
let ws: Workspace;

const body = (i: number, size: number) => `# Note ${i}\n${'lorem ipsum '.repeat(Math.ceil(size / 12)).slice(0, size)}\n`;

beforeEach(async () => {
  dir = await tmpRoot('tp');
  for (let i = 0; i < 300; i++) {
    const d = path.join(dir, `area-${i % 7}`, `t${i % 3}`);
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(d, `n${i}.md`), body(i, 1000 + (i % 17) * 400));
  }
  await fsp.writeFile(path.join(dir, 'crlf.txt'), 'a\r\nb\r\n');
  await fsp.writeFile(path.join(dir, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# bom\n')]));
  await fsp.writeFile(path.join(dir, 'ansi.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café" in cp1252
  await fsp.writeFile(path.join(dir, 'nul.txt'), Buffer.from('ab\u0000cd'));
  await fsp.writeFile(path.join(dir, 'huge.md'), 'x'.repeat(2 * 1024 * 1024 + 1));
  await fsp.writeFile(path.join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  ws = new Workspace(dir);
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

async function allPages(w: Workspace, maxBytes?: number): Promise<TextPage[]> {
  const pages: TextPage[] = [];
  let cursor: string | null = null;
  do {
    const p: TextPage = await w.readAllTextPage({ cursor, maxBytes });
    pages.push(p);
    cursor = p.nextCursor;
  } while (cursor);
  return pages;
}

const strip = (f: FileData) => ({ ...f });

describe('readAllTextPage', () => {
  it('pages concatenate to exactly readAllText (same files, same order, same metadata)', async () => {
    const all = await ws.readAllText();
    const pages = await allPages(ws, 64 * 1024);
    expect(pages.length).toBeGreaterThan(5);
    const flat = pages.flatMap((p) => p.files);
    expect(flat.map(strip)).toEqual(all.map(strip));
    expect(flat.map((f) => f.path)).toEqual([...flat.map((f) => f.path)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // Skipped: binary / NUL content, > 2 MB, non-text extensions.
    const paths = new Set(flat.map((f) => f.path));
    for (const p of ['nul.txt', 'huge.md', 'image.png']) expect(paths.has(p), p).toBe(false);
    expect(flat.find((f) => f.path === 'crlf.txt')).toMatchObject({ content: 'a\nb\n', eol: 'crlf' });
    expect(flat.find((f) => f.path === 'bom.md')).toMatchObject({ content: '# bom\n', bom: true });
    expect(flat.find((f) => f.path === 'ansi.txt')).toMatchObject({ content: 'café', encoding: 'windows-1252' });
    expect(flat.length).toBe(303);
  });

  it('keeps pages near maxBytes (clamped) and never returns an empty page before the end', async () => {
    for (const p of (await allPages(ws, 64 * 1024)).slice(0, -1)) {
      expect(p.files.length).toBeGreaterThan(0);
      const size = p.files.reduce((a, f) => a + f.content.length, 0);
      // Stops once the budget is reached: at most one file over it (or earlier, on the time budget).
      expect(size - p.files[p.files.length - 1].content.length).toBeLessThan(64 * 1024);
    }
    // Absurd sizes are clamped (64 KB … 8 MB).
    const tiny = await ws.readAllTextPage({ maxBytes: 1 });
    expect(tiny.files.length).toBeGreaterThan(1);
    const nan = await ws.readAllTextPage({ maxBytes: Number.NaN });
    expect(nan.files.length).toBeGreaterThan(0);
  });

  it('cursor neither repeats nor skips existing files when the tree changes between pages', async () => {
    const first = await ws.readAllTextPage({ maxBytes: 64 * 1024 });
    // Files appear before and after the cursor, one existing file disappears.
    await fsp.writeFile(path.join(dir, '0-first.md'), 'early');
    await fsp.writeFile(path.join(dir, 'zz-last.md'), 'late');
    await ws.listTree();
    const last = first.files[first.files.length - 1].path;
    const rest: FileData[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const p = await ws.readAllTextPage({ cursor, maxBytes: 64 * 1024 });
      rest.push(...p.files);
      cursor = p.nextCursor;
    }
    const seen = [...first.files, ...rest].map((f) => f.path);
    expect(new Set(seen).size).toBe(seen.length);
    expect(rest.every((f) => f.path > last)).toBe(true);
    expect(seen).toContain('zz-last.md');
    expect(seen).not.toContain('0-first.md'); // sorts before the cursor: arrives as a watcher event instead
    expect(seen.length).toBe(304);
  });

  it('a cursor from an unknown / deleted path resumes after it', async () => {
    const all = (await ws.readAllText()).map((f) => f.path);
    const got: string[] = [];
    let cursor: string | null = 'area-3/t1/n0.md~gone';
    while (cursor) {
      const p: TextPage = await ws.readAllTextPage({ cursor, maxBytes: 8 << 20 });
      got.push(...p.files.map((f) => f.path));
      cursor = p.nextCursor;
    }
    expect(got).toEqual(all.filter((x) => x > 'area-3/t1/n0.md~gone'));
    expect((await ws.readAllTextPage({ cursor: '￿' })).files).toEqual([]);
  });

  it('the async (slow file system) path returns the same data', async () => {
    const fast = await ws.readAllText();
    const slow = new Workspace(dir);
    (slow as any).slowFs = true;
    expect((await slow.readAllText()).map(strip)).toEqual(fast.map(strip));
    slow.dispose();
  });

  it('remembers mtimes (external edits are detected after indexing)', async () => {
    await ws.readAllText();
    const entry = (ws as any).index.get('area-0/t0/n0.md');
    expect(entry.mtime).toBe((await fsp.stat(path.join(dir, 'area-0/t0/n0.md'))).mtimeMs);
  });

  it('skips FIFOs without blocking', async () => {
    if (process.platform === 'win32') return;
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('mkfifo', [path.join(dir, 'pipe.md')]);
    } catch {
      return;
    }
    const t = Date.now();
    const all = await ws.readAllText();
    expect(Date.now() - t).toBeLessThan(5000);
    expect(all.some((f) => f.path === 'pipe.md')).toBe(false);
  });

  it('is exposed by the service (and tolerates junk options)', async () => {
    const svc = new BackendService(path.join(dir, '..', `${path.basename(dir)}-cfg`));
    await svc.openWorkspace(dir);
    const p = await svc.readAllTextPage();
    expect(p.files.length).toBeGreaterThan(0);
    const junk = await svc.readAllTextPage('nope' as any);
    expect(junk.files[0].path).toBe(p.files[0].path);
    const bad = await svc.readAllTextPage({ cursor: 42 as any, maxBytes: 'x' as any });
    expect(bad.files[0].path).toBe(p.files[0].path);
    svc.dispose();
  });
});

describe('fast reads', () => {
  // Timing budget: retried so a burst of CPU contention from the parallel suite can't fail it; a real regression fails every attempt.
  it('reading 2000 files is quick (sync bursts instead of libuv round-trips)', { retry: 2 }, async () => {
    const big = await tmpRoot('tp-many');
    try {
      for (let i = 0; i < 2000; i++) {
        const d = path.join(big, `d${i % 20}`);
        if (!fs.existsSync(d)) fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, `f${i}.md`), body(i, 500));
      }
      const w = new Workspace(big);
      await w.listTree();
      const t = performance.now();
      const all = await w.readAllText();
      const ms = performance.now() - t;
      expect(all.length).toBe(2000);
      console.log(`[platform] readAllText 2000 files: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(3000); // generous: ~30 ms on a dev box, ~500 ms with the old async reads under WSL
      w.dispose();
    } finally {
      await fsp.rm(big, { recursive: true, force: true });
    }
  });
});
