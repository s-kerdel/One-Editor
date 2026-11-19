// Git (lazy chunk, loaded on idle by ./install): the status store wired to the app — refresh on save,
// fs events, `.git` changes (backend watcher), window focus — the shell slots (tree marks, branch item,
// change-bar source, menus) and the palette commands. No CodeMirror here: the change bars live in the
// editor chunk (./gutter), the diff view and the Source control pane are their own chunks.
import './git.css';
import { h } from 'preact';
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { webToken } from '../platform';
import { GitStore, type GitBackend } from './store';
import { diffUnavailable, openDiffWithHead } from './diff-open';
import { gitUi, type GitUi } from './install';
import { changesTree, rowClass } from './marks';
import { ChangesBanner, GitBranchItem, GitTreeMark, fileMenuItems } from './ui';
import type { GitGutterSource } from './gutter';
import { compareEnabled, editorSource, hasComparePick } from './compare-menu';

export { GitStore } from './store';
export { openDiffWithHead } from './diff-open';

let store: GitStore | null = null;
/** The app's git store (null until installGit ran, or when the backend has no git support). */
export const getGitStore = () => store;

import { gitCall } from './rpc';

const HINT_KEY = 'sec-edit.git.hintShown';

function hintOnce() {
  try {
    if (localStorage.getItem(HINT_KEY)) return;
    localStorage.setItem(HINT_KEY, '1');
  } catch {}
  const where = app.backend.os === 'win32' ? 'Install Git for Windows (git-scm.com)' : 'Install git';
  app.toast(`This folder is a git repository, but git was not found. ${where} to see changes in the editor.`, 'info', 9000);
}

/** HEAD contents for the editor's change bars, straight from the store. */
export function gutterSource(s: GitStore): GitGutterSource {
  return {
    key: (p) => s.headKey(p),
    load: (p) => s.headFile(p).then((r) => r?.content ?? null),
    subscribe: (cb) => s.subscribe(cb),
  };
}

/** `.git` changed (commit / checkout in a terminal): Electron IPC, or the server's git event stream. */
function onGitChanged(cb: () => void): () => void {
  const bridge = (globalThis as { secEditBridge?: { on(ch: string, cb: () => void): () => void } }).secEditBridge;
  if (bridge) return bridge.on('git:changed', cb);
  if (typeof EventSource === 'undefined') return () => {};
  const es = new EventSource(new URL(`./api/events?git=1&token=${encodeURIComponent(webToken())}`, location.href).toString());
  es.addEventListener('git', cb);
  return () => es.close();
}

type EditorViewT = import('@codemirror/view').EditorView;
const view = () => app.editor?.getView?.() as EditorViewT | undefined;
const canCompare = () => compareEnabled() && !!app.activePath.value && !!view();
/** Captures the editor source at invocation, then loads the compare chunk. */
const cmp = (fn: (m: typeof import('./compare'), src: ReturnType<typeof editorSource>) => unknown) => () => {
  const src = editorSource();
  void import('./compare').then((m) => fn(m, src));
};
// Through the editor chunk (already loaded when there is a view), so ./gutter stays inside it.
const withGutter = (fn: (m: typeof import('../editor'), v: EditorViewT) => unknown) => () => {
  const v = view();
  if (v) return void import('../editor').then((m) => fn(m, v));
};

export function installGit(): GitStore | null {
  if (store) return store;
  const call = gitCall();
  if (!call) return null; // backend without git: everything stays hidden
  const backend: GitBackend = { gitStatus: () => call('status'), gitHeadFile: (p, rev) => call('headFile', p, rev) };
  const s = new GitStore(backend, { foldCase: app.backend.os === 'win32' || app.backend.os === 'darwin', onHint: hintOnce });
  store = s;
  const enabled = () => app.settings.value['git.enabled'] !== false;
  s.setEnabled(enabled());
  app.events.on('settings:changed', () => s.setEnabled(enabled()));
  app.events.on('workspace:opened', () => s.reset());
  app.events.on('doc:saved', () => s.refresh());
  app.events.on('file:updated', () => s.refresh());
  app.events.on('file:renamed', () => s.refresh());
  app.backend.onFsEvents(() => s.refresh());
  onGitChanged(() => s.refresh());
  window.addEventListener('focus', () => s.refresh(true));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && s.refresh(true));
  if (app.workspace.value) s.refresh(true);

  // "Show changes" tree, memoised so the virtualised tree only re-flattens when something changed.
  let memo: { tree: unknown; marks: unknown; out: ReturnType<GitUi['view']> } | null = null;
  const ui: GitUi = {
    row: (p, dir) => rowClass(s.marks.value, p, dir),
    Mark: (p) => h(GitTreeMark, { store: s, ...p }),
    Branch: () => h(GitBranchItem, { store: s }),
    Banner: () => h(ChangesBanner, { store: s }),
    view(tree) {
      if (!s.changesOnly.value) return null;
      const marks = s.marks.value;
      if (memo?.tree !== tree || memo.marks !== marks) {
        const ct = changesTree(tree, marks);
        memo = { tree, marks, out: { tree: ct.tree, expanded: ct.dirs } };
      }
      return memo.out;
    },
    menu: (p) => fileMenuItems(s, p),
    gutter: gutterSource(s),
  };
  gitUi.value = ui;

  const ok = () => !!s.status.value?.ok;
  const active = () => app.activePath.value;
  registerCommands([
    {
      id: 'git.openPanel',
      title: 'Show source control',
      category: 'Git',
      keys: ['Mod-Shift-g'],
      keywords: ['commit', 'stage', 'push', 'pull', 'branch', 'scm', 'changes'],
      run: () => {
        app.sidebarVisible.value = true;
        app.sidebarPanel.value = 'git';
      },
    },
    {
      id: 'git.diffWithHead',
      title: 'Diff with last commit',
      category: 'Git',
      keywords: ['compare', 'changes', 'head', 'history'],
      when: () => !!active() && !diffUnavailable(s, active()!),
      run: () => void openDiffWithHead(s, active()!),
    },
    {
      id: 'git.showChanges',
      title: 'Show changed files only',
      category: 'Git',
      keywords: ['filter', 'modified', 'status'],
      when: ok,
      run: () => {
        s.changesOnly.value = !s.changesOnly.value;
        app.sidebarVisible.value = true;
        app.sidebarPanel.value = 'files';
      },
    },
    { id: 'git.refresh', title: 'Refresh status', category: 'Git', when: ok, run: () => s.refreshNow() },
    { id: 'git.nextChange', title: 'Go to next change', category: 'Git', keys: ['Alt-F5'], when: ok, run: withGutter((m, v) => m.nextChange(v)) },
    { id: 'git.previousChange', title: 'Go to previous change', category: 'Git', keys: ['Shift-Alt-F5'], when: ok, run: withGutter((m, v) => m.previousChange(v)) },
    { id: 'git.peekChange', title: 'Show change at cursor', category: 'Git', when: ok, run: withGutter((m, v) => m.peekChangeAtCursor(v)) },
    { id: 'git.revertChange', title: 'Revert change at cursor', category: 'Git', when: ok, run: withGutter((m, v) => m.revertChangeAtCursor(v)) },
    // Compare text: works without a repository (git is only the diff engine; built-in fallback).
    { id: 'compare.withClipboard', title: 'Compare text with clipboard', category: 'Compare', keywords: ['diff', 'clipboard', 'paste'], when: canCompare, run: cmp((m, src) => m.compareWithClipboard(src)) },
    { id: 'compare.select', title: 'Select text for compare', category: 'Compare', keywords: ['diff', 'remember', 'mark'], when: canCompare, run: cmp((m, src) => m.selectForCompare(src)) },
    { id: 'compare.withPrevious', title: 'Compare text with previous selection', category: 'Compare', keywords: ['diff', 'selection'], when: () => canCompare() && hasComparePick(), run: cmp((m, src) => m.compareWithPrevious(src)) },
  ]);
  (globalThis as { __secEditGit?: GitStore }).__secEditGit = s; // E2E / debugging
  return s;
}
