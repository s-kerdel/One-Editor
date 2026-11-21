// Navigation history: stack semantics, coalescing, cap, forward-clear, rename / delete handling, session.
import { describe, expect, it } from 'vitest';
import { NavHistory } from '../../../src/renderer/nav/history';

const paths = (h: NavHistory) => h.entries.map((e) => (e.page ? `${e.path}#${e.page}` : e.line === undefined ? e.path : `${e.path}:${e.line}`));
/** Visits far enough apart in time that nothing coalesces. */
function walker(h: NavHistory) {
  let now = 0;
  return (path: string, line?: number, o: { edit?: boolean; force?: boolean; page?: number; dt?: number } = {}) => {
    now += o.dt ?? 1000;
    return h.visit({ path, line, col: 0, page: o.page }, { now, edit: o.edit, force: o.force });
  };
}

describe('NavHistory', () => {
  it('pushes on a file switch and steps back / forward', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 3);
    go('b.md', 0);
    go('c.md', 7);
    expect(paths(h)).toEqual(['a.md:3', 'b.md:0', 'c.md:7']);
    expect(h.canForward).toBe(false);
    expect(h.step(-1)?.path).toBe('b.md');
    expect(h.step(-1)).toMatchObject({ path: 'a.md', line: 3 });
    expect(h.step(-1)).toBeNull();
    expect(h.canBack).toBe(false);
    expect(h.step(1)?.path).toBe('b.md');
    expect(h.step(1)?.path).toBe('c.md');
    expect(h.step(1)).toBeNull();
  });

  it('small moves and typing update the current entry; only a big non-typing jump pushes', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 0);
    expect(go('a.md', 4)).toBe(false);
    expect(go('a.md', 10)).toBe(false); // 6 lines from the entry, which followed to line 4
    expect(paths(h)).toEqual(['a.md:10']);
    expect(go('a.md', 500, { edit: true })).toBe(false); // undo / paste far away: still an edit
    expect(paths(h)).toEqual(['a.md:500']);
    expect(go('a.md', 489)).toBe(true); // 11 lines
    expect(go('a.md', 479)).toBe(false); // exactly 10: not a jump
    expect(paths(h)).toEqual(['a.md:500', 'a.md:479']);
  });

  it('keeps the scroll position of an entry when the cursor moves without one', () => {
    const h = new NavHistory();
    h.visit({ path: 'a.md', line: 5, col: 0 }, { now: 0 });
    h.patch('a.md', { top: 2 });
    h.patch('other.md', { top: 99 });
    h.visit({ path: 'a.md', line: 6, col: 3 }, { now: 1 });
    expect(h.current).toEqual({ path: 'a.md', line: 6, col: 3, top: 2 });
  });

  it('coalesces a rapid run of jumps into one entry, keeping where the run started', () => {
    const h = new NavHistory({ coalesceMs: 350 });
    const go = walker(h);
    go('a.md', 0);
    expect(go('a.md', 50)).toBe(true);
    for (let l = 100; l <= 400; l += 50) go('a.md', l, { dt: 100 }); // held PgDn
    expect(paths(h)).toEqual(['a.md:0', 'a.md:400']);
    go('a.md', 800, { dt: 351 });
    expect(paths(h)).toEqual(['a.md:0', 'a.md:400', 'a.md:800']);
  });

  it('opening a file at a line is one entry (file switch + reveal), not two', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 2);
    go('b.md', 0);
    go('b.md', 120, { dt: 16 });
    expect(paths(h)).toEqual(['a.md:2', 'b.md:120']);
  });

  it('a jump right after stepping back is a new entry, not part of the old run', () => {
    const h = new NavHistory();
    h.visit({ path: 'a.md', line: 0 }, { now: 0 });
    h.visit({ path: 'b.md', line: 0 }, { now: 10 });
    h.step(-1);
    h.visit({ path: 'a.md', line: 90 }, { now: 20 });
    expect(paths(h)).toEqual(['a.md:0', 'a.md:90']);
  });

  it('a new navigation clears the forward entries (a coalesced one too)', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 0);
    go('b.md', 0);
    go('c.md', 0);
    h.step(-1);
    h.step(-1);
    expect(h.canForward).toBe(true);
    go('d.md', 0);
    expect(paths(h)).toEqual(['a.md:0', 'd.md:0']);
    expect(h.canForward).toBe(false);
    // small moves never clear it
    go('e.md', 0);
    h.step(-1);
    go('d.md', 3);
    expect(h.canForward).toBe(true);
  });

  it('caps the stack, dropping the oldest', () => {
    const h = new NavHistory({ cap: 100 });
    const go = walker(h);
    for (let i = 0; i < 130; i++) go(`n${i}.md`, 0);
    expect(h.entries).toHaveLength(100);
    expect(h.entries[0].path).toBe('n30.md');
    expect(h.current?.path).toBe('n129.md');
    expect(h.index).toBe(99);
  });

  it('a marked navigation pushes however short; an edit never does', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 10);
    expect(go('a.md', 12, { force: true })).toBe(true);
    expect(go('a.md', 12, { force: true })).toBe(false); // same place
    expect(go('a.md', 13, { force: true, edit: true })).toBe(false);
    expect(paths(h)).toEqual(['a.md:10', 'a.md:13']);
  });

  it('PDF pages: scrolling follows, a marked page change pushes, no page = page 1', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 0);
    go('doc.pdf');
    expect(go('doc.pdf', undefined, { page: 2 })).toBe(false);
    expect(go('doc.pdf', undefined, { page: 9 })).toBe(false); // unmarked: scrolling
    expect(paths(h)).toEqual(['a.md:0', 'doc.pdf#9']);
    expect(go('doc.pdf', undefined, { page: 3, force: true })).toBe(true);
    expect(paths(h)).toEqual(['a.md:0', 'doc.pdf#9', 'doc.pdf#3']);
    const g = new NavHistory();
    g.visit({ path: 'doc.pdf' }, { now: 0 });
    expect(g.visit({ path: 'doc.pdf', page: 1 }, { now: 5000, force: true })).toBe(false);
    expect(g.entries).toHaveLength(1);
  });

  it('skips entries of deleted files and never lands on the place it is already at', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 1);
    go('gone.md', 0);
    go('b.md', 0);
    go('gone.md', 5);
    go('a.md', 1);
    go('c.md', 0);
    const exists = (p: string) => p !== 'gone.md';
    expect(h.step(-1, exists)?.path).toBe('a.md');
    expect(h.step(-1, exists)?.path).toBe('b.md'); // gone.md:5 dropped
    expect(paths(h)).toEqual(['a.md:1', 'gone.md:0', 'b.md:0', 'a.md:1', 'c.md:0']);
    expect(h.step(-1, exists)?.path).toBe('a.md');
    expect(paths(h)).toEqual(['a.md:1', 'b.md:0', 'a.md:1', 'c.md:0']);
    expect(h.index).toBe(0);
    expect(h.step(-1, exists)).toBeNull();
    // forward, with b.md deleted too: a.md:1 → (b.md gone, a.md:1 is where we are) → c.md
    const exists2 = (p: string) => p !== 'b.md';
    expect(h.step(1, exists2)?.path).toBe('c.md');
    expect(paths(h)).toEqual(['a.md:1', 'c.md:0']);
    expect(h.index).toBe(1);
  });

  it('returns null and stays put when everything behind is gone', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('x.md', 0);
    go('y.md', 0);
    go('a.md', 0);
    expect(h.step(-1, (p) => p === 'a.md')).toBeNull();
    expect(paths(h)).toEqual(['a.md:0']);
    expect(h.current?.path).toBe('a.md');
  });

  it('dropCurrent forgets an entry that could not be opened and stands where it came from', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 0);
    go('b.md', 0);
    go('c.md', 0);
    h.step(-1);
    h.dropCurrent(-1);
    expect(paths(h)).toEqual(['a.md:0', 'c.md:0']);
    expect(h.current?.path).toBe('c.md');
    h.step(-1);
    h.step(1);
    h.dropCurrent(1);
    expect(paths(h)).toEqual(['a.md:0']);
    expect(h.current?.path).toBe('a.md');
  });

  it('follows renames and folder moves', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('notes/a.md', 4);
    go('notes/sub/b.md', 0);
    go('notes-old/c.md', 0);
    h.rename('notes/a.md', 'notes/z.md');
    h.rename('notes', 'archive');
    expect(paths(h)).toEqual(['archive/z.md:4', 'archive/sub/b.md:0', 'notes-old/c.md:0']);
  });

  it('snapshot keeps at most 50 entries around the current one; restore validates', () => {
    const h = new NavHistory();
    const go = walker(h);
    for (let i = 0; i < 80; i++) go(`n${i}.md`, i);
    for (let i = 0; i < 60; i++) h.step(-1);
    const s = h.snapshot(50);
    expect(s.entries).toHaveLength(50);
    expect(s.entries[s.index].path).toBe('n19.md');
    const g = new NavHistory();
    g.restore(JSON.parse(JSON.stringify(s)));
    expect(g.current).toMatchObject({ path: 'n19.md', line: 19 });
    expect(g.canBack && g.canForward).toBe(true);
    const tail = new NavHistory();
    for (let i = 0; i < 80; i++) tail.visit({ path: `n${i}.md` }, { now: i * 1000 });
    expect(tail.snapshot(50).entries.at(-1)?.path).toBe('n79.md');
    expect(tail.snapshot(50).index).toBe(49);

    const bad = new NavHistory();
    bad.restore('nope');
    bad.restore({ entries: [null, { path: 5 }, { path: '' }] });
    expect(bad.entries).toEqual([]);
    bad.restore({ entries: [{ path: 'a.md', line: -4, top: 'x', page: 2.7 }, { path: 'b.md' }], index: 99 });
    expect(bad.entries[0]).toEqual({ path: 'a.md', line: undefined, col: undefined, top: undefined, page: 2 });
    expect(bad.index).toBe(1);
  });

  it('places(): what the buttons offer — nearest first, gone files and repeats left out, nothing moves', () => {
    const h = new NavHistory();
    const go = walker(h);
    go('a.md', 3);
    go('b.md', 0);
    go('a.md', 3); // the same spot as the first entry: listed once
    go('a.md', 200);
    go('c.ts', 9);
    go('d.md', 0);
    for (let i = 0; i < 3; i++) h.step(-1); // at a.md:3 (the second one)
    const at = () => `${h.current?.path}:${h.current?.line}`;
    expect(at()).toBe('a.md:3');
    const list = (dir: 1 | -1, max = 10, exists?: (p: string) => boolean) => h.places(dir, max, exists).map((e) => `${e.path}:${e.line}`);
    expect(list(-1)).toEqual(['b.md:0', 'a.md:3']);
    expect(list(1)).toEqual(['a.md:200', 'c.ts:9', 'd.md:0']);
    expect(list(1, 2)).toEqual(['a.md:200', 'c.ts:9']);
    expect(list(1, 10, (p) => p !== 'c.ts')).toEqual(['a.md:200', 'd.md:0']);
    expect(at()).toBe('a.md:3');
    // [0] is exactly where one step goes
    expect(h.places(-1, 1)[0]).toBe(h.entries[h.index - 1]);
  });

  it('button state: greyed out at either end, live as the stack changes (= places(dir, 1) is empty)', () => {
    const h = new NavHistory();
    const go = walker(h);
    const state = (exists?: (p: string) => boolean) => ({ back: h.places(-1, 1, exists).length > 0, forward: h.places(1, 1, exists).length > 0 });
    expect(state()).toEqual({ back: false, forward: false }); // empty
    go('a.md', 0);
    expect(state()).toEqual({ back: false, forward: false }); // one place: nowhere to go
    go('b.md', 0);
    expect(state()).toEqual({ back: true, forward: false });
    h.step(-1);
    expect(state()).toEqual({ back: false, forward: true });
    h.step(1);
    expect(state()).toEqual({ back: true, forward: false });
    expect(state((p) => p !== 'a.md')).toEqual({ back: false, forward: false }); // the only place back was deleted
    h.step(-1);
    go('c.md', 0); // a new navigation drops the forward entries
    expect(state()).toEqual({ back: true, forward: false });
    h.clear();
    expect(state()).toEqual({ back: false, forward: false });
  });

  it('goTo jumps straight to a listed place and keeps the ones in between; forget undoes a failed jump', () => {
    const h = new NavHistory();
    const go = walker(h);
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) go(p, 0);
    const [, , a] = h.places(-1, 10);
    expect(a.path).toBe('a.md');
    expect(h.goTo(a)).toBe(true);
    expect(h.current?.path).toBe('a.md');
    expect(h.places(1, 10).map((e) => e.path)).toEqual(['b.md', 'c.md', 'd.md']);
    expect(h.places(-1, 10)).toEqual([]);
    // A jump is a fresh start: the next navigation pushes (it is never coalesced into an old run).
    h.visit({ path: 'a.md', line: 90 }, { now: 4000.1 });
    expect(paths(h)).toEqual(['a.md:0', 'a.md:90']);

    const g = new NavHistory();
    const go2 = walker(g);
    for (const p of ['a.md', 'b.md', 'c.md', 'd.md']) go2(p, 0);
    const from = g.current;
    const b = g.places(-1, 10)[1];
    g.goTo(b);
    g.forget(b, from); // b.md could not be opened
    expect(paths(g)).toEqual(['a.md:0', 'c.md:0', 'd.md:0']);
    expect(g.current?.path).toBe('d.md');
    expect(g.goTo(b)).toBe(false); // no longer in the history (a stale menu row)
    expect(g.current?.path).toBe('d.md');
  });

  it('clear empties everything', () => {
    const h = new NavHistory();
    h.visit({ path: 'a.md' }, { now: 0 });
    h.clear();
    expect(h.current).toBeNull();
    expect(h.step(-1)).toBeNull();
  });
});
