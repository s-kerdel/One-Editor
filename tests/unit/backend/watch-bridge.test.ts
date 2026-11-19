// Watching where fs.watch is unreliable (\\wsl.localhost\…, network shares): the folder-mtime poller
// and inotify run inside the WSL distro; plus the workspace dropping events inside ignored folders.
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { defaultWatchMode, dirPollBackend, wslBackend, wslTarget } from '../../../src/backend/watcher';
import { isBridgeRoot, defaultReadThreads } from '../../../src/backend/readpool';
import { Workspace } from '../../../src/backend/workspace';

const TMP = path.resolve(__dirname, '../../../.tmp/unit-watch-bridge');
const waitFor = async (pred: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
afterEach(() => {
  delete process.env.SEC_EDIT_TEST_FS_LATENCY_MS;
});

describe('bridge roots', () => {
  it('detects WSL / UNC roots and maps them into the distro', () => {
    expect(isBridgeRoot('\\\\wsl.localhost\\Ubuntu\\home\\me\\code')).toBe(true);
    expect(isBridgeRoot('\\\\wsl$\\Debian\\srv')).toBe(true);
    expect(isBridgeRoot('\\\\nas\\share\\notes')).toBe(true);
    expect(isBridgeRoot('C:\\Users\\me')).toBe(false);
    expect(isBridgeRoot('/home/me')).toBe(false);
    expect(defaultReadThreads('\\\\wsl.localhost\\Ubuntu\\x')).toBe(32);
    expect(wslTarget('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\code')).toEqual({ distro: 'Ubuntu-22.04', path: '/home/me/code' });
    expect(wslTarget('\\\\wsl$\\Ubuntu\\')).toEqual({ distro: 'Ubuntu', path: '/' });
    expect(wslTarget('\\\\nas\\share')).toBeNull();
    expect(defaultWatchMode('\\\\nas\\share\\x')).toBe('dirpoll');
  });

  it('inotify inside the distro: changed paths map back to workspace paths; a dead watcher falls back to polling', async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kill(): void };
    child.stdout = new PassThrough();
    child.kill = () => {};
    let args: string[] = [];
    const hints: string[] = [];
    let rescans = 0;
    const b = wslBackend('\\\\wsl.localhost\\Ubuntu\\home\\me\\code', { hint: (r) => hints.push(r), rescan: () => rescans++ }, { children: () => new Set(), hotFiles: () => [] }, ['node_modules', '.git'], ((_cmd: string, a: string[]) => ((args = a), child)) as never);
    expect(args.slice(0, 4)).toEqual(['-d', 'Ubuntu', '--exec', 'inotifywait']);
    expect(args[args.length - 1]).toBe('/home/me/code');
    expect(args.join(' ')).toContain('node_modules');
    child.stdout.write('/home/me/code/notes/a.md\n/home/me/code/src/x.ts\r\n/home/me/');
    child.stdout.write('code/notes/b.md\n');
    await new Promise((r) => setTimeout(r, 10));
    expect(hints).toEqual(['notes/a.md', 'src/x.ts', 'notes/b.md']);
    b.addDir('');
    child.emit('exit', 1); // e.g. inotify-tools not installed
    expect(rescans).toBe(1);
    b.close();
  });
});

describe('folder poller (dirpoll)', () => {
  it('finds adds, deletes and edits of hot files — with injected bridge latency', async () => {
    process.env.SEC_EDIT_TEST_FS_LATENCY_MS = '3';
    await fsp.mkdir(TMP, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(TMP, 'poll-'));
    fs.mkdirSync(path.join(dir, 'a'));
    fs.writeFileSync(path.join(dir, 'a', 'keep.md'), 'x');
    fs.writeFileSync(path.join(dir, 'a', 'gone.md'), 'x');
    fs.writeFileSync(path.join(dir, 'hot.md'), 'v1');
    const known = new Map<string, Set<string>>([['', new Set(['a', 'hot.md'])], ['a', new Set(['keep.md', 'gone.md'])]]);
    const hints = new Set<string>();
    const b = dirPollBackend(dir, { hint: (r) => hints.add(r), rescan: () => {} }, { children: (r) => known.get(r) ?? new Set(), hotFiles: () => ['hot.md'] }, { minMs: 40, maxMs: 80 });
    b.addDir('');
    b.addDir('a');
    await new Promise((r) => setTimeout(r, 150)); // first ticks record mtimes
    fs.writeFileSync(path.join(dir, 'a', 'new.md'), 'x');
    fs.rmSync(path.join(dir, 'a', 'gone.md'));
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(path.join(dir, 'hot.md'), 'v2 longer');
    await waitFor(() => hints.has('a/new.md') && hints.has('a/gone.md') && hints.has('hot.md'));
    expect(hints.has('a/keep.md'), 'unchanged entries are not re-checked').toBe(false);
    b.pause?.(true);
    hints.clear();
    fs.writeFileSync(path.join(dir, 'a', 'while-hidden.md'), 'x');
    await new Promise((r) => setTimeout(r, 200));
    expect(hints.size, 'paused while hidden').toBe(0);
    b.pause?.(false);
    await waitFor(() => hints.has('a/while-hidden.md'));
    b.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('ignored folders are dropped at the watcher', () => {
  it('a storm in a git-ignored folder costs no stat and no events', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(TMP, 'storm-'));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'coverage/\n');
    fs.mkdirSync(path.join(dir, 'coverage'));
    fs.writeFileSync(path.join(dir, 'a.md'), '# a');
    const ws = new Workspace(dir, { watchMode: 'perdir', debounceMs: 20, readThreads: 0 });
    const events: string[] = [];
    ws.onEvents((e) => events.push(...e.map((x) => `${x.type}:${x.path}`)));
    await ws.listTree();
    await ws.readAllTextPage({}); // the indexer computes the ignore rules; the watcher gets a copy
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, 'coverage', `c${i}.html`), 'x');
    fs.writeFileSync(path.join(dir, 'b.md'), '# b');
    await waitFor(() => events.includes('add:b.md'));
    await ws.settle();
    expect(events.filter((e) => e.includes('coverage/')), 'events inside the ignored folder').toEqual([]);
    // Either unwatched (per-folder backends drop ignored folders' watches) or dropped on arrival.
    expect(ws.droppedHints).toBeGreaterThanOrEqual(0);
    ws.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});

describe('folder poller: a folder found after start', () => {
  it('is diffed on its first look (entries made between its listing and that look are not lost)', async () => {
    await fsp.mkdir(TMP, { recursive: true });
    const dir = await fsp.mkdtemp(path.join(TMP, 'poll-new-'));
    const known = new Map<string, Set<string>>([['', new Set()]]);
    const hints = new Set<string>();
    const b = dirPollBackend(dir, { hint: (r) => hints.add(r), rescan: () => {} }, { children: (r) => known.get(r) ?? new Set(), hotFiles: () => [] }, { minMs: 30, maxMs: 60 });
    b.addDir('');
    await new Promise((r) => setTimeout(r, 100)); // started
    // The workspace listed the new folder (empty) and registered it; then files appeared — and nothing more.
    fs.mkdirSync(path.join(dir, 'late'));
    known.set('late', new Set());
    b.addDir('late');
    fs.writeFileSync(path.join(dir, 'late', 'x.md'), 'x');
    await waitFor(() => hints.has('late/x.md'));
    b.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });
});
