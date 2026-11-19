// Markdown list editing: indent/outdent with subtrees, ordered-list renumbering, task toggling.
// Text based (not parser based) so it behaves the same on partially parsed docs. Pure → unit tested.
import { EditorSelection, EditorState, Transaction, type ChangeSpec, type StateCommand, type TransactionSpec } from '@codemirror/state';

export interface ListLine {
  quote: string; // blockquote prefix ("> ")
  indent: string; // whitespace after the quote prefix
  bullet?: string; // - * +
  num?: number;
  numStr?: string;
  delim?: string; // . or )
  space: string; // whitespace after the marker
  task?: string; // "[ ] " incl. trailing whitespace
  checked?: boolean;
  /** Offset of the marker within the line. */
  markerFrom: number;
  /** Offset where the item text starts. */
  contentFrom: number;
}

const LIST_RE = /^((?:[ \t]*>[ \t]?)*)([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?/;
const HR_RE = /^(?:[ \t]*>[ \t]?)*[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

export function parseListLine(text: string): ListLine | null {
  if (HR_RE.test(text)) return null;
  const m = LIST_RE.exec(text);
  if (!m) return null;
  const [all, quote, indent, bullet, numStr, delim, space, task] = m;
  const markerFrom = quote.length + indent.length;
  return {
    quote,
    indent,
    bullet,
    num: numStr ? +numStr : undefined,
    numStr,
    delim,
    space,
    task,
    checked: task ? /x/i.test(task) : undefined,
    markerFrom,
    contentFrom: all.length,
  };
}

export function columns(ws: string, tabSize = 4): number {
  let col = 0;
  for (const ch of ws) col = ch === '\t' ? col + tabSize - (col % tabSize) : col + 1;
  return col;
}

function quoteOf(text: string): string {
  return /^(?:[ \t]*>[ \t]?)*/.exec(text)![0];
}
function leadingWs(text: string, quote: string): string {
  return /^[ \t]*/.exec(text.slice(quote.length))![0];
}
const isBlank = (text: string, quote: string) => text.slice(quote.length).trim() === '';

/** Last line (number) of the item starting at `lineNo`, including deeper continuation lines. */
export function subtreeEnd(state: EditorState, lineNo: number): number {
  const doc = state.doc;
  const first = doc.line(lineNo).text;
  const quote = quoteOf(first);
  const w = columns(leadingWs(first, quote));
  let end = lineNo;
  for (let n = lineNo + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (quoteOf(text) !== quote) break;
    if (isBlank(text, quote)) continue;
    if (columns(leadingWs(text, quote)) <= w) break;
    end = n;
  }
  return end;
}

/** Nearest previous list line at the given relation to width `w` (sibling: ===, parent: <). */
function findPrev(state: EditorState, lineNo: number, quote: string, w: number, kind: 'sibling' | 'parent'): { line: number; item: ListLine } | null {
  const doc = state.doc;
  for (let n = lineNo - 1; n >= 1; n--) {
    const text = doc.line(n).text;
    if (quoteOf(text) !== quote) return null;
    if (isBlank(text, quote)) continue;
    const item = parseListLine(text);
    const lw = columns(leadingWs(text, quote));
    if (kind === 'sibling') {
      if (lw > w) continue;
      return item && lw === w ? { line: n, item } : null;
    }
    if (lw >= w) continue;
    return item ? { line: n, item } : null;
  }
  return null;
}

function usesTabs(state: EditorState, around: number): boolean {
  const doc = state.doc;
  for (let n = Math.max(1, around - 50); n <= Math.min(doc.lines, around + 50); n++) {
    const text = doc.line(n).text;
    const q = quoteOf(text);
    const ws = leadingWs(text, q);
    if (ws && parseListLine(text)) return ws.startsWith('\t');
  }
  return false;
}

function selectedLines(state: EditorState): number[] {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (b > a && r.to === state.doc.line(b).from) b--; // selection ending at line start doesn't include that line
    for (let n = a; n <= b; n++) set.add(n);
  }
  return [...set].sort((x, y) => x - y);
}

/** Remove up to `cols` columns of indentation after the quote prefix; returns the change. */
function dedentChange(state: EditorState, lineNo: number, cols: number): ChangeSpec | null {
  const line = state.doc.line(lineNo);
  const quote = quoteOf(line.text);
  const ws = leadingWs(line.text, quote);
  let removed = 0;
  let i = 0;
  while (i < ws.length && removed < cols) {
    removed = columns(ws.slice(0, i + 1));
    i++;
  }
  if (!i) return null;
  return { from: line.from + quote.length, to: line.from + quote.length + i };
}

/**
 * Tab / Shift-Tab on list items. Moves the item(s) together with their children one level,
 * then renumbers affected ordered lists. Returns null when the cursor isn't on a list item.
 */
export function indentListSpec(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const lines = selectedLines(state);
  const firstText = state.doc.line(lines[0]).text;
  const first = parseListLine(firstText);
  if (!first) return null;
  // Only take over Tab when every selected non-blank line is part of a list block.
  const quote = first.quote;
  const w = columns(first.indent);
  let last = lines[lines.length - 1];
  for (const n of lines) {
    if (parseListLine(state.doc.line(n).text)) last = Math.max(last, subtreeEnd(state, n));
  }
  const changes: ChangeSpec[] = [];
  const numberFix: Array<{ line: number; num: number }> = [];
  if (dir === 1) {
    const sib = findPrev(state, lines[0], quote, w, 'sibling');
    if (!sib) return {}; // first item can't be nested further; swallow Tab so focus stays
    const tabs = usesTabs(state, lines[0]);
    const target = tabs ? columns(first.indent + '\t') : columns(sib.item.indent) + (sib.item.contentFrom - sib.item.markerFrom - (sib.item.task?.length ?? 0));
    const delta = Math.max(1, target - w);
    const insert = tabs ? '\t' : ' '.repeat(delta);
    for (let n = lines[0]; n <= last; n++) {
      const line = state.doc.line(n);
      const q = quoteOf(line.text);
      if (q !== quote || isBlank(line.text, q)) continue;
      changes.push({ from: line.from + q.length, insert });
    }
    if (first.num !== undefined) {
      // Continue an existing sublist under the sibling, else start a new one at 1.
      let num = 1;
      for (let n = sib.line + 1; n < lines[0]; n++) {
        const it = parseListLine(state.doc.line(n).text);
        if (it && it.quote === quote && columns(it.indent) === w + delta) num = it.num !== undefined ? it.num + 1 : 1;
      }
      numberFix.push({ line: lines[0], num });
    }
  } else {
    const parent = findPrev(state, lines[0], quote, w, 'parent');
    const target = parent ? columns(parent.item.indent) : 0;
    if (w === 0) return null;
    const delta = w - target;
    for (let n = lines[0]; n <= last; n++) {
      const line = state.doc.line(n);
      const q = quoteOf(line.text);
      if (q !== quote || isBlank(line.text, q)) continue;
      const c = dedentChange(state, n, delta);
      if (c) changes.push(c);
    }
    // Former following siblings become children of the outdented item → their run restarts.
    const after = last + 1 <= state.doc.lines ? parseListLine(state.doc.line(last + 1).text) : null;
    if (after && after.num !== undefined && columns(after.indent) === w && after.quote === quote) numberFix.push({ line: last + 1, num: 1 });
  }
  if (!changes.length) return {};
  const cs1 = state.changes(changes);
  const fixChanges: ChangeSpec[] = [];
  for (const f of numberFix) {
    const line = state.doc.line(f.line);
    const item = parseListLine(line.text)!;
    if (item.num !== f.num) fixChanges.push({ from: line.from + item.markerFrom, to: line.from + item.markerFrom + item.numStr!.length, insert: String(f.num) });
  }
  let cs = cs1;
  if (fixChanges.length) cs = state.changes([...changes, ...fixChanges]);
  const mid = state.update({ changes: cs }).state;
  const ren = renumberChanges(mid, mid.doc.lineAt(cs.mapPos(state.doc.line(lines[0]).from, 1)).number);
  const total = ren.length ? cs.compose(mid.changes(ren)) : cs;
  return { changes: total, selection: state.selection.map(total, 1), userEvent: dir === 1 ? 'input.indent' : 'delete.dedent', scrollIntoView: true };
}

export const indentListItem: StateCommand = ({ state, dispatch }) => {
  const spec = indentListSpec(state, 1);
  if (!spec) return false;
  dispatch(state.update(spec));
  return true;
};
export const outdentListItem: StateCommand = ({ state, dispatch }) => {
  const spec = indentListSpec(state, -1);
  if (!spec) return false;
  dispatch(state.update(spec));
  return true;
};

/** Bounds of the list block (contiguous list/continuation/blank-between lines) around lineNo. */
export function listBlock(state: EditorState, lineNo: number): { from: number; to: number } | null {
  const doc = state.doc;
  const inList = (n: number) => {
    const text = doc.line(n).text;
    if (parseListLine(text)) return true;
    const q = quoteOf(text);
    return !isBlank(text, q) && /^[ \t]+/.test(text.slice(q.length));
  };
  let start = lineNo;
  if (!inList(lineNo)) {
    // allow the line right after a changed region (e.g. a deleted item)
    if (lineNo < doc.lines && inList(lineNo + 1)) start = lineNo + 1;
    else if (lineNo > 1 && inList(lineNo - 1)) start = lineNo - 1;
    else return null;
  }
  let from = start;
  let to = start;
  const maxScan = 5000;
  for (let n = start - 1, i = 0; n >= 1 && i < maxScan; n--, i++) {
    const text = doc.line(n).text;
    if (inList(n)) from = n;
    else if (isBlank(text, quoteOf(text)) && n > 1 && inList(n - 1)) continue;
    else break;
  }
  for (let n = start + 1, i = 0; n <= doc.lines && i < maxScan; n++, i++) {
    const text = doc.line(n).text;
    if (inList(n)) to = n;
    else if (isBlank(text, quoteOf(text)) && n < doc.lines && inList(n + 1)) continue;
    else break;
  }
  return { from, to };
}

/**
 * Changes that renumber every ordered run in the list block around lineNo. Each run starts at its
 * smallest number (lists may intentionally start at 5).
 */
export function renumberChanges(state: EditorState, lineNo: number): ChangeSpec[] {
  const block = listBlock(state, lineNo);
  if (!block) return [];
  const doc = state.doc;
  type Entry = { from: number; item: ListLine };
  type Run = { items: Entry[]; ordered: boolean };
  const runs: Run[] = [];
  const stack: Array<{ w: number; run: Run }> = [];
  for (let n = block.from; n <= block.to; n++) {
    const line = doc.line(n);
    const item = parseListLine(line.text);
    if (!item) continue;
    const w = columns(item.indent);
    while (stack.length && stack[stack.length - 1].w > w) stack.pop();
    const top = stack[stack.length - 1];
    const ordered = item.num !== undefined;
    const entry = { from: line.from, item };
    if (top && top.w === w && top.run.ordered === ordered) top.run.items.push(entry);
    else {
      const run: Run = { items: [entry], ordered };
      runs.push(run);
      if (top && top.w === w) stack[stack.length - 1] = { w, run };
      else stack.push({ w, run });
    }
  }
  const changes: ChangeSpec[] = [];
  for (const run of runs) {
    if (!run.ordered) continue;
    const nums = run.items.map((e) => e.item.num!);
    if (nums.length >= 2 && nums.every((x) => x === nums[0])) continue; // lazy "1. 1. 1." style
    // min() keeps an intentional start ("5.") yet survives moving/deleting the first item.
    const start = Math.min(...nums);
    run.items.forEach((e, i) => {
      const want = start + i;
      if (e.item.num !== want) changes.push({ from: e.from + e.item.markerFrom, to: e.from + e.item.markerFrom + e.item.numStr!.length, insert: String(want) });
    });
  }
  return changes;
}

export const renumberList: StateCommand = ({ state, dispatch }) => {
  const changes = renumberChanges(state, state.doc.lineAt(state.selection.main.head).number);
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: 'input.renumber' }));
  return true;
};

/**
 * Keeps ordered lists numbered after structural edits (line moves, deletes, pastes, new lines).
 * Plain typing of digits is left alone so users can still set a list's start number.
 */
export const autoRenumber = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.annotation(Transaction.userEvent)) return tr;
  if (tr.isUserEvent('undo') || tr.isUserEvent('redo') || tr.isUserEvent('input.renumber')) return tr;
  if (tr.startState.doc.lines === tr.newDoc.lines && !tr.isUserEvent('move')) return tr;
  if (tr.newDoc.length > 2_000_000) return tr;
  const state = tr.state;
  const seen = new Set<number>();
  const changes: ChangeSpec[] = [];
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    const a = state.doc.lineAt(fromB).number;
    const b = state.doc.lineAt(toB).number;
    for (let n = Math.max(1, a - 1); n <= Math.min(state.doc.lines, b + 1); n++) {
      if (seen.has(n)) continue;
      const block = listBlock(state, n);
      if (!block) continue;
      for (let k = block.from; k <= block.to; k++) seen.add(k);
      changes.push(...renumberChanges(state, n));
    }
  });
  if (!changes.length) return tr;
  return [tr, { changes, sequential: true }];
});

/** Mod-Enter: plain → "- [ ] ", unchecked ↔ checked, bullet → task. */
export const toggleTask: StateCommand = ({ state, dispatch }) => {
  const changes: ChangeSpec[] = [];
  for (const n of selectedLines(state)) {
    const line = state.doc.line(n);
    const item = parseListLine(line.text);
    if (item?.task) {
      const at = line.from + item.contentFrom - item.task.length + 1;
      changes.push({ from: at, to: at + 1, insert: item.checked ? ' ' : 'x' });
    } else if (item) {
      const at = line.from + item.contentFrom;
      changes.push({ from: at, insert: '[ ] ' });
    } else {
      const quote = quoteOf(line.text);
      const ws = leadingWs(line.text, quote);
      changes.push({ from: line.from + quote.length + ws.length, insert: '- [ ] ' });
    }
  }
  if (!changes.length) return false;
  dispatch(state.update({ changes, userEvent: 'input.task', scrollIntoView: true }));
  return true;
};

/** Toggle the checkbox on the line containing pos (used by the live-preview checkbox widget). */
export function toggleTaskAt(state: EditorState, pos: number): TransactionSpec | null {
  const line = state.doc.lineAt(pos);
  const item = parseListLine(line.text);
  if (!item?.task) return null;
  const at = line.from + item.contentFrom - item.task.length + 1;
  return { changes: { from: at, to: at + 1, insert: item.checked ? ' ' : 'x' }, userEvent: 'input.task' };
}

/** Backspace right after "- [ ] " removes the checkbox, keeping the bullet. */
export const deleteTaskMarker: StateCommand = ({ state, dispatch }) => {
  const r = state.selection.main;
  if (!r.empty || state.selection.ranges.length > 1) return false;
  const line = state.doc.lineAt(r.head);
  const item = parseListLine(line.text);
  if (!item?.task || r.head !== line.from + item.contentFrom) return false;
  const from = line.from + item.contentFrom - item.task.length;
  dispatch(state.update({ changes: { from, to: r.head }, selection: EditorSelection.cursor(from), userEvent: 'delete.backward' }));
  return true;
};
