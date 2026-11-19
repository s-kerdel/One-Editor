// The interning tokenizer (Vocabulary.addText) must see exactly the words tokenizeWords sees,
// count each once per document, and keep no slice of the scanned text alive.
import { describe, expect, it } from 'vitest';
import { Vocabulary, tokenizeWords } from '../../../src/search/typo';
import { synthDocs } from './synth';

describe('Vocabulary.addText', () => {
  it('finds the same unique tokens as tokenizeWords and counts document frequency', () => {
    const v = new Vocabulary();
    const df = new Map<string, number>();
    const texts = [...synthDocs(300, 5).map((d) => d.content.toLowerCase()), 'a bb ccc __x_ 9z\nnaïve café über ß 日本語 x' + 'y'.repeat(60), '', 'émoji 😀 mid😀word', 'aa aa aa'];
    for (const t of texts) {
      const ids = v.addText([t, 'path/to/file-name.md']);
      const got = new Set([...ids].map((id) => v.tokenOf(id)!));
      const want = new Set(tokenizeWords(t + '\n' + 'path/to/file-name.md'));
      expect(got).toEqual(want);
      expect(ids.length, 'unique ids').toBe(got.size);
      for (const w of want) df.set(w, (df.get(w) ?? 0) + 1);
    }
    for (const [w, n] of df) expect(v.docFreq(w), w).toBe(n);
    // Removing a document decrements exactly its words.
    const ids = v.addText(['zebra zebra quokka']);
    expect(v.docFreq('zebra')).toBe(1);
    v.removeDoc(ids);
    expect(v.docFreq('zebra')).toBe(0);
    expect(v.docFreq('quokka')).toBe(0);
  });

  it('survives table growth with many distinct tokens', () => {
    const v = new Vocabulary();
    const words = Array.from({ length: 20000 }, (_, i) => `w${i.toString(36)}x`);
    v.addText([words.join(' ')]);
    v.addText([words.slice(0, 100).join(' ')]);
    expect(v.size).toBe(20000);
    expect(v.docFreq(words[5])).toBe(2);
    expect(v.docFreq(words[19999])).toBe(1);
  });
});
