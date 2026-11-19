import { describe, it, expect } from 'vitest';
import type { TreeNode } from '../../../src/shared/api';
import { findNode, flattenTree, moveNode, removeNode, insertNode, filesUnder, ancestors } from '../../../src/renderer/app/tree-model';
import { applyFsEvents } from '../../../src/renderer/app/disk-sync';

const tree = (): TreeNode => ({
  name: 'root',
  path: '',
  kind: 'dir',
  children: [
    { name: 'notes', path: 'notes', kind: 'dir', children: [{ name: 'a.md', path: 'notes/a.md', kind: 'file' }, { name: 'b10.md', path: 'notes/b10.md', kind: 'file' }] },
    { name: 'README.md', path: 'README.md', kind: 'file' },
  ],
});

describe('tree model', () => {
  it('inserts in natural order (dirs first) without touching unrelated nodes', () => {
    const t = tree();
    const t2 = insertNode(t, { name: 'b9.md', path: 'notes/b9.md', kind: 'file' });
    expect(findNode(t2, 'notes')!.children!.map((c) => c.name)).toEqual(['a.md', 'b9.md', 'b10.md']);
    expect(t2.children![1]).toBe(t.children![1]); // README untouched (structural sharing)
    expect(t.children![0].children!.length).toBe(2); // original not mutated
  });

  it('creates missing parent folders on insert', () => {
    const t = insertNode(tree(), { name: 'x.md', path: 'new/deep/x.md', kind: 'file' });
    expect(findNode(t, 'new/deep/x.md')?.kind).toBe('file');
    expect(t.children![0].name).toBe('new'); // dirs sort first
  });

  it('applies watcher events and returns the same object when nothing changes', () => {
    const t = tree();
    expect(applyFsEvents(t, [{ type: 'change', path: 'notes/a.md' }])).toBe(t);
    const t2 = applyFsEvents(t, [
      { type: 'addDir', path: 'pack' },
      { type: 'add', path: 'pack/one.md' },
      { type: 'unlink', path: 'README.md' },
      { type: 'unlinkDir', path: 'notes' },
    ]);
    expect(t2.children!.map((c) => c.path)).toEqual(['pack']);
    expect(findNode(t2, 'pack/one.md')).toBeTruthy();
    expect(applyFsEvents(t2, [{ type: 'add', path: 'pack/one.md' }])).toBe(t2); // idempotent
  });

  it('moves subtrees, re-pathing children', () => {
    const t = moveNode(tree(), 'notes', 'archive/notes');
    expect(findNode(t, 'archive/notes/a.md')?.path).toBe('archive/notes/a.md');
    expect(findNode(t, 'notes')).toBeNull();
    expect(removeNode(t, 'does/not/exist')).toBe(t);
  });

  it('flattens visible rows; filter shows matches with ancestors expanded', () => {
    const t = tree();
    expect(flattenTree(t, new Set()).map((r) => r.node.path)).toEqual(['notes', 'README.md']);
    expect(flattenTree(t, new Set(['notes'])).map((r) => r.node.path)).toEqual(['notes', 'notes/a.md', 'notes/b10.md', 'README.md']);
    expect(flattenTree(t, new Set(), 'B10').map((r) => r.node.path)).toEqual(['notes', 'notes/b10.md']);
    const withCreate = flattenTree(t, new Set(), '', { parent: 'notes', kind: 'file' });
    expect(withCreate[1].create).toBe('file'); // input row is the folder's first child, folder auto-expanded
  });

  it('helpers', () => {
    expect(filesUnder(findNode(tree(), 'notes'))).toEqual(['notes/a.md', 'notes/b10.md']);
    expect(ancestors('a/b/c.md')).toEqual(['a', 'a/b']);
  });
});
