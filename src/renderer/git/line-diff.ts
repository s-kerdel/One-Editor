// Line diff for the change gutter: buffer vs HEAD → added / modified / deleted hunks, plus the edit
// that reverts one hunk. Pure (no DOM), cheap for the usual case (few edits in a big file):
// common prefix/suffix are trimmed first, the rest runs Myers O((N+M)·D) on interned lines.

export type HunkKind = 'added' | 'modified' | 'deleted';

export interface Hunk {
  kind: HunkKind;
  /** First line (0-based) of the hunk in the new text. For 'deleted': the line the removal sits before. */
  newStart: number;
  newCount: number;
  /** Removed lines in the old (HEAD) text. */
  oldStart: number;
  oldCount: number;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Edit distance budget: beyond it the middle becomes one coarse hunk (memory stays O(D²) ≈ 4 MB). */
const MAX_D = 1000;

const hunk = (oldStart: number, oldCount: number, newStart: number, newCount: number): Hunk => ({
  kind: oldCount === 0 ? 'added' : newCount === 0 ? 'deleted' : 'modified',
  newStart,
  newCount,
  oldStart,
  oldCount,
});

export const splitLines = (text: string): string[] => text.split('\n');

export function diffLines(oldText: string, newText: string, maxD = MAX_D): Hunk[] {
  if (oldText === newText) return [];
  return diffLineArrays(splitLines(oldText), splitLines(newText), maxD);
}

export function diffLineArrays(a: readonly string[], b: readonly string[], maxD = MAX_D): Hunk[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const n = a.length - pre - suf;
  const m = b.length - pre - suf;
  if (!n && !m) return [];
  if (!n || !m) return [hunk(pre, n, pre, m)];
  // Intern lines → ints, so the inner loop compares numbers.
  const ids = new Map<string, number>();
  const intern = (s: string) => {
    let id = ids.get(s);
    if (id === undefined) ids.set(s, (id = ids.size));
    return id;
  };
  const ah = new Int32Array(n);
  const bh = new Int32Array(m);
  for (let i = 0; i < n; i++) ah[i] = intern(a[pre + i]);
  for (let j = 0; j < m; j++) bh[j] = intern(b[pre + j]);
  const marks = myers(ah, bh, maxD);
  if (!marks) return [hunk(pre, n, pre, m)];
  const { del, ins } = marks;
  const out: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !del[i] && !ins[j]) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    while ((i < n && del[i]) || (j < m && ins[j])) {
      while (i < n && del[i]) i++;
      while (j < m && ins[j]) j++;
    }
    out.push(hunk(pre + si, i - si, pre + sj, j - sj));
  }
  return out;
}

/** Myers' greedy diff; marks deleted a-lines / inserted b-lines. null when D exceeds the budget. */
function myers(a: Int32Array, b: Int32Array, maxD: number): { del: Uint8Array; ins: Uint8Array } | null {
  const N = a.length;
  const M = b.length;
  const max = Math.min(N + M, maxD);
  const off = max + 1;
  const V = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)); // V[k] for k ∈ [-d-1, d+1], as it was before step d
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      V[off + k] = x;
      if (x >= N && y >= M) return backtrack(trace, d, N, M);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], D: number, N: number, M: number) {
  const del = new Uint8Array(N);
  const ins = new Uint8Array(M);
  let x = N;
  let y = M;
  for (let d = D; d > 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) ins[prevY] = 1;
    else del[prevX] = 1;
    x = prevX;
    y = prevY;
  }
  return { del, ins };
}

/**
 * The change (offsets into the LF new text) that puts hunk `h` back to its old lines.
 * `newLines` / `oldLines` are the texts split on '\n'.
 */
export function revertChange(newLines: readonly string[], oldLines: readonly string[], h: Hunk): TextChange {
  const startOf = (line: number) => {
    let o = 0;
    for (let i = 0; i < line; i++) o += newLines[i].length + 1;
    return o;
  };
  const total = newLines.length;
  const old = oldLines.slice(h.oldStart, h.oldStart + h.oldCount).join('\n');
  if (h.newCount > 0 && h.oldCount > 0) {
    const from = startOf(h.newStart);
    let to = from;
    for (let i = h.newStart; i < h.newStart + h.newCount; i++) to += newLines[i].length + 1;
    return { from, to: to - 1, insert: old };
  }
  if (h.newCount > 0) {
    // Added lines: remove them together with one line break.
    const from = startOf(h.newStart);
    let to = from;
    for (let i = h.newStart; i < h.newStart + h.newCount; i++) to += newLines[i].length + 1;
    if (h.newStart + h.newCount < total) return { from, to, insert: '' };
    return { from: from - 1, to: to - 1, insert: '' }; // at the end: take the break before instead
  }
  // Deleted lines: insert them before line newStart (or append at the very end).
  if (h.newStart < total) {
    const at = startOf(h.newStart);
    return { from: at, to: at, insert: old + '\n' };
  }
  const end = startOf(total) - 1;
  return { from: end, to: end, insert: '\n' + old };
}

/** Applies changes (non-overlapping, any order) to a string. */
export function applyChanges(text: string, changes: TextChange[]): string {
  let out = text;
  for (const c of [...changes].sort((x, y) => y.from - x.from)) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

/** Totals for a diff header: lines added / removed. */
export function diffStats(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    added += h.newCount;
    removed += h.oldCount;
  }
  return { added, removed };
}
