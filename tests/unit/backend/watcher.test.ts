// Watcher semantics must be identical for every backend: native recursive (Windows/macOS), per-directory
// inotify (Linux) and polling (network drives). Node on Linux supports all three, so we test all three.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FsEvent } from '../../../src/shared/api';
import { Workspace } from '../../../src/backend/workspace';
import type { WatchMode } from '../../../src/backend/watcher';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await sleep(25);
  }
}

for (const mode of ['perdir', 'recursive', 'poll'] as WatchMode[]) {
  describe(`watcher (${mode})`, () => {
    let dir: string;
    let ws: Workspace;
    let events: FsEvent[];
    const has = (type: FsEvent['type'], p: string) => events.some((e) => e.type === type && e.path === p);
    const quiet = async () => {
      // Long enough for debounce (or a poll cycle) to flush anything pending.
      await sleep(mode === 'poll' ? 450 : 300);
      await ws.settle();
    };

    beforeEach(async () => {
      dir = await fsp.mkdtemp(path.join(os.tmpdir(), `sec-watch-${mode}-`));
      await fsp.mkdir(path.join(dir, 'notes'));
      await fsp.writeFile(path.join(dir, 'notes', 'a.md'), 'A');
      await fsp.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
      ws = new Workspace(dir, { watchMode: mode, debounceMs: 30, pollMs: 150, exclude: ['node_modules'] });
      await ws.listTree();
      events = [];
      ws.onEvents((e) => events.push(...e));
      await sleep(100);
    });
    afterEach(async () => {
      ws.dispose();
      await fsp.rm(dir, { recursive: true, force: true });
    });

    it('reports add, change and unlink for external edits', async () => {
      await fsp.writeFile(path.join(dir, 'notes', 'b.md'), 'B');
      await waitFor(() => has('add', 'notes/b.md'));
      await sleep(30);
      await fsp.writeFile(path.join(dir, 'notes', 'b.md'), 'B2 longer');
      await waitFor(() => has('change', 'notes/b.md'));
      await fsp.rm(path.join(dir, 'notes', 'b.md'));
      await waitFor(() => has('unlink', 'notes/b.md'));
    });

    it('reports a folder moved in, including its contents', async () => {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-outside-'));
      await fsp.mkdir(path.join(outside, 'pack', 'sub'), { recursive: true });
      await fsp.writeFile(path.join(outside, 'pack', 'one.md'), '1');
      await fsp.writeFile(path.join(outside, 'pack', 'sub', 'two.md'), '2');
      await fsp.rename(path.join(outside, 'pack'), path.join(dir, 'pack'));
      await waitFor(() => has('addDir', 'pack') && has('add', 'pack/one.md') && has('add', 'pack/sub/two.md'));
      expect(has('addDir', 'pack/sub')).toBe(true);
      await fsp.rm(outside, { recursive: true, force: true });
    });

    it('reports one unlinkDir for a deleted folder (not every child)', async () => {
      await fsp.rm(path.join(dir, 'notes'), { recursive: true });
      await waitFor(() => has('unlinkDir', 'notes'));
      await quiet();
      expect(events.filter((e) => e.path.startsWith('notes/') && e.type === 'unlinkDir')).toEqual([]);
    });

    it('reports external renames as unlink + add', async () => {
      await fsp.rename(path.join(dir, 'notes', 'a.md'), path.join(dir, 'notes', 'renamed.md'));
      await waitFor(() => has('unlink', 'notes/a.md') && has('add', 'notes/renamed.md'));
    });

    it('detects a newly created file in a newly created folder', async () => {
      await fsp.mkdir(path.join(dir, 'fresh'));
      await sleep(mode === 'poll' ? 0 : 60);
      await fsp.writeFile(path.join(dir, 'fresh', 'x.md'), 'x');
      await waitFor(() => has('add', 'fresh/x.md'));
      // ...and keeps watching inside it
      await sleep(40);
      await fsp.writeFile(path.join(dir, 'fresh', 'y.md'), 'y');
      await waitFor(() => has('add', 'fresh/y.md'));
    });

    it('never echoes our own operations', async () => {
      await ws.writeFile('notes/a.md', 'mine');
      await ws.createFile('notes/new.md', 'n');
      await ws.createDir('made');
      await ws.writeFile('made/deep.md', 'd');
      await ws.rename('notes/new.md', 'notes/new2.md');
      await ws.rename('made', 'made2');
      await ws.remove('notes/new2.md');
      await quiet();
      await quiet();
      expect(events).toEqual([]);
    });

    it('ignores excluded folders and our temp files', async () => {
      await fsp.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
      await fsp.writeFile(path.join(dir, 'notes', '.~a.md.1234.sec-edit.tmp'), 'tmp');
      await quiet();
      await quiet();
      expect(events).toEqual([]);
    });
  });
}
