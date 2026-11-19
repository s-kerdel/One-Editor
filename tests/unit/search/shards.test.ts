// Sharded search must answer exactly like one index: same results, order, scores, rows, totals,
// typo corrections and suggestions — whatever the shard count.
import { describe, expect, it } from 'vitest';
import { SearchHost } from '../../../src/search/host';
import { ShardedSearch, shardOfPath } from '../../../src/search/shards';
import { SearchEngine } from '../../../src/search/engine';
import type { SearchOptions } from '../../../src/search/types';
import { synthDocs } from './synth';
import { fixtureDocs } from './helpers';

/** N in-process shards (async delivery, like workers). */
function sharded(n: number) {
  let s!: ShardedSearch;
  const hosts: SearchHost[] = [];
  const ports = Array.from({ length: n }, (_, i) => {
    const host = new SearchHost(
      (m) => setTimeout(() => s.onMessage(i, m), 0),
      () => new Promise((r) => setTimeout(r, 0)),
    );
    hosts.push(host);
    return { post: (m: Parameters<SearchHost['handle']>[0]) => setTimeout(() => host.handle(m), 0) };
  });
  s = new ShardedSearch(ports);
  return { s, hosts };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

const corpus = [
  ...fixtureDocs(),
  ...synthDocs(600, 7),
  { path: 'notes/typo/kubectl.md', content: '# Kubectl notes\n\nkubectl rollout restart deploy/api\nkubectl get pods -o wide\n' },
  { path: 'notes/typo/artisan.md', content: 'php artisan migrate:fresh --seed\n\nartisan tinker\n' },
  { path: 'notes/typo/rare.md', content: 'The word zephyrine appears once here, and zephyrine-like twice.\n' },
  { path: 'notes/accents/cafe.md', content: '# Café\n\nNaïve résumé of the café menu.\n' },
];

const QUERIES: Array<[string, SearchOptions?]> = [
  ['rollback'],
  ['deploy cluster'],
  ['git push --force-with-lease origin main'],
  ['"build before"'],
  ['kubctl'], // typo → fuzzy fallback
  ['artsan migrate'], // typo in one clause
  ['zephyrin'], // few hits → maybe "did you mean"
  ['naive resume'], // diacritic folding
  ['quick -fox'],
  ['tag:ops'],
  ['ext:md release'],
  ['in:code kubectl'],
  ['lang:bash docker'],
  ['path:folder1 project'],
  ['TODO', { caseSensitive: true }],
  ['dep.oy', { regex: true }],
  ['ser(ver|vice)', { regex: true }],
  ['the', { limit: 7 }],
  ['the', { limit: 1000, maxMatchesPerFile: 1, fuzzy: false }],
  ['node', { wholeWord: true }],
  ['qzxvy'], // nothing at all
  ['('], // regex error path (literal by default) / warnings
  ['[unclosed', { regex: true }],
  [''],
];

describe('sharded search equals one index', () => {
  for (const n of [1, 3, 8]) {
    it(`${n} shard(s): identical responses`, async () => {
      const one = new SearchEngine();
      one.reset(corpus);
      const { s } = sharded(n);
      s.reset(1);
      s.append(1, corpus.slice(0, 300), false);
      s.append(1, corpus.slice(300), true);
      // Live edits route to the owning shard; a rename keeps the doc where it is.
      const edit = { path: corpus[5].path, content: corpus[5].content + '\nrollback the cluster deploy now\n' };
      one.upsert(edit);
      s.upsert([edit]);
      one.rename('notes/typo', 'notes/typos');
      s.rename('notes/typo', 'notes/typos');
      one.remove(corpus[9].path);
      s.remove([corpus[9].path]);
      await settle();
      for (const [q, o] of QUERIES) {
        const a = one.search(q, o);
        const b = await s.search(q, o, `c-${q}`);
        expect(b, q).not.toBeNull();
        const strip = (r: typeof a) => ({ ...r, tookMs: 0 });
        expect(strip(b!), `query "${q}" ${JSON.stringify(o ?? {})}`).toEqual(strip(a));
      }
      for (const hq of [{ query: '' }, { query: 'note', limit: 5 }, { query: 'kub' }, { query: '', path: corpus[0].path }, { query: 'a', fileQuery: 'folder' }]) {
        expect(await s.headings(hq), JSON.stringify(hq)).toEqual(one.headings(hq.query, hq));
      }
    });
  }

  it('covers fuzzy + suggestions in the query set (guards the test itself)', () => {
    const one = new SearchEngine();
    one.reset(corpus);
    expect(one.search('kubctl').fuzzy).toBe(true);
    expect(one.search('artsan migrate').corrections?.length).toBeGreaterThan(0);
  });

  it('a newer search on a channel supersedes the older one on every shard', async () => {
    const { s } = sharded(4);
    s.reset(1);
    s.append(1, synthDocs(3000, 3), true);
    await settle();
    const first = s.search('project meeting notes', {}, 'panel');
    const second = s.search('release deploy', {}, 'panel');
    expect(await first).toBeNull();
    expect((await second)?.totalFiles).toBeGreaterThan(0);
  });

  it('routes by a stable path hash and spreads documents over shards', () => {
    expect(shardOfPath('notes/a.md', 8)).toBe(shardOfPath('notes/a.md', 8));
    const counts = new Array(8).fill(0);
    for (const d of synthDocs(2000, 1)) counts[shardOfPath(d.path, 8)]++;
    for (const c of counts) expect(c).toBeGreaterThan(150);
  });
});
