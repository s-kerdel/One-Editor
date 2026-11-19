// @vitest-environment happy-dom
// Git UI pieces: status-bar branch item + menu, tree marks, the diff view (merge view) and its opener.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { signal } from '@preact/signals';
import type { GitStatus } from '@shared/git';
import { app, type DocState } from '../../../src/renderer/app/app';
import { GitStore, type GitBackend } from '../../../src/renderer/git/store';
import { GitBranchItem, GitTreeMark, branchMenuItems } from '../../../src/renderer/git/ui';
import { DiffView, type DiffViewProps } from '../../../src/renderer/git/DiffView';
import { openDiffWithHead } from '../../../src/renderer/git/diff-open';

const OID = 'c'.repeat(40);
const status = (over: Partial<GitStatus> = {}): GitStatus => ({
  ok: true,
  branch: { head: 'feature/x', oid: OID, detached: false, upstream: 'origin/feature/x', ahead: 2, behind: 1 },
  entries: [
    { path: 'notes/a.md', state: 'modified', unstaged: true },
    { path: 'new.md', state: 'untracked' },
    { path: 'build', state: 'ignored', dir: true },
  ],
  prefix: '',
  ms: 1,
  ...over,
});
async function storeWith(s: GitStatus | null, head = 'old\n') {
  const backend: GitBackend = { gitStatus: async () => s ?? { ok: false, reason: 'no-repo' }, gitHeadFile: async (_p, rev) => ({ content: head, oid: rev ?? OID }) };
  const store = new GitStore(backend);
  await store.refreshNow();
  return store;
}
const host = () => {
  document.body.innerHTML = '<div id="h"></div>';
  return document.getElementById('h')!;
};
afterEach(() => {
  render(null, document.getElementById('h') ?? document.body);
  app.overlay.value = null;
});

describe('GitBranchItem', () => {
  it('branch, ahead/behind and a dirty dot', async () => {
    const store = await storeWith(status());
    const el = host();
    act(() => render(<GitBranchItem store={store} />, el));
    const btn = el.querySelector('[data-testid="git-branch"]')!;
    expect(btn.querySelector('.se-git-branch-name')!.textContent).toBe('feature/x');
    expect([...btn.querySelectorAll('.se-git-ab')].map((n) => n.textContent)).toEqual(['↑2', '↓1']);
    expect(btn.querySelector('.se-git-branch-dirty')).not.toBeNull();
    expect(btn.getAttribute('title')).toContain('2 ahead, 1 behind origin/feature/x');
  });

  it('detached: short commit id; clean: no dot', async () => {
    const store = await storeWith(status({ branch: { head: null, oid: OID, detached: true, upstream: null, ahead: 0, behind: 0 }, entries: [] }));
    const el = host();
    act(() => render(<GitBranchItem store={store} />, el));
    expect(el.querySelector('.se-git-branch-name')!.textContent).toBe(OID.slice(0, 7));
    expect(el.querySelector('.se-git-branch-dirty')).toBeNull();
    expect(el.querySelector('.se-git-ab')).toBeNull();
  });

  it('renders nothing when git is unavailable', async () => {
    const store = await storeWith(null);
    const el = host();
    act(() => render(<GitBranchItem store={store} />, el));
    expect(el.innerHTML).toBe('');
  });

  it('menu: copy branch, show changes (count), diff with last commit', async () => {
    const store = await storeWith(status());
    const items = branchMenuItems(store, 'notes/a.md');
    expect(items.map((i) => i.label ?? '—')).toEqual(['Copy branch name', 'Show changes (2)', 'Diff with last commit', 'Open source control', '—', '↑2  ↓1  origin/feature/x']);
    items[1].run!();
    expect(store.changesOnly.value).toBe(true);
    expect(branchMenuItems(store, 'new.md')[1].label).toBe('Show all files');
    expect(branchMenuItems(store, 'new.md')[2].disabled).toBe(true); // untracked: nothing to diff
  });
});

describe('GitTreeMark', () => {
  it('letters for files, dot for folders, nothing for ignored', async () => {
    const store = await storeWith(status());
    const el = host();
    act(() =>
      render(
        <div>
          <GitTreeMark store={store} path="notes/a.md" dir={false} />
          <GitTreeMark store={store} path="new.md" dir={false} />
          <GitTreeMark store={store} path="notes" dir />
          <GitTreeMark store={store} path="build" dir />
          <GitTreeMark store={store} path="build/x.js" dir={false} />
          <GitTreeMark store={store} path="clean.md" dir={false} />
        </div>,
        el,
      ),
    );
    const marks = [...el.firstElementChild!.children].map((n) => `${n.className}:${n.textContent}`);
    expect(marks).toEqual(['se-git-letter se-git-modified:M', 'se-git-letter se-git-untracked:U', 'se-git-dot se-git-modified:']);
  });

  it('updates when the status changes', async () => {
    let s = status();
    const store = new GitStore({ gitStatus: async () => s, gitHeadFile: async () => ({ content: null, oid: null }) });
    await store.refreshNow();
    const el = host();
    act(() => render(<GitTreeMark store={store} path="notes/a.md" dir={false} />, el));
    expect(el.textContent).toBe('M');
    s = status({ entries: [] });
    await act(() => store.refreshNow());
    expect(el.textContent).toBe('');
  });
});

describe('DiffView', () => {
  const props = (over: Partial<DiffViewProps> = {}): DiffViewProps => ({
    path: 'notes/a.md',
    base: 'one\ntwo\nthree\n',
    current: 'one\nTWO\nthree\nfour\n',
    baseLabel: 'Last commit (ccccccc)',
    currentLabel: 'Working copy',
    layout: 'unified',
    onLayout: vi.fn(),
    onClose: vi.fn(),
    ...over,
  });

  it('unified: one editor with the deleted lines inline, stats in the header', () => {
    const el = host();
    act(() => render(<DiffView {...props()} />, el));
    expect(el.querySelector('[data-testid="git-diff-stats"]')!.textContent).toBe('+2 −1');
    expect(el.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(el.querySelector('.cm-deletedChunk')?.textContent).toContain('two');
    expect(el.querySelector('.cm-content')!.textContent).toContain('four');
  });

  it('side by side: a merge view with both versions; the toggle reports the layout', () => {
    const p = props({ layout: 'split' });
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    expect(el.querySelector('.cm-mergeView')).not.toBeNull();
    const editors = el.querySelectorAll('.cm-mergeView .cm-editor');
    expect(editors).toHaveLength(2);
    expect(editors[0].textContent).toContain('two');
    expect(editors[1].textContent).toContain('TWO');
    (el.querySelector('[role="radio"]:not([aria-checked="true"])') as HTMLButtonElement).click();
    expect(p.onLayout).toHaveBeenCalledWith('unified');
  });

  it('read-only editors; Esc closes', () => {
    const p = props();
    const el = host();
    act(() => render(<DiffView {...p} />, el));
    expect(el.querySelector('.cm-content')!.getAttribute('contenteditable')).toBe('false');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.onClose).toHaveBeenCalled();
  });

  it('identical texts: a friendly empty state', () => {
    const el = host();
    act(() => render(<DiffView {...props({ current: 'one\ntwo\nthree\n', sameNote: 'Only line endings differ.' })} />, el));
    expect(el.querySelector('[data-testid="git-diff-empty"]')!.textContent).toContain('No changes since the last commit');
    expect(el.textContent).toContain('Only line endings differ.');
    expect(el.querySelector('.cm-editor')).toBeNull();
  });
});

describe('openDiffWithHead', () => {
  it('opens the overlay with HEAD vs the live buffer (unsaved edits included)', async () => {
    const store = await storeWith(status(), 'old\n');
    app.docs.set('notes/a.md', { path: 'notes/a.md', saved: 'x', content: 'new\n', mtime: 0, eol: 'lf', dirty: signal(true) } as DocState);
    expect(await openDiffWithHead(store, 'notes/a.md')).toBe(true);
    const Overlay = app.overlay.value!;
    const el = host();
    await act(async () => {
      render(<Overlay />, el);
      await new Promise((r) => setTimeout(r, 50)); // lazy chunk
    });
    expect(el.querySelector('.se-git-diff-sub')!.textContent).toContain('unsaved edits');
    expect(el.querySelector('[data-testid="git-diff-stats"]')!.textContent).toBe('+1 −1');
    app.docs.delete('notes/a.md');
  });

  it('refuses untracked files with a toast', async () => {
    const store = await storeWith(status());
    const toast = vi.spyOn(app, 'toast').mockImplementation(() => 0);
    expect(await openDiffWithHead(store, 'new.md')).toBe(false);
    expect(toast.mock.calls[0][0]).toContain('not in the last commit');
    expect(app.overlay.value).toBeNull();
    toast.mockRestore();
  });
});
