// Markdown-specific key handling: smart Enter/Backspace/Tab, formatting shortcuts, auto-pairing.
import { EditorSelection, Prec, type ChangeSpec, type EditorState, type StateCommand, type Extension, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { EditorView, keymap, type Command, type KeyBinding } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { insertNewlineContinueMarkupCommand, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { indentMore as indentMoreCmd, indentLess as indentLessCmd, insertTab } from '@codemirror/commands';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import { toggleBold, toggleItalic, toggleStrike, insertLink, setHeading, isUrl } from './format';
import { indentListItem, outdentListItem, toggleTask, deleteTaskMarker, parseListLine } from './lists';
import { tableNextCell, tablePrevCell, tableEnter } from './tables';

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText', 'Frontmatter', 'InlineMath', 'BlockMath', 'HTMLBlock', 'CommentBlock']);

/** True when pos is inside code/math/frontmatter where Markdown editing helpers must stay out. */
export function inCodeContext(state: EditorState, pos: number): boolean {
  for (let n: { name: string; parent: any } | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (CODE_NODES.has(n.name)) return true;
  }
  return false;
}

const continueMarkup = insertNewlineContinueMarkupCommand({ nonTightLists: false });

/** Enter on an unclosed opening fence ("```php") inserts the closing fence. */
export const closeFenceOnEnter: StateCommand = ({ state, dispatch }) => {
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(r.head);
  const m = /^(\s*)(`{3,}|~{3,})([^`\s]*)\s*$/.exec(line.text);
  if (!m || r.head !== line.to) return false;
  const tree = syntaxTree(state);
  let node = tree.resolveInner(line.from + m[1].length, 1);
  while (node && node.name !== 'FencedCode' && node.parent) node = node.parent;
  if (!node || node.name !== 'FencedCode' || node.from !== line.from + m[1].length) return false;
  if (node.getChildren('CodeMark').length >= 2) return false;
  const insert = `\n${m[1]}\n${m[1]}${m[2]}`;
  dispatch(state.update({ changes: { from: r.head, insert }, selection: EditorSelection.cursor(r.head + 1 + m[1].length), userEvent: 'input', scrollIntoView: true }));
  return true;
};

const inTableCommand =
  (cmd: StateCommand): StateCommand =>
  (target) =>
    !inCodeContext(target.state, target.state.selection.main.head) && cmd(target);

const markdownEnter: StateCommand = (t) => inTableCommand(tableEnter)(t) || closeFenceOnEnter(t) || continueMarkup(t);

/** Backspace inside an empty auto-paired "**|**" / "==|==" / "~~|~~" removes both halves. */
const deletePairedMarkers: StateCommand = ({ state, dispatch }) => {
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length > 1) return false;
  for (const m of ['**', '==', '~~']) {
    if (state.sliceDoc(r.head - 2, r.head) === m && state.sliceDoc(r.head, r.head + 2) === m && state.sliceDoc(r.head - 3, r.head - 2) !== m[0]) {
      dispatch(state.update({ changes: { from: r.head - 2, to: r.head + 2 }, userEvent: 'delete.backward' }));
      return true;
    }
  }
  return false;
};

/** Tab: table cell → list indent → indent selection / insert indentation. */
const markdownTab: StateCommand = (t) => {
  if (inTableCommand(tableNextCell)(t)) return true;
  if (!inCodeContext(t.state, t.state.selection.main.head) && parseListLine(t.state.doc.lineAt(t.state.selection.main.head).text)) return indentListItem(t);
  const r = t.state.selection.main;
  if (r.empty && t.state.selection.ranges.length === 1) return insertTab(t);
  return indentMoreCmd(t);
};
const markdownShiftTab: StateCommand = (t) => {
  if (inTableCommand(tablePrevCell)(t)) return true;
  if (!inCodeContext(t.state, t.state.selection.main.head) && parseListLine(t.state.doc.lineAt(t.state.selection.main.head).text)) return outdentListItem(t) || true;
  return indentLessCmd(t);
};

/** Clipboard text without ever triggering a browser permission prompt (Electron reads freely). */
async function readClipboardQuietly(): Promise<string | null> {
  try {
    const electron = !!(window as unknown as { secEditBridge?: unknown }).secEditBridge;
    if (!electron) {
      const p = await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
      if (p?.state !== 'granted') return null;
    }
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

/** Mod-k reads the clipboard (async) so a copied URL becomes the link target. */
export const linkCommand: Command = (view) => {
  const run = (clip: string | null) => insertLink(clip)(view);
  const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  if (isUrl(sel) || !navigator.clipboard?.readText) {
    run(null);
    return true;
  }
  const timeout = new Promise<null>((res) => setTimeout(() => res(null), 250));
  void Promise.race([readClipboardQuietly(), timeout]).then((clip) => run(clip));
  return true;
};

/** Ctrl/Cmd-H: open the search panel with the replace field focused. */
export const openReplacePanel: Command = (view) => {
  openSearchPanel(view);
  requestAnimationFrame(() => {
    const input = view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]');
    input?.focus();
    input?.select();
  });
  return true;
};

export const markdownKeymap: KeyBinding[] = [
  { key: 'Enter', run: markdownEnter },
  { key: 'Backspace', run: (t) => deletePairedMarkers(t) || deleteTaskMarker(t) || deleteMarkupBackward(t) },
  { key: 'Tab', run: markdownTab, shift: markdownShiftTab },
  { key: 'Mod-b', run: toggleBold, preventDefault: true },
  { key: 'Mod-i', run: toggleItalic, preventDefault: true },
  { key: 'Mod-Shift-x', run: toggleStrike, preventDefault: true },
  { key: 'Mod-k', run: linkCommand, preventDefault: true },
  { key: 'Mod-Enter', run: toggleTask, preventDefault: true },
  ...[1, 2, 3, 4, 5, 6].map((n) => ({ key: `Mod-${n}`, run: setHeading(n), preventDefault: true })),
];

/** Editor-local bindings shared by every file type. */
export const commonKeymap: KeyBinding[] = [
  { key: 'Mod-g', run: gotoLine, preventDefault: true },
  { key: 'Mod-h', run: openReplacePanel, preventDefault: true },
];

const WRAP_CHARS = new Set(['*', '_', '`', '~', '=']);

/**
 * Typing a markup char with a selection wraps it; "**" auto-closes; typing over an auto-inserted
 * closing marker steps over it; the third backtick of a fence drops the auto-paired backticks.
 */
export const markdownInput = EditorView.inputHandler.of((view, from, to, text) => {
  const state = view.state;
  if (view.composing || text.length !== 1) return false;
  const sel = state.selection;
  if (WRAP_CHARS.has(text) && sel.ranges.some((r) => !r.empty)) {
    if (sel.ranges.some((r) => r.empty)) return false;
    if (inCodeContext(state, sel.main.from) && text !== '`') return false;
    view.dispatch(
      state.changeByRange((r) => ({
        changes: [
          { from: r.from, insert: text },
          { from: r.to, insert: text },
        ],
        range: EditorSelection.range(r.anchor + 1, r.head + 1),
      })),
      { userEvent: 'input.type' },
    );
    return true;
  }
  if (from !== to || sel.ranges.length > 1) return false;
  if (text === '*' || text === '~' || text === '=') {
    if (inCodeContext(state, from)) return false;
    const at = (i: number) => (from + i < 0 || from + i >= state.doc.length ? '' : state.sliceDoc(from + i, from + i + 1));
    const prev = at(-1);
    const prev2 = at(-2);
    const next = at(0);
    const next2 = at(1);
    // Step over an auto-inserted closing pair: "**bold|**" → "**bold*|*" → "**bold**|".
    const closingAhead = next === text && next2 === text && at(2) !== text && !!prev && !/\s/.test(prev);
    const closingMiddle = next === text && next2 !== text && prev === text && !!prev2 && !/\s/.test(prev2) && prev2 !== text;
    if (closingAhead || closingMiddle) {
      view.dispatch({ selection: EditorSelection.cursor(from + 1), userEvent: 'select' });
      return true;
    }
    // Auto-close "**" / "~~" when typed at a word boundary ("==" is too common in technical prose).
    const lineStart = state.doc.lineAt(from).from;
    if (text !== '=' && prev === text && prev2 !== text && (!next || /[\s)\].,;:!?]/.test(next)) && (from - 1 === lineStart || /[\s([{>"'-]/.test(prev2))) {
      if (text === '~' && from - 1 === lineStart) return false; // "~~~" code fence
      view.dispatch({ changes: { from, insert: text + text + text }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' });
      return true;
    }
    return false;
  }
  if (text === '`') {
    const spec = thirdBacktick(state, from);
    if (spec) {
      view.dispatch(spec);
      return true;
    }
  }
  return false;
});

/**
 * Typing the third backtick of a fence (cursor after "``"). Normalises the line to ``` (no auto-paired
 * leftovers; typing a letter then offers languages). When this closes a code block whose closing fence
 * was auto-inserted right below (closeFenceOnEnter), that fence is typed over instead of left behind.
 */
export function thirdBacktick(state: EditorState, from: number): TransactionSpec | null {
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const after = state.sliceDoc(from, line.to);
  if (!/^\s*``$/.test(before) || !/^`*$/.test(after)) return null;
  const changes: ChangeSpec[] = [{ from, to: line.to, insert: '`' }];
  const over = autoClosingFenceBelow(state, line.number, before.length - 2);
  if (over) changes.push(over);
  return { changes, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' };
}

/** The closing ``` of the code block around `lineNo` when only blank lines separate it from that line. */
function autoClosingFenceBelow(state: EditorState, lineNo: number, indent: number): { from: number; to: number } | null {
  const doc = state.doc;
  const line = doc.line(lineNo);
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(line.from, 1);
  while (node && node.name !== 'FencedCode') node = node.parent;
  if (!node || node.from >= line.from) return null; // not inside a block (or on its opening line)
  const marks = node.getChildren('CodeMark');
  if (marks.length < 2) return null;
  const open = doc.sliceString(marks[0].from, marks[0].to);
  const close = marks[marks.length - 1];
  const closeLine = doc.lineAt(close.from);
  if (open !== '```' || closeLine.number <= lineNo || closeLine.text.trim() !== '```' || closeLine.text.length - closeLine.text.trimStart().length !== indent) return null;
  for (let n = lineNo + 1; n < closeLine.number; n++) if (doc.line(n).text.trim()) return null;
  return { from: line.to, to: closeLine.to };
}

export function markdownKeys(): Extension {
  return [Prec.high(keymap.of(markdownKeymap)), Prec.high(markdownInput)];
}
