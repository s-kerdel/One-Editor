// Trailing-whitespace rules (pure, unit-tested): pasted text (terminal padding) and saved text.
// Whitespace = space, tab, NBSP and the other Unicode spaces terminals pad lines with. Line breaks
// are never touched (a CR before LF stays).
import { diffLines } from '../git/line-diff';

/** One trailing whitespace run (no CR / LF). */
const TRAIL = /[ \t\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]+$/;

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

// ---- terminal rows ---------------------------------------------------------------------------
// Windows Terminal (and others) can copy a block as ONE line: every screen row padded with spaces
// to the window width W, no newlines at all. unwrapTerminalRows() finds W and turns the rows back
// into lines: a row padded at its end → line break; a row full to the edge → the next row continues
// it (a soft wrap of one long line).
// Rows are measured in UTF-16 code units. A wide character (CJK, most emoji) takes two terminal
// cells but one or two code units, so rows holding them don't line up: such a paste is left as one
// line (only its trailing spaces go) — never mangled. Weak evidence is left alone the same way.
// Known ambiguity: indents that grow by the same step on every row (2, 4, 6) read exactly like
// flat lines at a slightly wider W; the lines come out right, their indentation flat.

const MIN_W = 40;
const MAX_W = 400;
/** Indent the next row may start with after a padded row. */
const MAX_INDENT = 12;
/** A padding run: this many spaces or more. */
const LONG_RUN = 8;

export interface RowWidthCandidate {
  w: number;
  /** Long space runs ending at a row start (+ indent) / the rest (alignment inside rows). */
  explained: number;
  unexplained: number;
  /** Sum of the indents those runs end at. */
  fit: number;
  /** Rows that would be all spaces. */
  blank: number;
  /** Row boundaries, how many of them end a padded row, and the shortest such padding. */
  boundaries: number;
  padded: number;
  minPad: number;
  score: number;
}

/** Every row width that fits `line` (exported for tests / tuning); the best scores highest. */
export function rowWidthCandidates(line: string): RowWidthCandidate[] {
  const n = line.length;
  if (n < 2 * MIN_W || n > 200_000 || !/ {8}/.test(line) || /^\s*\|/.test(line)) return []; // tables keep their cells
  // End (exclusive) of the space run at each position; -1 elsewhere.
  const runEnd = new Int32Array(n + 1).fill(-1);
  for (let i = n - 1, end = n; i >= 0; i--) {
    if (line.charCodeAt(i) === 32) runEnd[i] = end;
    else end = i;
  }
  const runs: Array<{ s: number; e: number }> = [];
  for (let i = 0; i < n; ) {
    if (runEnd[i] < 0) i++;
    else {
      if (runEnd[i] - i >= LONG_RUN) runs.push({ s: i, e: runEnd[i] });
      i = runEnd[i];
    }
  }
  if (runs.length < 2) return [];
  const out: RowWidthCandidate[] = [];
  for (let w = MIN_W; w <= MAX_W && 2 * w < n; w++) {
    let boundaries = 0;
    let padded = 0;
    let minPad = Infinity;
    let ok = true;
    const paddedRow = new Uint8Array(Math.ceil(n / w));
    for (let b = w; b < n; b += w) {
      boundaries++;
      if (line.charCodeAt(b - 1) !== 32) continue; // full row: soft wrap
      // Padded row: its spaces must stop at the start of a row (+ indent), never mid-row.
      const e = runEnd[b - 1];
      if (e < n && (e - b) % w > MAX_INDENT) {
        ok = false;
        break;
      }
      // Only real padding counts: a row's padding is long (a word gap that happens to sit at b isn't).
      let s0 = b - 1;
      while (s0 > 0 && line.charCodeAt(s0 - 1) === 32) s0--;
      if (b - s0 < Math.max(LONG_RUN, w >> 3)) continue;
      // …and it is the row's longest space run (content inside a row is denser than its padding).
      let inner = 0;
      for (let i = Math.max(b - w, 0); i < s0; ) {
        if (runEnd[i] < 0) i++;
        else (inner = Math.max(inner, Math.min(runEnd[i], s0) - i)), (i = runEnd[i]);
      }
      if (inner <= b - s0) (padded++, (minPad = Math.min(minPad, b - s0)), (paddedRow[b / w - 1] = 1));
    }
    // Real dumps are mostly padded rows; each soft-wrapped (full) row needs two more padded ones.
    if (!ok || padded < 2 + 2 * (boundaries - padded)) continue;
    // Just three rows is thin evidence: then the rows must be clearly padded (a third of W or more).
    if (padded === 2 && minPad * 3 < w) continue;
    // Long space runs this width explains: they end where a row starts (+ indent). The others are
    // alignment (kubectl columns, `key:      # comment`): fine inside a row that ends in its
    // padding, or in the last row; anywhere else ("stray") they argue against this width.
    let explained = 0;
    let fit = 0;
    const indents = new Set<number>();
    let odd = 0;
    let stray = 0;
    const lastRow = Math.ceil(n / w) - 1;
    for (const r of runs) {
      const off = r.e % w;
      if (r.e === n) explained++;
      else if (off <= MAX_INDENT && r.s < r.e - off) explained++, (fit += off), indents.add(off), (odd += off & 1);
      else {
        const row = Math.floor(r.s / w);
        if (row !== lastRow && !paddedRow[row]) stray++;
      }
    }
    // The runs must land on row starts or a small indent (random spacing lands anywhere in 0…12).
    if (explained < 2 || fit > 4 * explained) continue;
    let blank = 0;
    for (let b = 0; b < n; b += w) if (runEnd[b] >= Math.min(n, b + w)) blank++;
    // Evidence = padding runs that end where a row starts. Each wrong width shows a symptom: a
    // divisor of W adds blank rows, a multiple explains fewer runs (padding lands mid-row), and
    // W ± a few shifts every row start so the indents stop being the few, mostly even values real
    // text has (2, 2, 2 becomes 1, 0, …). Alignment inside padded rows costs next to nothing.
    const aligned = runs.length - explained - stray;
    const indentNoise = 2 * Math.max(0, indents.size - 1) + odd + fit / explained / 2;
    const score = 2 * (explained - stray) - aligned / 4 - blank - indentNoise;
    out.push({ w, explained, unexplained: runs.length - explained, fit, blank, boundaries, padded, minPad, score });
  }
  return out;
}

function chooseRowWidth(line: string): number | null {
  let best: RowWidthCandidate | null = null;
  for (const c of rowWidthCandidates(line)) if (!best || c.score > best.score) best = c;
  // Weak evidence → leave the line alone (it still gets right-trimmed); mangling text is worse.
  return best && best.score > 1.5 ? best.w : null;
}

/** One pasted line → the terminal lines it held (unchanged when it isn't padded terminal rows). */
export function unwrapTerminalRows(line: string): string {
  const w = chooseRowWidth(line);
  if (!w) return line;
  let out = '';
  for (let b = 0; b < line.length; b += w) {
    const end = Math.min(line.length, b + w);
    const row = line.slice(b, end);
    out += row.replace(TRAIL, '');
    // A full row continues on the next one; a padded row ends its line.
    if (end < line.length && line.charCodeAt(end - 1) === 32) out += '\n';
  }
  return out;
}

/**
 * Pasted text: terminal rows unwrapped (see above), trailing whitespace off every line, trailing
 * blank lines dropped, and exactly one final newline when the clipboard ended with one. CRLF / CR
 * become LF (the editor is LF inside).
 */
export function trimPasted(text: string): string {
  // Only whitespace (an indent being pasted on purpose): leave it alone.
  if (!/[^\s\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]/.test(text)) return text;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const endsWithNewline = lines.length > 1 && lines[lines.length - 1].replace(TRAIL, '') === '';
  const out = lines.flatMap((l) => unwrapTerminalRows(l).split('\n')).map((l) => l.replace(TRAIL, ''));
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
