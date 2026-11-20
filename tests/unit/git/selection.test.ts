// Choose what to commit, pane side (pure): the tri-state box from the status codes, what a click stages
// or unstages (renames), the header box, and the batcher (rapid clicks → one git call, optimistic boxes
// that settle on the refreshed status or fall back on failure).
import { describe, it, expect } from 'vitest';
import type { GitEntry } from '@shared/git';
import { allOf, ariaChecked, checkOf, selectedCount, StageBatcher, togglePaths, wantOf } from '../../../src/renderer/git/selection';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const e = (o: Partial<GitEntry> & { path: string }): GitEntry => ({ state: 'modified', ...o });

describe('tri-state from the status', () => {
  it('staged = ticked, both = partly, untracked / work-tree only = not, conflicts / ignored = no box', () => {
    expect(checkOf(e({ path: 'a', staged: true }))).toBe('on'); // M.
    expect(checkOf(e({ path: 'a', unstaged: true }))).toBe('off'); // .M
    expect(checkOf(e({ path: 'a', staged: true, unstaged: true }))).toBe('mixed'); // MM: some hunks staged
    expect(checkOf(e({ path: 'a', state: 'added', staged: true }))).toBe('on'); // A.
    expect(checkOf(e({ path: 'a', state: 'deleted', unstaged: true }))).toBe('off'); // .D
    expect(checkOf(e({ path: 'a', state: 'deleted', staged: true }))).toBe('on'); // D.
    expect(checkOf(e({ path: 'a', state: 'renamed', from: 'b', staged: true, unstaged: true }))).toBe('mixed'); // RM
    expect(checkOf(e({ path: 'a', state: 'untracked' }))).toBe('off');
    expect(checkOf(e({ path: 'd', state: 'untracked', dir: true }))).toBe('off');
    expect(checkOf(e({ path: 'a', state: 'conflicted', staged: true, unstaged: true }))).toBeNull();
    expect(checkOf(e({ path: 'a', state: 'ignored' }))).toBeNull();
    expect([ariaChecked('on'), ariaChecked('off'), ariaChecked('mixed')]).toEqual(['true', 'false', 'mixed']);
  });

  it('a click: partly staged goes in whole; unticking a rename takes its old name back too', () => {
    expect([wantOf('off'), wantOf('mixed'), wantOf('on')]).toEqual([true, true, false]);
    const r = e({ path: 'new.md', state: 'renamed', from: 'old.md', staged: true });
    expect(togglePaths(r, false)).toEqual(['new.md', 'old.md']);
    expect(togglePaths(r, true)).toEqual(['new.md']);
    expect(togglePaths(e({ path: 'x', state: 'renamed', from: null, staged: true }), false)).toEqual(['x']);
  });

  it('header box and the selection count', () => {
    expect(allOf([])).toBe('off');
    expect(allOf(['on', 'on'])).toBe('on');
    expect(allOf(['off', 'off'])).toBe('off');
    expect(allOf(['on', 'off'])).toBe('mixed');
    expect(allOf(['mixed', 'mixed'])).toBe('mixed');
    expect(selectedCount(['on', 'mixed', 'off'])).toBe(2);
  });
});

describe('StageBatcher', () => {
  function fake(ok = true) {
    const calls: Array<{ stage: string[]; unstage: string[] }> = [];
    let release: (() => void) | null = null;
    let hold = false;
    const run = async (stage: string[], unstage: string[]) => {
      calls.push({ stage, unstage });
      if (hold) await new Promise<void>((r) => (release = r));
      return ok;
    };
    return {
      calls,
      run,
      hold: () => (hold = true),
      release: () => {
        hold = false;
        release?.();
      },
    };
  }

  it('rapid clicks become one call; the boxes flip at once and settle afterwards', async () => {
    const f = fake();
    const b = new StageBatcher(f.run, 20);
    b.request([{ path: 'a', want: true }]);
    b.request([{ path: 'b', want: true }]);
    b.request([{ path: 'c', want: false, paths: ['c', 'old-c'] }]);
    expect([...b.pending.value]).toEqual([
      ['a', true],
      ['b', true],
      ['c', false],
    ]);
    expect(f.calls).toHaveLength(0);
    await tick(40);
    expect(f.calls).toEqual([{ stage: ['a', 'b'], unstage: ['c', 'old-c'] }]);
    expect(b.pending.value.size).toBe(0);
    expect(b.idle).toBe(true);
  });

  it('a click toggled back before the call: the last wish wins (one entry per path)', async () => {
    const f = fake();
    const b = new StageBatcher(f.run, 20);
    b.request([{ path: 'a', want: true }]);
    b.request([{ path: 'a', want: false }]);
    await b.drain();
    expect(f.calls).toEqual([{ stage: [], unstage: ['a'] }]);
  });

  it('clicks while git runs go into ONE follow-up call; their boxes stay flipped meanwhile', async () => {
    const f = fake();
    const b = new StageBatcher(f.run, 5);
    f.hold();
    b.request([{ path: 'a', want: true }]);
    await tick(20);
    expect(f.calls).toHaveLength(1);
    for (const p of ['b', 'c', 'd']) b.request([{ path: p, want: true }]);
    b.request([{ path: 'a', want: false }]); // clicked again while its first call runs
    f.release();
    f.hold(); // keep the follow-up running to look at the boxes meanwhile
    await tick(5);
    expect(f.calls).toHaveLength(2);
    expect(b.pending.value.get('a')).toBe(false); // not dropped by the first call settling
    expect(b.pending.value.get('d')).toBe(true);
    f.release();
    await b.drain();
    expect(f.calls).toEqual([
      { stage: ['a'], unstage: [] },
      { stage: ['b', 'c', 'd'], unstage: ['a'] },
    ]);
    expect(b.pending.value.size).toBe(0);
  });

  it('drain() sends at once and waits (commit right after a click)', async () => {
    const f = fake();
    const b = new StageBatcher(f.run, 10_000);
    b.request([{ path: 'a', want: true }]);
    await b.drain();
    expect(f.calls).toHaveLength(1);
  });

  it('git refused: the optimistic boxes go back (the status never changed)', async () => {
    const f = fake(false);
    const b = new StageBatcher(f.run, 1);
    b.request([{ path: 'a', want: true }]);
    await b.drain();
    expect(b.pending.value.size).toBe(0);
    const t = new StageBatcher(async () => {
      throw new Error('rpc down');
    }, 1);
    t.request([{ path: 'a', want: true }]);
    await t.drain();
    expect(t.pending.value.size).toBe(0);
  });
});
