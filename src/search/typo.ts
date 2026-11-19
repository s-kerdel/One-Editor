// Typo tolerance: a workspace vocabulary (word tokens + doc frequency) with a trigram index, used to
// correct query words that have zero exact hits ("kubctl" → "kubectl", "artsan" → "artisan").
import { isWordCode } from './text';

const MIN_TOKEN = 2;
const MAX_TOKEN = 48;

/** Unique word tokens ([\p{L}\p{N}_]+) of an already lowercased/folded string. */
export function tokenizeWords(s: string): string[] {
  const seen = new Set<string>();
  let start = -1;
  const n = s.length;
  for (let i = 0; i <= n; i++) {
    const c = i < n ? s.charCodeAt(i) : 32;
    const w = c < 128 ? (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || (c >= 65 && c <= 90) : isWordCode(c);
    if (w) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const len = i - start;
      if (len >= MIN_TOKEN && len <= MAX_TOKEN) seen.add(s.slice(start, i));
      start = -1;
    }
  }
  return [...seen];
}

/** Optimal-string-alignment (Damerau-Levenshtein with adjacent transpositions), early exit above max. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (!la) return lb;
  if (!lb) return la;
  let prev2 = new Array<number>(lb + 1);
  let prev = new Array<number>(lb + 1);
  let cur = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === cb) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev2;
    prev2 = prev;
    prev = cur;
    cur = t;
  }
  return prev[lb];
}

function trigrams(w: string): string[] {
  const p = `\u0001${w}\u0002`;
  const out: string[] = [];
  for (let i = 0; i + 3 <= p.length; i++) out.push(p.slice(i, i + 3));
  return out;
}

export interface Suggestion {
  token: string;
  distance: number;
  df: number;
}

/**
 * One shard's view of a suggestion candidate. `hits` = shared trigrams (-1: short token, found by
 * length). Distance is only computed where the token occurs (df > 0); Infinity otherwise.
 */
export interface VocabCandidate {
  token: string;
  df: number;
  hits: number;
  distance: number;
}

/** Most trigram-similar tokens kept per word; edit distance decides among them. */
const TRIGRAM_CAP = 400;

export function maxEditsFor(len: number): number {
  return len <= 2 ? 0 : len <= 5 ? 1 : 2;
}

const ASCII_WORD = new Uint8Array(128);
for (let c = 0; c < 128; c++) ASCII_WORD[c] = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || (c >= 65 && c <= 90) ? 1 : 0;

/** A token string that does not keep the document it was cut from alive (V8 slices ≥ 13 chars share their parent). */
function detach(s: string): string {
  if (s.length < 13) return s;
  const codes = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) codes[i] = s.charCodeAt(i);
  return String.fromCharCode.apply(null, codes);
}

export class Vocabulary {
  private ids = new Map<string, number>();
  private tokens: string[] = [];
  private counts: number[] = [];
  private tri = new Map<string, number[]>();
  private byLen = new Map<number, number[]>();
  /** Open-addressing intern table (id + 1, 0 = empty) keyed by a hash of the characters, so
   *  scanning a text never slices known words. */
  private table = new Int32Array(1 << 12);
  private hashes = new Int32Array(1024);
  /** Per token: serial of the last document that counted it (dedupe within a document). */
  private seenIn: Int32Array = new Int32Array(1024);
  private serial = 0;

  get size() {
    return this.ids.size;
  }

  /** Slot of the token s[start, start+len) with hash h: its id, or ~slot (negative) where it would go. */
  private find(h: number, s: string, start: number, len: number): number {
    const t = this.table;
    const mask = t.length - 1;
    for (let p = h & mask; ; p = (p + 1) & mask) {
      const v = t[p];
      if (v === 0) return ~p;
      const id = v - 1;
      if (this.hashes[id] === h && sameAt(this.tokens[id], s, start, len)) return id;
    }
  }

  private intern(t: string, h: number, slot: number): number {
    const id = this.tokens.length;
    this.ids.set(t, id);
    this.tokens.push(t);
    this.counts.push(0);
    if (id >= this.hashes.length) {
      const g = new Int32Array(this.hashes.length * 2);
      g.set(this.hashes);
      this.hashes = g;
      const s2 = new Int32Array(this.seenIn.length * 2);
      s2.set(this.seenIn);
      this.seenIn = s2;
    }
    this.hashes[id] = h;
    this.table[slot] = id + 1;
    // Keep the table at most half full.
    if ((id + 1) * 2 > this.table.length) {
      const old = this.table;
      const t2 = new Int32Array(old.length * 2);
      const mask = t2.length - 1;
      for (let k = 0; k <= id; k++) {
        let p = this.hashes[k] & mask;
        while (t2[p] !== 0) p = (p + 1) & mask;
        t2[p] = k + 1;
      }
      this.table = t2;
    }
    if (t.length > 4) {
      for (const g of trigrams(t)) {
        const list = this.tri.get(g);
        if (list) list.push(id);
        else this.tri.set(g, [id]);
      }
    } else {
      const list = this.byLen.get(t.length);
      if (list) list.push(id);
      else this.byLen.set(t.length, [id]);
    }
    return id;
  }

  /**
   * Counts the unique word tokens of already lowercased/folded texts as one document (same tokens as
   * tokenizeWords over the texts joined by a newline). Returns their ids, for removeDoc. Known words
   * are matched in place — no substring per occurrence, which was most of the indexing garbage.
   */
  addText(texts: readonly string[]): Uint32Array {
    const doc = ++this.serial;
    const out: number[] = [];
    for (const s of texts) {
      const n = s.length;
      let start = -1;
      let h = 0;
      for (let i = 0; i <= n; i++) {
        const c = i < n ? s.charCodeAt(i) : 32;
        if (c < 128 ? ASCII_WORD[c] === 1 : isWordCode(c)) {
          if (start < 0) {
            start = i;
            h = 0x811c9dc5;
          }
          h = Math.imul(h ^ c, 0x01000193);
        } else if (start >= 0) {
          const len = i - start;
          if (len >= MIN_TOKEN && len <= MAX_TOKEN) {
            let id = this.find(h, s, start, len);
            if (id < 0) id = this.intern(detach(s.slice(start, i)), h, ~id);
            if (this.seenIn[id] !== doc) {
              this.seenIn[id] = doc;
              this.counts[id]++;
              out.push(id);
            }
          }
          start = -1;
        }
      }
    }
    return Uint32Array.from(out);
  }

  addDoc(tokens: string[]) {
    this.addText([tokens.join('\n')]);
  }

  removeDoc(tokens: Uint32Array | string[]) {
    for (const t of tokens) {
      const id = typeof t === 'number' ? t : this.ids.get(t);
      if (id !== undefined && this.counts[id] > 0) this.counts[id]--;
    }
  }

  clear() {
    this.ids.clear();
    this.tokens = [];
    this.counts = [];
    this.tri.clear();
    this.byLen.clear();
    this.table = new Int32Array(1 << 12);
    this.hashes = new Int32Array(1024);
    this.seenIn = new Int32Array(1024);
  }

  tokenOf(id: number): string | undefined {
    return this.tokens[id];
  }

  docFreq(t: string): number {
    const id = this.ids.get(t);
    return id === undefined ? 0 : this.counts[id];
  }

  /** Closest vocabulary words within the edit budget, best first. */
  suggest(word: string, limit = 3): Suggestion[] {
    return mergeSuggest(word, [this.candidates(word)], limit);
  }

  /**
   * Suggestion candidates for `word`: every short token of a nearby length, plus the TRIGRAM_CAP most
   * trigram-similar longer ones (ties by token, so the cap picks the same tokens however the
   * vocabulary is split across shards). Tokens no longer in any document still take part in the cap.
   */
  candidates(word: string): VocabCandidate[] {
    const max = maxEditsFor(word.length);
    if (!max) return [];
    const out: VocabCandidate[] = [];
    const add = (id: number, hits: number) => {
      const t = this.tokens[id];
      const df = this.counts[id];
      out.push({ token: t, df, hits, distance: df && t !== word ? editDistance(word, t, max) : Infinity });
    };
    // Short tokens aren't trigram-indexed (too few grams to be selective): scan by length.
    for (let L = Math.max(MIN_TOKEN, word.length - max); L <= Math.min(4, word.length + max); L++) this.byLen.get(L)?.forEach((id) => add(id, -1));
    if (word.length + max > 4) {
      const hits = new Map<number, number>();
      for (const g of trigrams(word)) this.tri.get(g)?.forEach((id) => hits.set(id, (hits.get(id) ?? 0) + 1));
      const ranked = [...hits.entries()].filter(([id]) => Math.abs(this.tokens[id].length - word.length) <= max).sort((a, b) => b[1] - a[1] || cmp(this.tokens[a[0]], this.tokens[b[0]]));
      for (const [id, h] of ranked.slice(0, TRIGRAM_CAP)) add(id, h);
    }
    return out;
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Suggestions from one or more vocabularies' candidates (shards hold disjoint documents, so
 * document frequencies add up; the trigram cap is re-applied over the union, as one index would).
 */
export function mergeSuggest(word: string, parts: VocabCandidate[][], limit = 3): Suggestion[] {
  const max = maxEditsFor(word.length);
  if (!max) return [];
  const all = new Map<string, VocabCandidate>();
  for (const part of parts)
    for (const c of part) {
      const e = all.get(c.token);
      if (!e) all.set(c.token, { ...c });
      else {
        e.df += c.df;
        e.distance = Math.min(e.distance, c.distance);
      }
    }
  const short: VocabCandidate[] = [];
  let long: VocabCandidate[] = [];
  for (const c of all.values()) (c.hits < 0 ? short : long).push(c);
  long = long.sort((a, b) => b.hits - a.hits || cmp(a.token, b.token)).slice(0, TRIGRAM_CAP);
  const out: Suggestion[] = [];
  for (const c of [...short, ...long]) if (c.df > 0 && c.token !== word && c.distance <= max) out.push({ token: c.token, distance: c.distance, df: c.df });
  out.sort((a, b) => a.distance - b.distance || b.df - a.df || cmp(a.token, b.token));
  return out.slice(0, limit);
}

function sameAt(t: string, s: string, start: number, len: number): boolean {
  if (t.length !== len) return false;
  for (let k = 0; k < len; k++) if (t.charCodeAt(k) !== s.charCodeAt(start + k)) return false;
  return true;
}
