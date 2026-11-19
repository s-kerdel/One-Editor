// A note's neighbourhood for the Connections view: related notes (co-citation + shared tags), a
// capped local graph and orphan lists. Pure: reads the adjacency the KnowledgeIndex keeps patched,
// so switching notes costs O(that note's neighbourhood), never O(all notes).
import { stem } from '@shared/paths';
import type { GraphData, GraphNode } from './graph';

export interface LinkGraph {
  /** Notes `path` links to: resolved Markdown notes, unique, itself excluded. */
  linksFrom(path: string): readonly string[];
  /** Notes linking to `path` (may include `path` itself). */
  linksTo(path: string): ReadonlySet<string>;
  tagsOf(path: string): readonly string[];
  /** Notes carrying exactly this tag (case-insensitive). */
  notesTagged(tag: string): ReadonlySet<string>;
}

export interface RelatedNote {
  path: string;
  score: number;
  /** Shared link neighbours: notes both link to, or notes linking to both. */
  links: number;
  /** Tags both carry. */
  tags: string[];
}

export interface RelatedOptions {
  limit?: number;
  /** Edge visits at most (hub notes stay bounded; the most specific neighbours go first). */
  budget?: number;
}

/** A shared tag counts for less than a shared link: tags are coarse. */
const TAG_WEIGHT = 0.5;
/** A tag on this many notes says nothing about how two of them relate (and would cost a scan). */
const TAG_FAN_MAX = 500;
const DEFAULT_BUDGET = 20_000;

const hasIncoming = (g: LinkGraph, p: string) => {
  for (const s of g.linksTo(p)) if (s !== p) return true;
  return false;
};

/**
 * Notes related to `path` without linking to it directly, ranked by
 *  · bibliographic coupling — both link to the same note,
 *  · co-citation — another note links to both,
 *  · shared tags,
 * each weighted 1/log2(1 + fan): a note only three others cite says more than a hub everyone cites.
 */
export function relatedNotes(g: LinkGraph, path: string, opts: RelatedOptions = {}): RelatedNote[] {
  const limit = opts.limit ?? 12;
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const out = g.linksFrom(path);
  const inc = g.linksTo(path);
  const direct = new Set<string>(out);
  for (const s of inc) direct.add(s);
  direct.add(path);

  const acc = new Map<string, RelatedNote>();
  const bump = (p: string, w: number, tag?: string) => {
    if (direct.has(p)) return;
    let a = acc.get(p);
    if (!a) acc.set(p, (a = { path: p, score: 0, links: 0, tags: [] }));
    a.score += w;
    if (tag) a.tags.push(tag);
    else a.links++;
  };

  // Intermediate notes, most specific first, so a budget cut drops the hubs.
  const via: Array<{ fan: number; cites: boolean; p: string }> = [];
  for (const t of out) via.push({ fan: g.linksTo(t).size, cites: false, p: t });
  for (const c of inc) if (c !== path) via.push({ fan: g.linksFrom(c).length, cites: true, p: c });
  via.sort((a, b) => a.fan - b.fan || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  let work = 0;
  for (const v of via) {
    if (v.fan <= 1) continue; // only `path` itself
    if (work + v.fan > budget) break;
    work += v.fan;
    const w = 1 / Math.log2(1 + v.fan);
    if (v.cites) {
      for (const t of g.linksFrom(v.p)) if (t !== path) bump(t, w);
    } else for (const s of g.linksTo(v.p)) if (s !== path) bump(s, w);
  }
  for (const tag of g.tagsOf(path)) {
    const notes = g.notesTagged(tag);
    if (notes.size <= 1 || notes.size > TAG_FAN_MAX || work + notes.size > budget) continue;
    work += notes.size;
    const w = TAG_WEIGHT / Math.log2(1 + notes.size);
    for (const p of notes) if (p !== path) bump(p, w, tag);
  }
  return [...acc.values()].sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).slice(0, limit);
}

export interface SharedTag {
  tag: string;
  /** Other notes carrying it. */
  count: number;
}

export function sharedTags(g: LinkGraph, path: string): SharedTag[] {
  return g.tagsOf(path).map((tag) => {
    const notes = g.notesTagged(tag);
    return { tag, count: notes.size - (notes.has(path) ? 1 : 0) };
  });
}

/** Other notes tagged `tag`, sorted (at most `limit`). */
export function notesSharingTag(g: LinkGraph, path: string, tag: string, limit = 30): string[] {
  const out: string[] = [];
  for (const p of g.notesTagged(tag)) if (p !== path) out.push(p);
  return out.sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

/** Notes 1–2 hops around `path` (node 0), at most `cap` nodes, edges among them only. */
export function localGraph(g: LinkGraph, path: string, depth: 1 | 2, cap = 60): GraphData {
  const ids = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const add = (p: string) => {
    ids.set(p, nodes.length);
    nodes.push({ id: p, label: stem(p), kind: 'note', degree: 0 });
  };
  const neighbours = (p: string): Set<string> => {
    const s = new Set(g.linksFrom(p));
    for (const x of g.linksTo(p)) s.add(x);
    s.delete(p);
    return s;
  };
  const degree = (p: string) => g.linksFrom(p).length + g.linksTo(p).size;
  add(path);
  // Too many direct neighbours: keep the best connected ones (deterministic order).
  const first = [...neighbours(path)];
  if (first.length > cap - 1) {
    const deg = new Map(first.map((p) => [p, degree(p)]));
    first.sort((a, b) => deg.get(b)! - deg.get(a)! || a.localeCompare(b));
  } else first.sort((a, b) => a.localeCompare(b));
  for (const p of first.slice(0, cap - 1)) add(p);
  if (depth === 2 && nodes.length < cap) {
    // Second hop: notes reached from the most first-hop notes win.
    const score = new Map<string, number>();
    let work = 0;
    for (let i = 1; i < nodes.length && work < DEFAULT_BUDGET; i++)
      for (const q of neighbours(nodes[i].id)) {
        work++;
        if (!ids.has(q)) score.set(q, (score.get(q) ?? 0) + 1);
      }
    const second = [...score].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, cap - nodes.length);
    for (const [p] of second) add(p);
  }
  const edges: number[] = [];
  const seen = new Set<number>();
  for (const [p, i] of ids)
    for (const t of g.linksFrom(p)) {
      const j = ids.get(t);
      if (j === undefined || j === i) continue;
      const key = i < j ? i * 0x10000 + j : j * 0x10000 + i;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(i, j);
      nodes[i].degree++;
      nodes[j].degree++;
    }
  return { nodes, edges };
}

/** Notes with no links in or out (to other notes). */
export function orphanNotes(g: LinkGraph, notes: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of notes) if (!g.linksFrom(p).length && !hasIncoming(g, p)) out.push(p);
  return out.sort((a, b) => a.localeCompare(b));
}

/** Notes no other note links to. */
export function notesWithoutIncoming(g: LinkGraph, notes: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of notes) if (!hasIncoming(g, p)) out.push(p);
  return out.sort((a, b) => a.localeCompare(b));
}
