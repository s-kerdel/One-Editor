// File-overview data: pure functions over one document's text (no DOM, no app state). Built on the
// scanners other features already use — search's Markdown structure scan (ATX + setext headings,
// fences incl. `~~~` and fences inside lists/quotes, frontmatter) and the Ctrl+Shift+O symbol scan —
// and memoised per content string, so tab switches and cursor moves never rescan a 1 MB note.
import { associationsVersion, languageById } from '@shared/languages';
import { parseStructure, K_FENCE, K_TEXT, type DocStructure } from '../../search/markdown';
import { extractNote, plainHeading, type NoteInfo } from '../../knowledge/extract';
import { countWords } from '../app/wordcount';
import { codeSymbols } from './symbols';

// ---------------------------------------------------------------- outline

export interface OutlineEntry {
  line: number; // 0-based
  /** Heading level 1–6, or symbol level (1 top-level, 2 member). */
  level: number;
  text: string;
  kind: 'heading' | 'symbol';
  /** Symbol kind ('class', 'function', 'const' …). */
  detail?: string;
  /** Nesting depth in the tree (an h1 → h3 jump indents once). */
  depth: number;
  /** Index of the parent entry, -1 at the top. */
  parent: number;
  hasChildren: boolean;
  /** Last line of this entry's section (before the next entry at the same or a higher level). */
  end: number;
  /** Stable across edits elsewhere in the file (fold state survives typing). */
  key: string;
}

type RawEntry = Pick<OutlineEntry, 'line' | 'level' | 'text' | 'kind' | 'detail'>;

/** Adds tree structure (depth, parent, children, section end, keys) to a flat, line-ordered list. */
export function nestOutline(raw: RawEntry[], lastLine: number): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const stack: number[] = [];
  const seen = new Map<string, number>();
  for (const r of raw) {
    while (stack.length && out[stack[stack.length - 1]].level >= r.level) out[stack.pop()!].end = r.line - 1;
    const parent = stack.length ? stack[stack.length - 1] : -1;
    if (parent >= 0) out[parent].hasChildren = true;
    const base = `${r.level}:${r.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ ...r, depth: stack.length, parent, hasChildren: false, end: lastLine, key: n ? `${base}#${n}` : base });
    stack.push(out.length - 1);
  }
  return out;
}

export function markdownOutline(s: DocStructure): OutlineEntry[] {
  const raw: RawEntry[] = [];
  for (const h of s.headings) {
    const text = plainHeading(h.text);
    if (text) raw.push({ line: h.line, level: h.level, text, kind: 'heading' });
  }
  return nestOutline(raw, s.lineStarts.length - 1);
}

export function codeOutline(path: string, content: string, lastLine: number): OutlineEntry[] {
  return nestOutline(
    codeSymbols(path, content).map((s) => ({ line: s.line, level: s.level, text: s.text, kind: 'symbol' as const, detail: s.detail })),
    lastLine,
  );
}

/** Index of the last item starting at or before `line` (binary search), -1 if none. */
export function lastAtOrBefore(items: ReadonlyArray<{ line: number }>, line: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].line <= line) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** The innermost outline entry whose section contains `line` (-1 above the first one). */
export function activeOutlineIndex(entries: readonly OutlineEntry[], line: number): number {
  return line < 0 ? -1 : lastAtOrBefore(entries, line);
}

export interface OutlineRow {
  i: number;
  collapsed: boolean;
}

/** Visible rows given the folded keys (children of a folded entry are hidden). */
export function visibleOutlineRows(entries: readonly OutlineEntry[], folded: ReadonlySet<string>): OutlineRow[] {
  const rows: OutlineRow[] = [];
  let hideDepth = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.depth > hideDepth) continue;
    hideDepth = Infinity;
    const collapsed = e.hasChildren && folded.has(e.key);
    rows.push({ i, collapsed });
    if (collapsed) hideDepth = e.depth;
  }
  return rows;
}

/** The entry to highlight: `idx`, or its nearest ancestor that is visible (folded parents hide it). */
export function visibleAncestor(entries: readonly OutlineEntry[], folded: ReadonlySet<string>, idx: number): number {
  if (idx < 0) return -1;
  let shown = idx;
  for (let p = entries[idx].parent; p >= 0; p = entries[p].parent) if (folded.has(entries[p].key)) shown = p;
  return shown;
}

/** Fold set for "show `levels` levels": every parent at depth ≥ levels - 1 is folded (0 = fold everything). */
export function foldToLevel(entries: readonly OutlineEntry[], levels: number): Set<string> {
  const out = new Set<string>();
  for (const e of entries) if (e.hasChildren && e.depth >= levels - 1) out.add(e.key);
  return out;
}

export function maxDepth(entries: readonly OutlineEntry[]): number {
  let d = 0;
  for (const e of entries) if (e.depth + 1 > d) d = e.depth + 1;
  return d;
}

// ---------------------------------------------------------------- code blocks

export interface CodeBlockEntry {
  /** Fence line (0-based). */
  line: number;
  endLine: number;
  /** Fence info word as written ("bash"), '' when none. */
  lang: string;
  /** First meaningful line — the command — for the row label. */
  label: string;
  /** Leading comment, when the label skipped one (tooltip context). */
  note?: string;
  /** Content lines (without fences). */
  lines: number;
  closed: boolean;
}

const lineOf = (content: string, starts: Int32Array, i: number) => {
  const end = i + 1 < starts.length ? starts[i + 1] - 1 : content.length;
  const l = content.slice(starts[i], end);
  return l.endsWith('\r') ? l.slice(0, -1) : l;
};

const SHELLISH = new Set(['shell', 'powershell', 'bat', '']);
const PROMPT_RE = /^(?:\$|%|PS(?: [^>]*)?>|>)\s+/;
const GENERIC_COMMENT_RE = /^(?:#(?!!)|\/\/|--\s|;|<!--|\/\*|\*\/?\s|rem\s)/i;

function commentTest(langId: string): (s: string) => boolean {
  const info = langId ? languageById(langId) : null;
  if (!info) return (s) => GENERIC_COMMENT_RE.test(s);
  const line = info.comment?.line;
  const block = info.comment?.block?.[0];
  return (s) => (!!line && s.startsWith(line)) || (!!block && s.startsWith(block)) || s.startsWith('<!--') || s.startsWith('/*');
}

/**
 * The line that best names a code block: the first non-blank, non-comment line (shell prompts like
 * `$ ` stripped), else its first comment. Skips shebangs. `null` for an empty block.
 */
export function blockLabel(lines: readonly string[], langId: string): { label: string; note?: string } | null {
  const isComment = commentTest(langId);
  const shellish = SHELLISH.has(langId);
  let note: string | undefined;
  for (const raw of lines) {
    let s = raw.trim();
    if (!s || s.startsWith('#!') || s === '<?php' || s === '<?') continue; // shebangs, PHP open tags
    if (isComment(s)) {
      note ??= s;
      continue;
    }
    if (shellish) s = s.replace(PROMPT_RE, '');
    return { label: s.length > 200 ? `${s.slice(0, 200)}…` : s, note };
  }
  return note ? { label: note } : null;
}

/** Strips the fence's own container prefix (list indent, `> ` quote markers) from a content line. */
function unprefix(line: string, prefix: string): string {
  if (!prefix) return line;
  if (prefix.includes('>')) return line.replace(/^\s*(?:>\s?)*/, '');
  let i = 0;
  while (i < prefix.length && i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

export function codeBlocks(content: string, s: DocStructure): CodeBlockEntry[] {
  const out: CodeBlockEntry[] = [];
  for (const b of s.blocks) {
    const fence = lineOf(content, s.lineStarts, b.startLine);
    const prefix = /^[\s>]*/.exec(fence)![0];
    const closed = b.endLine > b.startLine && s.kinds[b.endLine] === K_FENCE;
    const last = closed ? b.endLine - 1 : b.endLine;
    const body: string[] = [];
    // A label only needs the first few lines; don't slice a 5 000-line block.
    for (let i = b.startLine + 1; i <= last && body.length < 40; i++) body.push(unprefix(lineOf(content, s.lineStarts, i), prefix));
    const l = blockLabel(body, b.langId);
    out.push({ line: b.startLine, endLine: b.endLine, lang: b.lang, label: l?.label ?? '', note: l?.note, lines: Math.max(0, last - b.startLine), closed });
  }
  return out;
}

/** Text of a block's content lines (for Copy), container prefixes removed. */
export function codeBlockText(content: string, s: DocStructure, block: CodeBlockEntry): string {
  const fence = lineOf(content, s.lineStarts, block.line);
  const prefix = /^[\s>]*/.exec(fence)![0];
  const last = block.closed ? block.endLine - 1 : block.endLine;
  const lines: string[] = [];
  for (let i = block.line + 1; i <= last; i++) lines.push(unprefix(lineOf(content, s.lineStarts, i), prefix));
  return lines.join('\n');
}

// ---------------------------------------------------------------- tasks

export interface TaskEntry {
  line: number;
  done: boolean;
  text: string;
  /** Column of the mark character between the brackets (' ' or 'x'). */
  col: number;
  depth: number;
}

export interface TaskSummary {
  open: number;
  done: number;
  items: TaskEntry[];
}

// Same task syntax the knowledge index counts (`- [ ] `, `1. [x] `, inside quotes too).
export const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]\s/;

const indentWidth = (s: string) => {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += 4;
    else break;
  }
  return w;
};

export function tasks(content: string, s: DocStructure): TaskSummary {
  const items: TaskEntry[] = [];
  let open = 0;
  let done = 0;
  const stack: number[] = [];
  const n = s.lineStarts.length;
  for (let i = 0; i < n; i++) {
    if (s.kinds[i] !== K_TEXT) continue;
    // Cheap pre-check before slicing: a task line starts (after indent) with a list marker or quote.
    let p = s.lineStarts[i];
    while (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9) p++;
    const c = content.charCodeAt(p);
    if (c !== 45 && c !== 42 && c !== 43 && c !== 62 && !(c >= 48 && c <= 57)) continue; // - * + > 0-9
    const line = lineOf(content, s.lineStarts, i);
    const m = TASK_RE.exec(line);
    if (!m) continue;
    const isDone = m[2] !== ' ';
    if (isDone) done++;
    else open++;
    const w = indentWidth(line);
    while (stack.length && stack[stack.length - 1] >= w) stack.pop();
    items.push({ line: i, done: isDone, text: plainHeading(line.slice(m[0].length)), col: m[1].length, depth: stack.length });
    stack.push(w);
  }
  return { open, done, items };
}

/** Offset of a task's mark char in `content`, or -1 if that line no longer holds the task. */
export function taskMarkOffset(content: string, task: Pick<TaskEntry, 'line' | 'col'>): number {
  let pos = 0;
  for (let i = 0; i < task.line; i++) {
    pos = content.indexOf('\n', pos);
    if (pos === -1) return -1;
    pos++;
  }
  let end = content.indexOf('\n', pos);
  if (end === -1) end = content.length;
  const m = TASK_RE.exec(content.slice(pos, end));
  return m && m[1].length === task.col ? pos + task.col : -1;
}

// ---------------------------------------------------------------- stats

export interface DocStats {
  words: number;
  chars: number;
  lines: number;
  /** At ~230 words per minute. */
  readingMinutes: number;
}

export function lineCount(content: string): number {
  let n = 1;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) n++;
  return n;
}

export function docStats(content: string): DocStats {
  const { words, chars } = countWords(content);
  return { words, chars, lines: lineCount(content), readingMinutes: words / 230 };
}

export function readingTimeLabel(words: number): string {
  if (!words) return '-';
  const m = words / 230;
  return m < 1 ? '< 1 min' : `${Math.round(m)} min`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", else a short date. */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  if (d < 45_000) return 'just now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)} h ago`;
  const day = new Date(ms);
  const yest = new Date(now - 86_400_000);
  if (day.toDateString() === yest.toDateString()) return 'yesterday';
  return day.toLocaleDateString(undefined, { year: day.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
}

/** UTF-8 byte length without allocating an encoded copy (1 MB notes). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n++;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ---------------------------------------------------------------- memoised per document

/** One document version. Every part is computed on first use, so closed sections cost nothing. */
export class DocModel {
  private _s?: DocStructure;
  private _outline?: OutlineEntry[];
  private _blocks?: CodeBlockEntry[];
  private _tasks?: TaskSummary;
  private _stats?: DocStats;
  private _lines?: number;
  private _note?: NoteInfo;
  private _bytes?: number;

  constructor(
    readonly path: string,
    readonly content: string,
    readonly markdown: boolean,
  ) {}

  get structure(): DocStructure {
    // parseStructure decides Markdown by extension; a .md file shown as code has no structure to scan.
    return (this._s ??= parseStructure(this.markdown ? this.path : `${this.path}.txt`, this.content));
  }
  get lines(): number {
    return (this._lines ??= this._s ? this._s.lineStarts.length : lineCount(this.content));
  }
  get outline(): OutlineEntry[] {
    return (this._outline ??= this.markdown ? markdownOutline(this.structure) : codeOutline(this.path, this.content, this.lines - 1));
  }
  get codeBlocks(): CodeBlockEntry[] {
    return (this._blocks ??= this.markdown ? codeBlocks(this.content, this.structure) : []);
  }
  get tasks(): TaskSummary {
    return (this._tasks ??= this.markdown ? tasks(this.content, this.structure) : { open: 0, done: 0, items: [] });
  }
  get stats(): DocStats {
    return (this._stats ??= docStats(this.content));
  }
  /** Tags, properties, links — only used until the knowledge index (which has the same) is loaded. */
  get note(): NoteInfo {
    return (this._note ??= extractNote(this.path, this.content));
  }
  get bytes(): number {
    return (this._bytes ??= utf8Length(this.content));
  }
  blockText(b: CodeBlockEntry): string {
    return codeBlockText(this.content, this.structure, b);
  }
}

const models = new Map<string, DocModel>();
let modelsLanguages = 0;

/** The model for this exact text (same string → same model, parts already computed stay cached). */
export function docModel(path: string, content: string, markdown: boolean): DocModel {
  // A code file's outline follows its language: new file type associations (Settings → Files) start over.
  if (modelsLanguages !== associationsVersion()) {
    modelsLanguages = associationsVersion();
    models.clear();
  }
  const hit = models.get(path);
  if (hit && hit.markdown === markdown && hit.content === content) return hit;
  const m = new DocModel(path, content, markdown);
  models.delete(path);
  models.set(path, m);
  if (models.size > 8) models.delete(models.keys().next().value!);
  return m;
}
