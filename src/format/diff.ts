// Minimal text diff used to apply formatter output as small editor changes: undo stays one
// step, untouched lines keep their decorations and the cursor maps to the logically same spot.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

const MAX_CELLS = 4_000_000; // LCS table budget; larger diffs fall back to one replacement

function splitLines(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const nl = s.indexOf('\n', i);
    if (nl === -1) {
      out.push(s.slice(i));
      break;
    }
    out.push(s.slice(i, nl + 1));
    i = nl + 1;
  }
  return out;
}

/** Shrinks a replacement to its differing core (common prefix/suffix removed). */
function trimChange(a: string, from: number, to: number, insert: string): TextChange | null {
  let p = 0;
  const maxP = Math.min(to - from, insert.length);
  while (p < maxP && a.charCodeAt(from + p) === insert.charCodeAt(p)) p++;
  let s = 0;
  const maxS = Math.min(to - from - p, insert.length - p);
  while (s < maxS && a.charCodeAt(to - 1 - s) === insert.charCodeAt(insert.length - 1 - s)) s++;
  if (from + p === to - s && p === insert.length - s) return null;
  return { from: from + p, to: to - s, insert: insert.slice(p, insert.length - s) };
}

/** Ordered, non-overlapping changes (offsets into `a`) that turn `a` into `b`. */
export function minimalChanges(a: string, b: string): TextChange[] {
  if (a === b) return [];
  const al = splitLines(a);
  const bl = splitLines(b);
  let pre = 0;
  while (pre < al.length && pre < bl.length && al[pre] === bl[pre]) pre++;
  let suf = 0;
  while (suf < al.length - pre && suf < bl.length - pre && al[al.length - 1 - suf] === bl[bl.length - 1 - suf]) suf++;
  const n = al.length - pre - suf;
  const m = bl.length - pre - suf;

  let preOff = 0;
  for (let i = 0; i < pre; i++) preOff += al[i].length;
  const single = (): TextChange[] => {
    let midA = 0;
    for (let i = 0; i < n; i++) midA += al[pre + i].length;
    const c = trimChange(a, preOff, preOff + midA, bl.slice(pre, pre + m).join(''));
    return c ? [c] : [];
  };
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_CELLS) return single();

  // LCS over the differing middle lines (suffix table, so the walk below runs forward).
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = al[pre + i];
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = ai === bl[pre + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  const changes: TextChange[] = [];
  let i = 0;
  let j = 0;
  let off = preOff;
  let hunkFrom = -1;
  let hunkInsert = '';
  const flush = () => {
    if (hunkFrom === -1) return;
    const c = trimChange(a, hunkFrom, off, hunkInsert);
    if (c) changes.push(c);
    hunkFrom = -1;
    hunkInsert = '';
  };
  while (i < n || j < m) {
    if (i < n && j < m && al[pre + i] === bl[pre + j]) {
      flush();
      off += al[pre + i].length;
      i++;
      j++;
    } else {
      if (hunkFrom === -1) hunkFrom = off;
      if (j < m && (i === n || t[i * w + j + 1] >= t[(i + 1) * w + j])) hunkInsert += bl[pre + j++];
      else off += al[pre + i++].length;
    }
  }
  flush();
  return changes;
}

export function applyChanges(a: string, changes: TextChange[]): string {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    out += a.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + a.slice(pos);
}

const isWs = (code: number) => code === 32 || code === 10 || code === 9 || code === 13;

/**
 * Where `offset` in `a` ends up after `changes`. Inside a rewritten hunk the cursor follows
 * the non-whitespace characters, since formatters mostly move whitespace around.
 */
export function mapOffset(a: string, changes: TextChange[], offset: number): number {
  let delta = 0;
  for (const c of changes) {
    if (offset <= c.from) break;
    if (offset >= c.to) {
      delta += c.insert.length - (c.to - c.from);
      continue;
    }
    let count = 0;
    for (let k = c.from; k < offset; k++) if (!isWs(a.charCodeAt(k))) count++;
    let pos = 0;
    for (; pos < c.insert.length && count > 0; pos++) if (!isWs(c.insert.charCodeAt(pos))) count--;
    return c.from + delta + pos;
  }
  return offset + delta;
}

/** Cursor position in `b` that corresponds to `offset` in `a`. */
export function mapCursor(a: string, b: string, offset: number): number {
  const o = Math.max(0, Math.min(offset, a.length));
  return Math.max(0, Math.min(mapOffset(a, minimalChanges(a, b), o), b.length));
}
