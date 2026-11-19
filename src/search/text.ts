// Low-level text helpers shared by the engine, fuzzy matcher and UI. Pure, no DOM.
// Key invariant: folded haystacks keep a mapping back to the original offsets, so every match
// can be reported (and replaced) at its exact position in the raw document.

const NON_ASCII = /[^\x00-\x7f]/;

export function isAscii(s: string): boolean {
  return !NON_ASCII.test(s);
}

/** Lowercase while preserving string length (so offsets stay aligned with the original). */
export function lowerAligned(s: string): string {
  const l = s.toLowerCase();
  if (l.length === s.length) return l;
  // Rare: a char lowercases to >1 code unit (e.g. U+0130 'İ'). Fall back to per-char.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const lc = c.toLowerCase();
    out += lc.length === 1 ? lc : c;
  }
  return out;
}

const COMBINING = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/;
// Letters that don't decompose under NFD but users still expect to fold.
const EXTRA_FOLD: Record<string, string> = { ø: 'o', Ø: 'O', đ: 'd', Đ: 'D', ł: 'l', Ł: 'L', ħ: 'h', Ħ: 'H', ı: 'i' };
const foldCache = new Map<number, string>();

/** Fold one UTF-16 code unit: strip diacritics. Returns '' for a standalone combining mark. */
function foldUnit(code: number, ch: string): string {
  let f = foldCache.get(code);
  if (f !== undefined) return f;
  if (COMBINING.test(ch)) f = '';
  else if (EXTRA_FOLD[ch]) f = EXTRA_FOLD[ch];
  else {
    const d = ch.normalize('NFD');
    const base = d.length > 1 ? d.replace(/[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g, '') : d;
    f = base.length === 1 ? base : ch;
  }
  foldCache.set(code, f);
  return f;
}

export function hasDiacritics(s: string): boolean {
  if (isAscii(s)) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) continue;
    if (foldUnit(c, s[i]) !== s[i]) return true;
  }
  return false;
}

/** Diacritic-folded text. `map[i]` = original offset of folded char i (absent = identity). */
export interface FoldedText {
  text: string;
  map?: Int32Array; // length text.length + 1 (last entry = original length)
}

export function foldDiacritics(s: string): FoldedText {
  if (isAscii(s)) return { text: s };
  // Non-ASCII but nothing to fold (dashes, quotes, emoji, CJK…): the same string, not a copy.
  let first = 0;
  for (; first < s.length; first++) {
    const c = s.charCodeAt(first);
    if (c >= 128 && foldUnit(c, s[first]) !== s[first]) break;
  }
  if (first === s.length) return { text: s };
  let out = '';
  let map: number[] | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      out += s[i];
      if (map) map.push(i);
      continue;
    }
    const f = foldUnit(c, s[i]);
    if (f.length !== 1 && !map) {
      map = [];
      for (let k = 0; k < out.length; k++) map.push(k);
    }
    if (f.length === 1) {
      out += f;
      if (map) map.push(i);
    } else if (f.length > 1) {
      // Not produced by foldUnit today; kept for safety.
      for (const ch of f) {
        out += ch;
        map!.push(i);
      }
    }
  }
  if (!map) return { text: out };
  map.push(s.length);
  return { text: out, map: Int32Array.from(map) };
}

/** Fold a query term the same way documents are folded (lowercase + strip diacritics). */
export function foldTerm(s: string): string {
  return foldDiacritics(lowerAligned(s)).text;
}

// ---- word characters (for whole-word matching and tokenising) ----

const WORD_RE = /[\p{L}\p{N}_\p{M}]/u;

export function isWordCode(c: number): boolean {
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  if (c >= 0xd800 && c <= 0xdfff) return false; // surrogates (emoji etc.)
  return WORD_RE.test(String.fromCharCode(c));
}

export function isWordAt(s: string, i: number): boolean {
  return i >= 0 && i < s.length && isWordCode(s.charCodeAt(i));
}

/** Whole-word check that only enforces a boundary on sides where the needle itself starts/ends with a word char
 *  (so `--force` still matches inside `--force-with-lease`, like VS Code's \b semantics). */
export function isWholeWord(hay: string, start: number, end: number): boolean {
  if (end <= start) return false;
  if (isWordAt(hay, start) && isWordAt(hay, start - 1)) return false;
  if (isWordAt(hay, end - 1) && isWordAt(hay, end)) return false;
  return true;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
}

export function normalizeEol(s: string): string {
  return s.indexOf('\r') === -1 ? s : s.replace(/\r\n?/g, '\n');
}

/** Offsets of each line start. */
export function computeLineStarts(s: string): Int32Array {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  const out = new Int32Array(n);
  let k = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) out[k++] = i + 1;
  return out;
}

/** Binary search: line index containing offset. */
export function lineOfOffset(lineStarts: Int32Array, offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
