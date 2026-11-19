import { describe, it, expect, vi } from 'vitest';
import type { GitHeadFile, GitStatus, GitStatusResult } from '@shared/git';
import { GitStore, type GitBackend } from '../../../src/renderer/git/store';

const OID = 'b'.repeat(40);
const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  ok: true,
  branch: { head: 'main', oid: OID, detached: false, upstream: null, ahead: 0, behind: 0 },
  entries: [],
  prefix: '',
  ms: 5,
  ...over,
});

function fakeBackend(results: GitStatusResult[] = [status()]) {
  let i = 0;
  const calls = { status: 0, head: [] as Array<[string, string | undefined]> };
  let gate: Promise<void> | null = null;
  const backend: GitBackend = {
    async gitStatus() {
      calls.status++;
      if (gate) await gate;
      return results[Math.min(i++, results.length - 1)];
    },
    async gitHeadFile(path, rev) {
      calls.head.push([path, rev]);
      return { content: `HEAD:${path}`, oid: rev ?? OID } satisfies GitHeadFile;
    },
  };
  return {
    backend,
    calls,
    hold() {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('GitStore', () => {
  it('debounces bursts of refresh() into one git status', async () => {
    const f = fakeBackend();
    const s = new GitStore(f.backend, { debounceMs: 20 });
    for (let i = 0; i < 10; i++) s.refresh();
    await tick(60);
    expect(f.calls.status).toBe(1);
    expect(s.status.value).toMatchObject({ ok: true });
  });

  it('single-flight: a request during a run queues exactly one more', async () => {
    const f = fakeBackend([status(), status({ entries: [{ path: 'a.md', state: 'modified' }] })]);
    const s = new GitStore(f.backend, { debounceMs: 5 });
    const release = f.hold();
    const first = s.refreshNow();
    void s.refreshNow();
    void s.refreshNow();
    expect(f.calls.status).toBe(1);
    release();
    await first;
    await tick(30);
    expect(f.calls.status).toBe(2);
    expect(s.marks.value.file('a.md')?.state).toBe('modified');
  });

  it('identical results do not re-render (signal value kept)', async () => {
    const f = fakeBackend([status({ ms: 3 }), status({ ms: 9 })]);
    const s = new GitStore(f.backend);
    await s.refreshNow();
    const v = s.status.value;
    const cb = vi.fn();
    s.subscribe(cb);
    await s.refreshNow();
    expect(s.status.value).toBe(v);
    expect(cb).not.toHaveBeenCalled();
  });

  it('drops results that arrive after a workspace switch', async () => {
    const f = fakeBackend([status({ entries: [{ path: 'old.md', state: 'modified' }] }), status()]);
    const s = new GitStore(f.backend, { debounceMs: 5 });
    const release = f.hold();
    const late = s.refreshNow();
    s.reset();
    release();
    await late;
    expect(s.marks.value.file('old.md')).toBeNull();
  });

  it('headKey / headFile: per commit, renames read the old path, untracked has none; cached', async () => {
    const f = fakeBackend([
      status({
        entries: [
          { path: 'new name.md', state: 'renamed', from: 'old name.md' },
          { path: 'u.md', state: 'untracked' },
          { path: 'staged-new.md', state: 'added' },
          { path: 'm.md', state: 'modified' },
        ],
      }),
    ]);
    const s = new GitStore(f.backend);
    expect(s.headKey('m.md')).toBeNull(); // no status yet
    await s.refreshNow();
    expect(s.headKey('m.md')).toBe(`${OID}:m.md`);
    expect(s.headKey('clean.md')).toBe(`${OID}:clean.md`);
    expect(s.headKey('u.md')).toBeNull();
    expect(s.headKey('staged-new.md')).toBeNull();
    expect(s.headKey('new name.md')).toBe(`${OID}:old name.md`);
    expect((await s.headFile('new name.md'))?.content).toBe('HEAD:old name.md');
    await s.headFile('m.md');
    await s.headFile('m.md');
    expect(f.calls.head).toEqual([
      ['old name.md', OID],
      ['m.md', OID],
    ]);
    expect(await s.headFile('u.md')).toBeNull();
  });

  it('no commits yet → no HEAD keys', async () => {
    const s = new GitStore(fakeBackend([status({ branch: { head: 'main', oid: null, detached: false, upstream: null, ahead: 0, behind: 0 } })]).backend);
    await s.refreshNow();
    expect(s.headKey('a.md')).toBeNull();
  });

  it('hint once when git is missing in what looks like a repo', async () => {
    const onHint = vi.fn();
    const f = fakeBackend([{ ok: false, reason: 'no-git', repoLikely: true }, { ok: false, reason: 'no-git', repoLikely: true, message: 'x' }]);
    const s = new GitStore(f.backend, { onHint });
    await s.refreshNow();
    await s.refreshNow();
    expect(onHint).toHaveBeenCalledTimes(1);
    const quiet = vi.fn();
    const s2 = new GitStore(fakeBackend([{ ok: false, reason: 'no-git' }]).backend, { onHint: quiet });
    await s2.refreshNow();
    expect(quiet).not.toHaveBeenCalled();
  });

  it('disabled: no git calls, nothing shown', async () => {
    const f = fakeBackend();
    const s = new GitStore(f.backend, { debounceMs: 1 });
    await s.refreshNow();
    s.setEnabled(false);
    expect(s.status.value).toBeNull();
    s.refresh();
    await s.refreshNow();
    await tick(10);
    expect(f.calls.status).toBe(1);
    s.setEnabled(true);
    await tick(10);
    expect(f.calls.status).toBe(2);
  });

  it('backend errors become an unavailable status (never throw into the UI)', async () => {
    const s = new GitStore({ gitStatus: () => Promise.reject(new Error('boom')), gitHeadFile: () => Promise.reject(new Error('x')) });
    await s.refreshNow();
    expect(s.status.value).toEqual({ ok: false, reason: 'error', message: 'boom' });
    expect(await s.headFile('a.md')).toBeNull();
  });
});
