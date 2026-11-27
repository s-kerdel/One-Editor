// Process explorer: parsing (Linux /proc, macOS ps, the Windows query helper), child classification,
// tree order, the text export, and — on Linux — a real snapshot + kill of a child process.
import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childRows, descendantsOf, gitVerb, parsePs, parseProcStat, parseWinProcs, procText, treeOrder, type ChildInfo, type ProcRow, type ProcSnapshot } from '../../../src/shared/processes';
import { ProcessExplorer, posixPs, registerProcessSource, safeGroup } from '../../../src/backend/processes';
import { BackendService } from '../../../src/backend/service';

describe('parsing', () => {
  it('/proc/<pid>/stat: a name with spaces and parentheses, CPU ticks → ms, RSS pages → bytes', () => {
    const s = parseProcStat('4242 (my (odd) name) S 1000 4242 4242 34816 4300 4194304 120 0 0 0 250 50 0 0 20 0 1 0 123456 12345678 2048 18446744073709551615 1 1 0 0 0', 100, 4096)!;
    expect(s).toMatchObject({ pid: 4242, ppid: 1000, pgid: 4242, tpgid: 4300, cpuMs: 3000, startTicks: 123456, memBytes: 2048 * 4096 });
  });

  it('macOS ps: command lines with spaces; RSS in KiB', () => {
    const out = '  501   1   501   501   0.0  51200 /Applications/sec-edit.app/Contents/MacOS/sec-edit\n  777 501   777   780   2.5  10240 /bin/zsh -il\n  780 777   780   780  99.1   2048 sleep 600\n';
    const rows = parsePs(out);
    expect(rows.map((r) => [r.pid, r.ppid, r.comm, r.cpuPct, r.memBytes])).toEqual([
      [501, 1, 'sec-edit', 0, 51200 * 1024],
      [777, 501, 'zsh', 2.5, 10240 * 1024],
      [780, 777, 'sleep', 99.1, 2048 * 1024],
    ]);
  });

  it('Windows helper output: private bytes preferred, 100 ns CPU units → ms; junk lines ignored', () => {
    const out = 'garbage\r\n1200\t4\tsec-edit.exe\t300000000\t250000000\t50000000\t150000000\t"C:\\Program Files\\sec-edit\\sec-edit.exe"\r\n1300\t1200\tpwsh.exe\t80000000\t0\t10000\t20000\tpwsh -NoLogo\r\n';
    const [a, b] = parseWinProcs(out);
    expect(a).toMatchObject({ pid: 1200, ppid: 4, comm: 'sec-edit.exe', memBytes: 250000000, memKind: 'private', cpuMs: 20000 });
    expect(b).toMatchObject({ pid: 1300, memBytes: 80000000, memKind: 'working set', cpuMs: 3 });
  });

  it('descendants only, breadth first, cycle-safe', () => {
    const p = (pid: number, ppid: number) => ({ pid, ppid, pgid: 0, tpgid: 0, comm: 'x', args: 'x', memBytes: 0, memKind: 'RSS' }) as ChildInfo;
    expect(descendantsOf(10, [p(10, 1), p(11, 10), p(12, 11), p(13, 1), p(14, 12), p(14, 14)]).map((c) => c.pid)).toEqual([11, 12, 14]);
  });

  it('git subcommand from a command line (global flags skipped)', () => {
    expect(gitVerb('git -c core.quotepath=off -C /repo status --porcelain=v2')).toBe('status');
    expect(gitVerb('C:\\Program Files\\Git\\cmd\\git.exe fetch origin')).toBe('fetch');
    expect(gitVerb('wsl.exe -d Ubuntu --cd /x --exec git log -n 1')).toBe('log');
  });
});

describe('child classification and tree', () => {
  const c = (pid: number, ppid: number, comm: string, args = comm, extra: Partial<ChildInfo> = {}): ChildInfo => ({ pid, ppid, pgid: pid, tpgid: 0, comm, args, memBytes: 1 << 20, memKind: 'RSS', ...extra });
  it('terminals with their foreground job, git, watchers, the WSL helper; Chromium helpers skipped', () => {
    const kids = [
      c(100, 1, 'bash', 'bash -l', { pgid: 100, tpgid: 120 }),
      c(120, 100, 'node', 'node server.js', { pgid: 120 }),
      c(121, 120, 'sleep', 'sleep 600', { pgid: 120 }),
      c(130, 100, 'cat', 'cat', { pgid: 130 }), // a background job of that shell
      c(200, 1, 'git', 'git -c x=y status --porcelain'),
      c(300, 1, 'wsl.exe', 'wsl.exe -d Ubuntu --exec sh -c sec-edit-git-helper'),
      c(310, 1, 'inotifywait', 'inotifywait -mrq /x'),
      c(400, 1, 'electron', 'electron --type=gpu-process', { ownExe: true }),
    ];
    const rows = childRows(kids, 1, { shellPids: new Set([100]), selfPids: new Set() }, () => 1);
    const by = Object.fromEntries(rows.map((r) => [r.pid, r]));
    expect(by[100]).toMatchObject({ name: 'Terminal: bash', parent: 'main', state: 'running a command' });
    expect(by[120]).toMatchObject({ parent: 'pid:100', state: 'foreground', actions: ['stopForeground'] });
    expect(by[121]).toMatchObject({ parent: 'pid:120', state: 'foreground' });
    expect(by[130]).toMatchObject({ state: 'background', actions: ['kill'] });
    expect(by[200]).toMatchObject({ name: 'git status', actions: ['stopGit'], activity: ['git'] });
    expect(by[300]).toMatchObject({ name: 'WSL git helper', kind: 'helper' });
    expect(by[310].name).toContain('inotifywait');
    expect(by[400]).toBeUndefined();
  });

  it('tree order: parents first, app before threads before children; text export indents', () => {
    const rows: ProcRow[] = [
      { id: 'pid:9', parent: 'main', kind: 'child', name: 'git status', pid: 9, cpu: 1.25 },
      { id: 'indexer', parent: 'main', kind: 'thread', name: 'Indexer', busy: 12 },
      { id: 'main', kind: 'app', name: 'Main process', pid: 1, mem: 120.5, memKind: 'RSS' },
      { id: 'readers', parent: 'indexer', kind: 'thread', name: 'Reader threads' },
      { id: 'renderer', parent: 'main', kind: 'app', name: 'UI (renderer)' },
    ];
    const t = treeOrder(rows);
    expect(t.map((x) => [x.row.id, x.depth])).toEqual([
      ['main', 0],
      ['renderer', 1],
      ['indexer', 1],
      ['readers', 2],
      ['pid:9', 1],
    ]);
    const text = procText(t, 'sec-edit 0.0.0');
    expect(text.split('\n')[0]).toBe('sec-edit 0.0.0');
    expect(text).toContain('    Reader threads');
    expect(text).toMatch(/Main process\s+1\s+-\s+-\s+120\.5 MB RSS/);
  });
});

describe.skipIf(process.platform !== 'linux')('Linux snapshot (real /proc)', () => {
  const kids: ChildProcess[] = [];
  afterEach(() => kids.forEach((k) => k.kill('SIGKILL')));

  it('lists a child with CPU on the second snapshot; kills only what it offered; nothing after close', async () => {
    const shell = spawn('bash', ['-c', 'sleep 600; true'], { stdio: 'ignore' });
    kids.push(shell);
    const off = registerProcessSource({ id: 'test-terminal', rows: () => [], shellPids: () => [shell.pid!] });
    const ex = new ProcessExplorer({ root: () => null });
    await new Promise((r) => setTimeout(r, 150)); // bash has started sleep
    await ex.snapshot();
    await new Promise((r) => setTimeout(r, 100));
    const snap = await ex.snapshot();
    const term = snap.rows.find((r) => r.pid === shell.pid)!;
    expect(term.name).toBe('Terminal: bash');
    const sleep = snap.rows.find((r) => r.parent === `pid:${shell.pid}` && r.name === 'sleep')!;
    expect(sleep, JSON.stringify(snap.rows.map((r) => r.name))).toBeTruthy();
    expect(sleep.cpu).not.toBeNull();
    expect(snap.rows.find((r) => r.id === 'main')).toMatchObject({ kind: 'app', pid: process.pid });
    expect(snap.rows.find((r) => r.id === 'explorer')!.cpu).not.toBeNull();
    expect(snap.selfMs).toBeGreaterThanOrEqual(0);

    expect(ex.kill(process.pid), 'never the app').toBe(false);
    expect(ex.kill(1), 'never a process it did not list').toBe(false);
    const gone = new Promise((r) => shell.once('exit', r));
    expect(ex.kill(sleep.pid!)).toBe(true);
    await gone; // bash continues after sleep is killed and exits
    ex.close();
    expect(ex.helperRunning).toBe(false);
    expect(ex.kill(sleep.pid!), 'forgotten after close').toBe(false);
    off();
  });

  // The page asks for `group`; only a terminal's foreground job may be stopped as a group. A plain child shares a
  // group with others (here: its own detached group, so nothing outside this test is ever signalled).
  it('`group` is honoured only for a terminal foreground job: a plain child is stopped alone', async () => {
    const sh = spawn('sh', ['-c', 'sleep 601 & sleep 602 & wait'], { stdio: 'ignore', detached: true });
    kids.push(sh);
    const ex = new ProcessExplorer({ root: () => null });
    await new Promise((r) => setTimeout(r, 150));
    const snap = await ex.snapshot();
    const [a, b] = ['sleep 601', 'sleep 602'].map((cmd) => snap.rows.find((r) => r.parent === `pid:${sh.pid}` && r.detail === cmd)!);
    expect(a?.actions, JSON.stringify(snap.rows.map((r) => [r.name, r.detail]))).toEqual(['kill']);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(ex.kill(a.pid!, true)).toBe(true);
    for (let i = 0; i < 50 && alive(a.pid!); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(a.pid!)).toBe(false);
    expect(alive(b.pid!), 'the other member of the group lives').toBe(true);
    expect(alive(sh.pid!), 'and so does its parent').toBe(true);
    ex.close();
    try {
      process.kill(-sh.pid!, 'SIGKILL');
    } catch {}
  });
});

describe.skipIf(process.platform === 'win32')('POSIX ps by absolute path', () => {
  it('never a bare name (an empty PATH entry would mean the current folder)', () => {
    expect(path.isAbsolute(posixPs())).toBe(true);
  });
});

describe('process group signals', () => {
  it("a group is signalled only when it is a real group that is not the app's own", () => {
    expect(safeGroup(4242, 100)).toBe(4242);
    expect(safeGroup(100, 100), "the app's own group").toBe(0);
    expect(safeGroup(4242, null), 'own group unknown: no group signal').toBe(0);
    expect(safeGroup(1, 100)).toBe(0);
    expect(safeGroup(0, 100)).toBe(0);
    expect(safeGroup(process.pid, 100)).toBe(0);
  });
});

// Several windows = several backends in one process: each explorer lists its own backend's indexer only, nothing goes
// into the process-wide source list, and a disposed backend leaves nothing behind (no row, no reference).
describe.skipIf(process.platform !== 'linux')('per-backend indexer rows (several windows)', () => {
  it("each backend's explorer shows its own indexer; none is shared; dispose leaves nothing", async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-proc-'));
    try {
      const cfg = path.join(tmp, 'config');
      const [a, b] = [path.join(tmp, 'a'), path.join(tmp, 'b')];
      for (const d of [a, b]) {
        await fsp.mkdir(d, { recursive: true });
        await fsp.writeFile(path.join(d, 'n.md'), 'x');
      }
      const sa = new BackendService(cfg, {}, { cacheDir: '' });
      const sb = new BackendService(cfg, {}, { cacheDir: '' });
      await sa.openWorkspace(a);
      await sb.openWorkspace(b);
      const indexers = async (s: BackendService) => ((await s.processes({ op: 'snapshot' })) as ProcSnapshot).rows.filter((r) => r.id === 'indexer');
      expect(await indexers(sa)).toHaveLength(1);
      expect(await indexers(sb)).toHaveLength(1);
      // An explorer of no backend (main's, a third window) sees neither: they were never process-wide sources.
      const bare = new ProcessExplorer({ root: () => null });
      expect((await bare.snapshot()).rows.some((r) => r.id === 'indexer')).toBe(false);
      sb.dispose();
      expect(await indexers(sa)).toHaveLength(1);
      expect((await bare.snapshot()).rows.some((r) => r.id === 'indexer')).toBe(false);
      bare.close();
      sa.dispose();
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});
