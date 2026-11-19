// The in-place word scanner must count exactly what the regex it replaced counted.
import { describe, expect, it } from 'vitest';
import { countWords } from '../../../src/renderer/app/wordcount';

const old = (text: string) => ({ words: text.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu)?.length ?? 0, chars: text.replace(/\n/g, '').length });

function fuzz(n: number, seed: number): string[] {
  const parts = ['a', 'Z', '9', ' ', '\n', "'", '’', '-', '_', 'é', 'é', '—', '日本', '😀', '𝒜b', 'ß', '́', '.', ',', '\t', '١٢', 'ñ', '\ud800', 'x\udc00'];
  let s = seed;
  const rnd = (m: number) => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff) % m);
  return Array.from({ length: n }, () => Array.from({ length: rnd(30) }, () => parts[rnd(parts.length)]).join(''));
}

describe('countWords', () => {
  it('matches the regex definition', () => {
    for (const t of ['', '# Hello world\n\n- item one', "don't stop — café", 'a\nb', "-x _y 'z", '𝒜𝒷𝒸 deux', ...fuzz(5000, 3)]) expect(countWords(t), JSON.stringify(t)).toEqual(old(t));
  });

  it('is fast and allocation-light on 1 MB', () => {
    const text = 'Some words — here, with café and 123 numbers.\n'.repeat(22000);
    const t = performance.now();
    const r = countWords(text);
    expect(r).toEqual(old(text));
    expect(performance.now() - t).toBeLessThan(200);
  });
});
