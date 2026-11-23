// opencode "AI changes": the pure model against a recording of a real opencode 2.3.2 server
// (edit, write, shell-made change, delete, rename, a hand edit during a turn) + hostile input.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addSession, cleanRel, diffQuery, emptyState, isBusy, onDiff, onEvent, patchLines, snapshot, toRel, worktreeOf, type OpencodeCtx } from '../../../src/main/terminal-opencode-model';
import { mapFollowPath } from '../../../src/main/terminal-follow';

const ROOT = '/ws';
const ctx: OpencodeCtx = { win: false, map: (abs) => mapFollowPath(abs, { root: ROOT, platform: 'linux', foldCase: false }) };
const inFolder = (dir: string) => dir === ROOT;
const rec = fs
  .readFileSync(path.join(__dirname, '../../fixtures/opencode/session-2.3.2.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const meta = rec.find((r) => r.kind === 'meta') as { expect: Record<string, [number, number]> };

describe('recorded session', () => {
  it('ends with the same +/− per file as git (numstat) when the last diff is applied', () => {
    const st = emptyState();
    let lastDiff: unknown;
    const follow: string[] = [];
    for (const r of rec) {
      if (r.kind === 'event') follow.push(...onEvent(st, r.event, ctx, inFolder).follow.map((f) => f.kind + (f.path ? ':' + f.path : '')));
      else if (r.kind === 'diff') lastDiff = r;
    }
    const d = lastDiff as { session: string; body: unknown };
    expect(onDiff(st, d.session, d.body, ctx)).not.toBeNull();
    const got = Object.fromEntries(snapshot(st).map((f) => [f.path, [f.additions, f.deletions]]));
    expect(got).toEqual(meta.expect);
    expect(snapshot(st).every((f) => f.exact)).toBe(true);
    // Two user prompts of the agent (+ one steer): the next prompt clears marks, the end of a turn says stop.
    expect(follow).toContain('prompt');
    expect(follow).toContain('stop');
    expect(follow).toContain('edit:src/a.ts');
    expect(follow).toContain('write:src/new1.ts'); // `write` has no patch: announced by tool.called, shown after tool.success
  });

  it('shows a row at the first signal (before the write), as an estimate', () => {
    const st = emptyState();
    for (const r of rec) {
      if (r.kind !== 'event') continue;
      onEvent(st, r.event, ctx, inFolder);
      if (r.event.type === 'session.tool.called') break;
    }
    expect(snapshot(st)).toEqual([{ path: 'src/a.ts', status: 'modified', additions: 0, deletions: 0, turn: 1, exact: false }]);
  });

  it('every row carries the turn that last changed it', () => {
    const st = emptyState();
    const turnsAt: number[] = [];
    for (const r of rec) {
      if (r.kind === 'event') onEvent(st, r.event, ctx, inFolder);
      else if (r.kind === 'diff') onDiff(st, r.session, r.body, ctx);
      turnsAt.push(st.turns);
    }
    expect(st.turns).toBeGreaterThanOrEqual(2);
    const rows = snapshot(st);
    expect(rows.every((f) => Number.isInteger(f.turn) && f.turn >= 1 && f.turn <= st.turns)).toBe(true);
    expect(new Set(rows.map((f) => f.turn)).size).toBeGreaterThan(1); // the recording's turns changed different files
    // A diff that repeats what is known moves no row to another turn.
    const before = JSON.stringify(rows);
    const lastDiff = [...rec].reverse().find((r) => r.kind === 'diff');
    onEvent(st, { type: 'session.inbox.enqueued', data: { sessionID: lastDiff.session, inboxID: 'msg_later', item: { type: 'user' } } }, ctx, inFolder);
    expect(onDiff(st, lastDiff.session, lastDiff.body, ctx)).toEqual({ changed: false });
    expect(JSON.stringify(snapshot(st))).toBe(before);
  });

  it('ignores another folder\'s sessions', () => {
    const st = emptyState();
    for (const r of rec) if (r.kind === 'event') onEvent(st, r.event, ctx, () => false);
    expect(st.sessions.size).toBe(0);
    expect(snapshot(st)).toEqual([]);
  });

  it('drops rows the diff no longer lists (reverted) and keeps another session\'s', () => {
    const st = emptyState();
    onDiff(st, 's1', { data: [{ file: 'a.ts', additions: 1, deletions: 0, status: 'modified' }, { file: 'b.ts', additions: 2, deletions: 1, status: 'added' }] }, ctx);
    onDiff(st, 's2', { data: [{ file: 'c.ts', additions: 3, deletions: 0, status: 'added' }] }, ctx);
    onDiff(st, 's1', { data: [{ file: 'a.ts', additions: 1, deletions: 0, status: 'modified' }] }, ctx);
    expect(snapshot(st).map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
  });
});

describe('hostile input', () => {
  const ev = (type: string, data: object) => ({ type, location: { directory: ROOT }, data: { sessionID: 's', ...data } });
  const start = () => {
    const st = emptyState();
    onEvent(st, ev('session.created', {}), ctx, inFolder);
    return st;
  };
  it('only paths inside the folder become rows or follow events', () => {
    const st = start();
    const bad = ['/etc/passwd', '/ws/../etc/passwd', '../x', 'a/../../x', '/wsx/a', '', '/ws', 'a\u0000b', 'x'.repeat(5000), 7, null, { a: 1 }, 'C:\\x', 'a//b'];
    for (const p of bad) {
      const r = onEvent(st, ev('session.tool.success', { id: 'c', metadata: { files: [{ file: p, additions: 1, deletions: 0 }] } }), ctx, inFolder);
      expect(r.follow.filter((f) => f.path)).toEqual([]);
      onEvent(st, ev('session.tool.called', { id: 'c2', input: { path: p } }), ctx, inFolder);
      onEvent(st, ev('session.step.ended', { files: [p] }), ctx, inFolder);
    }
    expect(snapshot(st)).toEqual([]);
  });
  it('malformed events and diff rows are skipped, never thrown on', () => {
    const st = start();
    for (const e of [null, 1, 'x', [], {}, { type: 5 }, { type: 'session.tool.success' }, { type: 'session.tool.success', data: null }, { type: 'session.tool.success', data: { sessionID: {} } }, ev('session.tool.success', { metadata: { files: 'no' } }), ev('session.step.ended', { files: 7 })]) {
      expect(() => onEvent(st, e, ctx, inFolder)).not.toThrow();
    }
    expect(onDiff(st, 's', null, ctx)).toBeNull();
    expect(onDiff(st, 's', { data: 'x' }, ctx)).toBeNull();
    onDiff(st, 's', { data: [null, 5, { file: 'a', additions: -1, deletions: 0, status: 'modified' }, { file: 'a', additions: 1.5, deletions: 0, status: 'modified' }, { file: 'a', additions: 1, deletions: 0, status: 'weird' }, { file: 'ok.ts', additions: 1, deletions: 2, status: 'deleted' }] }, ctx);
    expect(snapshot(st)).toEqual([{ path: 'ok.ts', status: 'deleted', additions: 1, deletions: 2, turn: 0, exact: true }]);
  });
  it('caps the list', () => {
    const st = start();
    onDiff(st, 's', { data: Array.from({ length: 2000 }, (_, i) => ({ file: `f${i}`, additions: 1, deletions: 0, status: 'added' })) }, ctx);
    expect(snapshot(st).length).toBe(500);
  });
});

describe('regressions', () => {
  const ev = (type: string, data: object, sid = 's') => ({ type, location: { directory: ROOT }, data: { sessionID: sid, ...data } });
  const start = () => {
    const st = emptyState();
    onEvent(st, ev('session.created', {}), ctx, inFolder);
    onEvent(st, ev('session.inbox.enqueued', { inboxID: 'm1', item: { type: 'user' } }), ctx, inFolder);
    return st;
  };

  it('a tool that only reads, searches or lists under a path changes nothing: no row, no follow event', () => {
    const st = start();
    // The events name no tool: only the input tells a write (text to put in a file) from a read.
    for (const input of [{ path: '/ws/src/a.ts' }, { path: '/ws/src/a.ts', offset: 1, limit: 50 }, { filePath: '/ws/src/a.ts' }, { pattern: 'TODO', path: '/ws/src' }, { path: '/ws' }]) {
      expect(onEvent(st, ev('session.tool.called', { id: 'r', input }), ctx, inFolder).changed).toBe(false);
      expect(onEvent(st, ev('session.tool.success', { id: 'r', content: [{ type: 'text', text: '…' }], metadata: {} }), ctx, inFolder).follow).toEqual([]);
    }
    expect(snapshot(st)).toEqual([]);
    // A write still announces its file and is shown once it succeeded.
    expect(onEvent(st, ev('session.tool.called', { id: 'w', input: { path: '/ws/src/new.ts', content: 'x' } }), ctx, inFolder).changed).toBe(true);
    expect(onEvent(st, ev('session.tool.success', { id: 'w', metadata: {} }), ctx, inFolder).follow).toEqual([{ kind: 'write', path: 'src/new.ts' }]);
    expect(snapshot(st).map((f) => f.path)).toEqual(['src/new.ts']);
  });

  it('a failed or interrupted edit leaves no row behind', () => {
    const st = start();
    onEvent(st, ev('session.tool.called', { id: 'a', input: { path: '/ws/a.ts', oldString: 'x', newString: 'y' } }), ctx, inFolder);
    onEvent(st, ev('session.tool.called', { id: 'b', input: { path: '/ws/b.ts', content: 'x' } }), ctx, inFolder);
    onEvent(st, ev('session.tool.called', { id: 'c', input: { path: '/ws/c.ts', content: 'x' } }), ctx, inFolder);
    expect(snapshot(st).map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(onEvent(st, ev('session.tool.failed', { id: 'a' }), ctx, inFolder).changed).toBe(true); // "oldString not found"
    expect(snapshot(st).map((f) => f.path)).toEqual(['b.ts', 'c.ts']);
    onEvent(st, ev('session.tool.success', { id: 'b', metadata: {} }), ctx, inFolder);
    onEvent(st, ev('session.execution.interrupted', {}), ctx, inFolder); // c never finished
    expect(snapshot(st).map((f) => f.path)).toEqual(['b.ts']);
    // A file that really changed keeps its row when a later call on it fails.
    onEvent(st, ev('session.tool.called', { id: 'd', input: { path: '/ws/b.ts', oldString: 'x', newString: 'y' } }), ctx, inFolder);
    expect(onEvent(st, ev('session.tool.failed', { id: 'd' }), ctx, inFolder).changed).toBe(false);
    expect(snapshot(st).map((f) => f.path)).toEqual(['b.ts']);
  });

  it('a subagent\'s session works inside its parent\'s turn: no new turn, no cleared marks, no early "stop"', () => {
    const st = start();
    onEvent(st, { type: 'session.created', location: { directory: '/elsewhere' }, data: { sessionID: 'kid', parentID: 's' } }, ctx, inFolder);
    const begin = onEvent(st, ev('session.inbox.enqueued', { inboxID: 'k1', item: { type: 'user' } }, 'kid'), ctx, inFolder);
    expect(begin.follow).toEqual([]);
    expect(st.turns).toBe(1);
    onEvent(st, ev('session.tool.called', { id: 'k', input: { path: '/ws/kid.ts', content: 'x' } }, 'kid'), ctx, inFolder);
    onEvent(st, ev('session.tool.success', { id: 'k', metadata: {} }, 'kid'), ctx, inFolder);
    const end = onEvent(st, ev('session.execution.succeeded', {}, 'kid'), ctx, inFolder);
    expect(end.follow).toEqual([]);
    expect(isBusy(st)).toBe(true); // the parent is still working
    expect(snapshot(st)).toEqual([{ path: 'kid.ts', status: 'modified', additions: 0, deletions: 0, turn: 1, exact: false }]);
    expect(onEvent(st, ev('session.execution.succeeded', {}), ctx, inFolder).follow).toEqual([{ kind: 'stop' }]);
  });

  it('a session id is only ever id characters (it goes into request paths)', () => {
    const st = emptyState();
    for (const sid of ['../../x', 'a/b', 'a?b=c', 'a b', '', 'x'.repeat(201)]) {
      onEvent(st, { type: 'session.created', location: { directory: ROOT }, data: { sessionID: sid } }, ctx, inFolder);
      expect(addSession(st, sid)).toBe(false);
    }
    expect(st.sessions.size).toBe(0);
  });

  it('the open folder below opencode\'s project root: its project-relative paths are mapped, the rest of the project is not listed', () => {
    // One has /repo/packages/app open; opencode's project (the git work tree) is /repo and its rows are relative to that.
    const sub: OpencodeCtx = { win: false, map: (abs) => mapFollowPath(abs, { root: '/repo/packages/app', platform: 'linux', foldCase: false }) };
    expect(worktreeOf('/repo/packages/app', 'packages/app', false)).toBe('/repo');
    expect(worktreeOf('/repo/packages/app/', 'packages/app/', false)).toBe('/repo');
    expect(worktreeOf('C:\\repo\\Packages\\app', 'packages/app', true)).toBe('C:/repo');
    for (const [dir, subpath] of [['/repo', ''], ['/repo/app', 'other'], ['/repo/app', '../app'], ['/repo/app', 7], [7, 'app']] as const) expect(worktreeOf(dir, subpath, false)).toBeNull();
    const st = emptyState();
    onEvent(st, { type: 'session.created', location: { directory: '/repo/packages/app' }, data: { sessionID: 's', subpath: 'packages/app' } }, sub, (d) => d === '/repo/packages/app');
    onEvent(st, ev('session.inbox.enqueued', { inboxID: 'm1', item: { type: 'user' } }), sub, () => true);
    onEvent(st, ev('session.step.ended', { files: ['packages/app/src/a.ts', 'packages/other/b.ts', 'README.md'] }), sub, () => true);
    onDiff(st, 's', { data: [{ file: 'packages/app/src/a.ts', additions: 2, deletions: 1, status: 'modified' }, { file: 'packages/other/b.ts', additions: 1, deletions: 0, status: 'added' }, { file: '../../etc/passwd', additions: 1, deletions: 0, status: 'added' }] }, sub);
    expect(snapshot(st)).toEqual([{ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, turn: 1, exact: true }]);
  });

  it('a folder opened through a link: opencode names files by the real folder, both names map', () => {
    const linked: OpencodeCtx = { win: false, map: (abs) => mapFollowPath(abs, { root: '/tmp/ws', realRoot: '/private/tmp/ws', platform: 'linux', foldCase: false }) };
    expect(toRel(linked, '/private/tmp/ws/src/a.ts')).toBe('src/a.ts');
    expect(toRel(linked, '/tmp/ws/src/a.ts')).toBe('src/a.ts');
    expect(toRel(linked, '/private/tmp/wsx/a.ts')).toBeNull();
    expect(toRel(linked, '/private/tmp/ws/../other/a.ts')).toBeNull();
  });

  it('many sessions (every subagent is one): the oldest idle one makes room, a working one never does', () => {
    const st = emptyState();
    for (let i = 0; i < 200; i++) expect(addSession(st, `s${i}`)).toBe(true);
    st.sessions.get('s0')!.busy = true;
    expect(addSession(st, 'next')).toBe(true);
    expect(st.sessions.size).toBe(200);
    expect(st.sessions.has('s0')).toBe(true);
    expect(st.sessions.has('s1')).toBe(false);
    for (const s of st.sessions.values()) s.busy = true;
    expect(addSession(st, 'full')).toBe(false);
  });
});

describe('helpers', () => {
  it('cleanRel / toRel', () => {
    expect(cleanRel('src/a.ts')).toBe('src/a.ts');
    expect(cleanRel('/abs')).toBeNull();
    expect(cleanRel('a\\b', true)).toBe('a/b');
    expect(cleanRel('a:b', true)).toBeNull();
    expect(toRel(ctx, '/ws/src/a.ts')).toBe('src/a.ts');
    expect(toRel(ctx, 'src/a.ts')).toBe('src/a.ts');
    expect(toRel(ctx, '/other/a.ts')).toBeNull();
  });
  it('patchLines marks the changed lines of the new file, not the context', () => {
    expect(patchLines('--- a\n+++ a\n@@ -1,4 +1,5 @@\n a\n b\n-c\n+C\n+D\n e\n')).toEqual([[3, 4]]);
    expect(patchLines('@@ -5 +5,0 @@\n-gone\n')).toEqual([[5, 5]]);
    expect(patchLines('@@ -1 +1 @@\n a\n')).toBeNull();
    expect(patchLines('no patch')).toBeNull();
    expect(patchLines(42)).toBeNull();
  });
  it('diffQuery spans first..last turn and refuses odd ids', () => {
    expect(diffQuery([])).toBe('?context=0');
    expect(diffQuery(['msg_1'])).toBe('?context=0');
    expect(diffQuery(['msg_1', 'msg_2', 'msg_3'])).toBe('?from=msg_1&to=msg_3&context=0');
    expect(diffQuery(['msg_1', 'a&b=c'])).toBe('?context=0');
  });
});
