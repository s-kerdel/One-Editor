import { describe, it, expect } from 'vitest';
import type { TreeNode } from '@shared/api';
import type { GitEntry } from '@shared/git';
import { buildMarks, changesTree, rowClass } from '../../../src/renderer/git/marks';

const entries: GitEntry[] = [
  { path: 'notes/a.md', state: 'modified', staged: true, unstaged: true },
  { path: 'notes/deep/new.md', state: 'untracked' },
  { path: 'notes/gone.md', state: 'deleted', unstaged: true },
  { path: 'renamed.md', state: 'renamed', from: 'old.md', staged: true },
  { path: 'c.md', state: 'conflicted' },
  { path: 'fresh', state: 'untracked', dir: true },
  { path: 'build', state: 'ignored', dir: true },
  { path: 'x.log', state: 'ignored' },
  { path: 'vendor/lib', state: 'modified', submodule: true },
];

describe('buildMarks', () => {
  const m = buildMarks(entries);

  it('file marks with letters and titles', () => {
    expect(m.file('notes/a.md')).toMatchObject({ state: 'modified', letter: 'M', title: 'Modified · partly staged' });
    expect(m.file('renamed.md')).toMatchObject({ letter: 'R', title: 'Renamed from old.md · staged', from: 'old.md' });
    expect(m.file('c.md')).toMatchObject({ letter: '!', title: 'Merge conflict' });
    expect(m.file('x.log')).toMatchObject({ state: 'ignored', letter: '' });
    expect(m.file('clean.md')).toBeNull();
  });

  it('inherits from untracked / ignored folders', () => {
    expect(m.file('fresh/a/b.md')).toMatchObject({ state: 'untracked', letter: 'U' });
    expect(m.file('build/out/x.js')).toMatchObject({ state: 'ignored' });
    expect(m.dir('build/out')).toMatchObject({ own: { state: 'ignored' } });
    expect(m.file('freshly.md')).toBeNull(); // prefix match must respect path segments
  });

  it('folder roll-up: count + most important state, ignored excluded', () => {
    expect(m.dir('notes')).toMatchObject({ count: 3, worst: 'modified' });
    expect(m.dir('notes/deep')).toMatchObject({ count: 1, worst: 'untracked' });
    expect(m.dir('')).toMatchObject({ count: 7, worst: 'conflicted' });
    expect(m.dir('fresh')).toMatchObject({ own: { state: 'untracked' } });
    expect(m.dir('vendor/lib')).toMatchObject({ own: { state: 'modified', submodule: true } });
    expect(m.dir('clean')).toBeNull();
  });

  it('lists changed and deleted paths', () => {
    expect(m.count).toBe(7);
    expect(m.deleted).toEqual(['notes/gone.md']);
    expect(m.changed).not.toContain('build');
  });

  it('case-insensitive lookups when asked', () => {
    const f = buildMarks([{ path: 'Notes/A.md', state: 'modified' }], { foldCase: true });
    expect(f.file('notes/a.md')?.state).toBe('modified');
    expect(f.dir('NOTES')?.count).toBe(1);
    expect(buildMarks([{ path: 'Notes/A.md', state: 'modified' }]).file('notes/a.md')).toBeNull();
  });

  it('row classes', () => {
    expect(rowClass(m, 'notes/a.md', false)).toBe(' se-git-modified');
    expect(rowClass(m, 'notes', true)).toBe(' se-git-has-changes');
    expect(rowClass(m, 'build', true)).toBe(' se-git-ignored');
    expect(rowClass(m, 'fresh', true)).toBe(' se-git-untracked');
    expect(rowClass(m, 'other', true)).toBe('');
    expect(rowClass(m, 'other.md', false)).toBe('');
  });
});

describe('changesTree', () => {
  const f = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, kind: 'file' });
  const d = (path: string, children: TreeNode[]): TreeNode => ({ name: path.split('/').pop()!, path, kind: 'dir', children });
  const tree = d('', [
    d('notes', [d('notes/deep', [f('notes/deep/new.md')]), f('notes/a.md'), f('notes/clean.md')]),
    d('fresh', [d('fresh/sub', [f('fresh/sub/x.md')])]),
    d('build', [f('build/out.js')]),
    d('clean', [f('clean/k.md')]),
    d('vendor', [d('vendor/lib', [f('vendor/lib/inside.md')])]),
    f('renamed.md'),
    f('x.log'),
    f('readme.md'),
  ]);

  it('keeps only changed files and the folders around them', () => {
    const { tree: t, dirs } = changesTree(tree, buildMarks(entries));
    const paths: string[] = [];
    const walk = (n: TreeNode) => (paths.push(n.path), n.children?.forEach(walk));
    t.children!.forEach(walk);
    expect(paths).toEqual(['notes', 'notes/deep', 'notes/deep/new.md', 'notes/a.md', 'fresh', 'fresh/sub', 'fresh/sub/x.md', 'vendor', 'vendor/lib', 'vendor/lib/inside.md', 'renamed.md']);
    expect([...dirs].sort()).toEqual(['fresh', 'fresh/sub', 'notes', 'notes/deep', 'vendor']); // submodule stays collapsed
  });
});
