// Slash menu catalog + pure insert transactions (no DOM / app imports → unit tested in Node).
// The UI (slash.ts) adds dynamic submenus (commands, images, templates) on top of this.
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import { fuzzyFilter } from '../../search/fuzzy';
import { formatDate } from '../../knowledge/templates';
import { formatTableLines } from './tables';

export type SlashAction =
  | { type: 'heading'; level: number }
  /** Line prefix: "- ", "1. ", "- [ ] ", "> ". Replaces any existing list/quote/heading prefix. */
  | { type: 'line'; prefix: string }
  /** Block on its own line(s); `cursor` = offset into text, `select` = selection length from there. */
  | { type: 'block'; text: string; cursor?: number; select?: number }
  | { type: 'inline'; text: string; cursor?: number }
  | { type: 'footnote' }
  | { type: 'table'; cols: number; rows: number };

export interface SlashItem {
  id: string;
  title: string;
  icon: string;
  keywords?: string[];
  /** Right-aligned hint (markdown syntax or a shortcut). */
  hint?: string;
  /** Section heading when the menu is unfiltered. */
  group?: string;
  /** Opens this submenu instead of inserting. */
  submenu?: string;
  /** Only listed when the user typed a query (deep items like "Warning callout"). */
  searchOnly?: boolean;
  action?: SlashAction;
  /** Open autocompletion after inserting (code fence languages, [[note names). */
  complete?: boolean;
  /** Handled by the UI layer (needs the app): properties, run command, upload, template… */
  special?: string;
  /** Payload for special items (command id, file path, …). */
  data?: string;
  /** Callout kind → accent colour in the menu. */
  tone?: string;
  disabled?: boolean;
}

export interface SlashMatch {
  item: SlashItem;
  /** Matched character positions in the title (for highlighting). */
  positions: number[];
}

// Same canonical kinds + aliases as the live-preview callouts (widgets.ts CALLOUTS).
export const CALLOUT_KINDS: Array<{ kind: string; icon: string; aliases: string[] }> = [
  { kind: 'note', icon: 'pencil', aliases: [] },
  { kind: 'abstract', icon: 'clipboard', aliases: ['summary', 'tldr'] },
  { kind: 'info', icon: 'info', aliases: [] },
  { kind: 'todo', icon: 'todo', aliases: [] },
  { kind: 'tip', icon: 'flame', aliases: ['hint', 'important'] },
  { kind: 'success', icon: 'check', aliases: ['check', 'done'] },
  { kind: 'question', icon: 'help', aliases: ['help', 'faq'] },
  { kind: 'warning', icon: 'warning', aliases: ['warn', 'caution', 'attention'] },
  { kind: 'failure', icon: 'x', aliases: ['fail', 'missing'] },
  { kind: 'danger', icon: 'zap', aliases: ['error'] },
  { kind: 'bug', icon: 'bug', aliases: [] },
  { kind: 'example', icon: 'list', aliases: [] },
  { kind: 'quote', icon: 'quote', aliases: ['cite'] },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function calloutItems(searchOnly: boolean): SlashItem[] {
  return CALLOUT_KINDS.map((c) => ({
    id: `callout-${c.kind}`,
    title: searchOnly ? `${cap(c.kind)} callout` : cap(c.kind),
    icon: c.icon,
    tone: c.kind,
    keywords: [...c.aliases, ...(searchOnly ? ['callout', 'admonition'] : [])],
    hint: searchOnly ? `[!${c.kind}]` : c.aliases.length ? c.aliases.join(', ') : undefined,
    searchOnly,
    action: calloutAction(c.kind),
  }));
}

function calloutAction(kind: string): SlashAction {
  const head = `> [!${kind}] `;
  return { type: 'block', text: `${head}${cap(kind)}\n> `, cursor: head.length + cap(kind).length + 3 };
}

export function dateItems(now: Date, dateFmt = 'YYYY-MM-DD', timeFmt = 'HH:mm', searchOnly = false): SlashItem[] {
  const day = (offset: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, now.getHours(), now.getMinutes());
  const mk = (id: string, title: string, text: string, icon: string, keywords: string[]): SlashItem => ({
    id: `date-${id}`,
    title,
    icon,
    hint: text,
    keywords,
    searchOnly,
    action: { type: 'inline', text },
  });
  return [
    mk('today', 'Today', formatDate(now, dateFmt), 'calendar', ['date', 'today']),
    mk('now', 'Now', `${formatDate(now, dateFmt)} ${formatDate(now, timeFmt)}`, 'calendar-clock', ['datetime', 'timestamp', 'now']),
    mk('time', 'Time', formatDate(now, timeFmt), 'clock', ['clock', 'hour']),
    mk('tomorrow', 'Tomorrow', formatDate(day(1), dateFmt), 'calendar', ['date', 'next day']),
    mk('yesterday', 'Yesterday', formatDate(day(-1), dateFmt), 'calendar', ['date', 'previous day']),
  ];
}

export const MERMAID_STARTER = 'flowchart LR\n  A[Start] --> B{Decide}\n  B -->|yes| C[Do it]\n  B -->|no| D[Skip]';

/** The root menu (static part). */
export function rootItems(): SlashItem[] {
  const heading = (n: number, searchOnly = false): SlashItem => ({
    id: `h${n}`,
    title: `Heading ${n}`,
    icon: n <= 3 ? `h${n}` : 'heading',
    hint: '#'.repeat(n),
    keywords: [`h${n}`, 'title', 'header', 'section'],
    group: 'Basic',
    searchOnly,
    action: { type: 'heading', level: n },
  });
  return [
    heading(1),
    heading(2),
    heading(3),
    heading(4, true),
    heading(5, true),
    heading(6, true),
    { id: 'bullet', title: 'Bullet list', icon: 'list', hint: '-', keywords: ['ul', 'unordered', 'bullets', 'list'], group: 'Basic', action: { type: 'line', prefix: '- ' } },
    { id: 'numbered', title: 'Numbered list', icon: 'ordered', hint: '1.', keywords: ['ol', 'ordered', 'numbers', 'list'], group: 'Basic', action: { type: 'line', prefix: '1. ' } },
    { id: 'task', title: 'Task list', icon: 'task', hint: '- [ ]', keywords: ['todo', 'checkbox', 'check', 'checklist'], group: 'Basic', action: { type: 'line', prefix: '- [ ] ' } },
    { id: 'quote', title: 'Quote', icon: 'quote', hint: '>', keywords: ['blockquote', 'citation'], group: 'Basic', action: { type: 'line', prefix: '> ' } },
    { id: 'divider', title: 'Divider', icon: 'minus', hint: '---', keywords: ['hr', 'horizontal rule', 'separator', 'line'], group: 'Basic', action: { type: 'block', text: '---\n', cursor: 4 } },
    { id: 'table', title: 'Table', icon: 'table', keywords: ['grid', 'columns', 'rows', 'spreadsheet'], group: 'Insert', submenu: 'table' },
    { id: 'code', title: 'Code block', icon: 'code', hint: '```', keywords: ['pre', 'snippet', 'fence', 'source', 'program'], group: 'Insert', action: { type: 'block', text: '```\n```', cursor: 3 }, complete: true },
    { id: 'callout', title: 'Callout', icon: 'info', keywords: ['admonition', 'alert', 'box', 'note'], group: 'Insert', submenu: 'callout' },
    { id: 'math', title: 'Math block', icon: 'sigma', hint: '$$', keywords: ['latex', 'katex', 'equation', 'formula', 'tex'], group: 'Insert', action: { type: 'block', text: '$$\n\n$$', cursor: 3 } },
    {
      id: 'mermaid',
      title: 'Mermaid diagram',
      icon: 'workflow',
      keywords: ['diagram', 'flowchart', 'chart', 'graph', 'sequence', 'uml'],
      group: 'Insert',
      action: { type: 'block', text: '```mermaid\n' + MERMAID_STARTER + '\n```', cursor: 11, select: MERMAID_STARTER.length },
    },
    { id: 'image', title: 'Image…', icon: 'image', keywords: ['picture', 'photo', 'img', 'screenshot', 'upload', 'attachment'], group: 'Insert', submenu: 'image' },
    { id: 'footnote', title: 'Footnote', icon: 'footnote', hint: '[^1]', keywords: ['reference', 'citation', 'note'], group: 'Insert', action: { type: 'footnote' } },
    { id: 'date', title: 'Date / time', icon: 'calendar', keywords: ['today', 'now', 'time', 'timestamp', 'clock'], group: 'Insert', submenu: 'date' },
    { id: 'link', title: 'Link to note', icon: 'link', hint: '[[', keywords: ['wikilink', 'internal', 'reference', 'page'], group: 'Notes', action: { type: 'inline', text: '[[]]', cursor: 2 }, complete: true },
    { id: 'embed', title: 'Embed note', icon: 'file', hint: '![[', keywords: ['transclude', 'transclusion', 'include'], group: 'Notes', action: { type: 'inline', text: '![[]]', cursor: 3 }, complete: true },
    { id: 'properties', title: 'Properties', icon: 'sliders', hint: '---', keywords: ['front matter', 'frontmatter', 'yaml', 'metadata', 'tags', 'aliases'], group: 'Notes', special: 'properties' },
    { id: 'template', title: 'Template…', icon: 'template', keywords: ['boilerplate', 'snippet'], group: 'Notes', submenu: 'template' },
    { id: 'command', title: 'Run command…', icon: 'terminal', keywords: ['palette', 'action', 'execute', '>'], group: 'Commands', submenu: 'command' },
    ...calloutItems(true),
  ];
}

/** Fuzzy filter over titles and keywords; keyword hits rank a little below title hits. */
export function filterSlashItems(query: string, items: SlashItem[], limit = 60): SlashMatch[] {
  const q = query.trim();
  if (!q) return items.filter((i) => !i.searchOnly).slice(0, limit).map((item) => ({ item, positions: [] }));
  const entries: Array<{ item: SlashItem; key: string; idx: number; alias: boolean }> = [];
  items.forEach((item, idx) => {
    entries.push({ item, key: item.title, idx, alias: false });
    for (const k of item.keywords ?? []) entries.push({ item, key: k, idx, alias: true });
  });
  const best = new Map<SlashItem, { score: number; positions: number[]; idx: number }>();
  for (const { item: e, match } of fuzzyFilter(q, entries, (e) => e.key, 2000)) {
    const exact = e.key.toLowerCase() === q.toLowerCase();
    // Exact keyword hits ("todo", "pre") beat incidental fuzzy title matches; an exact title beats both.
    const score = match.score + (exact ? (e.alias ? 16 : 24) : e.alias ? -6 : 0);
    const prev = best.get(e.item);
    if (!prev || score > prev.score) best.set(e.item, { score, positions: e.alias ? prev?.positions ?? [] : match.positions, idx: e.idx });
    else if (!e.alias && !prev.positions.length) prev.positions = match.positions;
  }
  return [...best.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].idx - b[1].idx)
    .slice(0, limit)
    .map(([item, m]) => ({ item, positions: m.positions }));
}

/** Parses "4x3", "4 × 3", "4*3" (cols × rows) typed into the table picker. */
export function parseTableSize(q: string): { cols: number; rows: number } | null {
  const m = /^\s*(\d{1,2})\s*(?:[x×*,]\s*(\d{1,2}))?\s*$/i.exec(q);
  if (!m) return null;
  const cols = Math.min(Math.max(+m[1], 1), 20);
  const rows = Math.min(Math.max(m[2] ? +m[2] : 3, 1), 50);
  return { cols, rows };
}

/** GFM table with `cols` columns and `rows` rows (header included), padded with formatTableLines. */
export function tableMarkdown(cols: number, rows: number): string {
  const header = '| ' + Array.from({ length: cols }, (_, i) => `Column ${i + 1}`).join(' | ') + ' |';
  const delim = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |';
  const body = Array.from({ length: Math.max(rows - 1, 1) }, () => '|' + ' |'.repeat(cols));
  return formatTableLines([header, delim, ...body]).join('\n');
}

const PREFIX_RE = /^([ \t]*)(?:#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;

export function nextFootnoteLabel(doc: string): string {
  let max = 0;
  for (const m of doc.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, +m[1]);
  return String(max + 1);
}

/**
 * Transaction that removes the typed "/query" (from..to, on one line) and performs `action`.
 * Line actions restyle the current line; blocks go on their own line(s) with blank-line separation.
 */
export function slashTransaction(state: EditorState, from: number, to: number, action: SlashAction): TransactionSpec {
  const doc = state.doc;
  const line = doc.lineAt(from);
  const end = Math.min(to, line.to);
  const before = line.text.slice(0, from - line.from);
  const after = line.text.slice(end - line.from);
  const rest = before + after; // the line without the slash query
  const caret = before.length; // caret column within `rest`
  const userEvent = 'input.slash';

  switch (action.type) {
    case 'heading':
    case 'line': {
      const m = PREFIX_RE.exec(rest)!;
      const indent = action.type === 'heading' ? '' : m[1];
      const oldPrefix = m[0].length;
      const body = rest.slice(oldPrefix);
      const prefix = action.type === 'heading' ? '#'.repeat(action.level) + ' ' : action.prefix;
      const text = indent + prefix + body;
      const col = indent.length + prefix.length + Math.max(0, caret - oldPrefix);
      return { changes: { from: line.from, to: line.to, insert: text }, selection: EditorSelection.cursor(line.from + col), userEvent, scrollIntoView: true };
    }
    case 'inline': {
      const cursor = action.cursor ?? action.text.length;
      return { changes: { from, to: end, insert: action.text }, selection: EditorSelection.cursor(from + cursor), userEvent, scrollIntoView: true };
    }
    case 'footnote': {
      const label = nextFootnoteLabel(doc.toString());
      const ref = `[^${label}]`;
      const text = doc.toString();
      const body = text.replace(/\s+$/, '');
      const tailBreaks = (text.slice(body.length).match(/\n/g) ?? []).length;
      const lastLine = body.slice(body.lastIndexOf('\n') + 1);
      // Directly under an existing definition; otherwise separated by a blank line.
      const want = !body ? 0 : /^\[\^[^\]]+\]:/.test(lastLine) ? 1 : 2;
      const def = '\n'.repeat(Math.max(0, want - tailBreaks)) + `${ref}: `;
      return {
        changes: [
          { from, to: end, insert: ref },
          { from: doc.length, insert: def },
        ],
        selection: EditorSelection.cursor(doc.length - (end - from) + ref.length + def.length),
        userEvent,
        scrollIntoView: true,
      };
    }
    case 'table':
    case 'block': {
      const text = action.type === 'table' ? tableMarkdown(action.cols, action.rows) : action.text;
      const cursor = action.type === 'table' ? 2 : action.cursor ?? text.length;
      const select = action.type === 'table' ? 'Column 1'.length : action.select ?? 0;
      // A line holding only a list/quote marker counts as empty: the block replaces it.
      const blank = !rest.slice(PREFIX_RE.exec(rest)![0].length).trim();
      const prevText = line.number > 1 ? doc.line(line.number - 1).text : '';
      const nextText = line.number < doc.lines ? doc.line(line.number + 1).text : '';
      const keep = blank ? '' : rest.replace(/[ \t]+$/, '');
      const pre = blank ? (prevText.trim() ? '\n' : '') : '\n\n';
      const post = !text.endsWith('\n') && nextText.trim() ? '\n' : '';
      const insert = keep + pre + text + post;
      const insertFrom = line.from;
      const insertTo = line.to;
      const start = insertFrom + keep.length + pre.length + cursor;
      return { changes: { from: insertFrom, to: insertTo, insert }, selection: EditorSelection.range(start, start + select), userEvent, scrollIntoView: true };
    }
  }
}

/** Where the slash menu may open: "/" typed at line start or after whitespace (context checks are the caller's). */
export function slashTriggerOk(lineTextBefore: string): boolean {
  return lineTextBefore === '' || /\s$/.test(lineTextBefore);
}
