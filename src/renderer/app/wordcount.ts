// Word / character count shared by the status bar and the file overview. Its own tiny module so
// a lazy chunk can use it without pulling the status bar (and its imports) out of the startup chunk.
// A word is /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/u. Scanned in place: matching the regex over a 1 MB
// note built an array of 200k words (and replace() a copy of the text) — a 25 ms task per count.
const START = /[\p{L}\p{N}]/u;
const PART = /[\p{L}\p{N}\p{M}'’_-]/u;
const kinds = new Map<number, number>();
/** 2 = may start a word, 1 = may continue one, 0 = neither. */
function kind(cp: number): number {
  if (cp < 128) return (cp >= 48 && cp <= 57) || ((cp | 32) >= 97 && (cp | 32) <= 122) ? 2 : cp === 39 || cp === 45 || cp === 95 ? 1 : 0;
  let k = kinds.get(cp);
  if (k === undefined) {
    const ch = String.fromCodePoint(cp);
    kinds.set(cp, (k = START.test(ch) ? 2 : PART.test(ch) ? 1 : 0));
  }
  return k;
}

export function countWords(text: string): { words: number; chars: number } {
  let words = 0;
  let lines = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp === 10) lines++;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = (cp - 0xd800) * 0x400 + lo - 0xdc00 + 0x10000;
        i++;
      }
    }
    const k = kind(cp);
    if (inWord) inWord = k > 0;
    else if (k === 2) {
      inWord = true;
      words++;
    }
  }
  return { words, chars: text.length - lines };
}
