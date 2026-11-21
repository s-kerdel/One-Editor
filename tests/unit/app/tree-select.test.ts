// File tree multi-selection: the pure steps (toggle, range, anchor, pruning, top-level paths) and the
// ui.treeMulti contract (it belongs to its focus: moving treeSelection elsewhere drops it).
import { describe, it, expect, beforeEach } from 'vitest';
import * as ui from '../../../src/renderer/app/ui';
import { toggleSel, rangeSel, pruneSel, topLevel, pick, selectAll, prune, treeKey, type TreeView } from '../../../src/renderer/app/tree-select';

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

// The tree's keys live in the lazy chunk too (FileTree hands them over; keys before it arrives are replayed).
describe('treeKey', () => {
  const node = (path: string, kind: 'file' | 'dir' = 'file') => ({ name: path.split('/').pop()!, path, kind, mtime: 0 });
  const rows = (open: boolean): TreeView['rows'] => [
    { node: node('notes', 'dir'), depth: 0, expanded: open },
    ...(open ? ['notes/a.md', 'notes/b.md', 'notes/c.md'].map((p) => ({ node: node(p), depth: 1, expanded: false })) : []),
    { node: node('README.md'), depth: 0, expanded: false },
  ];
  const toggled: Array<[string, boolean | undefined]> = [];
  const view = (open = true): TreeView => ({ rows: rows(open), page: 2, toggle: (p, o) => void toggled.push([p, o]) });
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods }) as KeyboardEvent;
  beforeEach(() => {
    ui.setTreeSel(null, null);
    toggled.length = 0;
  });

  it('arrows, Home / End and pages move the focused row; Shift extends a range from it', () => {
    ui.treeSelection.value = 'notes/a.md';
    expect(treeKey(key('ArrowDown'), view())).toBe(true);
    expect(ui.treeSelection.value).toBe('notes/b.md');
    treeKey(key('ArrowUp'), view());
    expect(ui.treeSelection.value).toBe('notes/a.md');
    treeKey(key('End'), view());
    expect(ui.treeSelection.value).toBe('README.md');
    treeKey(key('PageUp'), view());
    expect(ui.treeSelection.value).toBe('notes/b.md');
    treeKey(key('Home'), view());
    expect(ui.treeSelection.value).toBe('notes');
    treeKey(key('ArrowDown', { shiftKey: true }), view());
    treeKey(key('ArrowDown', { shiftKey: true }), view());
    expect(list(ui.treeMulti.value)).toEqual(['notes', 'notes/a.md', 'notes/b.md']);
    expect(ui.treeSelection.value).toBe('notes/b.md');
    // Esc goes back to the focused row alone.
    treeKey(key('Escape'), view());
    expect(ui.treeMulti.value).toBeNull();
    expect(ui.treeSelection.value).toBe('notes/b.md');
  });

  it('right opens a folder (then steps in), left closes it or goes to the parent', () => {
    ui.treeSelection.value = 'notes';
    treeKey(key('ArrowRight'), view(false));
    expect(toggled).toEqual([['notes', true]]);
    treeKey(key('ArrowRight'), view(true));
    expect(ui.treeSelection.value).toBe('notes/a.md');
    treeKey(key('ArrowLeft'), view(true));
    expect(ui.treeSelection.value).toBe('notes');
    treeKey(key('ArrowLeft'), view(true));
    expect(toggled).toEqual([['notes', true], ['notes', false]]);
  });

  it('select all (Ctrl / Cmd + A), type-ahead, and keys that are not the tree\'s', () => {
    ui.treeSelection.value = 'notes/a.md';
    const mod = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? { metaKey: true } : { ctrlKey: true };
    treeKey(key('a', mod), view());
    expect(ui.treeMulti.value?.paths.size).toBe(5);
    treeKey(key('r'), view());
    expect(ui.treeSelection.value).toBe('README.md');
    expect(treeKey(key('Tab'), view())).toBe(false);
    expect(treeKey(key('x', { altKey: true }), view())).toBe(false);
  });
});
