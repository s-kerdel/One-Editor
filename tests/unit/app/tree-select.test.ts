// File tree multi-selection: the pure steps (toggle, range, anchor, pruning, top-level paths) and the
// ui.treeMulti contract (it belongs to its focus: moving treeSelection elsewhere drops it).
import { describe, it, expect, beforeEach } from 'vitest';
import * as ui from '../../../src/renderer/app/ui';
import { toggleSel, rangeSel, pruneSel, topLevel, pick, selectAll, prune } from '../../../src/renderer/app/tree-select';

const order = ['notes', 'notes/a.md', 'notes/b.md', 'notes/c.md', 'README.md'];
const one = (p: string): ui.TreeSel => ({ focus: p, anchor: p, paths: new Set([p]) });
const list = (s: ui.TreeSel | null) => (s ? [...s.paths].sort() : null);

describe('selection steps', () => {
  it('toggle flips one row and moves focus + anchor to it', () => {
    const s = toggleSel(one('notes/a.md'), 'notes/c.md');
    expect(list(s)).toEqual(['notes/a.md', 'notes/c.md']);
    expect([s.focus, s.anchor]).toEqual(['notes/c.md', 'notes/c.md']);
    const t = toggleSel(s, 'notes/a.md');
    expect(list(t)).toEqual(['notes/c.md']);
    expect(t.focus).toBe('notes/a.md'); // the focus may be unselected (like Explorer / VS Code)
  });

  it('range runs from the anchor in row order, both directions, and keeps the anchor', () => {
    const down = rangeSel(order, one('notes/a.md'), 'notes/c.md');
    expect(list(down)).toEqual(['notes/a.md', 'notes/b.md', 'notes/c.md']);
    expect([down.focus, down.anchor]).toEqual(['notes/c.md', 'notes/a.md']);
    // Shift again from the same anchor replaces the range (it does not grow from the old focus).
    const up = rangeSel(order, down, 'notes');
    expect(list(up)).toEqual(['notes', 'notes/a.md']);
    expect(up.anchor).toBe('notes/a.md');
  });

  it('Ctrl + Shift adds the range to what is selected', () => {
    const s = toggleSel(one('notes'), 'notes/c.md'); // {notes, c}, anchor c
    const r = rangeSel(order, s, 'README.md', true);
    expect(list(r)).toEqual(['README.md', 'notes', 'notes/c.md']);
  });

  it('a range from a vanished anchor starts over at the clicked row; an unknown row changes nothing', () => {
    const s = { focus: 'gone.md', anchor: 'gone.md', paths: new Set(['gone.md']) };
    const r = rangeSel(order, s, 'notes/b.md');
    expect(list(r)).toEqual(['notes/b.md']);
    expect(r.anchor).toBe('notes/b.md');
    expect(rangeSel(order, s, 'nope.md')).toBe(s);
  });

  it('pruning drops rows that vanished and moves a lost focus / anchor', () => {
    const s = { focus: 'notes/c.md', anchor: 'notes/a.md', paths: new Set(['notes/a.md', 'notes/b.md', 'notes/c.md']) };
    const kept = pruneSel(order, s)!;
    expect(list(kept)).toEqual(list(s)); // nothing vanished: same rows
    // Folder collapsed: its children vanish, so does a focus inside it.
    const collapsed = pruneSel(['notes', 'README.md'], { ...s, paths: new Set([...s.paths, 'README.md']) })!;
    expect(list(collapsed)).toEqual(['README.md']);
    expect([collapsed.focus, collapsed.anchor]).toEqual(['README.md', 'README.md']);
    expect(pruneSel(['README.md'], s)).toBeNull();
  });

  it('top-level paths: a folder covers its children, look-alike names are not children', () => {
    expect(topLevel(['notes/a.md', 'notes', 'notes2/x.md', 'deep/nested/folder/x.md', 'deep'])).toEqual(['notes', 'notes2/x.md', 'deep']);
    expect(topLevel(['a.md', 'b.md'])).toEqual(['a.md', 'b.md']);
  });
});

describe('ui.treeMulti', () => {
  beforeEach(() => ui.setTreeSel(null, null));

  it('Ctrl / Shift picks build on the focused row; a plain move of the focus drops the set', () => {
    ui.treeSelection.value = 'notes/a.md';
    pick(order, 'notes/c.md', false, false); // Ctrl + click
    expect(list(ui.treeMulti.value)).toEqual(['notes/a.md', 'notes/c.md']);
    expect(ui.treeSelection.value).toBe('notes/c.md');
    expect(ui.isTreeSelected('notes/a.md')).toBe(true);
    expect(ui.isTreeSelected('notes/b.md')).toBe(false);
    pick(order, 'README.md', true, false); // Shift + click from anchor c
    expect(list(ui.treeMulti.value)).toEqual(['README.md', 'notes/c.md']);
    // Arrow / reveal / new note: only treeSelection moves, so the set must not come back later either.
    ui.treeSelection.value = 'notes/b.md';
    expect(ui.treeMulti.value).toBeNull();
    ui.treeSelection.value = 'README.md';
    expect(ui.treeMulti.value).toBeNull();
    expect(ui.isTreeSelected('README.md')).toBe(true);
    expect(ui.isTreeSelected('notes/c.md')).toBe(false);
  });

  it('a hidden focus is not part of a new selection', () => {
    ui.treeSelection.value = 'deleted.md';
    pick(order, 'notes/a.md', false, false);
    expect(list(ui.treeMulti.value)).toEqual(['notes/a.md']);
  });

  it('select all keeps the focus; prune writes only when rows left', () => {
    ui.treeSelection.value = 'notes/b.md';
    selectAll(order);
    expect(ui.treeMulti.value?.paths.size).toBe(order.length);
    expect(ui.treeSelection.value).toBe('notes/b.md');
    const before = ui.treeMulti.value;
    prune(order);
    expect(ui.treeMulti.value).toBe(before);
    prune(['notes', 'README.md']); // collapsed: b.md (the focus) vanished
    expect(list(ui.treeMulti.value)).toEqual(['README.md', 'notes']);
    expect(ui.treeSelection.value).toBe(ui.treeMulti.value!.focus);
    prune([]);
    expect(ui.treeMulti.value).toBeNull();
  });
});
