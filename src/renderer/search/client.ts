// Search client: owns the search workers, keeps their index in sync with disk + unsaved editor
// content, and exposes promise-based search/headings calls. Started lazily (idle after boot, or on first use).
//
// The index is sharded over several workers (ShardedSearch: stable path hash, exact two-phase
// merge), so a big folder indexes — and is searched — on several cores. The shard count follows the
// folder size: a notes folder of a few hundred files stays on one worker.
import { signal } from '@preact/signals';
import { app } from '../app/app';
import { streamAllTextPages } from '../app/workspace-text';
import { activityNow, logActivity } from '../app/activity';
import { markIndexStarted } from './demand';
import { webToken } from '../platform';
import { ShardedSearch } from '../../search/shards';
import type { FeedSource } from '../../search/feeder';
import type { FromWorker, HeadingQuery, NoteItem, ToWorker } from '../../search/protocol';
import type { Mention } from '../../knowledge/index';
import type { HeadingHit, SearchDoc, SearchOptions, SearchResponse } from '../../search/types';
import type { DefHit, DefQuery } from '../../search/defs';
import { isExtPath } from '@shared/external';

const WATCHDOG_MS = 8000;
const EDIT_DEBOUNCE_MS = 120;
/** Index payload per worker message (UTF-16 chars): ~1–2 ms to clone, so no long task on either side. */
const SLICE_CHARS = 1_000_000;
/** Files per shard below which another worker costs more (startup, memory) than it saves. */
const FILES_PER_SHARD = 800;
/** While indexing, live results refresh at most this often. */
const PROGRESS_BUMP_MS = 700;
/**
 * Feeder page size. Electron (app:// protocol; RPC travels over IPC): 4 MB = fewer round trips.
 * Browser mode: 1 MB — a 4 MB response held the page's HTTP delivery for tens of ms on a busy machine,
 * and every small RPC answer (opening a file) queued behind it, once per page.
 */
const feedPageBytes = () => (app.backend.kind === 'web' ? 1 << 20 : 4 << 20);
/** Longest the first build waits for the knowledge module to subscribe to its notes. */
const NOTES_GATE_MS = 1500;
/** File events are coalesced this long before the changed files are re-read and re-indexed. */
const REFRESH_DEBOUNCE_MS = 500;

interface Port {
  post(m: ToWorker): void;
  /** Hands MessagePorts to the worker (feeder ↔ peer shards). */
  postPorts?(m: ToWorker, ports: MessagePort[]): void;
  terminate(): void;
}

/** Note metadata from the shards (the knowledge index is built from these: no text in this thread). */
export type NotesEvent = { kind: 'start'; gen: number } | { kind: 'items'; gen?: number; items: NoteItem[]; removed?: string[] } | { kind: 'done'; gen: number };

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
  lastBuild: { shards: number; engineMs: number[]; wallMs: number; fed: boolean } | null = null;

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
  /** Shard 0 pulls the text itself (index channel) for the current build. */
  private feeding = false;
  private buildTrigger = 'workspace-open';
  /** The `files.associations` value the shards hold (JSON), so only a real change is sent again. */
  private fileTypes = 'null';
  private notesCbs = new Set<(e: NotesEvent) => void>();
  private refreshPending = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshSeq = 0;
  private refreshWaiters = new Map<number, { t0: number; paths: number }>();

  /**
   * Knowledge subscribes here: its index is rebuilt from these events. Subscribing after a build has
   * started gets a replay (the shards re-extract from the text they hold) — nothing is missed.
   */
  onNotes(cb: (e: NotesEvent) => void, opts: { replay?: boolean } = {}): () => void {
    this.notesCbs.add(cb);
    if (!opts.replay) return () => this.notesCbs.delete(cb); // observers (tests, diagnostics)
    this.openNotesGate();
    if (this.shards && this.status.value !== 'idle') {
      if (this.status.value === 'indexing') this.replayAfterBuild = true;
      else this.replayNotes();
    }
    return () => this.notesCbs.delete(cb);
  }

  private replayAfterBuild = false;
  private replaying = new Set<number>();

  private replayNotes() {
    if (!this.shards) return;
    const gen = this.gen;
    this.replaying = new Set();
    this.notes({ kind: 'start', gen });
    for (const p of this.ports) p.post({ type: 'replay', gen });
  }

  private notes(e: NotesEvent) {
    for (const cb of this.notesCbs) {
      try {
        cb(e);
      } catch (err) {
        console.error('[search] notes listener failed', err);
      }
    }
  }

  /** Where shard 0 can fetch the workspace text itself: Electron app://, or the browser-mode server. */
  private feedSource(): FeedSource | null {
    if (this.inline || typeof Worker === 'undefined' || typeof app.backend?.readAllTextPage !== 'function') return null;
    if (app.backend.kind === 'electron') {
      const token = (window as unknown as { secEditBridge?: { indexToken?: string } }).secEditBridge?.indexToken;
      return token ? { base: 'app://sec-edit/__index/', token, header: 'x-sec-edit-index' } : null;
    }
    if (app.backend.kind === 'web') return { base: new URL('./api/index/', location.href).toString(), token: webToken(), header: 'x-sec-edit-token' };
    return null;
  }

  /** Subscribe to app events (cheap; no worker yet). */
  wire() {
    if (this.wired) return;
    this.wired = true;
    app.events.on('workspace:opened', () => {
      if (this.shards) void this.reindex();
    });
    app.events.on('doc:changed', (path, content) => {
      if (!this.shards || isExtPath(path)) return;
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
      if (this.feedSource()) return this.refreshPaths([path], 'doc-closed');
      app.backend
        .readFile(path)
        .then((f) => this.upsert(path, f.content, f.mtime))
        .catch(() => this.removePath(path));
    });
    // Files changed on disk that are not open: re-read just those, coalesced (never a full pass).
    app.events.on('files:changed', (paths) => this.refreshPaths(paths, 'fs-events'));
    // File type associations changed: the shards get them now; the rebuild follows as 'index:stale'.
    app.events.on('settings:changed', (s) => this.sendFileTypes(s['files.associations']));
    // What gets indexed changed (ignore rules, size cap, excluded folders): rebuild.
    app.events.on('index:stale', () => {
      this.buildTrigger = 'settings';
      if (this.shards) void this.reindex();
    });
    // Hidden / minimised window: the feeder stops pulling pages until it is shown again.
    document.addEventListener('visibilitychange', () => this.ports[0]?.post({ type: 'pause', on: document.visibilityState === 'hidden' }));
  }

  /**
   * Start the workers and build the index (idempotent). The build's setup (workers, knowledge reset)
   * runs in a task of its own: whoever calls this (the palette opening, a panel mounting) renders and
   * takes focus first.
   */
  start(): Promise<void> {
    if (this.starting) return this.starting;
    markIndexStarted(); // on demand: this is the first consumer; the index stays live from now on
    // The knowledge index is built from this build's note stream: give its module a moment to
    // subscribe (it loads at the same idle moment), or it gets a full replay = twice the work.
    const gate = new Promise<void>((r) => {
      this.openNotesGate = () => ((this.notesSubscribed = true), r());
      if (this.notesSubscribed) r();
      setTimeout(r, NOTES_GATE_MS);
    });
    this.starting = new Promise<void>((r) => setTimeout(r, 0))
      .then(() => gate)
      .then(() => this.reindex());
    return this.starting;
  }

  private notesSubscribed = false;
  private openNotesGate: () => void = () => void (this.notesSubscribed = true);

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
    // Feeder wiring: shard 0 talks to every peer directly (documents never pass through this thread).
    if (n > 1 && ports.every((p) => p.postPorts) && typeof MessageChannel !== 'undefined') {
      for (let i = 1; i < n; i++) {
        const ch = new MessageChannel();
        ports[0].postPorts!({ type: 'peer', index: i }, [ch.port1]);
        ports[i].postPorts!({ type: 'feedPort' }, [ch.port2]);
      }
    }
    // Each shard decides a file's language itself (lang: filter, symbol index): the user's associations go first.
    this.fileTypes = '';
    this.sendFileTypes(app.settings.value['files.associations']);
    this.shards = new ShardedSearch(ports);
    this.shardCount.value = n;
    this.shardWaiters.splice(0).forEach((f) => f());
  }

  private sendFileTypes(assoc: unknown) {
    const key = JSON.stringify(assoc ?? null);
    if (key === this.fileTypes) return;
    this.fileTypes = key;
    for (const p of this.ports) p.post({ type: 'fileTypes', assoc: assoc ?? null });
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
        return { post: (m) => w.postMessage(m), postPorts: (m, transfer) => w.postMessage(m, transfer), terminate: () => w.terminate() };
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
      if (this.feeding) this.finishFeed();
      this.indexed.value = parts.reduce((a, b) => a + b.count, 0);
      this.indexMs.value = performance.now() - this.buildStart;
      this.lastBuild = { shards: this.shards.n, engineMs: parts.map((p) => Math.round(p.ms)), wallMs: Math.round(this.indexMs.value), fed: this.feeding };
      this.status.value = 'ready';
      this.progress.value = null;
      activityNow.value = null;
      logActivity({ kind: 'index', trigger: this.buildTrigger, ms: this.indexMs.value, detail: `${this.indexed.value.toLocaleString()} files · ${this.shards.n} shard${this.shards.n === 1 ? '' : 's'}${this.feeding ? '' : ' · via UI thread'}` });
      this.buildTrigger = 'workspace-open';
      this.notes({ kind: 'done', gen: m.gen });
      if (this.replayAfterBuild) {
        this.replayAfterBuild = false;
        // A subscriber that joined mid-build saw only part of it.
        this.replayNotes();
      }
      this.readyWaiters.splice(0).forEach((f) => f());
      this.bump();
      return;
    }
    if (m.type === 'replayed') {
      if (m.gen !== this.gen || !this.shards) return;
      this.replaying.add(shard);
      if (this.replaying.size === this.shards.n) this.notes({ kind: 'done', gen: m.gen });
      return;
    }
    if (m.type === 'notes') {
      if (m.gen !== undefined && m.gen !== this.gen) return;
      this.notes({ kind: 'items', gen: m.gen, items: m.items, removed: m.removed });
      return;
    }
    if (m.type === 'progress') {
      if (m.gen !== this.gen) return;
      this.setProgress(m.done, m.total);
      return;
    }
    if (m.type === 'feedError') {
      if (m.gen !== this.gen) return;
      console.warn('[search] index channel failed, reading through the UI thread', m.message);
      this.feeding = false;
      void this.reindexVia(m.gen, false);
      return;
    }
    if (m.type === 'refreshed') {
      const w = this.refreshWaiters.get(m.id);
      this.refreshWaiters.delete(m.id);
      if (w) logActivity({ kind: 'index-update', trigger: 'fs-events', ms: performance.now() - w.t0, detail: `${w.paths} changed · ${m.files} re-indexed · ${m.removed} dropped${m.error ? ` · ${m.error}` : ''}` });
      this.bump();
      return;
    }
    if (this.shards?.onMessage(shard, m)) return;
    if (m.type === 'error') console.warn('[search worker]', m.message);
  }

  /**
   * Full rebuild, overlaying unsaved editor content. Normally shard 0 pulls the text from the backend
   * itself and routes it to its peers (the UI thread never sees it); otherwise pages stream through here.
   */
  async reindex() {
    const gen = ++this.gen;
    this.status.value = 'indexing';
    this.reindexing = true;
    this.indexedBy = new Map();
    this.buildStart = performance.now();
    this.setProgress(0, 0);
    this.notes({ kind: 'start', gen });
    const src = app.workspace.value ? this.feedSource() : null;
    if (src) {
      this.ensureShards(shardsFor(app.files.value.length));
      if (!this.inline && this.shards) {
        this.feeding = true;
        this.shards.reset(gen);
        this.ports[0].post({ type: 'pause', on: document.visibilityState === 'hidden' });
        this.ports[0].post({ type: 'feed', gen, src, shards: this.shards.n, maxBytes: feedPageBytes() });
        return;
      }
    }
    this.feeding = false;
    return this.reindexVia(gen, true);
  }

  /** After a fed build: open docs' live text and changes that arrived meanwhile win over the disk pass. */
  private finishFeed() {
    this.reindexing = false;
    const ups = new Map<string, SearchDoc>();
    for (const d of app.docs.values()) if (!d.binary && !isExtPath(d.path)) ups.set(d.path, { path: d.path, content: app.editor?.getContent(d.path) ?? d.content, mtime: d.mtime });
    const gone: string[] = [];
    for (const [p, d] of this.queued) {
      if (d) ups.set(p, d);
      else gone.push(p);
    }
    this.queued.clear();
    if (gone.length) this.shards!.remove(gone);
    if (ups.size) this.shards!.upsert([...ups.values()]);
    if (this.refreshPending.size) this.scheduleRefresh();
  }

  private setProgress(done: number, total: number) {
    this.progress.value = { done, total };
    activityNow.value = total ? `Indexing ${done.toLocaleString()} / ${total.toLocaleString()}` : 'Indexing…';
    // Progressive search: open panels re-run against what is indexed so far.
    if (performance.now() - this.lastBump > PROGRESS_BUMP_MS) {
      this.lastBump = performance.now();
      this.bump();
    }
  }

  private refreshFirst = 0;

  /** Changed files (not open): coalesced, then re-read and re-indexed — never a full pass. */
  refreshPaths(paths: string[], _trigger = 'fs-events') {
    if (!this.shards) return;
    if (!this.refreshPending.size) this.refreshFirst = performance.now();
    for (const p of paths) this.refreshPending.add(p);
    this.scheduleRefresh();
  }

  private scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    // A storm keeps pushing the batch back, but never more than 2 s.
    const wait = Math.max(0, Math.min(REFRESH_DEBOUNCE_MS, this.refreshFirst + 2000 - performance.now()));
    this.refreshTimer = setTimeout(() => this.flushRefresh(), wait);
  }

  private flushRefresh() {
    this.refreshTimer = null;
    if (this.reindexing || !this.shards) return; // picked up when the build finishes
    // Open docs: their live text is authoritative (the editor reports its own changes).
    const paths = [...this.refreshPending].filter((p) => !app.docs.has(p));
    this.refreshPending.clear();
    if (!paths.length) return;
    const src = this.feedSource();
    const id = ++this.refreshSeq;
    if (src && !this.inline) {
      this.refreshWaiters.set(id, { t0: performance.now(), paths: paths.length });
      for (let i = 0; i < paths.length; i += 2000) {
        const chunk = paths.slice(i, i + 2000);
        this.ports[0].post({ type: 'refresh', id, src, paths: chunk, shardOf: this.shards.shardMap(chunk) });
      }
      return;
    }
    // No index channel (in-thread search, tests): read through the backend, a few at a time.
    void (async () => {
      const t0 = performance.now();
      const docs: SearchDoc[] = [];
      const gone: string[] = [];
      for (let i = 0; i < paths.length; i += 8)
        await Promise.all(
          paths.slice(i, i + 8).map((p) =>
            app.backend.readFile(p).then(
              // A binary file is a no-content hit: keep it findable by name / path / ext, never by content.
              (f) => void docs.push({ path: p, content: f.binary ? '' : f.content, mtime: f.mtime }),
              () => void gone.push(p),
            ),
          ),
        );
      if (docs.length) this.shards?.upsert(docs, true);
      if (gone.length) this.shards?.remove(gone, true);
      logActivity({ kind: 'index-update', trigger: 'fs-events', ms: performance.now() - t0, detail: `${paths.length} changed · via UI thread` });
      this.bump();
    })();
  }

  /** Mentions of a note (title / aliases) in other notes: the shards hold the text. */
  async mentions(names: string[], exclude: string, limit = 500): Promise<Mention[]> {
    void this.start();
    await this.whenReady();
    this.flushEdits();
    if (!this.shards || !names.length) return [];
    return (await this.watch(this.shards.mentions(names, exclude, limit), () => [])) ?? [];
  }

  /** The pre-feeder path: pages arrive here (UI thread) and are posted to the shards. */
  private async reindexVia(gen: number, _initial: boolean) {
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
          if (page.total) this.setProgress(page.done ?? seen.size, page.total);
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
      if (this.refreshPending.size) this.scheduleRefresh();
    } catch (err) {
      console.error('[search] indexing failed', err);
      if (gen !== this.gen) return;
      if (!this.shards) this.ensureShards(1);
      this.status.value = 'error';
      this.progress.value = null;
      activityNow.value = null;
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
    if (!this.shards || isExtPath(path)) return; // files outside the folder are never indexed
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

  /**
   * Definitions by exact name (Go to definition). Starts the index if needed; `wait` = until it is built,
   * else from what is indexed so far. null = no shards yet / workers replaced.
   */
  async definitions(q: DefQuery, opts: { wait?: boolean } = {}): Promise<DefHit[] | null> {
    void this.start();
    if (opts.wait) await this.whenReady();
    else await this.whenShards();
    this.flushEdits();
    if (!this.shards) return null;
    return this.watch(this.shards.definitions(q), () => null);
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
