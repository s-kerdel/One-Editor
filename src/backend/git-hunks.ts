// Partial staging, pure part (unit-tested): git's zero-context diffs → hunks; the blocks the diff view
// shows (HEAD → working copy, composed from HEAD → index and index → working copy, so every block knows
// which of its parts are staged); and the patch that puts chosen blocks into the index or takes them out
// again (`git apply --cached --unidiff-zero`). Diff text is handled as latin1 = raw bytes 1:1, so CRLF,
// "no newline at end of file" and any encoding survive the round trip unchanged.
import type { GitHunk, GitHunkPick } from '../shared/git';

export interface ZeroHunk {
  /** 0-based first line, or the insertion point when the side is empty. */
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Removed / added lines: raw bytes (latin1), without the sign and the '\n' (a CR stays). */
  del: string[];
  add: string[];
  /** The last removed / added line has no newline (end of file). */
  delNoEol: boolean;
  addNoEol: boolean;
}

export type ParsedZeroDiff = { binary: true } | { binary: false; hunks: ZeroHunk[] };

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 1-based unified-diff start → 0-based (an empty side names the line *after which* it sits). */
const start0 = (l: number, count: number) => (count === 0 ? l : l - 1);
const start1 = (s: number, count: number) => (count === 0 ? s : s + 1);

/**
 * One file's `git diff -U0 --inter-hunk-context=0` output (latin1). null: not what we can patch safely
 * (context lines, several files, counts that do not add up).
 */
export function parseZeroDiff(text: string): ParsedZeroDiff | null {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const hunks: ZeroHunk[] = [];
  let i = 0;
  let files = 0;
  for (; i < lines.length && !lines[i].startsWith('@@'); i++) {
    const l = lines[i];
    if (l.startsWith('diff --git ') && ++files > 1) return null;
    if (l.startsWith('Binary files ') || l === 'GIT binary patch') return { binary: true };
  }
  while (i < lines.length) {
    const m = HEADER.exec(lines[i++]);
    if (!m) return null;
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    const h: ZeroHunk = { oldStart: start0(Number(m[1]), oldCount), oldCount, newStart: start0(Number(m[3]), newCount), newCount, del: [], add: [], delNoEol: false, addNoEol: false };
    // Driven by the counts: a removed line "-- x" must never be taken for a header.
    let last: '-' | '+' | null = null;
    while (i < lines.length && (h.del.length < oldCount || h.add.length < newCount || lines[i].startsWith('\\'))) {
      const l = lines[i++];
      const sign = l[0];
      if (sign === '\\') {
        if (last === '-') h.delNoEol = true;
        else if (last === '+') h.addNoEol = true;
        else return null;
      } else if (sign === '-' && h.del.length < oldCount && !h.add.length) {
        h.del.push(l.slice(1));
        last = '-';
      } else if (sign === '+' && h.add.length < newCount) {
        h.add.push(l.slice(1));
        last = '+';
      } else return null; // context (' ') or anything unexpected
    }
    if (h.del.length !== oldCount || h.add.length !== newCount) return null;
    const prev = hunks[hunks.length - 1];
    if (prev && h.oldStart < prev.oldStart + prev.oldCount) return null;
    hunks.push(h);
  }
  return { binary: false, hunks };
}

/** A block of the diff view: HEAD lines [a0, a1) → working-copy lines [b0, b1), and what it is made of. */
export interface Block extends GitHunk {
  /** HEAD → index hunks inside it (what is staged). */
  staged: ZeroHunk[];
  /** Index → working copy hunks inside it (what is not). */
  unstaged: ZeroHunk[];
}

/**
 * HEAD → working copy blocks from HEAD → index (`staged`) and index → working copy (`unstaged`) hunks.
 * Both speak of the index's lines, so hunks whose index ranges overlap or touch form one block; the
 * lines between blocks are equal in all three versions, which makes the HEAD / working-copy ranges
 * exact. A block's range never changes when its parts move between staged and not (picks stay valid).
 */
export function composeBlocks(staged: readonly ZeroHunk[], unstaged: readonly ZeroHunk[]): Block[] {
  type Item = { i0: number; i1: number; s?: ZeroHunk; u?: ZeroHunk };
  const items: Item[] = [...staged.map((s) => ({ i0: s.newStart, i1: s.newStart + s.newCount, s })), ...unstaged.map((u) => ({ i0: u.oldStart, i1: u.oldStart + u.oldCount, u }))];
  items.sort((x, y) => x.i0 - y.i0 || x.i1 - y.i1);
  const blocks: Block[] = [];
  /** Line-count change of the staged / unstaged hunks before the current block. */
  let sShift = 0;
  let uShift = 0;
  for (let k = 0; k < items.length; ) {
    const c0 = items[k].i0;
    let c1 = items[k].i1;
    const s: ZeroHunk[] = [];
    const u: ZeroHunk[] = [];
    while (k < items.length && items[k].i0 <= c1) {
      const it = items[k++];
      c1 = Math.max(c1, it.i1);
      if (it.s) s.push(it.s);
      else u.push(it.u!);
    }
    const sIn = s.reduce((n, h) => n + h.newCount - h.oldCount, 0);
    const uIn = u.reduce((n, h) => n + h.newCount - h.oldCount, 0);
    blocks.push({ a0: c0 - sShift, a1: c1 - sShift - sIn, b0: c0 + uShift, b1: c1 + uShift + uIn, state: s.length && u.length ? 'mixed' : s.length ? 'staged' : 'unstaged', staged: s, unstaged: u });
    sShift += sIn;
    uShift += uIn;
  }
  return blocks;
}

/** The same change the other way round (HEAD → index hunk → one that turns the index back). */
export function invertHunk(h: ZeroHunk): ZeroHunk {
  return { oldStart: h.newStart, oldCount: h.newCount, newStart: h.oldStart, newCount: h.oldCount, del: h.add, add: h.del, delNoEol: h.addNoEol, addNoEol: h.delNoEol };
}

/**
 * Index hunks for the picks: included blocks bring their unstaged parts in, excluded ones take their
 * staged parts back out (inverted). Both kinds speak of the current index's lines. `missing`: picks
 * that match no block any more (the file changed meanwhile).
 */
export function hunksForPicks(blocks: readonly Block[], picks: readonly GitHunkPick[]): { hunks: ZeroHunk[]; missing: number } {
  const hunks: ZeroHunk[] = [];
  let missing = 0;
  for (const p of picks) {
    const b = blocks.find((x) => x.a0 === p.a0 && x.a1 === p.a1 && x.b0 === p.b0 && x.b1 === p.b1);
    if (!b) missing++;
    else if (p.include) hunks.push(...b.unstaged);
    else hunks.push(...b.staged.map(invertHunk));
  }
  return { hunks, missing };
}

/** C-style quoting the way git writes names with special characters (git apply reads it back). */
export function quotePath(p: string): string {
  if (!/["\\\x00-\x1f\x7f]/.test(p)) return p;
  const esc: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
  return `"${p.replace(/["\\\x00-\x1f\x7f]/g, (c) => esc[c] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`)}"`;
}

/**
 * A patch of `hunks` (old side = the image it applies to: the index) for `git apply --cached
 * --unidiff-zero`. New starts are recomputed from the hunks actually in it: without context lines git
 * places each hunk by that number, and the original ones assume every other hunk of the diff applied too.
 * `repoPath`: path from the repository root (git apply reads names that way, even from a subfolder).
 */
export function buildPatch(repoPath: string, hunks: readonly ZeroHunk[]): Buffer {
  const sorted = [...hunks].sort((x, y) => x.oldStart - y.oldStart);
  const a = quotePath(`a/${repoPath}`);
  const b = quotePath(`b/${repoPath}`);
  const head = Buffer.from(`diff --git ${a} ${b}\n--- ${a}\n+++ ${b}\n`, 'utf8');
  let body = '';
  let shift = 0;
  for (const h of sorted) {
    const newStart = h.oldStart + shift;
    shift += h.newCount - h.oldCount;
    body += `@@ -${start1(h.oldStart, h.oldCount)},${h.oldCount} +${start1(newStart, h.newCount)},${h.newCount} @@\n`;
    for (const l of h.del) body += `-${l}\n`;
    if (h.delNoEol && h.del.length) body += '\\ No newline at end of file\n';
    for (const l of h.add) body += `+${l}\n`;
    if (h.addNoEol && h.add.length) body += '\\ No newline at end of file\n';
  }
  return Buffer.concat([head, Buffer.from(body, 'latin1')]);
}

/** One file's porcelain v2 record (`status -z -- <path> [<from>]`), for the path in question. */
export interface FileRecord {
  kind: '1' | '2' | 'u' | '?';
  xy: string;
  sub: string;
  modes: string[];
  /** Rename / copy source (repository path). */
  orig?: string;
}

export function parseFileRecord(out: string, repoPath: string): FileRecord | null {
  const f = out.split('\0');
  for (let i = 0; i < f.length; i++) {
    const rec = f[i];
    const kind = rec[0];
    if (kind === '?' && rec.slice(2) === repoPath) return { kind: '?', xy: '??', sub: 'N...', modes: [] };
    if (kind !== '1' && kind !== '2' && kind !== 'u') continue;
    const n = kind === '1' ? 8 : kind === '2' ? 9 : 10;
    const parts = rec.split(' ');
    const p = parts.slice(n).join(' ');
    const orig = kind === '2' ? f[++i] : undefined; // -z: the source is its own field
    if (p !== repoPath) continue;
    return { kind, xy: parts[1] ?? '', sub: parts[2] ?? '', modes: parts.slice(3, kind === 'u' ? 7 : 6), ...(orig !== undefined ? { orig } : {}) };
  }
  return null;
}
