// Bookmarks model (src/shared/bookmarks.ts): the path rule (one table row per attack), list cleaning, the ops
// (add / remove / reorder / label / rename-follow) and the watcher heuristic for renames made outside One.
import { describe, it, expect } from 'vitest';
import { applyOp, cleanList, cleanOp, cleanPath, fsMoves, MAX_BOOKMARKS, type Bookmark } from '../../../src/shared/bookmarks';

const paths = (l: Bookmark[]) => l.map((b) => b.path);
const list = (...ps: string[]): Bookmark[] => ps.map((path) => ({ path }));

describe('cleanPath: workspace-relative POSIX only', () => {
  const refused: Array<[string, unknown]> = [
    ['empty', ''],
    ['not a string', 42],
    ['absolute POSIX', '/etc/passwd'],
    ['parent segment', '../outside.md'],
    ['parent inside', 'notes/../../x.md'],
    ['dot segment', 'notes/./a.md'],
    ['empty segment', 'notes//a.md'],
    ['trailing slash', 'notes/'],
    ['backslash', 'notes\\a.md'],
    ['drive letter', 'C:/Windows/win.ini'],
    ['drive relative', 'c:notes'],
    ['UNC', '\\\\server\\share\\a.md'],
    ['NUL', 'a\u0000.md'],
    ['newline', 'a\n.md'],
    ['DEL', 'a\u007f.md'],
    ['too long', 'a/'.repeat(600) + 'b'],
  ];
  for (const [name, p] of refused) it(`refuses ${name}`, () => expect(cleanPath(p)).toBeNull());
  it('keeps ordinary paths as spelled', () => {
    for (const p of ['README.md', 'notes/Daily notes.md', 'deep/a/b/c', '.hidden/x.md', 'ünï/çödé.md', 'a..b.md']) expect(cleanPath(p)).toBe(p);
  });
});

describe('cleanList', () => {
  it('keeps valid entries, first one wins, labels trimmed and capped, junk dropped', () => {
    const l = cleanList([{ path: 'a.md', label: '  Work  ' }, { path: 'a.md' }, { path: '../x' }, null, 'b.md', { path: 'b.md', label: '\u0000\n' }, { path: 'c', label: 'x'.repeat(500) }]);
    expect(l).toEqual([{ path: 'a.md', label: 'Work' }, { path: 'b.md' }, { path: 'c', label: 'x'.repeat(120) }]);
    expect(cleanList({ items: [] })).toEqual([]);
    expect(cleanList(Array.from({ length: MAX_BOOKMARKS + 20 }, (_, i) => ({ path: `n${i}.md` })))).toHaveLength(MAX_BOOKMARKS);
  });
});

describe('cleanOp (what a page may send)', () => {
  it('accepts the known shapes', () => {
    expect(cleanOp({ op: 'add', paths: ['a.md'], before: 'b.md' })).toEqual({ op: 'add', paths: ['a.md'], before: 'b.md' });
    expect(cleanOp({ op: 'remove', paths: ['a.md'], extra: 1 })).toEqual({ op: 'remove', paths: ['a.md'] });
    expect(cleanOp({ op: 'move', paths: ['a.md'] })).toEqual({ op: 'move', paths: ['a.md'] });
    expect(cleanOp({ op: 'label', path: 'a.md', label: '' })).toEqual({ op: 'label', path: 'a.md', label: '' });
    expect(cleanOp({ op: 'rename', from: 'a', to: 'b/a' })).toEqual({ op: 'rename', from: 'a', to: 'b/a' });
  });
  it('refuses anything else, and any bad path in it', () => {
    for (const bad of [null, 'add', { op: 'drop' }, { op: 'add' }, { op: 'add', paths: 'a.md' }, { op: 'add', paths: ['a.md', '../b'] }, { op: 'add', paths: ['a.md'], before: '/x' }, { op: 'label', path: 'a.md' }, { op: 'label', path: 'C:/x', label: 'y' }, { op: 'rename', from: 'a', to: '..' }, { op: 'add', paths: Array(1001).fill('a.md') }]) {
      expect(cleanOp(bad), JSON.stringify(bad)?.slice(0, 60)).toBeNull();
    }
  });
});

describe('applyOp', () => {
  const base = list('a.md', 'b.md', 'c.md', 'd.md');
  it('add: at the end or in front of a bookmark; known ones are not added twice', () => {
    expect(paths(applyOp(base, { op: 'add', paths: ['x.md'] }))).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'x.md']);
    expect(paths(applyOp(base, { op: 'add', paths: ['x.md', 'y.md', 'x.md', 'a.md'], before: 'b.md' }))).toEqual(['a.md', 'x.md', 'y.md', 'b.md', 'c.md', 'd.md']);
    expect(paths(applyOp(base, { op: 'add', paths: ['x.md'], before: 'gone.md' }))).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'x.md']);
  });
  it('remove', () => {
    expect(paths(applyOp(base, { op: 'remove', paths: ['b.md', 'zz'] }))).toEqual(['a.md', 'c.md', 'd.md']);
  });
  it('move (reorder): in front of a bookmark, to the end, several keep their order', () => {
    expect(paths(applyOp(base, { op: 'move', paths: ['d.md'], before: 'a.md' }))).toEqual(['d.md', 'a.md', 'b.md', 'c.md']);
    expect(paths(applyOp(base, { op: 'move', paths: ['a.md'] }))).toEqual(['b.md', 'c.md', 'd.md', 'a.md']);
    expect(paths(applyOp(base, { op: 'move', paths: ['d.md', 'a.md'], before: 'c.md' }))).toEqual(['b.md', 'a.md', 'd.md', 'c.md']);
    // In front of itself: in front of the next unmoved one (no change).
    expect(paths(applyOp(base, { op: 'move', paths: ['b.md'], before: 'b.md' }))).toEqual(paths(base));
    expect(paths(applyOp(base, { op: 'move', paths: ['zz'], before: 'a.md' }))).toEqual(paths(base));
  });
  it('label: sets, trims, clears with an empty name; the path never changes', () => {
    const l = applyOp(base, { op: 'label', path: 'b.md', label: '  Inbox ' });
    expect(l[1]).toEqual({ path: 'b.md', label: 'Inbox' });
    expect(applyOp(l, { op: 'label', path: 'b.md', label: '   ' })[1]).toEqual({ path: 'b.md' });
  });
  it('rename: the file, a folder and everything bookmarked inside it follow; labels stay', () => {
    const l: Bookmark[] = [{ path: 'notes', label: 'N' }, { path: 'notes/a.md' }, { path: 'notes-x/b.md' }, { path: 'other.md' }];
    expect(applyOp(l, { op: 'rename', from: 'notes', to: 'archive/notes' })).toEqual([{ path: 'archive/notes', label: 'N' }, { path: 'archive/notes/a.md' }, { path: 'notes-x/b.md' }, { path: 'other.md' }]);
    expect(paths(applyOp(l, { op: 'rename', from: 'other.md', to: 'Other.md' }))).toEqual(['notes', 'notes/a.md', 'notes-x/b.md', 'Other.md']);
    expect(applyOp(l, { op: 'rename', from: 'nothing', to: 'x' })).toBe(l);
    // Moved onto something already bookmarked: one entry is left.
    expect(paths(applyOp(list('a.md', 'b.md'), { op: 'rename', from: 'b.md', to: 'a.md' }))).toEqual(['a.md']);
  });
});

describe('fsMoves: renames made outside One (unlink + add in one watcher batch)', () => {
  const ev = (type: string, path: string) => ({ type, path });
  it('a file moved to another folder (same name)', () => {
    expect(fsMoves(['notes/a.md'], [ev('unlink', 'notes/a.md'), ev('add', 'archive/a.md')])).toEqual([{ from: 'notes/a.md', to: 'archive/a.md' }]);
  });
  it('a file renamed in its folder (also a case-only rename)', () => {
    expect(fsMoves(['notes/a.md'], [ev('unlink', 'notes/a.md'), ev('add', 'notes/b.md')])).toEqual([{ from: 'notes/a.md', to: 'notes/b.md' }]);
    expect(fsMoves(['Note.md'], [ev('unlink', 'Note.md'), ev('add', 'note.md')])).toEqual([{ from: 'Note.md', to: 'note.md' }]);
  });
  it('a renamed folder carries the bookmarks inside it', () => {
    const batch = [ev('unlinkDir', 'notes'), ev('addDir', 'journal'), ev('add', 'journal/a.md'), ev('addDir', 'journal/sub')];
    expect(fsMoves(['notes', 'notes/a.md', 'notes/sub/x.md'], batch)).toEqual([{ from: 'notes', to: 'journal' }]);
    expect(fsMoves(['notes/a.md'], batch)).toEqual([{ from: 'notes', to: 'journal' }]);
  });
  it('no guess when it is not clear, or the file is still there', () => {
    expect(fsMoves(['a.md'], [ev('unlink', 'a.md')])).toEqual([]); // deleted
    expect(fsMoves(['a.md'], [ev('unlink', 'a.md'), ev('add', 'b.md'), ev('add', 'c.md')])).toEqual([]); // two candidates
    expect(fsMoves(['a.md', 'b.md'], [ev('unlink', 'a.md'), ev('unlink', 'b.md'), ev('add', 'c.md')])).toEqual([]); // two gone
    expect(fsMoves(['a.md'], [ev('unlink', 'a.md'), ev('add', 'a.md'), ev('add', 'a.md.tmp')])).toEqual([]); // atomic save
    expect(fsMoves(['a.md'], [ev('unlink', 'a.md'), ev('addDir', 'b')])).toEqual([]); // another kind
    expect(fsMoves(['x.md'], [ev('unlink', 'a.md'), ev('add', 'b.md')])).toEqual([]); // not bookmarked
  });
});
