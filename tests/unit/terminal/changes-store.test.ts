// "AI changes" store: whatever main sends is checked field by field; a terminal's list is replaced, not merged;
// one list per agent terminal; turns fold; "reviewed" and "Clear" hold until a row changes.
import { describe, it, expect, beforeEach } from 'vitest';
import { applyChanges, changes, clearChanges, foldAll, foldTurn, groupByTurn, isReviewed, lists, markEnded, MAX_LISTS, pickList, reduceChanges, reduceClear, reduceEnded, reduceFold, reduceFoldAll, reduceReviewed, setReviewed, totals, type AgentChanges } from '../../../src/renderer/terminal/changes/store';

const row = (path: string, turn = 1, o: object = {}) => ({ path, status: 'modified', additions: 2, deletions: 1, turn, exact: true, ...o });
const ev = (o: object = {}) => ({ id: 3, agent: 'opencode', busy: true, turns: 2, files: [row('a.ts', 1)], ...o });
const only = (ls: readonly AgentChanges[]) => ls[0];

beforeEach(() => {
  clearChanges('all');
  pickList(null);
});

describe('reducers (pure)', () => {
  it('replaces a terminal\'s list and validates every field', () => {
    let ls = reduceChanges([], ev());
    expect(only(ls)).toMatchObject({ id: 3, agent: 'opencode', busy: true, turns: 2, ended: false, files: [{ path: 'a.ts', additions: 2, deletions: 1, turn: 1, exact: true }] });
    ls = reduceChanges(ls, ev({ files: [] }));
    expect(only(ls).files).toEqual([]);
    for (const bad of [null, 1, 'x', {}, ev({ id: 'x' }), ev({ id: 1.5 }), ev({ agent: 'other' }), ev({ agent: undefined }), ev({ files: 'no' })]) expect(reduceChanges(ls, bad)).toBe(ls);
    ls = reduceChanges(ls, ev({ turns: 2, files: [null, { path: '' }, row('b', 1, { status: 'weird' }), row('c', 1, { additions: -1 }), row('ok', 9), row('ok2', 1, { turn: 'x', exact: 'yes' })] }));
    // A turn past the terminal's count is pulled back; a missing one is "before the first".
    expect(only(ls).files).toEqual([
      { path: 'ok', status: 'modified', additions: 2, deletions: 1, turn: 2, exact: true },
      { path: 'ok2', status: 'modified', additions: 2, deletions: 1, turn: 0, exact: false },
    ]);
    expect(totals(only(ls).files)).toEqual({ additions: 4, deletions: 2 });
  });

  it('both agents, one list per terminal; an ended one is kept until cleared', () => {
    let ls = reduceChanges([], ev({ id: 1, agent: 'claude', turns: 1 }));
    ls = reduceChanges(ls, ev({ id: 2, agent: 'opencode', turns: 1 }));
    expect(ls.map((l) => [l.id, l.agent])).toEqual([[1, 'claude'], [2, 'opencode']]);
    ls = reduceChanges(ls, ev({ id: 1, agent: 'claude', turns: 1, files: [row('x.ts')] }));
    expect(ls.map((l) => l.files[0].path)).toEqual(['x.ts', 'a.ts']); // the other terminal's list is untouched
    expect(reduceEnded(ls, 99)).toBe(ls);
    ls = reduceEnded(ls, 1);
    expect(ls[0]).toMatchObject({ busy: false, ended: true, files: [{ path: 'x.ts' }] });
    expect(reduceClear(ls, 1).map((l) => l.id)).toEqual([2]); // ended: gone altogether
  });

  it('never more than a handful of lists: ended ones go first, then the one prompted longest ago', () => {
    let ls: readonly AgentChanges[] = [];
    for (let i = 1; i <= MAX_LISTS; i++) ls = reduceChanges(ls, ev({ id: i }));
    ls = reduceEnded(ls, 4);
    ls = reduceChanges(ls, ev({ id: 100 }));
    expect(ls.map((l) => l.id)).toEqual([1, 2, 3, 5, 6, 7, 8, 100]);
    ls = reduceChanges(ls, ev({ id: 101 }));
    expect(ls).toHaveLength(MAX_LISTS);
    expect(ls.some((l) => l.id === 1)).toBe(false);
  });

  it('groups by turn, newest first and open; a new turn folds the older ones and forgets hand-made folds', () => {
    let ls = reduceChanges([], ev({ busy: false, turns: 2, files: [row('a.ts', 1), row('b.ts', 2), row('c.ts', 2, { additions: 5, deletions: 0 }), row('old.ts', 0)] }));
    const g = () => groupByTurn(only(ls));
    expect(g().map((x) => [x.turn, x.files.map((f) => f.path), x.additions, x.deletions, x.open, x.live])).toEqual([
      [2, ['b.ts', 'c.ts'], 7, 1, true, false],
      [1, ['a.ts'], 2, 1, false, false],
      [0, ['old.ts'], 2, 1, false, false],
    ]);
    // By hand: open turn 1, close turn 2.
    ls = reduceFold(ls, 3, 1);
    ls = reduceFold(ls, 3, 2);
    expect(g().map((x) => x.open)).toEqual([false, true, false]);
    // An update inside the same turn keeps that.
    ls = reduceChanges(ls, ev({ busy: false, turns: 2, files: [row('a.ts', 1), row('b.ts', 2), row('old.ts', 0)] }));
    expect(g().map((x) => x.open)).toEqual([false, true, false]);
    // Turn 3 starts: it shows at once (no change yet), open; everything older is folded again.
    ls = reduceChanges(ls, ev({ busy: true, turns: 3, files: [row('a.ts', 1), row('b.ts', 2), row('old.ts', 0)] }));
    expect(g().map((x) => [x.turn, x.files.length, x.open, x.live])).toEqual([
      [3, 0, true, true],
      [2, 1, false, false],
      [1, 1, false, false],
      [0, 1, false, false],
    ]);
    // It ends without a change: no empty group stays, the newest turn with changes is the open one.
    ls = reduceChanges(ls, ev({ busy: false, turns: 3, files: [row('a.ts', 1), row('b.ts', 2), row('old.ts', 0)] }));
    expect(g().map((x) => [x.turn, x.open])).toEqual([[2, true], [1, false], [0, false]]);
    ls = reduceFoldAll(ls, 3);
    expect(g().every((x) => x.open)).toBe(true);
    ls = reduceFoldAll(ls, 3, 1);
    expect(g().map((x) => x.open)).toEqual([false, true, false]);
    expect(reduceFold(ls, 3, 77)).toBe(ls); // no such turn
  });

  it('"reviewed" dims a row until the agent changes it again', () => {
    let ls = reduceChanges([], ev({ files: [row('a.ts', 1), row('b.ts', 1)] }));
    ls = reduceReviewed(ls, 3, ['a.ts']);
    expect(only(ls).files.map((f) => isReviewed(only(ls), f))).toEqual([true, false]);
    ls = reduceChanges(ls, ev({ files: [row('a.ts', 1, { exact: false }), row('b.ts', 1)] })); // the same numbers (an estimate became exact or back): still reviewed
    expect(isReviewed(only(ls), only(ls).files[0])).toBe(true);
    ls = reduceChanges(ls, ev({ files: [row('a.ts', 2, { additions: 9 }), row('b.ts', 1)] })); // changed in a later turn
    expect(isReviewed(only(ls), only(ls).files[0])).toBe(false);
    ls = reduceReviewed(ls, 3, ['a.ts', 'b.ts'], true);
    expect(only(ls).files.every((f) => isReviewed(only(ls), f))).toBe(true);
    ls = reduceReviewed(ls, 3, ['a.ts']); // flips
    expect(isReviewed(only(ls), only(ls).files[0])).toBe(false);
    expect(reduceReviewed(ls, 3, ['nope.ts'])).toBe(ls);
  });

  it('"Clear" on a running terminal: the rows go and do not come back with the next update — only what changes since does', () => {
    let ls = reduceChanges([], ev({ files: [row('a.ts', 1), row('b.ts', 1)] }));
    ls = reduceClear(ls, 3);
    expect(only(ls)).toMatchObject({ id: 3, files: [], busy: true });
    ls = reduceChanges(ls, ev({ files: [row('a.ts', 1), row('b.ts', 1), row('c.ts', 2)] })); // main still sends the whole list
    expect(only(ls).files.map((f) => f.path)).toEqual(['c.ts']);
    ls = reduceChanges(ls, ev({ files: [row('a.ts', 2, { additions: 7 }), row('b.ts', 1), row('c.ts', 2)] }));
    expect(only(ls).files.map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
  });
});

describe('signals', () => {
  it('the panel shows the terminal prompted last, or the one the user picked', () => {
    applyChanges(ev({ id: 1, agent: 'claude', busy: false, turns: 1 }));
    applyChanges(ev({ id: 2, agent: 'opencode', busy: false, turns: 1 }));
    expect(changes.value!.id).toBe(2);
    applyChanges(ev({ id: 1, agent: 'claude', busy: false, turns: 1, files: [row('z.ts')] })); // an update alone moves nothing
    expect(changes.value!.id).toBe(2);
    applyChanges(ev({ id: 1, agent: 'claude', busy: true, turns: 2 })); // a new turn there
    expect(changes.value!.id).toBe(1);
    pickList(2);
    applyChanges(ev({ id: 1, agent: 'claude', busy: true, turns: 3 }));
    expect(changes.value!.id).toBe(2);
    markEnded(2);
    expect(changes.value).toMatchObject({ id: 2, ended: true, busy: false });
    clearChanges(); // the shown one (ended): gone, and the pick with it
    expect(lists.value.map((l) => l.id)).toEqual([1]);
    expect(changes.value!.id).toBe(1);
    foldTurn(1, 1, false);
    setReviewed(1, ['a.ts'], true);
    foldAll(1);
    expect(changes.value!.open).toEqual({ 1: true, 3: true }); // the running turn 3 shows too
    clearChanges('all');
    expect(changes.value).toBeNull();
  });
});
