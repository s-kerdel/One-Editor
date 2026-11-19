// Sharded search: the index is split over N workers (documents by a stable hash of the path) so
// building it and running a query use N cores. Results equal one index exactly: each query runs in
// two phases — every shard finds its candidates and reports exact document frequencies, then all
// shards score with the *summed* corpus statistics (BM25 idf / average length) and the best
// results are merged with the same (score, path) order one index sorts by. Typo fallback and
// "did you mean" ask every shard's vocabulary and merge it (document frequencies add up).
// Pure TS, transport-agnostic: ports can be Web Workers or in-process SearchHosts (tests).
import { compareHeadings, compareRanked, correctionWords, correctWith, finishResults, fuzzyClauses, fuzzyTerms, hasResults, searchable, suggestionWords, wantsFuzzy, wantsSuggestions, type RankedResult, type VocabInfo } from './engine';
import { mergeSuggest } from './typo';
import { foldTerm } from './text';
import { parseQuery } from './query';
import type { FromWorker, HeadingQuery, ToWorker } from './protocol';
import type { HeadingHit, SearchDoc, SearchOptions, SearchResponse } from './types';
import type { Mention } from '../knowledge/index';

// Same order as knowledge's compareMentions (inlined: the search client chunk stays free of knowledge code).
const compareMentions = (a: Mention, b: Mention) => a.from.localeCompare(b.from) || a.line - b.line || a.col - b.col;

const DEFAULT_LIMIT = 200;

export interface ShardPort {
  post(m: ToWorker): void;
}

/** FNV-1a over UTF-16 code units: stable across runs and platforms. */
export function shardOfPath(path: string, n: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

type Matched = Extract<FromWorker, { type: 'matched' }>;
interface Waiter {
  parts: unknown[];
  left: number;
  resolve: (parts: unknown[] | null) => void;
  error?: string;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class ShardedSearch {
  /** Path → shard. A rename keeps a document on its shard, so routing is not a pure function of the path. */
  private owner = new Map<string, number>();
  private waiting = new Map<number, Waiter>();
  private latest = new Map<string, number>();
  private nextId = 1;

  constructor(readonly ports: ShardPort[]) {
    if (!ports.length) throw new Error('ShardedSearch needs at least one shard');
  }

  get n() {
    return this.ports.length;
  }

  // ---------------------------------------------------------------- index maintenance

  /** Renames since the last rebuild: documents the feeder routed by their old name stay where they are. */
  private renames: Array<[string, string]> = [];

  shardFor(path: string): number {
    let s = this.owner.get(path);
    if (s === undefined) {
      s = shardOfPath(this.origin(path), this.n);
      this.owner.set(path, s);
    }
    return s;
  }

  /** The name a document had when it was routed (undoing later renames). */
  private origin(path: string): string {
    let p = path;
    for (let i = this.renames.length - 1; i >= 0; i--) {
      const [from, to] = this.renames[i];
      if (p === to) p = from;
      else if (p.startsWith(to + '/')) p = from + p.slice(to.length);
    }
    return p;
  }

  /** Routing of `paths` (for the feeder's incremental updates). */
  shardMap(paths: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const p of paths) out[p] = this.shardFor(p);
    return out;
  }

  private group(docs: SearchDoc[]): SearchDoc[][] {
    const out: SearchDoc[][] = this.ports.map(() => []);
    for (const d of docs) out[this.shardFor(d.path)].push(d);
    return out;
  }

  /** Starts a rebuild; slices follow via append(). */
  reset(gen: number) {
    this.owner.clear();
    this.renames = [];
    for (const p of this.ports) p.post({ type: 'reset', gen, docs: [], more: true });
  }

  /** Every shard hears the last slice (`done`), with or without documents. */
  append(gen: number, docs: SearchDoc[], done: boolean) {
    this.group(docs).forEach((list, i) => {
      if (list.length || done) this.ports[i].post({ type: 'append', gen, docs: list, done });
    });
  }

  /** `notes`: the shards also report note metadata (changes from disk, not from the editor). */
  upsert(docs: SearchDoc[], notes = false) {
    this.group(docs).forEach((list, i) => list.length && this.ports[i].post(notes ? { type: 'upsert', docs: list, notes } : { type: 'upsert', docs: list }));
  }

  remove(paths: string[], notes = false) {
    const out: string[][] = this.ports.map(() => []);
    for (const p of paths) {
      out[this.shardFor(p)].push(p);
      this.owner.delete(p);
    }
    out.forEach((list, i) => list.length && this.ports[i].post(notes ? { type: 'remove', paths: list, notes } : { type: 'remove', paths: list }));
  }

  /** File or folder rename: every shard moves its own documents. */
  rename(from: string, to: string) {
    for (const p of this.ports) p.post({ type: 'rename', from, to });
    const moved: Array<[string, number]> = [];
    for (const [p, s] of this.owner) if (p === from || p.startsWith(from + '/')) moved.push([p, s]);
    for (const [p, s] of moved) {
      this.owner.delete(p);
      this.owner.set(to + p.slice(from.length), s);
    }
    this.renames.push([from, to]);
  }

  // ---------------------------------------------------------------- replies

  /** Feed every message a shard posts here (`indexed` / unknown ids are ignored: the caller handles those). */
  onMessage(shard: number, m: FromWorker): boolean {
    if (!('id' in m) || m.id === undefined) return false;
    const w = this.waiting.get(m.id);
    if (!w) return false;
    if (m.type === 'cancelled') {
      this.waiting.delete(m.id);
      w.resolve(null);
      return true;
    }
    if (m.type === 'error') w.error = m.message;
    else w.parts[shard] = m.type === 'ranked' ? m.results : m.type === 'headings' ? m.hits : m.type === 'vocab' ? m.info : m.type === 'mentions' ? m.items : m.type === 'result' ? m.response : m;
    if (--w.left === 0) {
      this.waiting.delete(m.id);
      w.resolve(w.parts);
    }
    return true;
  }

  /** Resolves every request in flight with null (workers replaced): callers retry. */
  dropPending() {
    const ws = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of ws) w.resolve(null);
  }

  private gather<T>(build: (id: number) => ToWorker, id = this.nextId++): Promise<{ parts: T[]; error?: string } | null> {
    return new Promise((resolve) => {
      const w: Waiter = { parts: new Array(this.n), left: this.n, resolve: () => {} };
      w.resolve = (parts) => resolve(parts ? { parts: parts as T[], error: w.error } : null);
      this.waiting.set(id, w);
      const msg = build(id);
      for (const p of this.ports) p.post(msg);
    });
  }

  private async vocabulary(words: string[]): Promise<{ df: (w: string) => number; suggest: (w: string, limit: number) => ReturnType<typeof mergeSuggest> } | null> {
    const uniq = [...new Set(words)];
    const r = await this.gather<VocabInfo[]>((id) => ({ type: 'vocab', id, words: uniq }));
    if (!r) return null;
    const at = new Map(uniq.map((w, i) => [w, i]));
    return {
      df: (w) => {
        const i = at.get(w);
        return i === undefined ? 0 : r.parts.reduce((s, p) => s + (p?.[i]?.df ?? 0), 0);
      },
      suggest: (w, limit) => {
        const i = at.get(w);
        return i === undefined ? [] : mergeSuggest(w, r.parts.map((p) => p?.[i]?.cands ?? []), limit);
      },
    };
  }

  private latestOn(channel: string, id: number) {
    this.latest.set(channel, id);
  }

  private superseded(channel: string, id: number) {
    return this.latest.get(channel) !== id;
  }

  // ---------------------------------------------------------------- queries

  /** Same contract as SearchEngine.search; null = superseded by a newer search on `channel` (or workers replaced). */
  async search(query: string, opts: SearchOptions = {}, channel = 'panel'): Promise<SearchResponse | null> {
    const t0 = now();
    const pq = parseQuery(query, { regex: opts.regex, literal: opts.literal, caseSensitive: opts.caseSensitive ?? 'smart' });
    const warnings = pq.warnings.length ? pq.warnings : undefined;
    const sumOf = (parts: Matched[]) => {
      const df = new Array<number>(parts[0]?.df.length ?? 0).fill(0);
      let totalFiles = 0;
      let totalMatches = 0;
      let N = 0;
      let totalLen = 0;
      for (const m of parts) {
        m.df.forEach((d, i) => (df[i] += d));
        totalFiles += m.totalFiles;
        totalMatches += m.totalMatches;
        N += m.N;
        totalLen += m.totalLen;
      }
      return { df, totalFiles, totalMatches, N, totalLen };
    };
    const id0 = this.nextId++;
    this.latestOn(channel, id0);
    if (pq.error || !searchable(pq)) {
      // Nothing to run; the index size still comes from the shards.
      const r = await this.gather<Matched>((id) => ({ type: 'match', id, channel, query: '', options: opts }), id0);
      const indexed = r ? sumOf(r.parts).N : 0;
      return { results: [], totalFiles: 0, totalMatches: 0, tookMs: now() - t0, warnings, indexed, ...(pq.error ? { error: pq.error } : {}) };
    }
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const m1 = await this.gather<Matched>((id) => ({ type: 'match', id, channel, query, options: opts }), id0);
    if (!m1 || this.superseded(channel, id0)) return null;
    if (m1.error) return { results: [], totalFiles: 0, totalMatches: 0, tookMs: now() - t0, error: m1.error, warnings };
    let runId = id0;
    let sum = sumOf(m1.parts);
    let fuzzy = false;
    let corrections: SearchResponse['corrections'];
    if (wantsFuzzy(sum, limit, opts)) {
      const words = fuzzyTerms(pq, sum.df).flatMap(correctionWords);
      const vocab = words.length ? await this.vocabulary(words) : null;
      if (words.length && (!vocab || this.superseded(channel, id0))) return null;
      const fz = vocab ? fuzzyClauses(pq, sum.df, (t) => correctWith(t, vocab.df, vocab.suggest)) : null;
      if (fz) {
        const variants: Record<string, string[]> = {};
        for (const c of fz.corrections) variants[c.from] = c.to;
        const id1 = this.nextId++;
        this.latestOn(channel, id1);
        const m2 = await this.gather<Matched>((id) => ({ type: 'match', id, channel, query, options: opts, fuzzy: { df: sum.df, variants } }), id1);
        if (!m2 || this.superseded(channel, id1)) return null;
        runId = id1;
        sum = sumOf(m2.parts);
        if (hasResults(sum, limit)) {
          fuzzy = true;
          corrections = fz.corrections;
        }
      }
    }
    const ranked = await this.gather<RankedResult[]>(() => ({ type: 'rank', id: runId, stats: { N: sum.N, totalLen: sum.totalLen, df: sum.df }, options: opts }), runId);
    if (!ranked || this.superseded(channel, runId)) return null;
    const merged = ranked.parts.flat().sort(compareRanked).slice(0, limit);
    const results = finishResults(merged, fuzzy);
    let suggestions: SearchResponse['suggestions'];
    if (!fuzzy && wantsSuggestions(sum, opts)) {
      const words = suggestionWords(pq);
      const vocab = words.length ? await this.vocabulary(words.map(foldTerm)) : null;
      if (words.length && (!vocab || this.superseded(channel, runId))) return null;
      for (const w of words) {
        const best = vocab!.suggest(foldTerm(w), 1)[0];
        if (best && best.df >= Math.max(3, sum.totalFiles * 3)) (suggestions ??= []).push({ from: w, to: best.token });
      }
    }
    return {
      results,
      totalFiles: sum.totalFiles,
      totalMatches: sum.totalMatches,
      tookMs: now() - t0,
      truncated: sum.totalFiles > results.length || undefined,
      fuzzy: fuzzy || undefined,
      corrections,
      suggestions,
      warnings,
      indexed: sum.N,
    };
  }

  /** Unlinked mentions of `names` across all shards (as KnowledgeIndex.unlinkedMentions, merged). */
  async mentions(names: string[], exclude: string, limit = 500): Promise<Mention[] | null> {
    const r = await this.gather<Mention[]>((id) => ({ type: 'mentions', id, names, exclude, limit }));
    if (!r) return null;
    return r.parts.flat().sort(compareMentions).slice(0, limit);
  }

  /** Same contract as SearchEngine.headings (each shard's best `limit`, merged). */
  async headings(q: HeadingQuery): Promise<HeadingHit[] | null> {
    const r = await this.gather<HeadingHit[]>((id) => ({ type: 'headings', id, q }));
    if (!r) return null;
    return r.parts
      .flat()
      .sort(compareHeadings)
      .slice(0, q.limit ?? 100);
  }
}
