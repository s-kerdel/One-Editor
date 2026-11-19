// The indexer as the app runs it: in a worker thread (bundled source, `eval: true`), so indexing never
// runs on the Electron main / server event loop. Same results as in-thread, a busy loop stays free.
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { buildSync } from 'esbuild';
import type { FileData } from '../../../src/shared/api';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-indexer-worker');
let dir: string;
let Workspace: typeof import('../../../src/backend/workspace').Workspace;

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  const out = path.join(TMP, 'indexer-worker.cjs');
  buildSync({ entryPoints: [path.resolve(__dirname, '../../../src/backend/indexer-worker.ts')], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: out, logLevel: 'error' });
  process.env.SEC_EDIT_INDEXER_SRC_FILE = out;
  ({ Workspace } = await import('../../../src/backend/workspace'));
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  for (let i = 0; i < 300; i++) {
    fs.mkdirSync(path.join(dir, `d${i % 7}`), { recursive: true });
    fs.writeFileSync(path.join(dir, `d${i % 7}`, `n${i}.md`), `# N${i}\n\nworker text ${i}\r\n`);
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), 'gen/\n');
  fs.mkdirSync(path.join(dir, 'gen'));
  fs.writeFileSync(path.join(dir, 'gen', 'x.md'), 'ignored');
});
afterAll(async () => {
  delete process.env.SEC_EDIT_INDEXER_SRC_FILE;
  await fsp.rm(dir, { recursive: true, force: true });
});

async function all(ws: InstanceType<typeof Workspace>) {
  await ws.listTree();
  const out: FileData[] = [];
  let cursor: string | null = null;
  do {
    const p = await ws.readAllTextPage({ cursor, maxBytes: 64 * 1024 });
    out.push(...p.files);
    cursor = p.nextCursor;
  } while (cursor);
  return out;
}

describe('indexer worker thread', () => {
  it('returns what the in-thread indexer returns; raw pages are the same JSON', async () => {
    const w = new Workspace(dir, { watchMode: 'poll', readThreads: 2 });
    const viaWorker = await all(w);
    expect((w as any).host.inWorker).toBe(true);
    const raw = JSON.parse(new TextDecoder().decode(await w.readAllTextPageRaw({ maxBytes: 8 << 20 })));
    expect(raw.files.map((f: FileData) => f.path)).toEqual(viaWorker.map((f) => f.path));
    const upd = await w.readIndexedFiles(['d0/n0.md', 'gen/x.md', 'nope.md']);
    expect(upd.files.map((f) => f.path)).toEqual(['d0/n0.md']);
    expect(upd.skipped).toEqual(['gen/x.md']);
    expect(upd.gone).toEqual(['nope.md']);
    w.dispose();
    const saved = process.env.SEC_EDIT_INDEXER_SRC_FILE;
    // In-thread reference (no worker source).
    const { LocalIndexerHost } = await import('../../../src/backend/indexer-host');
    expect(LocalIndexerHost).toBeTruthy();
    const l = new Workspace(dir, { watchMode: 'poll', readThreads: 0 });
    (l as any).host = new LocalIndexerHost({ root: l.root, cacheFile: null, readThreads: 0, index: (l as any).indexOpts, foldCase: false });
    const inThread = await all(l);
    l.dispose();
    process.env.SEC_EDIT_INDEXER_SRC_FILE = saved;
    const strip = (f: FileData) => ({ path: f.path, content: f.content, eol: f.eol });
    expect(viaWorker.map(strip)).toEqual(inThread.map(strip));
    expect(viaWorker.some((f) => f.path === 'gen/x.md')).toBe(false);
  });

  it('a full pass with slow opens leaves this event loop free', async () => {
    process.env.SEC_EDIT_TEST_FS_LATENCY_MS = '2';
    try {
      const w = new Workspace(dir, { watchMode: 'poll', readThreads: 4 });
      await w.listTree();
      let maxGap = 0;
      let last = performance.now();
      let done = false;
      const ticker = (async () => {
        while (!done) {
          await new Promise((r) => setTimeout(r, 5));
          const t = performance.now();
          maxGap = Math.max(maxGap, t - last);
          last = t;
        }
      })();
      const files = await all(w);
      done = true;
      await ticker;
      w.dispose();
      expect(files.length).toBe(300);
      // 300 opens × 2 ms happened, but never on this thread.
      expect(maxGap, 'longest stall of the host event loop').toBeLessThan(40);
    } finally {
      delete process.env.SEC_EDIT_TEST_FS_LATENCY_MS;
    }
  });
});
