// fzf-style fuzzy matcher (v2 algorithm: optimal alignment via DP, boundary / camelCase / consecutive bonuses).
// Used by quick open, the command palette and heading search. Exports stay compatible with the baseline:
//   fuzzyMatch(query, target) → { score, positions } | null
//   fuzzyFilter(query, items, key, limit)
// Space-separated query words must all match (any order), like fzf's extended mode.
import type { FuzzyMatch } from './types';
import { foldDiacritics, isAscii, lowerAligned } from './text';

const SCORE_MATCH = 16;
const GAP_START = -3;
const GAP_EXT = -1;
const BONUS_BOUNDARY = 8;
const BONUS_NONWORD = 8;
const BONUS_CAMEL = 7;
const BONUS_CONSEC = 4;
const BONUS_WHITE = 10;
const BONUS_DELIM = 9;
const FIRST_MULT = 2;
const NEG = -1e9;
const MAX_DP = 2048;

const C_WHITE = 0;
const C_NONWORD = 1;
const C_DELIM = 2;
const C_LOWER = 3;
const C_UPPER = 4;
const C_LETTER = 5;
const C_NUMBER = 6;

function charClass(c: number): number {
  if (c >= 97 && c <= 122) return C_LOWER;
  if (c >= 65 && c <= 90) return C_UPPER;
  if (c >= 48 && c <= 57) return C_NUMBER;
  if (c === 32 || c === 9 || c === 10 || c === 13) return C_WHITE;
  if (c === 47 || c === 92 || c === 58 || c === 59 || c === 44 || c === 124) return C_DELIM; // / \ : ; , |
  if (c < 128) return C_NONWORD;
  const ch = String.fromCharCode(c);
  if (ch.toLowerCase() !== ch) return C_UPPER;
  if (ch.toUpperCase() !== ch) return C_LOWER;
  if (/\p{L}/u.test(ch)) return C_LETTER;
  if (/\p{N}/u.test(ch)) return C_NUMBER;
  return C_NONWORD;
}

function bonusFor(prev: number, cur: number): number {
  if (cur > C_DELIM) {
    if (prev === C_WHITE) return BONUS_WHITE;
    if (prev === C_DELIM) return BONUS_DELIM;
    if (prev === C_NONWORD) return BONUS_BOUNDARY;
  }
  if (prev === C_LOWER && cur === C_UPPER) return BONUS_CAMEL;
  if (prev !== C_NUMBER && cur === C_NUMBER) return BONUS_CAMEL;
  if (cur === C_NONWORD || cur === C_DELIM) return BONUS_NONWORD;
  if (cur === C_WHITE) return BONUS_WHITE;
  return 0;
}

// Reusable DP buffers (single-threaded, grown on demand).
let cap = 0;
let M = new Float64Array(0);
let G = new Float64Array(0);
let R = new Int8Array(0);
let CM = new Uint8Array(0); // M choice: 1 consecutive, 2 from gap
let CG = new Uint8Array(0); // G choice: 1 from M, 2 from G
function ensure(size: number) {
  if (size <= cap) return;
  cap = Math.max(size, cap * 2, 1024);
  M = new Float64Array(cap);
  G = new Float64Array(cap);
  R = new Int8Array(cap);
  CM = new Uint8Array(cap);
  CG = new Uint8Array(cap);
}

/** Core: pattern p (already case-normalised) against target text t (original) / tn (normalised, same length). */
function matchOne(p: string, t: string, tn: string): FuzzyMatch | null {
  const n = p.length;
  const m = tn.length;
  if (!n) return { score: 0, positions: [] };
  if (n > m) return null;
  // Earliest feasible positions (greedy forward) and latest (greedy backward) bound the DP.
  const first = new Int32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    j = tn.indexOf(p[i], j);
    if (j === -1) return null;
    first[i] = j++;
  }
  const last = new Int32Array(n);
  j = m - 1;
  for (let i = n - 1; i >= 0; i--) {
    j = tn.lastIndexOf(p[i], j);
    last[i] = j--;
  }
  const bonus = new Int8Array(m);
  let prevCls = C_WHITE;
  for (let k = 0; k < m; k++) {
    const cls = charClass(t.charCodeAt(k));
    bonus[k] = bonusFor(prevCls, cls);
    prevCls = cls;
  }
  if (m > MAX_DP || n * m > 200_000) return greedy(p, bonus, first);

  ensure(n * m);
  const lo = first[0];
  const hi = last[n - 1];
  for (let i = 0; i < n; i++) {
    const row = i * m;
    const pc = p.charCodeAt(i);
    const jStart = first[i];
    const jEnd = last[i];
    for (let k = Math.max(lo, jStart - 1); k <= hi; k++) {
      const idx = row + k;
      // G: q[i] matched strictly before k, k is a gap char
      if (k > jStart) {
        const fromM = M[idx - 1] + GAP_START;
        const fromG = G[idx - 1] + GAP_EXT;
        if (fromM >= fromG) {
          G[idx] = fromM;
          CG[idx] = 1;
        } else {
          G[idx] = fromG;
          CG[idx] = 2;
        }
      } else G[idx] = NEG;
      if (k < jStart || k > jEnd || tn.charCodeAt(k) !== pc) {
        M[idx] = NEG;
        continue;
      }
      if (i === 0) {
        M[idx] = SCORE_MATCH + bonus[k] * FIRST_MULT;
        R[idx] = bonus[k];
        CM[idx] = 0;
        continue;
      }
      const prev = idx - m - 1;
      let best = NEG;
      let choice = 0;
      let run = bonus[k];
      if (k > 0 && M[prev] > NEG / 2) {
        let b = bonus[k];
        const fb = R[prev];
        let r = fb;
        if (b >= BONUS_BOUNDARY && b > fb) r = b;
        else b = Math.max(b, fb, BONUS_CONSEC);
        best = M[prev] + SCORE_MATCH + b;
        choice = 1;
        run = r;
      }
      if (k > 0 && G[prev] > NEG / 2) {
        const s = G[prev] + SCORE_MATCH + bonus[k];
        if (s > best) {
          best = s;
          choice = 2;
          run = bonus[k];
        }
      }
      M[idx] = best;
      CM[idx] = choice;
      R[idx] = run;
    }
  }
  // best end position
  const lastRow = (n - 1) * m;
  let bestJ = -1;
  let bestS = NEG;
  for (let k = first[n - 1]; k <= hi; k++) {
    if (M[lastRow + k] > bestS) {
      bestS = M[lastRow + k];
      bestJ = k;
    }
  }
  if (bestJ < 0 || bestS <= NEG / 2) return null;
  const positions = new Array<number>(n);
  let i = n - 1;
  let k = bestJ;
  let inM = true;
  while (i >= 0) {
    const idx = i * m + k;
    if (inM) {
      positions[i] = k;
      const c = CM[idx];
      i--;
      k--;
      inM = c !== 2;
    } else {
      inM = CG[idx] === 1;
      k--;
    }
  }
  return { score: bestS, positions };
}

function greedy(p: string, bonus: Int8Array, first: Int32Array): FuzzyMatch {
  let score = 0;
  let prev = -2;
  const positions: number[] = [];
  for (let i = 0; i < p.length; i++) {
    const k = first[i];
    score += SCORE_MATCH + (k === prev + 1 ? Math.max(bonus[k], BONUS_CONSEC) : bonus[k] + GAP_START);
    positions.push(k);
    prev = k;
  }
  return { score, positions };
}

export interface FuzzyOptions {
  /** Default: smart — case-sensitive only when the query has uppercase. Commands pass false. */
  caseSensitive?: boolean;
}

interface Prepared {
  t: string;
  tn: string;
  map?: Int32Array;
}

function prepare(target: string, cs: boolean): Prepared {
  const base = cs ? target : lowerAligned(target);
  if (isAscii(target)) return { t: target, tn: base };
  const f = foldDiacritics(base);
  if (!f.map) return { t: target, tn: f.text };
  // Folding dropped combining marks: build a matching "original" view aligned with the folded text.
  let t = '';
  for (let i = 0; i < f.text.length; i++) t += target[f.map[i]];
  return { t, tn: f.text, map: f.map };
}

function normQuery(q: string, cs: boolean): string {
  return foldDiacritics(cs ? q : lowerAligned(q)).text;
}

export function fuzzyMatch(query: string, target: string, opts: FuzzyOptions = {}): FuzzyMatch | null {
  const words = query.split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, positions: [] };
  const cs = opts.caseSensitive ?? /\p{Lu}/u.test(query);
  const prep = prepare(target, cs);
  let score = 0;
  const pos = new Set<number>();
  for (const w of words) {
    const r = matchOne(normQuery(w, cs), prep.t, prep.tn);
    if (!r) return null;
    score += r.score;
    for (const p of r.positions) pos.add(prep.map ? prep.map[p] : p);
  }
  return { score: score - target.length * 0.01, positions: [...pos].sort((a, b) => a - b) };
}

/** Path-aware: prefers hits in the file name (unless the query contains '/'). */
export function fuzzyMatchPath(query: string, path: string, opts: FuzzyOptions = {}): FuzzyMatch | null {
  const full = fuzzyMatch(query, path, opts);
  if (!full || query.includes('/')) return full;
  const slash = path.lastIndexOf('/');
  if (slash < 0) return { score: full.score + 12 * query.replace(/\s/g, '').length * 0.25, positions: full.positions };
  const base = fuzzyMatch(query, path.slice(slash + 1), opts);
  if (!base) return full;
  const boosted = base.score + 3 * query.replace(/\s/g, '').length;
  if (boosted >= full.score) return { score: boosted - path.length * 0.01, positions: base.positions.map((p) => p + slash + 1) };
  return full;
}

export function fuzzyFilter<T>(query: string, items: T[], key: (t: T) => string, limit = 100, opts?: FuzzyOptions & { path?: boolean }): Array<{ item: T; match: FuzzyMatch }> {
  const out: Array<{ item: T; match: FuzzyMatch; i: number; len: number }> = [];
  const fn = opts?.path ? fuzzyMatchPath : fuzzyMatch;
  for (let i = 0; i < items.length; i++) {
    const k = key(items[i]);
    const m = fn(query, k, opts);
    if (m) out.push({ item: items[i], match: m, i, len: k.length });
  }
  out.sort((a, b) => b.match.score - a.match.score || a.len - b.len || a.i - b.i);
  return out.slice(0, limit).map(({ item, match }) => ({ item, match }));
}
