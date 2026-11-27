// What both agents' change lists share (path rules, rows, the throttled sender), the Claude Code list model, git's
// numstat behind the backend's trust gate (real repositories under .tmp), and service-level regressions.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChangesSender, cleanRel, countLines, mergeRanges, snapshotRows, toRel, touchRow, type ChangeRow, type PathCtx } from '../../../src/main/terminal-changes';
import { cleanNumstat, emptyClaudeChanges, onClaudeStep, reconcile, setBaseline } from '../../../src/main/terminal-claude-changes';
import { mapFollowPath } from '../../../src/main/terminal-follow';
import { planOpencode, planOpencodeServe } from '../../../src/main/terminal-shells';
import { TerminalService, type PtyLike, type PtyModuleLike } from '../../../src/main/terminal';
import { parseNumstat } from '../../../src/backend/git-numstat';
import { BackendService } from '../../../src/backend/service';
import { AGENT_NAMES, CHANGES_MAX_FILES, type ShellInfo, type TerminalChangesEvent } from '../../../src/shared/terminal';
import { git, makeRepo, testEnv, tmpDir, write } from '../git/helpers';

describe('shared pieces', () => {
  const ctx: PathCtx = { win: false, map: (abs) => mapFollowPath(abs, { root: '/ws', platform: 'linux', foldCase: false }) };

  it('paths: relative ones are checked lexically, absolute ones mapped into the folder, a project root above it joined first', () => {
    expect(cleanRel('src/a.ts')).toBe('src/a.ts');
    for (const bad of ['/abs', '../x', 'a/../b', 'a//b', './a', '', 'a\u0000', 'C:x', 7, null]) expect(cleanRel(bad), String(bad)).toBeNull();
    expect(cleanRel('a\\b:c', true)).toBeNull();
    expect(toRel(ctx, '/ws/a.ts')).toBe('a.ts');
    expect(toRel(ctx, 'a.ts')).toBe('a.ts');
    expect(toRel(ctx, 'ws/a.ts', '/')).toBe('a.ts'); // relative to a root above the folder
    expect(toRel(ctx, 'other/a.ts', '/')).toBeNull();
    expect(toRel(ctx, '../ws/a.ts', '/ws')).toBe('a.ts'); // resolved first, then judged
    expect(toRel(ctx, '../etc/passwd', '/ws')).toBeNull();
  });

  it('ranges merge, lines count like a diff counts them', () => {
    expect(mergeRanges([5, 3, 4, 9, 10, 20])).toEqual([[3, 5], [9, 10], [20, 20]]);
    expect(mergeRanges([1, 3, 5, 7], 2)).toEqual([[1, 1], [3, 3]]);
    expect([countLines(''), countLines('a'), countLines('a\n'), countLines('a\nb'), countLines('a\nb\n'), countLines('\n'), countLines(7)]).toEqual([0, 1, 1, 2, 2, 1, 0]);
  });

  it('rows: capped, a snapshot in a stable order without the trackers\' own fields', () => {
    const files = new Map<string, ChangeRow<{ secret: string }>>();
    expect(touchRow(files, 'b.ts', 2, { secret: 'x' })).toBe(true);
    expect(touchRow(files, 'b.ts', 3, { secret: 'y' })).toBe(false);
    touchRow(files, 'a.ts', 1, { secret: 'x' });
    expect(snapshotRows(files)).toEqual([
      { path: 'a.ts', status: 'modified', additions: 0, deletions: 0, turn: 1, exact: false },
      { path: 'b.ts', status: 'modified', additions: 0, deletions: 0, turn: 2, exact: false },
    ]);
    for (let i = 0; i < CHANGES_MAX_FILES + 50; i++) touchRow(files, `f${i}`, 1, { secret: '' });
    expect(files.size).toBe(CHANGES_MAX_FILES);
  });

  it('the sender: one message for a burst, nothing when nothing moved, nothing after close', async () => {
    vi.useFakeTimers();
    try {
      const sent: TerminalChangesEvent[] = [];
      const st = { busy: true, turns: 1, files: new Map<string, ChangeRow>() };
      const s = new ChangesSender(4, 'claude', () => st, (e) => sent.push(e), 50);
      for (let i = 0; i < 20; i++) {
        touchRow(st.files, `f${i}`, 1, {});
        s.schedule();
      }
      expect(sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(50);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ id: 4, agent: 'claude', busy: true, turns: 1 });
      expect(sent[0].files).toHaveLength(20);
      s.schedule();
      await vi.advanceTimersByTimeAsync(50);
      expect(sent).toHaveLength(1); // the same state again: not sent
      st.busy = false;
      s.schedule();
      s.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Claude Code list model', () => {
  const paths = (st: ReturnType<typeof emptyClaudeChanges>) => snapshotRows(st.files).map((f) => `${f.path} +${f.additions} -${f.deletions} t${f.turn}${f.exact ? ' exact' : ''}`);

  it('turns, estimates, and what a Stop without git leaves', () => {
    const st = emptyClaudeChanges();
    expect(onClaudeStep(st, { kind: 'prompt' })).toBe(true);
    expect(onClaudeStep(st, { kind: 'pre', path: 'a.ts' })).toBe(true);
    expect(onClaudeStep(st, { kind: 'pre', path: 'a.ts' })).toBe(false);
    expect(onClaudeStep(st, { kind: 'edit', path: 'a.ts', counts: { additions: 2, deletions: 1 } })).toBe(true);
    expect(onClaudeStep(st, { kind: 'edit', path: 'a.ts' })).toBe(false); // nothing new to show
    onClaudeStep(st, { kind: 'pre', path: 'never.ts' });
    expect(onClaudeStep(st, { kind: 'stop' })).toBe(true);
    expect(onClaudeStep(st, { kind: 'stop' })).toBe(false);
    expect(reconcile(st, null)).toBe(true); // the announced row nothing wrote goes
    expect(paths(st)).toEqual(['a.ts +2 -1 t1']);
    onClaudeStep(st, { kind: 'prompt' });
    onClaudeStep(st, { kind: 'write', path: 'a.ts', counts: { additions: 9, deletions: 0 }, created: true }); // rewritten as a new file
    expect(snapshotRows(st.files)).toEqual([{ path: 'a.ts', status: 'added', additions: 9, deletions: 0, turn: 2, exact: false }]);
    expect(st).toMatchObject({ busy: true, turns: 2 });
  });

  it('git at Stop: exact for Claude\'s files, shell-made changes join, what was there before stays out, hostile rows are dropped', () => {
    const st = emptyClaudeChanges();
    setBaseline(st, [{ path: 'mine.md', additions: 3, deletions: 0, status: 'modified' }, { path: 'both.md', additions: 1, deletions: 1, status: 'modified' }]);
    onClaudeStep(st, { kind: 'prompt' });
    onClaudeStep(st, { kind: 'edit', path: 'a.ts', counts: { additions: 5, deletions: 5 } });
    onClaudeStep(st, { kind: 'edit', path: 'ignored.log', counts: { additions: 1, deletions: 0 } });
    onClaudeStep(st, { kind: 'stop' });
    const rows = [
      { path: 'a.ts', additions: 4, deletions: 2, status: 'modified' },
      { path: 'mine.md', additions: 3, deletions: 0, status: 'modified' }, // as before the session
      { path: 'both.md', additions: 6, deletions: 1, status: 'modified' }, // changed further by a shell command
      { path: 'gone.ts', additions: 0, deletions: 12, status: 'deleted' },
      { path: '../x', additions: 1, deletions: 0, status: 'added' },
      { path: '/abs', additions: 1, deletions: 0, status: 'added' },
      { path: 'weird', additions: 1, deletions: 0, status: 'renamed' },
      { path: 'neg', additions: -1, deletions: 0, status: 'added' },
      null,
    ];
    expect(cleanNumstat(rows)!.map((r) => r.path)).toEqual(['a.ts', 'mine.md', 'both.md', 'gone.ts']);
    expect(cleanNumstat('no')).toBeNull();
    expect(reconcile(st, rows)).toBe(true);
    expect(paths(st)).toEqual(['a.ts +4 -2 t1 exact', 'both.md +6 -1 t1 exact', 'gone.ts +0 -12 t1 exact', 'ignored.log +1 -0 t1']);
    expect(st.files.get('gone.ts')!.status).toBe('deleted');
    expect(reconcile(st, rows)).toBe(false); // the same answer again: nothing to send
    // Turn 2: Claude commits. Its own rows stay as they were; the shell's rows git no longer lists go.
    onClaudeStep(st, { kind: 'prompt' });
    onClaudeStep(st, { kind: 'stop' });
    expect(reconcile(st, [{ path: 'mine.md', additions: 3, deletions: 0, status: 'modified' }])).toBe(true);
    expect(paths(st)).toEqual(['a.ts +4 -2 t1 exact', 'ignored.log +1 -0 t1']);
  });

  it('a snapshot per prompt: what the user saved before turn 2 is not turn 2’s; what changed during it is', () => {
    const st = emptyClaudeChanges();
    const n = (path: string, additions: number, status = 'modified') => ({ path, additions, deletions: 0, status });
    onClaudeStep(st, { kind: 'prompt' });
    setBaseline(st, []); // turn 1 starts on a clean tree
    onClaudeStep(st, { kind: 'edit', path: 'a.ts', counts: { additions: 1, deletions: 0 } });
    onClaudeStep(st, { kind: 'stop' });
    reconcile(st, [n('a.ts', 1), n('gen.txt', 4, 'added'), n('log.txt', 1)]); // two files only a shell command changed
    expect(paths(st)).toEqual(['a.ts +1 -0 t1 exact', 'gen.txt +4 -0 t1 exact', 'log.txt +1 -0 t1 exact']);
    // Between the turns the user saves notes.md and edits gen.txt by hand; turn 2's snapshot sees both.
    onClaudeStep(st, { kind: 'prompt' });
    setBaseline(st, [n('a.ts', 1), n('gen.txt', 6, 'added'), n('log.txt', 1), n('notes.md', 2)]);
    onClaudeStep(st, { kind: 'edit', path: 'b.ts', counts: { additions: 3, deletions: 0 } });
    onClaudeStep(st, { kind: 'stop' });
    // In turn 2 Claude edited b.ts, and its shell built out.txt and appended to log.txt.
    expect(reconcile(st, [n('a.ts', 1), n('gen.txt', 6, 'added'), n('log.txt', 3), n('notes.md', 2), n('b.ts', 3), n('out.txt', 5, 'added')])).toBe(true);
    expect(paths(st)).toEqual(['a.ts +1 -0 t1 exact', 'b.ts +3 -0 t2 exact', 'gen.txt +6 -0 t1 exact', 'log.txt +3 -0 t2 exact', 'out.txt +5 -0 t2 exact']);
    // Turn 3's snapshot failed (git timed out): nothing only git saw is called Claude's this turn.
    onClaudeStep(st, { kind: 'prompt' });
    setBaseline(st, null);
    onClaudeStep(st, { kind: 'stop' });
    reconcile(st, [n('a.ts', 1), n('gen.txt', 6, 'added'), n('log.txt', 3), n('notes.md', 2), n('b.ts', 3), n('out.txt', 5, 'added'), n('later.md', 1)]);
    expect(paths(st)).not.toContainEqual(expect.stringMatching(/^(later|notes)\.md/));
  });

  it('without a baseline (git came later) nothing only git saw is listed', () => {
    const st = emptyClaudeChanges();
    onClaudeStep(st, { kind: 'prompt' });
    onClaudeStep(st, { kind: 'edit', path: 'a.ts', counts: { additions: 1, deletions: 0 } });
    reconcile(st, [{ path: 'a.ts', additions: 1, deletions: 0, status: 'modified' }, { path: 'whose.md', additions: 9, deletions: 0, status: 'modified' }]);
    expect(paths(st)).toEqual(['a.ts +1 -0 t1 exact']);
  });
});

describe('git numstat (backend)', () => {
  const services: BackendService[] = [];
  afterEach(() => services.splice(0).forEach((s) => s.dispose()));
  const open = async (dir: string, trust = true) => {
    const s = new BackendService(await tmpDir('cfg'), {}, { cacheDir: '' }, { env: testEnv() });
    services.push(s);
    await s.openWorkspace(dir);
    if (trust) await s.git('trust');
    return s;
  };

  it('parses raw + numstat records (status, counts, binary, odd names)', () => {
    const z = ':100644 100644 de98044 0000000 M\0a b.txt\0:100644 000000 587be6b 0000000 D\0deep/gone.txt\0:000000 100644 0000000 2fe4df4 A\0new.txt\0:100644 100644 88768ef 0000000 M\0bin.dat\0' + '2\t1\ta b.txt\x000\t1\tdeep/gone.txt\x002\t0\tnew.txt\0-\t-\tbin.dat\0';
    expect(parseNumstat(z)).toEqual([
      { path: 'a b.txt', additions: 2, deletions: 1, status: 'modified' },
      { path: 'deep/gone.txt', additions: 0, deletions: 1, status: 'deleted' },
      { path: 'new.txt', additions: 2, deletions: 0, status: 'added' },
      { path: 'bin.dat', additions: 0, deletions: 0, status: 'modified' },
    ]);
    expect(parseNumstat('')).toEqual([]);
    expect(parseNumstat('garbage\0:broken\0')).toEqual([]);
    expect(parseNumstat('1\t1\ta\x001\t1\tb\0', 1)).toHaveLength(1);
  });

  it('counts what differs from the last commit — staged or not, deleted too; untracked files are not listed', async () => {
    const dir = await makeRepo('numstat', { 'src/a.ts': 'a\nb\nc\n', 'src/gone.ts': 'x\ny\n', 'README.md': 'r\n' });
    write(dir, 'src/a.ts', 'a\nB\nc\nd\n');
    fs.rmSync(path.join(dir, 'src/gone.ts'));
    write(dir, 'src/staged.ts', 'n1\nn2\n');
    git(dir, 'add', 'src/staged.ts');
    write(dir, 'untracked.txt', 'u\n');
    const s = await open(dir);
    expect(await s.git('numstat')).toEqual([
      { path: 'src/a.ts', additions: 2, deletions: 1, status: 'modified' },
      { path: 'src/gone.ts', additions: 0, deletions: 2, status: 'deleted' },
      { path: 'src/staged.ts', additions: 2, deletions: 0, status: 'added' },
    ]);
  });

  it('the open folder below the repository root: paths are relative to the folder, the rest of the repository is left out', async () => {
    const dir = await makeRepo('numstat-sub', { 'packages/app/src/a.ts': 'a\n', 'packages/other/b.ts': 'b\n', 'top.md': 't\n' });
    write(dir, 'packages/app/src/a.ts', 'a\nmore\n');
    write(dir, 'packages/other/b.ts', 'changed\n');
    write(dir, 'top.md', 'changed\n');
    const s = await open(path.join(dir, 'packages', 'app'));
    expect(await s.git('numstat')).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0, status: 'modified' }]);
  });

  it('no answer without trust, without a repository, without a commit, without a folder — and git is not started for an untrusted folder', async () => {
    const dir = await makeRepo('numstat-untrusted', { 'a.md': 'one\n', '.gitattributes': '*.md filter=evil\n' });
    const marker = path.join(dir, '..', `${path.basename(dir)}-ran`);
    git(dir, 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
    git(dir, 'config', 'core.fsmonitor', `touch '${marker}'`);
    write(dir, 'a.md', 'two\n');
    const untrusted = await open(dir, false);
    expect(await untrusted.git('numstat')).toBeNull();
    expect(fs.existsSync(marker)).toBe(false);
    // Trusted: the folder's filter and fsmonitor commands still never run for this read.
    await untrusted.git('trust');
    expect(await untrusted.git('numstat')).toEqual([{ path: 'a.md', additions: 1, deletions: 1, status: 'modified' }]);
    expect(fs.existsSync(marker)).toBe(false);

    const plain = await open(await tmpDir('numstat-plain'));
    expect(await plain.git('numstat')).toBeNull();
    const empty = await open(await makeRepo('numstat-empty'));
    expect(await empty.git('numstat')).toBeNull();
    const none = new BackendService(await tmpDir('cfg'), {}, { cacheDir: '' }, { env: testEnv() });
    services.push(none);
    await expect(none.git('numstat')).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });
});

describe('Opencode start plans and service regressions', () => {
  it('the private server: the binary itself, or an npm shim through cmd.exe as one verbatim command line', () => {
    expect(planOpencodeServe('/h/.opencode/bin/opencode', { platform: 'linux', env: {} })).toEqual({ file: '/h/.opencode/bin/opencode', args: ['serve', '--hostname', '127.0.0.1', '--port', '0'], verbatim: false });
    expect(planOpencodeServe('C:\\x\\opencode.exe', { platform: 'win32', env: {} }).verbatim).toBe(false);
    const shim = planOpencodeServe('C:\\Users\\R&D me\\npm\\opencode.cmd', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } });
    expect(shim).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/D', '/S /C ""C:\\Users\\R&D me\\npm\\opencode.cmd" serve --hostname 127.0.0.1 --port 0"'], verbatim: true });
    expect(() => planOpencodeServe('C:\\100%\\opencode.cmd', { platform: 'win32', env: {} })).toThrow(/%/);
    // Follow off: plain opencode, no server address, no password.
    expect(planOpencode({ available: true, path: '/x/opencode' }, '/ws', { platform: 'linux', env: { PATH: '/bin' } })).toMatchObject({ file: '/x/opencode', args: [], env: { PATH: '/x:/bin' } });
  });

  class FakePty implements PtyLike {
    pid = 4242;
    onData = () => ({ dispose() {} });
    onExit = () => ({ dispose() {} });
    write() {}
    resize() {}
    kill() {}
    pause() {}
    resume() {}
  }
  const SHELLS: ShellInfo[] = [{ id: 'cmd', name: 'Command Prompt', kind: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe', args: [] }];
  const server = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: 0, kill: () => (child.killed++, true) });
    return child;
  };

  it('the terminal is named "Opencode"; with its setting off nothing but the terminal starts', async () => {
    let started = 0;
    const spawned: Array<{ file: string; args: unknown; env: Record<string, string> }> = [];
    const pty: PtyModuleLike = { spawn: (file, args, o) => (spawned.push({ file, args, env: o.env as Record<string, string> }), new FakePty()) };
    const svc = new TerminalService({
      loadPty: () => pty,
      getWorkspaceRoot: () => '/ws',
      platform: 'linux',
      env: { PATH: '/bin' },
      detect: async () => [{ id: 'bash', name: 'bash', kind: 'bash', path: '/bin/bash', args: [] }],
      detectOpencode: async () => ({ available: true, path: '/x/opencode' }),
      follow: { dir: '/nowhere', foldCase: () => false, inside: async () => true },
      opencodeSpawn: () => (started++, server() as never),
      signalGroup: () => {},
    });
    const t = await svc.spawn(1, { preset: 'opencode' });
    expect(t.shell).toMatchObject({ id: 'opencode', kind: 'opencode', name: 'Opencode' });
    expect(AGENT_NAMES).toEqual({ claude: 'Claude Code', opencode: 'Opencode' });
    expect(started).toBe(0);
    expect(spawned[0]).toMatchObject({ file: '/x/opencode', args: [] });
    expect(spawned[0].env.OPENCODE_PASSWORD).toBeUndefined();
    svc.dispose();
  });

  it('a start that fails after the private server came up takes the server down with it (no orphan)', async () => {
    const child = server();
    const svc = new TerminalService({
      loadPty: () => ({ spawn: () => new FakePty() }),
      getWorkspaceRoot: () => 'C:\\ws',
      platform: 'win32',
      env: { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      detect: async () => SHELLS,
      // An npm shim in a folder cmd.exe cannot be given: planning the terminal's own start throws.
      detectOpencode: async () => ({ available: true, path: 'C:\\100%\\opencode.cmd' }),
      follow: { dir: 'C:\\data', foldCase: () => true, inside: async () => true },
      opencodeSpawn: () => {
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:9\nserver password secret-pass-12345\n')));
        return child as never;
      },
      treeKill: () => {},
    });
    await expect(svc.spawn(1, { preset: 'opencode', follow: true })).rejects.toThrow(/%/);
    expect(child.killed).toBeGreaterThan(0);
    expect(svc.count()).toBe(0);
    svc.dispose();
  });
});
