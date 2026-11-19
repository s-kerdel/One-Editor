// Shard 0's feeder: pulls the workspace text straight from the backend's index channel
// (app://sec-edit/__index/ in Electron, /api/index/ in the browser) and routes every document to its
// shard — itself, or a peer over a MessagePort. The text never touches the UI thread, and the
// backend produces it in a worker thread, so neither side's event loop stalls while indexing.
import type { FileData } from '../shared/api';
import type { FromWorker, ToWorker } from './protocol';
import { shardOfPath } from './shards';
import type { SearchDoc } from './types';

export interface FeedSource {
  /** Base URL of the index channel, ending in '/'. */
  base: string;
  /** Sent as `x-sec-edit-index` (Electron) or `x-sec-edit-token` (browser server). */
  token: string;
  header: string;
}

export type FetchJson = (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Promise<unknown>;

interface Page {
  files: FileData[];
  nextCursor: string | null;
  total?: number;
  done?: number;
}

const toDoc = (f: FileData): SearchDoc => ({ path: f.path, content: f.content, mtime: f.mtime });

export class Feeder {
  private gen = 0;
  private paused: Promise<void> | null = null;
  private resume: (() => void) | null = null;

  constructor(
    /** Handles a message as this shard would (shard 0's own SearchHost). */
    private readonly self: (m: ToWorker) => void,
    /** Peers 1..n-1 (index 0 unused). */
    private readonly peers: Array<{ postMessage(m: ToWorker): void } | undefined>,
    private readonly post: (m: FromWorker) => void,
    private readonly fetchJson: FetchJson,
  ) {}

  get shards() {
    return this.peers.length + 1;
  }

  setPeer(i: number, port: { postMessage(m: ToWorker): void }) {
    this.peers[i - 1] = port;
  }

  /** Hidden window: stop pulling pages until shown again (indexing never competes with nothing). */
  pause(on: boolean) {
    if (on && !this.paused) this.paused = new Promise((r) => (this.resume = r));
    else if (!on && this.paused) {
      this.resume?.();
      this.paused = null;
      this.resume = null;
    }
  }

  private route(docs: SearchDoc[], send: (shard: number, docs: SearchDoc[]) => void) {
    const n = this.shards;
    const by: SearchDoc[][] = Array.from({ length: n }, () => []);
    for (const d of docs) by[shardOfPath(d.path, n)].push(d);
    by.forEach((list, i) => send(i, list));
  }

  private to(i: number, m: ToWorker) {
    if (i === 0) this.self(m);
    else this.peers[i - 1]?.postMessage(m);
  }

  private headers(src: FeedSource) {
    return { [src.header]: src.token };
  }

  /** A full pass: every shard gets its documents, then `done`. Resolves when the last page is routed. */
  async feed(gen: number, src: FeedSource, maxBytes: number): Promise<void> {
    this.gen = gen;
    const get = (cursor: string | null) => this.fetchJson(src.base + `page?maxBytes=${maxBytes}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, { headers: this.headers(src) }) as Promise<Page>;
    try {
      let next: Promise<Page> | null = get(null);
      while (next) {
        const page: Page = await next;
        if (gen !== this.gen) return;
        // Ask for the next page before routing this one: the backend reads while we index.
        if (this.paused) await this.paused;
        next = page.nextCursor !== null && gen === this.gen ? get(page.nextCursor) : null;
        this.route(page.files.map(toDoc), (i, docs) => docs.length && this.to(i, { type: 'append', gen, docs, done: false }));
        this.post({ type: 'progress', gen, done: page.done ?? 0, total: page.total ?? 0 });
      }
      if (gen !== this.gen) return;
      for (let i = 0; i < this.shards; i++) this.to(i, { type: 'append', gen, docs: [], done: true });
    } catch (err) {
      if (gen === this.gen) this.post({ type: 'feedError', gen, message: String((err as Error)?.message ?? err) });
    }
  }

  /** Stops a pass in progress (a newer one supersedes it). */
  cancel() {
    this.gen++;
  }

  /**
   * Incremental update after file events: fetches the current text of `paths` (filters applied by the
   * backend) and upserts / removes them on their shards, with note metadata for the knowledge index.
   * `shardOf` is the coordinator's routing (documents keep their shard across renames).
   */
  async refresh(id: number, src: FeedSource, paths: string[], shardOf: Record<string, number>): Promise<void> {
    try {
      const r = (await this.fetchJson(src.base + 'files', { method: 'POST', body: JSON.stringify(paths), headers: { ...this.headers(src), 'content-type': 'application/json' } })) as { files: FileData[]; skipped: string[]; gone: string[] };
      const n = this.shards;
      const at = (p: string) => shardOf[p] ?? shardOfPath(p, n);
      const ups: SearchDoc[][] = Array.from({ length: n }, () => []);
      for (const f of r.files) ups[at(f.path)].push(toDoc(f));
      const gone: string[][] = Array.from({ length: n }, () => []);
      for (const p of [...r.skipped, ...r.gone]) gone[at(p)].push(p);
      for (let i = 0; i < n; i++) {
        if (ups[i].length) this.to(i, { type: 'upsert', docs: ups[i], notes: true });
        if (gone[i].length) this.to(i, { type: 'remove', paths: gone[i], notes: true });
      }
      this.post({ type: 'refreshed', id, files: r.files.length, removed: r.skipped.length + r.gone.length });
    } catch (err) {
      this.post({ type: 'refreshed', id, files: 0, removed: 0, error: String((err as Error)?.message ?? err) });
    }
  }
}

/** fetch → JSON, failing on HTTP errors (works in workers and in Node). */
export const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`index channel: HTTP ${res.status}`);
  return res.json();
};
