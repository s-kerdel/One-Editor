// Trailing whitespace in the editor (editor chunk): trims pasted text (terminal / AI output pads
// every line with spaces), Ctrl+Shift+V pastes exactly as copied, the caret line an autosave skipped
// is cleaned once the caret leaves it, and the "Trim trailing whitespace" command.
// Pastes go through CodeMirror's own clipboardInputFilter: multi-cursor and line-wise pasting keep
// working and the result is a single `input.paste` transaction (smart paste composes with it). A paste
// CodeMirror does not insert itself (paste.ts's rich HTML → Markdown) asks pastedText() instead.
import { Prec, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from '@codemirror/view';
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { isMarkdownView } from '../app/ui';
import { docPath } from '../editor/host';
import { changedLines, trimChanges, trimPasted } from './trim';
import { keepBreaks, pendingCaretLines } from './save';

let pasteAt = 0;
let rawUntil = 0;

const trimPasteOn = (path: string) => app.settings.value[isMarkdownView(path) ? 'editor.trimPaste.markdown' : 'editor.trimPaste.code'] !== false;
/** Ctrl+Shift+V just happened: this paste is taken exactly as copied (no trimming, no smart paste). */
export const pasteIsRaw = () => Date.now() < rawUntil;

/** What a plain-text paste of `raw` puts into `path` (smart paste compares against it). */
export function pastedText(raw: string, path: string): string {
  const text = raw.replace(/\r\n?/g, '\n');
  return pasteIsRaw() || !trimPasteOn(path) ? text : trimPasted(text);
}

/** Trims the lines an autosave skipped because the caret was on them, once it has left. */
const caretLeave = ViewPlugin.fromClass(
  class {
    update(u: ViewUpdate) {
      if (!u.selectionSet || u.docChanged) return;
      const path = u.state.facet(docPath);
      const pending = pendingCaretLines.get(path);
      if (!pending) return;
      const caret = new Set(u.state.selection.ranges.map((r) => u.state.doc.lineAt(r.head).number - 1));
      if ([...pending].some((l) => caret.has(l))) return;
      pendingCaretLines.delete(path);
      const view = u.view;
      queueMicrotask(() => {
        const doc = app.docs.get(path);
        if (!doc || view.state.facet(docPath) !== path) return;
        const text = view.state.doc.toString();
        const changed = changedLines(doc.saved, text);
        const lines = new Set([...pending].filter((l) => changed.has(l)));
        const changes = trimChanges(text, { markdown: isMarkdownView(path), keepBreaks: keepBreaks(), lines, skip: caret });
        // Not an undo step of its own; the autosave that follows writes it.
        if (changes.length) view.dispatch({ changes, annotations: Transaction.addToHistory.of(false), userEvent: 'input.trim' });
      });
    }
  },
);

/** Both markdown and code editors. */
export function whitespaceEditor(): Extension {
  return [
    // Runs alongside paste.ts's own Mod-Shift-v (plain text); neither stops the other.
    Prec.highest(keymap.of([{ key: 'Mod-Shift-v', run: () => ((rawUntil = Date.now() + 700), false) }])),
    Prec.highest(EditorView.domEventHandlers({ paste: () => ((pasteAt = Date.now()), false) })),
    EditorView.clipboardInputFilter.of((text, state) => {
      if (Date.now() - pasteAt > 250) return text; // drag and drop: unchanged
      if (pasteIsRaw()) {
        rawUntil = 0;
        return text;
      }
      return trimPasteOn(state.facet(docPath)) ? trimPasted(text) : text;
    }),
    caretLeave,
  ];
}

/** Trim trailing whitespace in the selection (lines it touches), else the whole file. Undoable. */
export function trimWhitespaceCommand(view: EditorView): boolean {
  const { state } = view;
  const ranges = state.selection.ranges.filter((r) => !r.empty);
  let lines: Set<number> | undefined;
  if (ranges.length) {
    lines = new Set();
    for (const r of ranges) for (let n = state.doc.lineAt(r.from).number; n <= state.doc.lineAt(r.to).number; n++) lines.add(n - 1);
  }
  const changes = trimChanges(state.doc.toString(), { markdown: isMarkdownView(state.facet(docPath)), keepBreaks: keepBreaks(), lines });
  if (!changes.length) {
    app.toast('No trailing whitespace', 'info', 1500);
    return true;
  }
  view.dispatch({ changes, userEvent: 'input.format', scrollIntoView: false });
  app.toast(`Trimmed ${changes.length} line${changes.length === 1 ? '' : 's'}`, 'success', 1500);
  return true;
}

const activeView = () => (app.activePath.value ? ((app.editor?.getView?.() as EditorView | undefined) ?? null) : null);

registerCommands([
  {
    id: 'editor.trimWhitespace',
    title: 'Trim trailing whitespace',
    category: 'Editor',
    keywords: ['spaces', 'trailing', 'strip', 'clean', 'whitespace', 'tabs'],
    when: () => !!activeView() && !app.docs.get(app.activePath.value!)?.binary,
    run: () => {
      const v = activeView();
      if (v) trimWhitespaceCommand(v), v.focus();
    },
  },
]);
