import { describe, expect, it } from 'vitest';
import { KnowledgeIndex } from '../../../src/knowledge/index';
import { localGraph, notesSharingTag, notesWithoutIncoming, orphanNotes, relatedNotes, sharedTags } from '../../../src/knowledge/connections';

function build(files: Record<string, string>) {
  const idx = new KnowledgeIndex();
  idx.setFiles(Object.keys(files));
  for (const [p, t] of Object.entries(files)) idx.update(p, t);
  return idx;
}

// X links to A and B. C also links to A (coupling with X). D links to X and E (co-citation of E).
// F shares the rare tag #rare with X. Hub links to everything (weak evidence).
const WS = {
  'X.md': '# X\n[[A]] [[B]] #rare #common',
  'A.md': '# A',
  'B.md': '# B',
  'C.md': '# C\n[[A]]',
  'D.md': '# D\n[[X]] [[E]]',
  'E.md': '# E',
  'F.md': '# F\n#rare #common',
  'G.md': '# G\n#common',
  'Hub.md': '# Hub\n[[A]] [[B]] [[C]] [[D]] [[E]] [[F]] [[G]] [[Lonely]] [[X]]',
  'Lonely.md': '# Lonely',
  'Orphan.md': '# Orphan\n[[Nowhere]] ![img](pic.png) [[Orphan]]',
  'pic.png': '',
};

describe('link graph accessors', () => {
  it('linksFrom: unique resolved notes, no self links, no attachments or unresolved', () => {
    const idx = build({ ...WS, 'Y.md': '[[A]] [[A#h]] [[Y]] [[Ghost]] ![x](pic.png)' });
    expect(idx.linksFrom('Y.md')).toEqual(['A.md']);
    expect([...idx.linksTo('A.md')].sort()).toEqual(['C.md', 'Hub.md', 'X.md', 'Y.md']);
    expect(idx.notesTagged('#RARE')).toEqual(new Set(['X.md', 'F.md']));
  });

  it('follows edits incrementally (cache dropped for the edited note and its targets)', () => {
    const idx = build(WS);
    expect(idx.linksFrom('C.md')).toEqual(['A.md']);
    idx.update('C.md', '# C\n[[B]] [[E]]');
    expect(idx.linksFrom('C.md')).toEqual(['B.md', 'E.md']);
    expect(idx.linksTo('A.md').has('C.md')).toBe(false);
    expect(idx.linksTo('E.md').has('C.md')).toBe(true);
    // A new note makes a dangling link resolve (full re-derive).
    expect(idx.linksFrom('Orphan.md')).toEqual([]);
    idx.update('Nowhere.md', '# Nowhere');
    expect(idx.linksFrom('Orphan.md')).toEqual(['Nowhere.md']);
    idx.remove('Nowhere.md');
    expect(idx.linksFrom('Orphan.md')).toEqual([]);
  });
});

describe('relatedNotes', () => {
  it('ranks by co-citation, coupling and shared tags; excludes direct neighbours', () => {
    const idx = build(WS);
    const rel = relatedNotes(idx, 'X.md');
    const paths = rel.map((r) => r.path);
    // A, B (outgoing) and D, Hub (incoming) are direct neighbours: never "related".
    for (const direct of ['A.md', 'B.md', 'D.md', 'Hub.md', 'X.md']) expect(paths).not.toContain(direct);
    // E: co-cited by D, which links to two notes only. C: also links to A. F: two shared tags (+ Hub).
    expect(paths[0]).toBe('E.md');
    expect(paths.slice(0, 3).sort()).toEqual(['C.md', 'E.md', 'F.md']);
    expect(rel.find((r) => r.path === 'C.md')!.links).toBe(2); // via A (coupling) and Hub (co-citation)
    const f = rel.find((r) => r.path === 'F.md')!;
    expect(f.tags.sort()).toEqual(['common', 'rare']);
    // A rare shared tag beats a common one.
    const g = rel.find((r) => r.path === 'G.md')!;
    expect(f.score).toBeGreaterThan(g.score);
  });

  it('a hub that links to everything is weak evidence', () => {
    const idx = build(WS);
    // Lonely is co-cited with X only by Hub (fan 9); E is co-cited by D (fan 2) and Hub.
    const rel = relatedNotes(idx, 'X.md');
    const score = (p: string) => rel.find((r) => r.path === p)?.score ?? 0;
    expect(score('E.md')).toBeGreaterThan(score('Lonely.md'));
    expect(score('Lonely.md')).toBeGreaterThan(0);
  });

  it('stays within its work budget on hubs (most specific neighbours first)', () => {
    const idx = build(WS);
    const rel = relatedNotes(idx, 'X.md', { budget: 3 });
    // Only the cheapest intermediates fit: no tag work, no hub expansion.
    expect(rel.every((r) => r.tags.length === 0)).toBe(true);
    expect(rel.length).toBeLessThanOrEqual(2);
  });

  it('updates after an edit', () => {
    const idx = build(WS);
    expect(relatedNotes(idx, 'X.md').map((r) => r.path)).toContain('C.md');
    idx.update('C.md', '# C\n[[X]]'); // now a direct neighbour
    expect(relatedNotes(idx, 'X.md').map((r) => r.path)).not.toContain('C.md');
  });
});

describe('tags, local graph, orphans', () => {
  it('shared tags count the other notes', () => {
    const idx = build(WS);
    expect(sharedTags(idx, 'X.md')).toEqual([
      { tag: 'rare', count: 1 },
      { tag: 'common', count: 2 },
    ]);
    expect(notesSharingTag(idx, 'X.md', 'common')).toEqual(['F.md', 'G.md']);
  });

  it('local graph: depth 1 vs 2, capped, edges among kept nodes only', () => {
    const idx = build(WS);
    const g1 = localGraph(idx, 'X.md', 1);
    expect(g1.nodes[0].id).toBe('X.md');
    expect(g1.nodes.map((n) => n.id).sort()).toEqual(['A.md', 'B.md', 'D.md', 'Hub.md', 'X.md']);
    const pairs = new Set<string>();
    for (let e = 0; e < g1.edges.length; e += 2) pairs.add([g1.nodes[g1.edges[e]].id, g1.nodes[g1.edges[e + 1]].id].sort().join('–'));
    expect(pairs).toEqual(new Set(['A.md–X.md', 'B.md–X.md', 'D.md–X.md', 'Hub.md–X.md', 'A.md–Hub.md', 'B.md–Hub.md', 'D.md–Hub.md']));
    expect(g1.nodes.find((n) => n.id === 'Hub.md')!.degree).toBe(4);

    const g2 = localGraph(idx, 'X.md', 2);
    expect(g2.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['C.md', 'E.md', 'Lonely.md']));
    expect(g2.nodes).toHaveLength(10); // everything but Orphan.md

    const capped = localGraph(idx, 'X.md', 2, 6);
    expect(capped.nodes).toHaveLength(6);
    expect(capped.nodes[0].id).toBe('X.md');
  });

  it('orphans have no links in or out; "no incoming" ignores outgoing ones', () => {
    const idx = build(WS);
    const notes = idx.notes().map((n) => n.path);
    // Orphan.md links only to itself, a missing note and an image.
    expect(orphanNotes(idx, notes)).toEqual(['Orphan.md']);
    expect(notesWithoutIncoming(idx, notes)).toEqual(['Hub.md', 'Orphan.md']);
    idx.update('G.md', '# G\n[[Orphan]]');
    expect(orphanNotes(idx, notes)).toEqual([]);
    expect(notesWithoutIncoming(idx, notes)).not.toContain('Orphan.md');
  });
});
