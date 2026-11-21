// Compare text, pure part: git's changed blocks → the merge view's Change list (word-level detail inside
// each block), the built-in fallback when git is unavailable, and unified-patch text for "Copy as patch".
import { Change, presentableDiff } from '@codemirror/merge';
import type { GitTextHunk } from '@shared/git';
import { diffLineArrays, splitLines } from './line-diff';

/** Blocks bigger than this are highlighted as a whole (no word-level pass). */
const WORD_LIMIT = 20_000;

function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) out.push(i + 1);
  return out;
}

/**
 * Character-range changes for the merge view from line blocks. Within a block the merge package's own
 * word-aware diff marks what changed, so lines stay aligned the way git decided.
 */
export function hunksToChanges(a: string, b: string, hunks: readonly GitTextHunk[]): Change[] {
  const la = lineStarts(a);
  const lb = lineStarts(b);
  const at = (starts: number[], text: string, line: number) => (line < starts.length ? starts[line] : text.length);
  const out: Change[] = [];
  for (const h of hunks) {
    const fromA = at(la, a, h.oldStart);
    const toA = at(la, a, h.oldStart + h.oldCount);
    const fromB = at(lb, b, h.newStart);
    const toB = at(lb, b, h.newStart + h.newCount);
    if (!h.oldCount || !h.newCount || toA - fromA > WORD_LIMIT || toB - fromB > WORD_LIMIT) {
      out.push(new Change(fromA, toA, fromB, toB));
      continue;
    }
    for (const c of presentableDiff(a.slice(fromA, toA), b.slice(fromB, toB))) out.push(new Change(fromA + c.fromA, fromA + c.toA, fromB + c.fromB, fromB + c.toB));
  }
  return out;
}

/** Built-in line diff (git unavailable). `ignoreWhitespace` compares lines with all whitespace removed. */
export function builtinHunks(a: string, b: string, ignoreWhitespace = false): GitTextHunk[] {
  const norm = (lines: string[]) => (ignoreWhitespace ? lines.map((l) => l.replace(/\s+/g, '')) : lines);
  return diffLineArrays(norm(splitLines(a)), norm(splitLines(b))).map(({ oldStart, oldCount, newStart, newCount }) => ({ oldStart, oldCount, newStart, newCount }));
}

export const hunkStats = (hunks: readonly GitTextHunk[]) => hunks.reduce((s, h) => ({ added: s.added + h.newCount, removed: s.removed + h.oldCount }), { added: 0, removed: 0 });

/** Unified diff with 3 lines of context, for the built-in fallback's "Copy as patch". */
export function formatPatch(a: string, b: string, hunks: readonly GitTextHunk[], labelA: string, labelB: string, context = 3): string {
  if (!hunks.length) return '';
  const A = splitLines(a);
  const B = splitLines(b);
  const out = [`--- a/${labelA}`, `+++ b/${labelB}`];
  // Merge blocks whose context would overlap into one @@ section.
  const groups: GitTextHunk[][] = [];
  for (const h of hunks) {
    const g = groups[groups.length - 1];
    const last = g?.[g.length - 1];
    if (last && h.oldStart - (last.oldStart + last.oldCount) <= context * 2) g.push(h);
    else groups.push([h]);
  }
  for (const g of groups) {
    const first = g[0];
    const last = g[g.length - 1];
    const aFrom = Math.max(0, first.oldStart - context);
    const aTo = Math.min(A.length, last.oldStart + last.oldCount + context);
    const bFrom = Math.max(0, first.newStart - context);
    const bTo = Math.min(B.length, last.newStart + last.newCount + context);
    out.push(`@@ -${aFrom + 1},${aTo - aFrom} +${bFrom + 1},${bTo - bFrom} @@`);
    let ia = aFrom;
    for (const h of g) {
      for (; ia < h.oldStart; ia++) out.push(` ${A[ia]}`);
      for (let k = 0; k < h.oldCount; k++) out.push(`-${A[h.oldStart + k]}`);
      for (let k = 0; k < h.newCount; k++) out.push(`+${B[h.newStart + k]}`);
      ia = h.oldStart + h.oldCount;
    }
    for (; ia < aTo; ia++) out.push(` ${A[ia]}`);
  }
  return out.join('\n') + '\n';
}

/** git's patch speaks of the temp files "a" / "b": put the real source names in its headers. */
export function relabelPatch(patch: string, labelA: string, labelB: string): string {
  const lines = patch.split('\n');
  const body = lines.findIndex((l) => l.startsWith('@@'));
  if (body < 0) return patch;
  // Only the header above the first @@ (a removed line "-- x" looks like "--- x" further down).
  return [`--- a/${labelA}`, `+++ b/${labelB}`, ...lines.slice(body)].join('\n');
}

const lf = (t: string) => t.replace(/\r\n?/g, '\n');
const closed = (t: string) => (t && !t.endsWith('\n') ? t + '\n' : t);

/**
 * The two texts as the compare view shows them: LF line ends, and a final newline for a piece of text
 * (a selection, the clipboard) — it never "owns" the end of a file, so a missing last newline would only
 * show up as a noisy changed line. A whole file stays exactly as it is (it can be edited in the view: the
 * text shown must be its document), and a piece compared with it ends the way the file does.
 */
export function compareTexts(left: { text: string; whole: boolean }, right: { text: string; whole: boolean }): [string, string] {
  const a = lf(left.text);
  const b = lf(right.text);
  if (left.whole === right.whole) return left.whole ? [a, b] : [closed(a), closed(b)];
  const like = (piece: string, file: string) => (!file || file.endsWith('\n') ? closed(piece) : piece.replace(/\n$/, ''));
  return left.whole ? [a, like(b, a)] : [like(a, b), b];
}
