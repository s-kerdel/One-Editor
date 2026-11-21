// @vitest-environment happy-dom
// Bookmarks panel + store in the renderer: rows (file, folder, label, missing), a folder's mini tree, and how the
// list follows renames — One's own (file:renamed, the folder root from Popups) and outside ones (watcher batches).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import type { TreeNode } from '../../../src/shared/api';
import { applyOp, type Bookmark, type BookmarkOp } from '../../../src/shared/bookmarks';
import { app } from '../../../src/renderer/app/app';
import { hueOf as shelfHue } from '../../../src/renderer/app/Shelf';

const file = (path: string): TreeNode => ({ name: path.split('/').pop()!, path, kind: 'file', mtime: 1 });
const dir = (path: string, children: TreeNode[]): TreeNode => ({ name: path.split('/').pop()!, path, kind: 'dir', children });
const tree: TreeNode = dir('', [dir('notes', [dir('notes/sub', [file('notes/sub/deep.md')]), file('notes/a.md'), file('notes/b.md')]), file('README.md')]);

let server: Bookmark[] = [];
const sent: BookmarkOp[] = [];
let fsListener: ((e: Array<{ type: string; path: string }>) => void) | null = null;
let m: typeof import('../../../src/renderer/bookmarks/Panel');
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

beforeAll(async () => {
  (app as any).backend = {
    kind: 'web',
    os: 'linux',
    async bookmarks(op?: BookmarkOp) {
      if (op) {
        sent.push(op);
        server = applyOp(server, op);
      }
      return server;
    },
    onFsEvents: (cb: typeof fsListener) => ((fsListener = cb), () => {}),
  };
  app.workspace.value = { root: '/w', name: 'w', caseSensitive: true } as never;
  app.tree.value = tree;
  m = await import('../../../src/renderer/bookmarks/Panel');
  await flush();
});

beforeEach(async () => {
  server = [{ path: 'notes' }, { path: 'README.md', label: 'Start here' }, { path: 'gone.md' }];
  sent.length = 0;
  await m.reload();
});

describe('bookmarks panel', () => {
  it("draws files, folders, labels and missing targets (the folder hue is Shelf's)", async () => {
    for (const n of ['notes', 'Projects', 'a', '']) expect(m.hueOf(n)).toBe(shelfHue(n));
    const host = document.createElement('div');
    await act(() => render(<m.BookmarksPanel />, host));
    const rows = [...host.querySelectorAll('.se-bm-top')];
    expect(rows.map((r) => r.getAttribute('data-bm'))).toEqual(['notes', 'README.md', 'gone.md']);
    expect(rows[0].classList.contains('dir')).toBe(true);
    expect(rows[1].querySelector('.se-tree-name')!.textContent).toBe('Start here');
    expect(rows[1].querySelector('.se-bm-hint')!.textContent).toBe('README.md');
    expect(rows[2].classList.contains('missing')).toBe(true);
    expect(rows[2].querySelector('.se-bm-remove')).toBeTruthy();

    // A folder unfolds inline; folders inside it unfold too.
    await act(() => (rows[0] as HTMLElement).click());
    expect([...host.querySelectorAll('.se-bm-sub')].map((r) => r.getAttribute('data-path'))).toEqual(['notes/sub', 'notes/a.md', 'notes/b.md']);
    await act(() => host.querySelector<HTMLElement>('.se-bm-sub[data-path="notes/sub"]')!.click());
    expect(host.querySelector('.se-bm-sub[data-path="notes/sub/deep.md"]')).toBeTruthy();

    // Remove on the missing row.
    await act(() => host.querySelector<HTMLElement>('.se-bm-remove')!.click());
    await flush();
    expect(sent.at(-1)).toEqual({ op: 'remove', paths: ['gone.md'] });
    expect(host.querySelector('[data-bm="gone.md"]')).toBeNull();
    render(null, host);
  });

  it("follows One's renames (per file, and a folder's root) and outside ones (watcher batch)", async () => {
    app.events.emit('file:renamed', 'README.md', 'docs/README.md');
    await flush();
    expect(m.bookmarks.value.map((b) => b.path)).toEqual(['notes', 'docs/README.md', 'gone.md']);
    expect(m.bookmarks.value[1].label).toBe('Start here');
    // Files moved inside a bookmarked folder: nothing to send.
    const before = sent.length;
    app.events.emit('file:renamed', 'notes/a.md', 'notes/c.md');
    expect(sent.length).toBe(before);
    // Popups' movePath reports the folder itself (an empty one has no file events).
    m.renamed('notes', 'archive/notes', true);
    await flush();
    expect(server.map((b) => b.path)).toEqual(['archive/notes', 'docs/README.md', 'gone.md']);
    // Outside One: unlink + add of the same name elsewhere.
    fsListener!([
      { type: 'unlink', path: 'docs/README.md' },
      { type: 'add', path: 'README.md' },
    ]);
    await flush();
    expect(server.map((b) => b.path)).toEqual(['archive/notes', 'README.md', 'gone.md']);
  });

  it('toggles, adds in front of a bookmark, reorders and labels', async () => {
    m.toggleBookmarks(['notes/a.md', 'notes']); // one is new: add it
    await flush();
    expect(server.map((b) => b.path)).toEqual(['notes', 'README.md', 'gone.md', 'notes/a.md']);
    m.toggleBookmarks(['notes/a.md', 'notes']); // all bookmarked: remove both
    await flush();
    expect(server.map((b) => b.path)).toEqual(['README.md', 'gone.md']);
    m.addBookmarks(['notes/b.md'], 'gone.md');
    m.moveBookmarks(['gone.md'], 'README.md');
    m.labelBookmark('notes/b.md', 'B');
    await flush();
    expect(server).toEqual([{ path: 'gone.md' }, { path: 'README.md', label: 'Start here' }, { path: 'notes/b.md', label: 'B' }]);
    expect(m.bookmarks.value).toEqual(server);
  });
});
