// Message handler around SearchEngine. Used inside the Web Worker (worker.ts) and as an in-thread
// fallback when workers are unavailable. Searches run as generators that yield every few ms, so a newer
// query (or cancel) arriving meanwhile aborts the stale one instead of queueing behind it.
import { SearchEngine, type MatchRun } from './engine';
import type { FromWorker, NoteItem, ToWorker } from './protocol';
import type { SearchDoc } from './types';
import { extractNote } from '../knowledge/extract';
import { findMentions, linkSnippets, mentionMatcher, type Mention } from '../knowledge/index';
import { isMarkdown } from '@shared/paths';

/** Metadata of the Markdown notes among `docs` (computed where the text already is). */
export function notesOf(docs: readonly SearchDoc[]): NoteItem[] {
  const out: NoteItem[] = [];
  for (const d of docs) {
    if (!isMarkdown(d.path)) continue;
    const info = extractNote(d.path, d.content);
    out.push({ path: d.path, info, snippets: linkSnippets(d.content, info.links) });
  }
  return out;
}

const SLICE_MS = 8;
/** Notes per 'notes' message (~1–2 ms to deserialise on the UI thread). */
const NOTES_BATCH = 64;

export class SearchHost {
  readonly engine = new SearchEngine();
  private latest = new Map<string, number>();
  private channelOf = new Map<number, string>();
  private cancelled = new Set<number>();
  /** A sliced rebuild in progress (reset with `more`): generation + engine time so far. */
  private building: { gen: number; ms: number } | null = null;
  /** Sharded search: candidates of the latest match per channel, waiting for their 'rank'. */
  private runs = new Map<number, MatchRun>();

  constructor(
    private post: (m: FromWorker) => void,
    private yieldFn: () => Promise<void> = defaultYield,
  ) {}

  handle(msg: ToWorker) {
    try {
      switch (msg.type) {
        case 'reset': {
          const t0 = performance.now();
          this.engine.reset(msg.docs);
          const ms = performance.now() - t0;
          if (msg.more) this.building = { gen: msg.gen, ms };
          else {
            this.building = null;
            this.post({ type: 'indexed', gen: msg.gen, count: this.engine.size, ms });
          }
          break;
        }
        case 'append': {
          const b = this.building;
          if (!b || b.gen !== msg.gen) break; // slice of a superseded rebuild
          const t0 = performance.now();
          this.engine.upsertMany(msg.docs);
          b.ms += performance.now() - t0;
          this.postNotes(msg.docs, msg.gen);
          if (msg.done) {
            this.building = null;
            this.post({ type: 'indexed', gen: msg.gen, count: this.engine.size, ms: b.ms });
          }
          break;
        }
        case 'upsert': {
          this.engine.upsertMany(msg.docs);
          if (msg.notes) this.postNotes(msg.docs);
          break;
        }
        case 'remove':
          msg.paths.forEach((p) => this.engine.remove(p));
          if (msg.notes) this.post({ type: 'notes', items: [], removed: msg.paths });
          break;
        case 'rename':
          this.engine.rename(msg.from, msg.to);
          break;
        case 'cancel':
          this.cancelled.add(msg.id);
          break;
        case 'headings':
          this.post({ type: 'headings', id: msg.id, hits: this.engine.headings(msg.q.query, msg.q) });
          break;
        case 'search':
          this.latest.set(msg.channel, msg.id);
          this.channelOf.set(msg.id, msg.channel);
          void this.runSearch(msg);
          break;
        case 'match': {
          // A newer match on the channel supersedes the older one, ranked or not.
          const prev = this.latest.get(msg.channel);
          if (prev !== undefined) {
            this.runs.delete(prev);
            this.channelOf.delete(prev);
          }
          this.latest.set(msg.channel, msg.id);
          this.channelOf.set(msg.id, msg.channel);
          void this.runMatch(msg);
          break;
        }
        case 'rank': {
          const run = this.runs.get(msg.id);
          if (!run || this.stale(msg.id)) {
            this.runs.delete(msg.id);
            this.post({ type: 'cancelled', id: msg.id });
            break;
          }
          void this.drive(msg.id, this.engine.rankSteps(run, msg.stats, msg.options), (results) => {
            this.runs.delete(msg.id);
            this.post({ type: 'ranked', id: msg.id, results });
          }).finally(() => this.runs.has(msg.id) || this.channelOf.delete(msg.id));
          break;
        }
        case 'vocab':
          this.post({ type: 'vocab', id: msg.id, info: this.engine.vocabInfo(msg.words) });
          break;
        case 'replay': {
          const docs: SearchDoc[] = [];
          for (const [path, content] of this.engine.contents()) if (isMarkdown(path)) docs.push({ path, content });
          for (let i = 0; i < docs.length; i += NOTES_BATCH) this.post({ type: 'notes', gen: msg.gen, items: notesOf(docs.slice(i, i + NOTES_BATCH)) });
          this.post({ type: 'replayed', gen: msg.gen });
          break;
        }
        case 'mentions': {
          const m = mentionMatcher(msg.names);
          const items: Mention[] = [];
          for (const [p, content] of this.engine.contents()) {
            if (p === msg.exclude || !isMarkdown(p)) continue;
            findMentions(content, p, m, msg.limit, items);
            if (items.length >= msg.limit) break;
          }
          this.post({ type: 'mentions', id: msg.id, items });
          break;
        }
      }
    } catch (err) {
      this.post({ type: 'error', id: 'id' in msg ? (msg as { id: number }).id : undefined, message: String((err as Error)?.message ?? err) });
    }
  }

  /** Note metadata in small messages: the UI thread deserialises each one in a single task. */
  private postNotes(docs: readonly SearchDoc[], gen?: number) {
    const md = docs.filter((d) => isMarkdown(d.path));
    for (let i = 0; i < md.length; i += NOTES_BATCH) {
      const items = notesOf(md.slice(i, i + NOTES_BATCH));
      this.post(gen === undefined ? { type: 'notes', items } : { type: 'notes', gen, items });
    }
  }

  private stale(id: number) {
    return this.cancelled.has(id) || this.latest.get(this.channelOf.get(id)!) !== id;
  }

  private runMatch(msg: Extract<ToWorker, { type: 'match' }>) {
    const plan = this.engine.planFor(msg.query, msg.options, msg.fuzzy);
    const { N, totalLen } = this.engine.corpus;
    if (!plan) {
      this.post({ type: 'matched', id: msg.id, df: [], totalFiles: 0, totalMatches: 0, N, totalLen });
      return;
    }
    return this.drive(msg.id, this.engine.matchSteps(plan), (run) => {
      this.runs.set(msg.id, run);
      const c = this.engine.corpus;
      this.post({ type: 'matched', id: msg.id, df: run.df, totalFiles: run.totalFiles, totalMatches: run.totalMatches, N: c.N, totalLen: c.totalLen });
    });
  }

  /** Runs a generator in time slices; a newer request on its channel (or a cancel) stops it. */
  private async drive<T>(id: number, gen: Generator<void, T, void>, done: (v: T) => void) {
    try {
      let t = performance.now();
      for (;;) {
        const r = gen.next();
        if (r.done) return done(r.value);
        if (performance.now() - t > SLICE_MS) {
          await this.yieldFn();
          if (this.stale(id)) {
            this.runs.delete(id);
            this.post({ type: 'cancelled', id });
            return;
          }
          t = performance.now();
        }
      }
    } catch (err) {
      this.runs.delete(id);
      this.post({ type: 'error', id, message: String((err as Error)?.message ?? err) });
    } finally {
      this.cancelled.delete(id);
    }
  }

  private async runSearch(msg: Extract<ToWorker, { type: 'search' }>) {
    const { id } = msg;
    try {
      const gen = this.engine.searchSteps(msg.query, msg.options);
      let t = performance.now();
      for (;;) {
        const r = gen.next();
        if (r.done) {
          this.post({ type: 'result', id, response: r.value });
          return;
        }
        if (performance.now() - t > SLICE_MS) {
          await this.yieldFn();
          if (this.stale(id)) {
            this.post({ type: 'cancelled', id });
            return;
          }
          t = performance.now();
        }
      }
    } catch (err) {
      this.post({ type: 'error', id, message: String((err as Error)?.message ?? err) });
    } finally {
      this.cancelled.delete(id);
      this.channelOf.delete(id);
    }
  }
}

function defaultYield(): Promise<void> {
  // MessageChannel beats setTimeout's clamping; incoming messages get a chance to run in between.
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}
