// Data-safety review: races between saves, long names, special files, odd-but-legal names.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Workspace } from '../../../src/backend/workspace';

// Review rule: temp files live in the project's .tmp/review, never /tmp.
const TMP = fileURLToPath(new URL('../../../.tmp/review/unit', import.meta.url));
let dir: string;
let ws: Workspace;
const p = (...s: string[]) => path.join(dir, ...s);
const errCode = (pr: Promise<unknown>) => pr.then(() => 'ok', (e) => e?.code ?? String(e));

beforeEach(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  ws = new Workspace(dir);
});
afterEach(async () => {
  ws.dispose();
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('concurrent saves of one file', () => {
  it('never lets an older save land after a newer one (autosave racing Ctrl+S)', async () => {
    await fsp.writeFile(p('a.md'), 'v0');
    const { mtime } = await ws.readFile('a.md');
    const opts = { expectedMtime: mtime, eol: 'lf' as const, bom: false, encoding: 'utf8' as const };
    // A big autosave still syncing to disk, then a small explicit save issued right after it.
    const big = 'old '.repeat(6_000_000);
    const first = ws.writeFile('a.md', big, opts);
    const second = ws.writeFile('a.md', 'newest', opts);
    const [r1, r2] = await Promise.allSettled([first, second]);
    expect(r1.status).toBe('fulfilled');
    const disk = await fsp.readFile(p('a.md'), 'utf8');
    if (r2.status === 'fulfilled') expect(disk).toBe('newest');
    else {
      // Serialised: the second save sees the first one's mtime → a conflict the UI can resolve, not a silent overwrite.
      expect((r2.reason as any).code).toBe('EXTERNAL_CHANGE');
      expect(disk.length).toBe(big.length);
    }
  });

  it('serialises a rename behind a pending write of the same file', async () => {
    await fsp.writeFile(p('a.md'), 'v0');
    const w = ws.writeFile('a.md', 'x'.repeat(8_000_000));
    const r = ws.rename('a.md', 'b.md');
    await Promise.all([w, r]);
    expect(fs.existsSync(p('a.md'))).toBe(false); // the write must not recreate the old name after the move
    expect((await fsp.readFile(p('b.md'), 'utf8')).length).toBe(8_000_000);
  });
});

describe('names', () => {
  it('saves files whose name is close to the 255-byte limit (temp name must not overflow)', async () => {
    const name = 'n'.repeat(245) + '.md';
    await ws.createFile(name, 'a');
    await ws.writeFile(name, 'b');
    expect(await fsp.readFile(p(name), 'utf8')).toBe('b');
    expect(fs.readdirSync(dir)).toEqual([name]);
  });

  it('case-only rename works for long names', async () => {
    const name = 'n'.repeat(240) + '.md';
    await fsp.writeFile(p(name), 'x');
    await ws.rename(name, name.toUpperCase());
    expect(fs.readdirSync(dir)).toEqual([name.toUpperCase()]);
  });

  it('a folder named "..notes" at the root is inside the workspace', async () => {
    await fsp.mkdir(p('..notes'));
    await fsp.writeFile(p('..notes', 'a.md'), 'hi');
    expect((await ws.readFile('..notes/a.md')).content).toBe('hi');
    await ws.writeFile('..notes/a.md', 'yo');
    expect(ws.rel(p('..notes', 'a.md'))).toBe('..notes/a.md');
    expect(ws.rel(path.dirname(dir))).toBeNull();
  });

  it('unicode, emoji, spaces, # % in names round-trip', async () => {
    for (const n of ['Café #1 50%.md', '📝 ideas.md', 'with  two spaces.md']) {
      await ws.createFile(`sub/${n}`, '');
      await ws.writeFile(`sub/${n}`, n);
      expect(await fsp.readFile(p('sub', n), 'utf8')).toBe(n);
    }
  });
});

describe('special files', () => {
  const fifo = () => p('pipe.md');
  afterEach(() => {
    // Unblock a reader stuck on the FIFO (if the guard failed) so the worker can exit.
    try {
      fs.closeSync(fs.openSync(fifo(), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
    } catch {}
  });

  it.skipIf(process.platform === 'win32')('refuses to open a FIFO instead of hanging forever', async () => {
    execFileSync('mkfifo', [fifo()]);
    const r = await Promise.race([errCode(ws.readFile('pipe.md')), new Promise((res) => setTimeout(() => res('hung'), 1500))]);
    expect(r).toBe('EINVAL');
    // Indexing must skip it too.
    await fsp.writeFile(p('ok.md'), 'fine');
    const all = await Promise.race([ws.readAllText(), new Promise<null>((res) => setTimeout(() => res(null), 3000))]);
    expect(all?.map((f) => f.path)).toEqual(['ok.md']);
  });
});

describe('watcher robustness', () => {
  it('a hint that fails to reconcile does not reject the flush or drop the other hints', async () => {
    await ws.listTree();
    const events: string[] = [];
    ws.onEvents((e) => events.push(...e.map((x) => `${x.type}:${x.path}`)));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const orig = ws.abs.bind(ws);
      ws.abs = (rel: string) => {
        if (rel === 'bad.md') throw Object.assign(new Error('boom'), { code: 'EINVAL' });
        return orig(rel);
      };
      await fsp.writeFile(p('good.md'), 'x');
      (ws as any).queue('bad.md');
      (ws as any).queue('good.md');
      await ws.settle();
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      expect(events).toContain('add:good.md');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
