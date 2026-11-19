// Quick open narrows while typing: a query that extends the previous one is matched only against the
// previous matches (fuzzyFilter's `collect`). That must give exactly what a full search gives.
import { describe, expect, it } from 'vitest';
import { fuzzyFilter } from '../../../src/search/fuzzy';

const words = ['Meeting', 'notes', 'kubernetes', 'déploiement', 'README', 'src', 'App', 'überblick', 'part-4', 'topic_3', 'x'];
function paths(n: number, seed = 7): string[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = () => words[Math.floor(rnd() * words.length)];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${pick()}/${pick()}-${i % 17}/${pick()} ${pick()}${i % 5 ? '.md' : '.ts'}`);
  return out;
}

const typed = ['m', 'me', 'mee', 'meet', 'meet ', 'meet 1', 'meet 12', 'k', 'ku', 'kub', 'kub/', 'kub/p', 'kub/pa', 'D', 'Dé', 'Dép', 'r', 're', 'rea', 'readme', 'README', 'ü', 'üb', 'ub', 'top', 'topic_3 x'];

describe('quick open: narrowing while typing gives the same results as a full search', () => {
  const all = paths(3000);
  it('every keystroke of several typed queries', () => {
    let prev: { q: string; matched: string[] } | null = null;
    for (const q of typed) {
      const pool = prev && q.startsWith(prev.q) ? prev.matched : all;
      const matched: string[] = [];
      const narrowed = fuzzyFilter(q, pool, (p) => p, 400, { path: true, collect: matched });
      const full = fuzzyFilter(q, all, (p) => p, 400, { path: true });
      expect(narrowed, `query "${q}"`).toEqual(full);
      prev = { q, matched };
    }
  });
});
