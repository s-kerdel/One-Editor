// Search implementation chunk: full-text search panel (worker-backed index), omnibox / command
// palette, heading navigation, replace in files. Loaded on demand by ./index.tsx (which owns the
// command + panel registrations), never on the launch path.
import { app } from '../app/app';
import { escapeRegExp } from '../../search/text';
import { searchClient } from './client';
import { registerCommand } from '../app/commands';
import { openPalette } from './Palette';
import { SearchPanel, installPanelEffects, runSearchNow, stepResult } from './SearchPanel';
import { focusTick, query, showReplace, useRegex, wholeWord } from './state';
import '../app/overlays.css'; // palette base (shell; .se-omnibox resizes it)
import './search.css';

export { searchClient, openPalette, SearchPanel, stepResult };

/** Selected text in the active editor (single line, sane length), if any. */
export function editorSelection(): string {
  const view = app.editor?.getView?.() as { state?: { selection: { main: { from: number; to: number } }; sliceDoc(a: number, b: number): string } } | undefined;
  let text = '';
  if (view?.state) {
    const r = view.state.selection.main;
    text = view.state.sliceDoc(r.from, r.to);
  } else if (app.editor?.getCursorOffset && app.activePath.value) {
    const c = app.editor.getCursor();
    if (c.selectionLength) {
      const head = app.editor.getCursorOffset();
      const content = app.editor.getContent() ?? '';
      text = content.slice(head - c.selectionLength, head);
    }
  }
  return text && !text.includes('\n') && text.length <= 300 ? text : '';
}

function showPanel() {
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = 'search';
  void searchClient.start();
}

/** Open the search panel with `q` and run it immediately. */
export function openSearch(q: string, opts: { replace?: boolean; regex?: boolean; wholeWord?: boolean } = {}) {
  showPanel();
  if (opts.replace !== undefined) showReplace.value = opts.replace;
  if (opts.regex !== undefined) useRegex.value = opts.regex;
  if (opts.wholeWord !== undefined) wholeWord.value = opts.wholeWord;
  query.value = q;
  focusTick.value++;
  runSearchNow();
}

export function focusSearch(replace = false) {
  showPanel();
  const sel = editorSelection();
  if (sel) query.value = useRegex.value ? escapeRegExp(sel) : sel;
  if (replace) showReplace.value = true;
  focusTick.value++;
}

let installed = false;

/** One-time wiring, run by the lazy loader right after this chunk arrives. */
export function installSearchImpl() {
  if (installed) return;
  installed = true;
  searchClient.wire();
  (globalThis as { __secEditSearch?: unknown }).__secEditSearch = searchClient; // E2E / debugging
  installPanelEffects();
  registerCommand({
    id: 'developer.activityLog',
    title: 'Developer: Show activity log',
    keywords: ['indexing', 'background', 'git', 'performance', 'debug'],
    run: () => void import('../app/ActivityLog').then((m) => m.openActivityLog()),
  });
  // Lives in this idle-loaded chunk like the activity log: zero launch bytes for a developer tool.
  registerCommand({
    id: 'developer.processExplorer',
    title: 'Developer: Process explorer',
    keywords: ['task manager', 'cpu', 'memory', 'ram', 'processes', 'threads', 'workers', 'performance', 'git', 'terminal'],
    // Toggles the (non-modal) dock under the editor; focus stays in the editor.
    run: () => void import('../app/process-explorer/ProcessExplorer').then((m) => m.toggleProcessExplorer()),
  });
}

/** "Rebuild search index". */
export function reindex() {
  void searchClient.start().then(() => searchClient.reindex());
}
