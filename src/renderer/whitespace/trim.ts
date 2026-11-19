// Trailing-whitespace rules (pure, unit-tested): pasted text (terminal padding) and saved text.
// Whitespace = space, tab, NBSP and the other Unicode spaces terminals pad lines with. Line breaks
// are never touched (a CR before LF stays).
import { diffLines } from '../git/line-diff';

/** One trailing whitespace run (no CR / LF). */
const TRAIL = /[ \t   -​  　﻿]+$/;

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Trailing whitespace of one line (a final CR is kept out of it). */
function trailOf(line: string): { start: number; end: number } | null {
  const end = line.endsWith('\r') ? line.length - 1 : line.length;
  const m = TRAIL.exec(line.slice(0, end));
  return m ? { start: m.index, end } : null;
}

/**
 * Pasted text: trailing whitespace off every line, trailing blank lines dropped, and exactly one
 * final newline when the clipboard ended with one. CRLF / CR become LF (the editor is LF inside).
 */
export function trimPasted(text: string): string {
  // Only whitespace (an indent being pasted on purpose): leave it alone.
  if (!/[^\s   -​  　﻿]/.test(text)) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1].replace(TRAIL, '') === '';
  const out = lines.map((l) => l.replace(TRAIL, ''));
  while (out.length > 1 && out[out.length - 1] === '') out.pop();
  return out.join('\n') + (endsWithNewline ? '\n' : '');
}

export interface TrimOptions {
  /** Markdown rules: keep hard breaks (≥ 2 trailing spaces before a non-empty line, outside code). */
  markdown: boolean;
  keepBreaks: boolean;
  /** 0-based lines to trim (undefined = all). */
  lines?: ReadonlySet<number>;
  /** 0-based lines never to trim (the caret's line during autosave). */
  skip?: ReadonlySet<number>;
}

/** Lines (0-based) that are fenced-code content or frontmatter: code rules there (no break exception). */
export function codeLines(lines: readonly string[]): Set<number> {
  const out = new Set<number>();
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? '')) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)\s*$/.test(lines[j])) {
        for (let k = 0; k <= j; k++) out.add(k);
        i = j + 1;
        break;
      }
    }
  }
  let fence: RegExp | null = null;
  for (; i < lines.length; i++) {
    const body = lines[i].replace(/^(?:[ \t]*>)*[ \t]*/, ''); // fences inside quotes / list items count too
    if (fence) {
      if (fence.test(body)) fence = null;
      else out.add(i);
      continue;
    }
    const m = /^(`{3,}|~{3,})/.exec(body);
    if (m) fence = new RegExp(`^\\${m[1][0]}{${m[1].length},}[ \\t]*\\r?$`);
  }
  return out;
}

/** Minimal edits that remove trailing whitespace (markdown: hard breaks normalised to two spaces). */
export function trimChanges(text: string, o: TrimOptions): TextChange[] {
  const lines = text.split('\n');
  const code = o.markdown ? codeLines(lines) : null;
  const out: TextChange[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; pos += lines[i].length + 1, i++) {
    if ((o.lines && !o.lines.has(i)) || o.skip?.has(i)) continue;
    const line = lines[i];
    const t = trailOf(line);
    if (!t) continue;
    let keep = '';
    if (o.markdown && o.keepBreaks && !code!.has(i) && t.start > 0 && line.slice(0, t.start).trim() !== '') {
      const run = line.slice(t.start, t.end);
      const next = lines[i + 1];
      // A hard break: two or more plain spaces, and a following line with text on it.
      if (/^ {2,}$/.test(run) && next !== undefined && next.trim() !== '') keep = '  ';
    }
    if (line.slice(t.start, t.end) === keep) continue;
    out.push({ from: pos + t.start, to: pos + t.end, insert: keep });
  }
  return out;
}

export function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = '';
  let at = 0;
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert;
    at = c.to;
  }
  return out + text.slice(at);
}

/** 0-based lines of `current` that were added or changed since `saved` (untouched lines are left alone). */
export function changedLines(saved: string, current: string): Set<number> {
  const out = new Set<number>();
  if (saved === current) return out;
  for (const h of diffLines(saved, current)) for (let k = 0; k < h.newCount; k++) out.add(h.newStart + k);
  return out;
}

/** Lines (0-based) of `text` that the offsets fall on. */
export function linesAt(text: string, offsets: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const off of offsets) {
    let n = 0;
    for (let i = text.indexOf('\n'); i >= 0 && i < off; i = text.indexOf('\n', i + 1)) n++;
    out.add(n);
  }
  return out;
}
