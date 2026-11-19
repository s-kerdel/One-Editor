// Search client: owns the search workers, keeps their index in sync with disk + unsaved editor
// content, and exposes promise-based search/headings calls. Started lazily (idle after boot, or on first use).
//
// The index is sharded over several workers (ShardedSearch: stable path hash, exact two-phase
// merge), so a big folder indexes — and is searched — on several cores. The shard count follows the
// folder size: a notes folder of a few hundred files stays on one worker.
import { signal } from '@preact/signals';
import { app } from '../app/app';
import { streamAllTextPages } from '../app/workspace-text';
import { ShardedSearch } from '../../search/shards';
import type { FromWorker, HeadingQuery, ToWorker } from '../../search/protocol';
import type { HeadingHit, SearchDoc, SearchOptions, SearchResponse } from '../../search/types';

const WATCHDOG_MS = 8000;
const EDIT_DEBOUNCE_MS = 120;
/** Index payload per worker message (UTF-16 chars): ~1–2 ms to clone, so no long task on either side. */
const SLICE_CHARS = 1_000_000;
/** Files per shard below which another worker costs more (startup, memory) than it saves. */
const FILES_PER_SHARD = 800;
/** While indexing, live results refresh at most this often. */
const PROGRESS_BUMP_MS = 700;

interface Port {
  post(m: ToWorker): void;
  terminate(): void;
}

/** Workers to shard over: `search.workers` (1–16), else one per core but one, at most 8. */
export function maxShards(): number {
  const s = Number(app.settings.value['search.workers']);
  if (Number.isFinite(s) && s >= 1) return Math.min(16, Math.floor(s));
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(8, hc - 1));
}

export function shardsFor(files: number | undefined, max = maxShards()): number {
  if (!files) return 1;
  return Math.max(1, Math.min(max, Math.ceil(files / FILES_PER_SHARD)));
}

class SearchClient {
  /** 'idle' until first start; 'indexing' while (re)building; 'ready' after. */
  readonly status = signal<'idle' | 'indexing' | 'ready' | 'error'>('idle');
  readonly indexed = signal(0);
  readonly indexMs = signal(0);
  /** Bumps whenever indexed content changes (panels can refresh live results). */
  readonly version = signal(0);
  readonly mode = signal<'worker' | 'inline' | 'none'>('none');
  /** Files examined / indexable files of the rebuild in progress (null when not indexing). */
  readonly progress = signal<{ done: number; total: number } | null>(null);
  readonly shardCount = signal(0);
  /** Last full build: engine time per shard (the critical path is the slowest) — perf guards, diagnostics. */
  lastBuild: { shards: number; engineMs: number[]; wallMs: number } | null = null;

  private ports: Port[] = [];
  private shards: ShardedSearch | null = null;
  private gen = 0;
  private starting: Promise<void> | null = null;
  private readyWaiters: Array<() => void> = [];
  private shardWaiters: Array<() => void> = [];
  private reindexing = false;
  private queued = new Map<string, SearchDoc | null>(); // during reindex
  private edits = new Map<string, string>(); // debounced doc:changed
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private wired = false;
  /** Increments whenever the workers are replaced (fallback / watchdog restart / new shard count). */
  private portEpoch = 0;
  /** Shards that reported `indexed` for the current generation (doc count, engine ms). */
  private indexedBy = new Map<number, { count: number; ms: number }>();
  private buildStart = 0;
  private lastBump = 0;
  private inline = false;

  /** Subscribe to app events (cheap; no worker yet). */
  wire() {
    if (this.wired) return;
    this.wired = true;
    app.events.on('workspace:opened', () => {
      if (this.shards) void this.reindex();
    });
    app.events.on('doc:changed', (path, content) => {
      if (!this.shards) return;
      this.edits.set(path, content);
      if (!this.editTimer) this.editTimer = setTimeout(() => this.flushEdits(), EDIT_DEBOUNCE_MS);
    });
    app.events.on('doc:saved', (path, content) => this.upsert(path, content));
    app.events.on('file:updated', (path, content) => {
      if (!this.shards) return;
      if (content === undefined) return this.removePath(path);
      // An open, dirty doc's live text wins over the disk version.
      const doc = app.docs.get(path);
      if (doc?.dirty.value) return;
      this.upsert(path, content);
    });
    app.events.on('file:renamed', (from, to) => {
      if (!this.shards) return;
      this.shards.rename(from, to);
      this.bump();
    });
    app.events.on('doc:closed', (path) => {
      // Closing may discard unsaved edits: re-sync with disk.
      if (!this.shards) return;
      app.backend
        .readFile(path)
        .then((f) => this.upsert(path, f.content, f.mtime))
        .catch(() => this.removePath(path));
    });
    // What gets indexed changed (ignore rules, size cap, excluded folders): rebuild.
    app.events.on('index:stale', () => {
      if (this.shards) void this.reindex();
    });
  }

  /** Start the workers and build the index (idempotent). */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.reindex();
    return this.starting;
  }

  /** (Re)creates the shard workers when the count changes; existing shards are reused otherwise. */
  private ensureShards(n: number) {
    if (this.inline || typeof Worker === 'undefined') n = 1;
    if (this.shards && this.shards.n === n) return;
    for (const p of this.ports) p.terminate();
    this.shards?.dropPending();
    this.portEpoch++;
    const ports: Port[] = [];
    for (let i = 0; i < n; i++) ports.push(this.createPort(i));
    this.ports = ports;
    this.shards = new ShardedSearch(ports);
    this.shardCount.value = n;
    this.shardWaiters.splice(0).forEach((f) => f());
  }

  private createPort(i: number): Port {
    if (!this.inline) {
      try {
        if (typeof Worker === 'undefined') throw new Error('no Worker');
        const w = new Worker(new URL('../../search/worker.ts', import.meta.url), { type: 'module', name: i ? `sec-edit-search-${i}` : 'sec-edit-search' });
        const epoch = this.portEpoch;
        w.onmessage = (e: MessageEvent<FromWorker>) => epoch === this.portEpoch && this.onMessage(i, e.data);
        w.onerror = (e) => {
          console.warn('[search] worker failed, falling back to in-thread search', e.message);
          e.preventDefault?.();
          this.fallbackToInline();
        };
        this.mode.value = 'worker';
        return { post: (m) => w.postMessage(m), terminate: () => w.terminate() };
      } catch (err) {
        console.warn('[search] Worker unavailable, using in-thread search', err);
      }
    }
    this.inline = true;
    return this.inlinePort(i);
  }

  private inlinePort(i: number): Port {
    this.mode.value = 'inline';
    let host: import('../../search/host').SearchHost | null = null;
    const queue: ToWorker[] = [];
    const epoch = this.portEpoch;
    void import('../../search/host').then(({ SearchHost }) => {
      host = new SearchHost(
        (m) => setTimeout(() => epoch === this.portEpoch && this.onMessage(i, m), 0),
        () => new Promise((r) => setTimeout(r, 0)),
      );
      queue.splice(0).forEach((m) => host!.handle(m));
    });
    return {
      post: (m) => (host ? host.handle(m) : queue.push(m)),
      terminate: () => {},
    };
  }

  private fallbackToInline() {
    if (this.inline) return;
    this.inline = true;
    for (const p of this.ports) p.terminate();
    this.shards?.dropPending();
    this.shards = null;
    this.ensureShards(1);
    void this.reindex();
  }

  private bump() {
    this.version.value++;
  }

  private onMessage(shard: number, m: FromWorker) {
    if (m.type === 'indexed') {
      if (m.gen !== this.gen || !this.shards) return;
      this.indexedBy.set(shard, { count: m.count, ms: m.ms });
      if (this.indexedBy.size < this.shards.n) return;
      const parts = [...this.indexedBy.values()];
      this.indexed.value = parts.reduce((a, b) => a + b.count, 0);
      this.indexMs.value = performance.now() - this.buildStart;
      this.lastBuild = { shards: this.shards.n, engineMs: parts.map((p) => Math.round(p.ms)), wallMs: Math.round(this.indexMs.value) };
      this.status.value = 'ready';
      this.progress.value = null;
      this.readyWaiters.splice(0).forEach((f) => f());
      this.bump();
      return;
    }
    if (this.shards?.onMessage(shard, m)) return;
    if (m.type === 'error') console.warn('[search worker]', m.message);
  }

  /** Full rebuild from disk, overlaying unsaved editor content. Pages stream into the shards as they arrive. */
  async reindex() {
    const gen = ++this.gen;
    this.status.value = 'indexing';
    this.reindexing = true;
    this.indexedBy = new Map();
    this.buildStart = performance.now();
    this.progress.value = { done: 0, total: 0 };
    let started = false;
    const begin = (total: number | undefined) => {
      started = true;
      this.ensureShards(shardsFor(total));
      this.shards!.reset(gen);
    };
    try {
      const epoch = () => this.portEpoch;
      const live = (path: string, content: string) => {
        const d = app.docs.get(path);
        return d ? (app.editor?.getContent(path) ?? d.content) : content;
      };
      const seen = new Set<string>();
      let ep = -1;
      if (app.workspace.value) {
        for await (const page of streamAllTextPages()) {
          if (gen !== this.gen || (started && ep !== epoch())) return; // superseded (a newer rebuild owns the shards)
          if (!started) {
            begin(page.total);
            ep = epoch();
          }
          const docs: SearchDoc[] = page.files.map((f) => (seen.add(f.path), { path: f.path, content: live(f.path, f.content), mtime: f.mtime }));
          if (!(await this.sendDocs(gen, docs, false))) return;
          if (page.total) this.progress.value = { done: page.done ?? seen.size, total: page.total };
          // Progressive search: open panels re-run against what is indexed so far.
          if (performance.now() - this.lastBump > PROGRESS_BUMP_MS) {
            this.lastBump = performance.now();
            this.bump();
          }
        }
      }
      if (!started) {
        begin(0);
        ep = epoch();
      }
      if (gen !== this.gen || ep !== epoch()) return;
      // Open docs that aren't on disk (yet): their live text is searchable too.
      const extra: SearchDoc[] = [];
      for (const d of app.docs.values()) if (!seen.has(d.path)) extra.push({ path: d.path, content: live(d.path, d.content), mtime: d.mtime });
      this.shards!.append(gen, extra, true);
      this.reindexing = false;
      // Changes that arrived while reading the workspace.
      const ups: SearchDoc[] = [];
      const gone: string[] = [];
      for (const [p, d] of this.queued) {
        if (d) ups.push(d);
        else gone.push(p);
      }
      this.queued.clear();
      if (gone.length) this.shards!.remove(gone);
      if (ups.length) this.shards!.upsert(ups);
    } catch (err) {
      console.error('[search] indexing failed', err);
      if (gen !== this.gen) return;
      if (!this.shards) this.ensureShards(1);
      this.status.value = 'error';
      this.progress.value = null;
      this.reindexing = false;
      // Don't leave searches hanging: they run against whatever is indexed (possibly nothing).
      this.readyWaiters.splice(0).forEach((f) => f());
    }
  }

  /**
   * Appends docs to the rebuild in progress. A big page goes over in slices with a yield in between:
   * one postMessage of tens of MB is a long structured-clone task on *both* threads. Returns false
   * when a newer rebuild (or a worker restart) took over meanwhile.
   */
  private async sendDocs(gen: number, docs: SearchDoc[], done: boolean): Promise<boolean> {
    const slices: SearchDoc[][] = [];
    let cur: SearchDoc[] = [];
    let size = 0;
    for (const d of docs) {
      cur.push(d);
      size += d.content.length;
      if (size >= SLICE_CHARS) {
        slices.push(cur);
        cur = [];
        size = 0;
      }
    }
    if (cur.length || !slices.length) slices.push(cur);
    const epoch = this.portEpoch;
    for (let i = 0; i < slices.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, 0));
      if (gen !== this.gen || epoch !== this.portEpoch || !this.shards) return false;
      this.shards.append(gen, slices[i], done && i === slices.length - 1);
    }
    return true;
  }

  upsert(path: string, content: string, mtime?: number) {
    if (!this.shards) return;
    if (this.reindexing) this.queued.set(path, { path, content, mtime });
    else this.shards.upsert([{ path, content, mtime }]);
    this.bump();
  }

  private removePath(path: string) {
    if (this.reindexing) this.queued.set(path, null);
    else this.shards?.remove([path]);
    this.bump();
  }

  /** Push debounced editor changes now (before a search, so unsaved text is always searchable). */
  flushEdits() {
    if (this.editTimer) clearTimeout(this.editTimer);
    this.editTimer = null;
    if (!this.edits.size || !this.shards) return;
    const docs = [...this.edits].map(([path, content]) => ({ path, content }));
    this.edits.clear();
    if (this.reindexing) docs.forEach((d) => this.queued.set(d.path, d));
    else this.shards.upsert(docs);
    this.bump();
  }

  whenReady(): Promise<void> {
    if (this.status.value === 'ready' || this.status.value === 'error') return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  /** Shards exist (the first page of the first rebuild arrived): searches can run, possibly partial. */
  private whenShards(): Promise<void> {
    if (this.shards) return Promise.resolve();
    return new Promise((r) => this.shardWaiters.push(r));
  }

  /** Bounds a request; a runaway (catastrophic regex) worker is killed and the index rebuilt. */
  private watch<T>(p: Promise<T | null>, onTimeout: () => T): Promise<T | null> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(onTimeout());
        this.restart();
      }, WATCHDOG_MS);
      void p.then((v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      });
    });
  }

  /**
   * Resolves null when superseded by a newer search on the same channel.
   * `progressive`: don't wait for the index to finish — answer from what is indexed so far
   * (the response then says `partial`); open panels re-run as more arrives (see `version`).
   */
  async search(query: string, options: SearchOptions = {}, channel = 'panel', flags: { progressive?: boolean } = {}): Promise<SearchResponse | null> {
    void this.start();
    if (flags.progressive) await this.whenShards();
    else await this.whenReady();
    return this.searchNow(query, options, channel, 2);
  }

  private async searchNow(query: string, options: SearchOptions, channel: string, retries: number): Promise<SearchResponse | null> {
    this.flushEdits();
    const shards = this.shards;
    if (!shards) return null;
    const epoch = this.portEpoch;
    const partial = this.status.value === 'indexing';
    const r = await this.watch(shards.search(query, options, channel), () => ({ results: [], totalFiles: 0, totalMatches: 0, tookMs: WATCHDOG_MS, error: 'Search took too long and was stopped (catastrophic regex?)' }));
    // Dropped because the workers were replaced (not superseded): run it again on the new ones.
    if (r === null && epoch !== this.portEpoch && retries > 0) {
      await this.whenShards();
      return this.searchNow(query, options, channel, retries - 1);
    }
    if (r && partial) r.partial = true;
    return r;
  }

  async headings(q: HeadingQuery): Promise<HeadingHit[]> {
    void this.start();
    await this.whenReady();
    this.flushEdits();
    if (!this.shards) return [];
    return (await this.watch(this.shards.headings(q), () => [])) ?? [];
  }

  private restart() {
    if (this.mode.value !== 'worker') return;
    for (const p of this.ports) p.terminate();
    this.shards?.dropPending();
    this.shards = null;
    this.ensureShards(this.shardCount.value || 1);
    void this.reindex();
  }
}

export const searchClient = new SearchClient();
