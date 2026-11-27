// Phrases across inline Markdown markers ("build before pushing" finds "`npm run build` before pushing"). The
// regex form backtracked exponentially for words made only of marker characters (audit M2: the MCP server and
// the desktop search hung on a quoted "** ** **" query over a note of marker runs). The scanner must give the
// regex's matches for every query and finish fast on the crafted ones.
import { describe, expect, it } from 'vitest';
import { loosePhrase } from '../../../src/search/engine';
import { engineWith } from './helpers';

/** The regex the scanner replaced (kept here as the reference; small inputs only). */
function regexMatches(needle: string, hay: string): Array<[number, number]> {
  const words = needle.trim().split(/\s+/);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const re = new RegExp(words.map(esc).join('[`*_~=]{0,3}[ \\t]+[`*_~=]{0,3}'), 'g');
  const out: Array<[number, number]> = [];
  for (let m = re.exec(hay); m; m = re.exec(hay)) out.push([m.index, m.index + m[0].length]);
  return out;
}
const scanMatches = (needle: string, hay: string) => {
  const out: Array<[number, number]> = [];
  loosePhrase(needle).scan(hay, (s, e) => void out.push([s, e]));
  return out;
};

/** Deterministic PRNG (mulberry32): the same cases on every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('loosePhrase: the same matches as the regex form', () => {
  it('normal phrases', () => {
    const cases: Array<[string, string]> = [
      ['build before pushing', 'Run `npm run build` before pushing to **main** today.'],
      ['very bold', 'a ==very **bold** mark== b'],
      ['foo bar', 'foo bar foo  bar foo\tbar foo_ _bar foo```` bar foo\nbar'],
      ['a b c', 'a b c a b c ab c a  b   c'],
      ['**bold** text', 'some **bold** text and ***bold** text'],
      ['x y', ''],
    ];
    for (const [needle, hay] of cases) expect(scanMatches(needle, hay), `${needle} | ${hay}`).toEqual(regexMatches(needle, hay));
  });

  it('random marker-heavy text and phrases (marker-only words included)', () => {
    const next = rng(20261127);
    const pick = (s: string) => s[Math.floor(next() * s.length)];
    const str = (alpha: string, max: number) => Array.from({ length: Math.floor(next() * max) }, () => pick(alpha)).join('');
    for (let i = 0; i < 3000; i++) {
      const words = Array.from({ length: 2 + Math.floor(next() * 3) }, () => str('ab`*_=~', 3) || 'a');
      const needle = words.join(' ');
      const hay = str('ab`*_=~ \t\n', 40);
      expect(scanMatches(needle, hay), JSON.stringify([needle, hay])).toEqual(regexMatches(needle, hay));
    }
  });
});

describe('crafted input finishes fast', () => {
  // 40 words of "``" against runs of six backticks: the regex had 3 ways per gap (3^40 paths before failing).
  const needle = Array(40).fill('``').join(' ') + ' end';
  const hay = Array(60).fill('``````').join(' ') + ' x';

  it('the scanner', () => {
    const t = performance.now();
    expect(scanMatches(needle, hay)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('a quoted query through the search engine (desktop search and MCP share it)', () => {
    const e = engineWith({ 'trap.md': `# Trap\n\n${hay}\n`, 'ok.md': 'Run `npm run build` before pushing.\n' });
    const t = performance.now();
    expect(e.search(`"${needle}"`).results).toEqual([]);
    expect(e.search('"build before pushing"').results.map((r) => r.path)).toEqual(['ok.md']);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('a huge note with many partial hits stays bounded (step budget per document)', () => {
    const big = Array(200_000).fill('``').join(' ');
    const t = performance.now();
    expect(scanMatches(`${Array(200).fill('``').join(' ')} end`, big)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
