// Opens "Diff with last commit" in the app's overlay slot. Light: the merge view is a lazy chunk.
import { useEffect, useState } from 'preact/hooks';
import type { ComponentType } from 'preact';
import { GIT_TIMEOUT_TEXT, type GitEntry } from '@shared/git';
import { basename } from '@shared/paths';
import { app } from '../app/app';
import type { GitStore } from './store';
import type { DiffLayout, DiffViewProps } from './DiffView';
import { editableSide } from './diff-edit';

const LAYOUT_KEY = 'sec-edit.git.diffLayout';

function savedLayout(): DiffLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

export type OverlayProps = Omit<DiffViewProps, 'layout' | 'onLayout' | 'onClose'>;

function closeOverlay() {
  app.overlay.value = null;
  app.editor?.focus();
}

function DiffOverlay(p: OverlayProps) {
  const [View, setView] = useState<ComponentType<DiffViewProps> | null>(null);
  const [layout, setLayout] = useState<DiffLayout>(savedLayout);
  useEffect(() => {
    let alive = true;
    import('./DiffView').then(
      (m) => alive && setView(() => m.DiffView),
      (err) => {
        console.error(err);
        app.toast('Could not load the diff view', 'error');
        closeOverlay();
      },
    );
    return () => {
      alive = false;
    };
  }, []);
  const pick = (l: DiffLayout) => {
    setLayout(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {}
  };
  return (
    <div class="se-overlay se-git-diff-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeOverlay()}>
      {View ? <View {...p} layout={layout} onLayout={pick} onClose={closeOverlay} /> : <div class="se-git-diff" aria-busy="true" />}
    </div>
  );
}

/** No status: the one sentence for "no answer in time", else the general one. */
function noStatus(store: GitStore): string | null {
  const s = store.status.peek();
  return s?.ok ? null : s?.reason === 'timeout' ? GIT_TIMEOUT_TEXT : 'Git is not available for this folder';
}

/** Why there is nothing to diff, or null when there is. */
export function diffUnavailable(store: GitStore, path: string): string | null {
  const s = store.status.peek();
  if (!s?.ok) return noStatus(store);
  if (!s.branch.oid) return 'There is no commit yet';
  if (!store.headKey(path)) return `“${basename(path)}” is not in the last commit yet`;
  return null;
}

/** Says why no diff opens. git gave no answer in time: with Retry, which reads git's state again
 *  (store.retry, one at a time) and nothing more — the diff is not opened by it; the user asks again. */
function sayWhy(store: GitStore, why: string) {
  if (why !== GIT_TIMEOUT_TEXT) return void app.toast(why, 'info');
  app.toast(why, 'error', 8000, [{ label: 'Retry', run: () => void store.retry() }]);
}

/**
 * A file's changes since the last commit, with the commit boxes: THE way in for "Diff with last commit"
 * (tab / tree menu, palette, status bar) and for a click on a Source control row (`row`: its entry, which
 * may be a new file). One route, so both get the same view and the same staging rules (./stage, lazy).
 * No git at all without a status (not a repository, not trusted, switched off).
 */
export async function openFileDiff(store: GitStore, path: string, row?: GitEntry): Promise<boolean> {
  const why = row ? noStatus(store) : diffUnavailable(store, path);
  if (why) {
    sayWhy(store, why);
    return false;
  }
  const { openStaging } = await import('./stage');
  return openStaging(store, path, row);
}

/** The plain view: HEAD ↔ working copy for `path`. Resolves false (after a toast) when there is nothing
 *  to show. `extra`: more view props (./stage adds the "include in commit" boxes). */
export async function openDiffWithHead(store: GitStore, path: string, extra?: Partial<OverlayProps>): Promise<boolean> {
  const why = diffUnavailable(store, path);
  if (why) {
    sayWhy(store, why);
    return false;
  }
  const head = await store.headFile(path);
  if (!head || head.content === null) {
    const name = basename(path);
    app.toast(
      head?.binary ? `“${name}” is a binary file` : head?.tooLarge ? `“${name}” is too large to compare` : head?.lfs ? `“${name}” is stored with Git LFS` : `“${name}” is not in the last commit`,
      'info',
    );
    return false;
  }
  const cur = await workingText(path);
  const editable = editableSide({ kind: 'working', text: cur.exists }) === 'b';
  const mark = store.marks.peek().file(path);
  const props: OverlayProps = {
    path,
    base: head.content,
    current: cur.text,
    baseLabel: `Last commit${head.oid ? ` (${head.oid.slice(0, 7)})` : ''}`,
    // An editable diff says "unsaved edits" itself, live.
    currentLabel: cur.dirty && !editable ? 'Working copy, unsaved edits included' : 'Working copy',
    editable,
    sameNote: mark ? 'Git still reports a change: line endings, encoding or the file mode differ.' : undefined,
    ...extra,
  };
  showDiff(props);
  return true;
}

/** Any two texts in the diff overlay. */
export function showDiff(props: OverlayProps) {
  app.overlay.value = () => <DiffOverlay {...props} />;
}

/** The file as the folder has it (unsaved edits included). `exists`: false when it is gone (everything
 *  shows as removed) or not text — then there is nothing to edit. */
export async function workingText(path: string): Promise<{ text: string; dirty: boolean; exists: boolean }> {
  const doc = app.docs.get(path);
  const text = doc?.binary ? undefined : (doc?.content ?? app.editor?.getContent(path));
  if (text !== undefined) return { text, dirty: !!doc?.dirty.peek(), exists: true };
  return app.backend.readFile(path).then(
    (f) => ({ text: f.binary ? '' : f.content, dirty: false, exists: !f.binary }),
    () => ({ text: '', dirty: false, exists: false }),
  );
}

/** Source-control rows: like openDiffWithHead, but a new (untracked / added) file is shown against nothing. */
export async function openChange(store: GitStore, path: string, extra?: Partial<OverlayProps>): Promise<boolean> {
  if (store.headKey(path)) return openDiffWithHead(store, path, extra);
  const cur = await workingText(path);
  const editable = editableSide({ kind: 'working', text: cur.exists }) === 'b';
  showDiff({ path, base: '', current: cur.text, baseLabel: 'Not in the last commit', currentLabel: cur.dirty && !editable ? 'Working copy, unsaved edits included' : 'New file', editable, ...extra });
  return true;
}

/** One file of a past commit against the commit's first parent. */
export async function openCommitDiff(file: { path: string; from?: string | null; status: string }, commit: { oid: string; parent: string | null }) {
  const read = (p: string, rev: string) => (app.backend.git ? app.backend.git('headFile', p, rev).then((r) => r.content) : Promise.resolve(null));
  const [base, current] = await Promise.all([
    commit.parent && file.status !== 'added' ? read(file.from ?? file.path, commit.parent) : Promise.resolve(''),
    file.status === 'deleted' ? Promise.resolve('') : read(file.path, commit.oid),
  ]);
  if (base === null || current === null) {
    app.toast(`“${basename(file.path)}” cannot be compared (binary or too large)`, 'info');
    return;
  }
  showDiff({ path: file.path, base, current, baseLabel: commit.parent ? `Before (${commit.parent.slice(0, 7)})` : 'Before (nothing: first commit)', currentLabel: `Commit ${commit.oid.slice(0, 7)}`, editable: editableSide({ kind: 'commit' }) === 'b' });
}
