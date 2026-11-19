// GFM table editing (Advanced-Tables style): Tab/Shift-Tab cell navigation, Enter adds a row,
// and pipe alignment. Text based → works on partially parsed docs and is unit tested in Node.
import { EditorSelection, type EditorState, type StateCommand, type TransactionSpec } from '@codemirror/state';

export type Align = 'left' | 'right' | 'center' | null;

export interface Row {
  indent: string;
  cells: string[];
}

const DELIM_CELL = /^\s*:?-+:?\s*$/;

/** Split a row on unescaped pipes (ignores pipes inside `code`). */
export function splitRow(text: string): Row {
  const indent = /^\s*/.exec(text)![0];
  const s = text.slice(indent.length);
  const cells: string[] = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      cur += ch + s[++i];
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  // Leading/trailing pipes produce empty edge cells.
  if (s.startsWith('|')) cells.shift();
  if (cells.length > 1 && /\|\s*$/.test(s) && cells[cells.length - 1].trim() === '') cells.pop();
  return { indent, cells: cells.map((c) => c.trim()) };
}

export function isDelimiterRow(text: string): boolean {
  if (!text.includes('-')) return false;
  const { cells } = splitRow(text);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

export function isTableRow(text: string): boolean {
  return text.includes('|') && text.trim().length > 0;
}

function alignOf(cell: string): Align {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
}

/** Display width (wide CJK / emoji count double). */
export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x300 && c <= 0x36f) continue; // combining marks
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd) ? 2 : 1;
  }
  return w;
}

function pad(text: string, width: number, align: Align): string {
  const gap = Math.max(0, width - strWidth(text));
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') return ' '.repeat(Math.floor(gap / 2)) + text + ' '.repeat(Math.ceil(gap / 2));
  return text + ' '.repeat(gap);
}

function delimCell(width: number, align: Align): string {
  if (align === 'center') return ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
  if (align === 'right') return '-'.repeat(Math.max(2, width - 1)) + ':';
  if (align === 'left') return ':' + '-'.repeat(Math.max(2, width - 1));
  return '-'.repeat(Math.max(3, width));
}

/** Align pipes. lines[1] must be the delimiter row. Missing cells are padded. */
export function formatTableLines(lines: string[]): string[] {
  const rows = lines.map(splitRow);
  const indent = rows[0]?.indent ?? '';
  const hasDelim = lines.length > 1 && isDelimiterRow(lines[1]);
  const cols = Math.max(...rows.map((r) => r.cells.length));
  const aligns: Align[] = [];
  for (let c = 0; c < cols; c++) aligns.push(hasDelim ? alignOf(rows[1].cells[c] ?? '') : null);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 3;
    rows.forEach((r, i) => {
      if (hasDelim && i === 1) return;
      w = Math.max(w, strWidth(r.cells[c] ?? ''));
    });
    widths.push(w);
  }
  return rows.map((r, i) => {
    const cells = widths.map((w, c) => (hasDelim && i === 1 ? delimCell(w, aligns[c]) : pad(r.cells[c] ?? '', w, aligns[c])));
    return `${indent}| ${cells.join(' | ')} |`;
  });
}

export interface TableRange {
  fromLine: number; // 1-based line numbers
  toLine: number;
  lines: string[];
  from: number;
  to: number;
}

/** The table (header + delimiter + rows) around pos, or null. */
export function tableAt(state: EditorState, pos: number): TableRange | null {
  const doc = state.doc;
  const cur = doc.lineAt(pos);
  if (!isTableRow(cur.text)) return null;
  let a = cur.number;
  let b = cur.number;
  while (a > 1 && isTableRow(doc.line(a - 1).text)) a--;
  while (b < doc.lines && isTableRow(doc.line(b).text) && isTableRow(doc.line(b + 1).text)) b++;
  // Header must be directly followed by the delimiter row.
  let start = -1;
  for (let n = a; n < b; n++) {
    if (isDelimiterRow(doc.line(n + 1).text) && !isDelimiterRow(doc.line(n).text)) {
      start = n;
      break;
    }
  }
  if (start < 0 || cur.number < start) return null;
  const lines: string[] = [];
  for (let n = start; n <= b; n++) lines.push(doc.line(n).text);
  return { fromLine: start, toLine: b, lines, from: doc.line(start).from, to: doc.line(b).to };
}

/** Index of the cell containing column `col` of a row line. */
export function cellIndexAt(text: string, col: number): number {
  const indent = /^\s*/.exec(text)![0].length;
  let idx = 0;
  let inCode = false;
  const lead = text.slice(indent).startsWith('|');
  for (let i = indent + (lead ? 1 : 0); i < col && i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) idx++;
  }
  return idx;
}

/** Offsets (within a formatted line) of each cell's content [from, to). */
export function cellRanges(text: string): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const pipes: number[] = [];
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) pipes.push(i);
  }
  const indent = /^\s*/.exec(text)![0].length;
  const lead = text[indent] === '|';
  const bounds = lead ? pipes : [indent - 1, ...pipes];
  for (let i = 0; i < bounds.length; i++) {
    const start = bounds[i] + 1;
    const end = i + 1 < bounds.length ? bounds[i + 1] : text.length;
    if (i + 1 >= bounds.length && text.slice(start).trim() === '' && lead) break;
    const raw = text.slice(start, end);
    const l = raw.length - raw.trimStart().length;
    const content = raw.trim();
    const from = start + (content ? l : Math.min(1, raw.length));
    out.push({ from, to: from + content.length });
  }
  return out;
}

function emptyRow(cols: number, indent: string): string {
  return `${indent}|${' |'.repeat(cols)}`;
}

/** Format the table and move to a cell (row index in table lines, col index). Appends rows as needed. */
function moveSpec(state: EditorState, t: TableRange, row: number, col: number, extraRowAt?: number): TransactionSpec {
  let lines = t.lines.slice();
  const cols = Math.max(...lines.map((l) => splitRow(l).cells.length));
  if (extraRowAt !== undefined) lines.splice(extraRowAt, 0, emptyRow(cols, splitRow(lines[0]).indent));
  lines = formatTableLines(lines);
  const text = lines.join('\n');
  let offset = 0;
  for (let i = 0; i < row; i++) offset += lines[i].length + 1;
  const cells = cellRanges(lines[row]);
  const cell = cells[Math.min(col, cells.length - 1)] ?? { from: 2, to: 2 };
  const anchor = t.from + offset + cell.from;
  const head = t.from + offset + cell.to;
  const changes = text === state.doc.sliceString(t.from, t.to) ? [] : [{ from: t.from, to: t.to, insert: text }];
  return { changes, selection: EditorSelection.range(anchor, head), scrollIntoView: true, userEvent: 'input.table' };
}

function cursorCell(state: EditorState, t: TableRange): { row: number; col: number; cols: number } {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const row = line.number - t.fromLine;
  const col = cellIndexAt(line.text, head - line.from);
  const cols = Math.max(...t.lines.map((l) => splitRow(l).cells.length));
  return { row, col: Math.min(col, cols - 1), cols };
}

export function tableNextCellSpec(state: EditorState): TransactionSpec | null {
  const t = tableAt(state, state.selection.main.head);
  if (!t) return null;
  let { row, col, cols } = cursorCell(state, t);
  col++;
  if (col >= cols) {
    col = 0;
    row++;
    if (row === 1) row = 2;
  }
  if (row >= t.lines.length) return moveSpec(state, t, t.lines.length, 0, t.lines.length);
  return moveSpec(state, t, row, col);
}

export function tablePrevCellSpec(state: EditorState): TransactionSpec | null {
  const t = tableAt(state, state.selection.main.head);
  if (!t) return null;
  let { row, col, cols } = cursorCell(state, t);
  col--;
  if (col < 0) {
    row--;
    if (row === 1) row = 0;
    if (row < 0) return moveSpec(state, t, 0, 0);
    col = cols - 1;
  }
  return moveSpec(state, t, row, col);
}

export function tableEnterSpec(state: EditorState): TransactionSpec | null {
  const t = tableAt(state, state.selection.main.head);
  if (!t) return null;
  const { row } = cursorCell(state, t);
  const isLast = row === t.lines.length - 1;
  const cur = splitRow(t.lines[row]);
  // Enter on an empty last row leaves the table.
  if (isLast && row > 1 && cur.cells.every((c) => c === '')) {
    const lines = formatTableLines(t.lines.slice(0, -1));
    const text = lines.join('\n') + '\n';
    return { changes: { from: t.from, to: t.to, insert: text }, selection: EditorSelection.cursor(t.from + text.length), scrollIntoView: true, userEvent: 'input.table' };
  }
  const at = row <= 1 ? 2 : row + 1;
  return moveSpec(state, t, at, 0, at);
}

export function formatTableSpec(state: EditorState): TransactionSpec | null {
  const t = tableAt(state, state.selection.main.head);
  if (!t) return null;
  const { row, col } = cursorCell(state, t);
  return moveSpec(state, t, row, col);
}

const asCommand =
  (fn: (s: EditorState) => TransactionSpec | null): StateCommand =>
  ({ state, dispatch }) => {
    if (state.selection.ranges.length > 1) return false;
    const spec = fn(state);
    if (!spec) return false;
    dispatch(state.update(spec));
    return true;
  };

export const tableNextCell = asCommand(tableNextCellSpec);
export const tablePrevCell = asCommand(tablePrevCellSpec);
export const tableEnter = asCommand(tableEnterSpec);
export const formatTable = asCommand(formatTableSpec);

/** Insert a 2x2 table at the cursor (on its own lines), selecting the first header cell. */
export const insertTable: StateCommand = ({ state, dispatch }) => {
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  const before = line.text.trim() ? '\n\n' : line.from > 0 && state.doc.lineAt(line.from - 1).text.trim() ? '\n' : '';
  const at = line.text.trim() ? line.to : line.from;
  const table = formatTableLines(['| Column 1 | Column 2 |', '| --- | --- |', '| | |']).join('\n');
  const insert = before + table + '\n';
  const start = at + before.length + 2;
  dispatch(state.update({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: EditorSelection.range(start, start + 'Column 1'.length), scrollIntoView: true, userEvent: 'input' }));
  return true;
};
