// Launch walks the folder once: the watcher's kick-off walk at open is shared with (or, if it already
// finished, handed to) the renderer's first listTree. Walking 10k+ entries twice cost launch ~60 ms.
// A tree handed out this way must be exactly what a fresh walk returns; any change since → fresh walk.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace } from '../../../src/backend/workspace';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-launch-walk');
let dir = '';
let ws: Workspace | null = null;

async function makeWs() {
  await fsp.mkdir(TMP, { recursive: true });
  dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
  for (let d = 0; d < 6; d++) {
    fs.mkdirSync(path.join(dir, `d${d}`, 'sub'), { recursive: true });
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(dir, `d${d}`, i % 2 ? 'sub' : '', `n${i}.md`), `# ${d}/${i}\n`);
  }
  ws = new Workspace(dir, { watchMode: 'poll', pollMs: 50, debounceMs: 10 });
  return ws;
}
const until = async (f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); ) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

afterEach(async () => {
  ws?.dispose();
  ws = null;
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

describe('launch: one tree walk', () => {
  it('the renderer joins the watcher kick-off walk that is still running', async () => {
    const w = await makeWs();
    w.onEvents(() => {}); // what openWorkspace does: the watcher starts and walks once
    const tree = await w.listTree(); // the renderer's boot listTree, while that walk runs
    expect(tree.children!.length).toBe(6);
    expect(w.fullWalks).toBe(1);
  });

  it('a walk that already finished answers the next listTree once, identical to a fresh walk', async () => {
    const w = await makeWs();
    w.onEvents(() => {});
    await until(() => w.fullWalks === 1 && (w as any).indexed);
    const reused = await w.listTree();
    expect(w.fullWalks, 'served from the launch walk').toBe(1);
    const fresh = await w.listTree();
    expect(w.fullWalks, 'only once: later calls (refresh) walk again').toBe(2);
    expect(reused).toEqual(fresh);
  });

  it('without a watcher, the next listTree walks again (nothing would report changes)', async () => {
    const w = await makeWs();
    await w.listTree(); // e.g. the indexer's first walk; no listener → no watcher
    fs.writeFileSync(path.join(dir, 'zz-late.md'), 'late');
    const tree = await w.listTree();
    expect(w.fullWalks).toBe(2);
    expect(tree.children!.map((c) => c.name)).toContain('zz-late.md');
  });

  it('per-folder watching: an entry added after its folder was read, before it was watched, still arrives', async () => {
    process.env.SEC_EDIT_TEST_FS_LATENCY_MS = '40'; // slow walk: ~40 ms per readdir, 3 at a time
    try {
      await fsp.mkdir(TMP, { recursive: true });
      dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
      for (let d = 0; d < 9; d++) fs.mkdirSync(path.join(dir, `d${d}`, 'a', 'b'), { recursive: true });
      ws = new Workspace(dir, { watchMode: 'perdir', debounceMs: 10 });
      const w = ws;
      const seen: string[] = [];
      w.onEvents((e) => seen.push(...e.map((x) => `${x.type}:${x.path}`)));
      // d0 is read in the first round (~80 ms); the walk ends ~300 ms later, then folders get watched.
      await new Promise((r) => setTimeout(r, 150));
      expect((w as any).indexed, 'walk still running').toBe(false);
      fs.writeFileSync(path.join(dir, 'd0', 'during-walk.md'), 'x');
      await until(() => seen.includes('add:d0/during-walk.md'), 5000);
      expect((w as any).index.has('d0/during-walk.md')).toBe(true);
    } finally {
      delete process.env.SEC_EDIT_TEST_FS_LATENCY_MS;
    }
  });

  it('index on demand (warmIndexer: false): no indexer after the walk until text is asked for', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
    fs.writeFileSync(path.join(dir, 'a.md'), 'alpha');
    ws = new Workspace(dir, { watchMode: 'poll', pollMs: 50, warmIndexer: false, cacheDir: path.join(dir, '..', 'cache-' + path.basename(dir)) });
    const w = ws;
    w.onEvents(() => {});
    await w.listTree();
    await new Promise((r) => setTimeout(r, 100));
    expect((w as any).host, 'no indexer thread / readers / cache read at launch').toBeNull();
    const page = await w.readAllTextPage({ maxBytes: 64 << 10 });
    expect(page.files.map((f) => f.path)).toEqual(['a.md']);
    expect((w as any).host).not.toBeNull();
  });

  it('index at launch (default): the indexer starts right after the walk', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    dir = await fsp.mkdtemp(path.join(TMP, 'ws-'));
    fs.writeFileSync(path.join(dir, 'a.md'), 'alpha');
    ws = new Workspace(dir, { watchMode: 'poll', pollMs: 50, cacheDir: path.join(dir, '..', 'cache-' + path.basename(dir)) });
    const w = ws;
    w.onEvents(() => {});
    await w.listTree();
    await until(() => !!(w as any).host);
  });

  it('a change after the launch walk means a fresh walk (never a stale tree)', async () => {
    const w = await makeWs();
    let events = 0;
    w.onEvents(() => events++);
    await until(() => w.fullWalks === 1 && (w as any).indexed);
    fs.mkdirSync(path.join(dir, 'new-folder'));
    fs.writeFileSync(path.join(dir, 'new-folder', 'x.md'), 'x');
    await until(() => events > 0);
    const before = w.fullWalks; // the poll watcher may rescan on its own
    const tree = await w.listTree();
    expect(w.fullWalks, 'walked again').toBe(before + 1);
    expect(tree.children!.map((c) => c.name)).toContain('new-folder');
  });
});
