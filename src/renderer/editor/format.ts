// Inline Markdown formatting commands (Mod-b/i/k, strikethrough, highlight, code, headings, blocks).
// Pure StateCommands over EditorState → unit tested in Node.
import { EditorSelection, type EditorState, type ChangeSpec, type SelectionRange, type StateCommand } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

const NODES: Record<string, { node: string[]; mark: string }> = {
  '**': { node: ['StrongEmphasis'], mark: 'EmphasisMark' },
  '*': { node: ['Emphasis'], mark: 'EmphasisMark' },
  '~~': { node: ['Strikethrough'], mark: 'StrikethroughMark' },
  '==': { node: ['Highlight'], mark: 'HighlightMark' },
  '`': { node: ['InlineCode'], mark: 'CodeMark' },
};

function enclosing(state: EditorState, from: number, to: number, names: string[]): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(from, 1); n; n = n.parent) {
    if (names.includes(n.name)) {
      const inside = from === to ? n.from < from && from < n.to : n.from <= from && to <= n.to;
      if (inside) return n;
    }
  }
  if (from === to) {
    for (let n: SyntaxNode | null = tree.resolveInner(from, -1); n; n = n.parent) {
      if (names.includes(n.name) && n.from < from && from < n.to) return n;
    }
  }
  return null;
}

/** Count of `ch` immediately before pos / after pos. */
function runBefore(state: EditorState, pos: number, ch: string): number {
  let n = 0;
  while (pos - n - 1 >= 0 && state.doc.sliceString(pos - n - 1, pos - n) === ch) n++;
  return n;
}
function runAfter(state: EditorState, pos: number, ch: string): number {
  let n = 0;
  const len = state.doc.length;
  while (pos + n < len && state.doc.sliceString(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/** Whether markers of type m sit on both sides, using star-run parity for * vs **. */
function wrappedBy(m: string, before: number, after: number): boolean {
  if (m === '*') return before % 2 === 1 && after % 2 === 1;
  if (m === '**') return before >= 2 && after >= 2;
  return before >= 1 && after >= 1;
}

function toggleRange(state: EditorState, range: SelectionRange, m: string): { changes: ChangeSpec[]; range: SelectionRange } {
  const { from, to } = range;
  const info = NODES[m];
  const L = m.length;
  const node = enclosing(state, from, to, info.node);
  if (node) {
    const marks = node.getChildren(info.mark);
    if (marks.length >= 2) {
      const open = marks[0];
      const close = marks[marks.length - 1];
      const changes = [
        { from: open.from, to: open.to },
        { from: close.from, to: close.to },
      ];
      const cs = state.changes(changes);
      return { changes, range: EditorSelection.range(cs.mapPos(range.anchor, -1), cs.mapPos(range.head, -1)) };
    }
  }
  const ch = m[0];
  const isStar = ch === '*';
  if (range.empty) {
    const before = isStar ? runBefore(state, from, '*') : state.doc.sliceString(from - L, from) === m ? 1 : 0;
    const after = isStar ? runAfter(state, from, '*') : state.doc.sliceString(from, from + L) === m ? 1 : 0;
    if (wrappedBy(m, before, after)) {
      return { changes: [{ from: from - L, to: from + L }], range: EditorSelection.cursor(from - L) };
    }
    const word = state.wordAt(from);
    if (word && word.from <= from && from <= word.to && word.from < word.to) {
      return { changes: [{ from: word.from, insert: m }, { from: word.to, insert: m }], range: EditorSelection.cursor(from + L) };
    }
    return { changes: [{ from, insert: m + m }], range: EditorSelection.cursor(from + L) };
  }
  const text = state.doc.sliceString(from, to);
  // Markers inside the selection: "**bold**" selected.
  if (text.length > 2 * L) {
    const lead = isStar ? /^\*+/.exec(text)?.[0].length ?? 0 : text.startsWith(m) ? 1 : 0;
    const trail = isStar ? /\*+$/.exec(text)?.[0].length ?? 0 : text.endsWith(m) ? 1 : 0;
    if (wrappedBy(m, lead, trail) && (isStar || text.length >= 2 * L)) {
      return {
        changes: [
          { from, to: from + L },
          { from: to - L, to },
        ],
        range: EditorSelection.range(from, to - 2 * L),
      };
    }
  }
  // Markers just outside the selection: **[bold]**.
  const before = isStar ? runBefore(state, from, '*') : state.doc.sliceString(from - L, from) === m ? 1 : 0;
  const after = isStar ? runAfter(state, to, '*') : state.doc.sliceString(to, to + L) === m ? 1 : 0;
  if (wrappedBy(m, before, after)) {
    return {
      changes: [
        { from: from - L, to: from },
        { from: to, to: to + L },
      ],
      range: EditorSelection.range(from - L, to - L),
    };
  }
  // Wrap, keeping surrounding whitespace outside the markers ("**word** " not "**word **").
  const a = from + (text.length - text.trimStart().length);
  const b = to - (text.length - text.trimEnd().length);
  if (a >= b) return { changes: [{ from, insert: m + m }], range: EditorSelection.cursor(from + L) };
  return { changes: [{ from: a, insert: m }, { from: b, insert: m }], range: EditorSelection.range(a + L, b + L) };
}

export function toggleMarkup(marker: string): StateCommand {
  return ({ state, dispatch }) => {
    const spec = state.changeByRange((range) => toggleRange(state, range, marker));
    dispatch(state.update(spec, { userEvent: 'input.format', scrollIntoView: true }));
    return true;
  };
}

export const toggleBold = toggleMarkup('**');
export const toggleItalic = toggleMarkup('*');
export const toggleStrike = toggleMarkup('~~');
export const toggleHighlight = toggleMarkup('==');
export const toggleInlineCode = toggleMarkup('`');

const URL_RE = /^(https?:\/\/|mailto:|file:\/\/|www\.)[^\s]+$/i;
export const isUrl = (s: string | null | undefined): boolean => !!s && URL_RE.test(s.trim());

/** Mod-k: wrap selection as a link; a selected URL becomes the target; a clipboard URL is used as target. */
export function insertLink(clipboard?: string | null): StateCommand {
  return ({ state, dispatch }) => {
    const clip = isUrl(clipboard) ? clipboard!.trim() : '';
    const spec = state.changeByRange((range) => {
      const text = state.doc.sliceString(range.from, range.to);
      // Already inside a link: select its text for editing instead of nesting.
      const link = enclosing(state, range.from, range.to, ['Link']);
      if (link && range.empty) {
        const marks = link.getChildren('LinkMark');
        if (marks.length >= 2) return { range: EditorSelection.range(marks[0].to, marks[1].from) };
      }
      if (range.empty) {
        const insert = `[](${clip})`;
        return { changes: { from: range.from, insert }, range: EditorSelection.cursor(range.from + 1) };
      }
      if (isUrl(text)) {
        const insert = `[](${text.trim()})`;
        return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + 1) };
      }
      const insert = `[${text}](${clip})`;
      const cursor = clip ? range.from + insert.length : range.from + text.length + 3;
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(cursor) };
    });
    dispatch(state.update(spec, { userEvent: 'input.format', scrollIntoView: true }));
    return true;
  };
}

/** Set (or toggle off when equal) the ATX heading level of the selected lines. */
export function setHeading(level: number): StateCommand {
  return ({ state, dispatch }) => {
    const changes: ChangeSpec[] = [];
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to; ) {
        const line = state.doc.lineAt(pos);
        if (!seen.has(line.number)) {
          seen.add(line.number);
          const m = /^(#{1,6})[ \t]+|^(#{1,6})$/.exec(line.text);
          const cur = m ? (m[1] || m[2] || '').length : 0;
          const prefix = level === cur || level === 0 ? '' : '#'.repeat(level) + ' ';
          changes.push({ from: line.from, to: line.from + (m ? m[0].length : 0), insert: prefix });
        }
        pos = line.to + 1;
      }
    }
    dispatch(state.update({ changes, userEvent: 'input.format', scrollIntoView: true }));
    return true;
  };
}

/** Wrap the selected lines in a fence (or insert an empty fenced block). */
export function insertCodeBlock(lang = ''): StateCommand {
  return ({ state, dispatch }) => {
    const r = state.selection.main;
    const a = state.doc.lineAt(r.from);
    const b = state.doc.lineAt(r.to);
    if (!r.empty) {
      const body = state.doc.sliceString(a.from, b.to);
      const insert = '```' + lang + '\n' + body + '\n```';
      dispatch(state.update({ changes: { from: a.from, to: b.to, insert }, selection: EditorSelection.cursor(a.from + 3 + lang.length), userEvent: 'input', scrollIntoView: true }));
      return true;
    }
    const pre = a.text.trim() ? '\n' : '';
    const at = a.text.trim() ? a.to : a.from;
    const insert = pre + '```' + lang + '\n\n```';
    const cursor = at + pre.length + 3 + lang.length + (lang ? 1 : 0);
    dispatch(state.update({ changes: { from: at, to: a.text.trim() ? at : a.to, insert }, selection: EditorSelection.cursor(lang ? cursor : at + pre.length + 3), userEvent: 'input', scrollIntoView: true }));
    return true;
  };
}

/** Insert an Obsidian callout, quoting the selected lines when there is a selection. */
export function insertCallout(type = 'note'): StateCommand {
  return ({ state, dispatch }) => {
    const r = state.selection.main;
    const a = state.doc.lineAt(r.from);
    const b = state.doc.lineAt(r.to);
    const header = `> [!${type}] `;
    if (!r.empty) {
      const body = state.doc
        .sliceString(a.from, b.to)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      const insert = `${header}\n${body}`;
      dispatch(state.update({ changes: { from: a.from, to: b.to, insert }, selection: EditorSelection.cursor(a.from + header.length), userEvent: 'input', scrollIntoView: true }));
      return true;
    }
    const pre = a.text.trim() ? '\n\n' : '';
    const at = a.text.trim() ? a.to : a.from;
    const insert = `${pre}${header}Title\n> `;
    const start = at + pre.length + header.length;
    dispatch(state.update({ changes: { from: at, to: a.text.trim() ? at : a.to, insert }, selection: EditorSelection.range(start, start + 5), userEvent: 'input', scrollIntoView: true }));
    return true;
  };
}

export const insertHorizontalRule: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const pre = line.text.trim() ? '\n\n' : '';
  const at = line.text.trim() ? line.to : line.from;
  const insert = `${pre}---\n`;
  dispatch(state.update({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: EditorSelection.cursor(at + insert.length), userEvent: 'input', scrollIntoView: true }));
  return true;
};

export const insertMathBlock: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head);
  const pre = line.text.trim() ? '\n' : '';
  const at = line.text.trim() ? line.to : line.from;
  const insert = `${pre}$$\n\n$$`;
  dispatch(state.update({ changes: { from: at, to: line.text.trim() ? at : line.to, insert }, selection: EditorSelection.cursor(at + pre.length + 3), userEvent: 'input', scrollIntoView: true }));
  return true;
};

// ---------------------------------------------------------------- line kinds (toolbar list / quote toggles)

export type LineKind = 'bullet' | 'ordered' | 'task' | 'quote';

const QUOTE_PREFIX_RE = /^(?:[ \t]*>[ \t]?)+/;
/** indent, bullet | number, task box (a box without a list marker is plain text). */
const LIST_PREFIX_RE = /^([ \t]*)(?:([-*+])[ \t]+|(\d{1,9})[.)][ \t]+)(\[[ xX]\][ \t]+)?/;

function parseLinePrefix(text: string) {
  const q = QUOTE_PREFIX_RE.exec(text)?.[0] ?? '';
  const rest = text.slice(q.length);
  const m = LIST_PREFIX_RE.exec(rest);
  const kinds = new Set<LineKind>();
  if (q) kinds.add('quote');
  if (m) kinds.add(m[4] ? 'task' : m[2] ? 'bullet' : 'ordered');
  const indent = m ? m[1].length : /^[ \t]*/.exec(rest)![0].length;
  // [markerFrom, markerTo): the list marker (+ task box) after the quote prefix and indentation.
  return { kinds, markerFrom: q.length + indent, markerTo: q.length + (m ? m[0].length : indent) };
}

/**
 * Toggle a list / quote kind on the selected lines (toolbar). When every line already has the kind it is
 * removed; otherwise it replaces any other list marker (numbers count up from 1). Quotes wrap lists.
 */
export function toggleLineKind(kind: LineKind): StateCommand {
  return ({ state, dispatch }) => {
    const lines: Array<{ from: number; text: string }> = [];
    const seen = new Set<number>();
    for (const r of state.selection.ranges) {
      for (let pos = r.from; pos <= r.to; ) {
        const line = state.doc.lineAt(pos);
        if (!seen.has(line.number)) {
          seen.add(line.number);
          lines.push({ from: line.from, text: line.text });
        }
        pos = line.to + 1;
      }
    }
    const targets = lines.length > 1 ? lines.filter((l) => l.text.trim()) : lines;
    if (!targets.length) return false;
    const all = targets.every((l) => parseLinePrefix(l.text).kinds.has(kind));
    const changes: ChangeSpec[] = [];
    let n = 0;
    for (const l of targets) {
      if (kind === 'quote') {
        const m = /^([ \t]*)>[ \t]?/.exec(l.text);
        if (all && m) changes.push({ from: l.from + m[1].length, to: l.from + m[0].length });
        else if (!all && !m) changes.push({ from: l.from, insert: '> ' });
        continue;
      }
      const p = parseLinePrefix(l.text);
      const insert = all ? '' : kind === 'bullet' ? '- ' : kind === 'task' ? '- [ ] ' : `${++n}. `;
      changes.push({ from: l.from + p.markerFrom, to: l.from + p.markerTo, insert });
    }
    if (!changes.length) return false;
    const set = state.changes(changes);
    // A caret at the start of a line moves behind the new marker; a selection grows to include the markers.
    const selection = EditorSelection.create(
      state.selection.ranges.map((r) =>
        r.empty ? EditorSelection.cursor(set.mapPos(r.head, 1)) : EditorSelection.range(set.mapPos(r.anchor, r.anchor < r.head ? -1 : 1), set.mapPos(r.head, r.anchor < r.head ? 1 : -1)),
      ),
      state.selection.mainIndex,
    );
    dispatch(state.update({ changes: set, selection, userEvent: 'input.format', scrollIntoView: true }));
    return true;
  };
}

// ---------------------------------------------------------------- active formatting (toolbar state)

export interface FormatState {
  /** ATX/Setext heading level of the cursor line, 0 = paragraph. */
  heading: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  highlight: boolean;
  code: boolean;
  link: boolean;
  bullet: boolean;
  ordered: boolean;
  task: boolean;
  quote: boolean;
  callout: boolean;
  codeBlock: boolean;
  table: boolean;
  math: boolean;
}

const CALLOUT_LINE = /^(?:[ \t]*>[ \t]?)+[ \t]*\[![\w-]+\]/;

/** What the toolbar should light up for the main selection. Pure: syntax tree + doc only. */
export function formatState(state: EditorState): FormatState {
  const s: FormatState = { heading: 0, bold: false, italic: false, strike: false, highlight: false, code: false, link: false, bullet: false, ordered: false, task: false, quote: false, callout: false, codeBlock: false, table: false, math: false };
  const { from, to, head, empty } = state.selection.main;
  const tree = syntaxTree(state);
  const seen = new Set<string>();
  const visit = (start: SyntaxNode | null) => {
    for (let n = start; n; n = n.parent) {
      const key = `${n.name}:${n.from}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Inline marks: strictly inside (cursor right after "**bold**" is not bold). Blocks: touching counts.
      const inside = empty ? n.from < head && head < n.to : n.from <= from && to <= n.to;
      const touching = n.from <= from && to <= n.to;
      switch (n.name) {
        case 'StrongEmphasis': s.bold ||= inside; break;
        case 'Emphasis': s.italic ||= inside; break;
        case 'Strikethrough': s.strike ||= inside; break;
        case 'Highlight': s.highlight ||= inside; break;
        case 'InlineCode': s.code ||= inside; break;
        case 'Link': case 'WikiLink': case 'Autolink': s.link ||= inside; break;
        case 'InlineMath': case 'BlockMath': s.math ||= touching; break;
        case 'FencedCode': case 'CodeBlock': s.codeBlock ||= touching; break;
        case 'Table': s.table ||= touching; break;
        case 'ListItem':
          if (touching && !s.bullet && !s.ordered && !s.task) {
            if (n.getChild('Task')) s.task = true;
            else if (n.parent?.name === 'OrderedList') s.ordered = true;
            else s.bullet = true;
          }
          break;
        case 'Blockquote':
          if (touching) {
            if (CALLOUT_LINE.test(state.doc.lineAt(n.from).text)) s.callout = true;
            else s.quote = true;
          }
          break;
        default: {
          const h = /^(?:ATXHeading|SetextHeading)(\d)$/.exec(n.name);
          if (h && touching && !s.heading) s.heading = +h[1];
        }
      }
    }
  };
  visit(tree.resolveInner(head, 1));
  visit(tree.resolveInner(head, -1));
  if (!empty) visit(tree.resolveInner(from, 1));
  return s;
}
