// Trim trailing whitespace on save. Called from the format module's save hooks (src/format/install.ts),
// which already tell an explicit save (Ctrl+S, palette) from autosave — so nothing here is startup code.
//   off      nothing
//   changed  only lines added / changed since the file was opened or last saved (no git noise)
//   all      every line
// Autosave never trims the line the caret is on (the space you just typed survives); that line is
// trimmed on the next explicit save, or as soon as the caret leaves it (see ./cm.ts).
import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { basename, dirname } from '@shared/paths';
import { app } from '../app/app';
import { isMarkdownView } from '../app/ui';
import { docPath } from '../editor/host';
import { globMatches, parseEditorConfig } from '../../format/config';
import { applyChanges, changedLines, linesAt, trimChanges, type TextChange } from './trim';

export type TrimMode = 'off' | 'changed' | 'all';

export function trimMode(markdown: boolean): TrimMode {
  const v = app.settings.value[markdown ? 'editor.trimOnSave.markdown' : 'editor.trimOnSave.code'];
  return v === 'off' || v === 'all' ? v : 'changed';
}
export const keepBreaks = () => app.settings.value['editor.trimOnSave.keepMarkdownBreaks'] !== false;

// ---- .editorconfig `trim_trailing_whitespace` (parsed with the formatter's reader) ----
const configs = new Map<string, Promise<string | null>>();
let watching = false;
function readConfig(path: string): Promise<string | null> {
  if (!watching) {
    watching = true;
    app.events.on('file:updated', (p) => basename(p) === '.editorconfig' && configs.delete(p));
    app.events.on('workspace:opened', () => configs.clear());
  }
  if (!app.files.value.includes(path)) return Promise.resolve(null); // no round-trip for files that aren't there
  let p = configs.get(path);
  if (!p) configs.set(path, (p = app.backend.readFile(path).then((f) => f.content, () => null)));
  return p;
}

/** true / false from the nearest .editorconfig section matching `file`; null = not set. */
export async function editorConfigTrim(file: string): Promise<boolean | null> {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    const text = await readConfig(dir ? `${dir}/.editorconfig` : '.editorconfig');
    if (text !== null) {
      const cfg = parseEditorConfig(text);
      let v: string | undefined;
      for (const s of cfg.sections) if (globMatches(s.glob, file, dir) && s.props.trim_trailing_whitespace) v = s.props.trim_trailing_whitespace;
      if (v === 'true' || v === 'false') return v === 'true';
      if (cfg.root) return null;
    }
    if (!dir) return null;
  }
}

/** Caret lines an autosave left alone, per note: trimmed when the caret leaves them (./cm.ts). */
export const pendingCaretLines = new Map<string, Set<number>>();

/** The visible editor, when it shows `path`. */
function viewOf(path: string): EditorView | null {
  const v = app.editor?.getView?.() as EditorView | undefined;
  return v?.state && v.state.facet(docPath) === path ? v : null;
}

/** Applies trims outside the undo history: Ctrl+Z after a save undoes your edit, not the cleanup. */
export function applyTrim(path: string, changes: TextChange[]): void {
  const view = viewOf(path);
  if (view) view.dispatch({ changes, annotations: Transaction.addToHistory.of(false), userEvent: 'input.trim' });
  else app.editor?.applyChanges?.(path, changes);
}

/** Text to save for `path`; the editor is updated in place (minimal edits, caret kept). Never throws. */
export async function trimForSave(path: string, content: string, o: { explicit: boolean }): Promise<string> {
  try {
    const doc = app.docs.get(path);
    if (!doc || doc.binary) return content;
    const md = isMarkdownView(path);
    let mode = trimMode(md);
    const ec = await editorConfigTrim(path).catch(() => null);
    if (ec !== null) mode = ec ? 'all' : 'off';
    if (mode === 'off') return content;
    const lines = mode === 'changed' ? changedLines(doc.saved, content) : undefined;
    if (lines && !lines.size) return content;
    const view = viewOf(path);
    const skip = !o.explicit && view?.hasFocus ? linesAt(content, view.state.selection.ranges.map((r) => r.head)) : undefined;
    const opts = { markdown: md, keepBreaks: keepBreaks(), lines };
    const changes = trimChanges(content, { ...opts, skip });
    if (skip && trimChanges(content, { ...opts, lines: new Set([...skip].filter((l) => !lines || lines.has(l))) }).length) pendingCaretLines.set(path, skip);
    else pendingCaretLines.delete(path);
    if (!changes.length) return content;
    applyTrim(path, changes);
    const now = app.editor?.getContent(path);
    // The editor took them (normal case); a doc the editor doesn't hold just gets the trimmed text.
    return now !== undefined && now !== content ? now : applyChanges(content, changes);
  } catch (err) {
    console.warn('[whitespace] trim on save failed', err);
    return content;
  }
}
