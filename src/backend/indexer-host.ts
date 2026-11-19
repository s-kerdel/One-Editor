// Runs the Indexer in a worker thread when its bundled source is available (the Electron main and
// server bundles embed it; see scripts/build-node.mjs), otherwise in this thread (unit tests).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { Indexer, type IndexOptions, type IndexPage, type IndexerConfig, type PathSnapshot, type ReadFilesResult, type Stamp } from './indexer';
import type { IgnoreSet } from './gitignore';
import { decodeTextFrame, encodeTextFrame, type FrameFile } from '../shared/textframe';

declare const __SEC_EDIT_INDEXER_SRC__: string | undefined;

let fromFile: string | null | undefined;

/**
 * The worker's source: the bundle's own embedded copy; from TypeScript sources (tests) a prebuilt
 * one named by SEC_EDIT_INDEXER_SRC_FILE (tests/e2e/global-setup.ts builds it), else none (in-thread).
 */
export function indexerSource(): string | null {
  if (typeof __SEC_EDIT_INDEXER_SRC__ === 'string') return __SEC_EDIT_INDEXER_SRC__;
  if (fromFile === undefined) {
    const f = process.env.SEC_EDIT_INDEXER_SRC_FILE;
    try {
      fromFile = f ? fs.readFileSync(f, 'utf8') : null;
    } catch {
      fromFile = null;
    }
  }
  return fromFile;
}

export interface Raw {
  /** Pages: a text frame (shared/textframe.ts); file batches: UTF-8 JSON (ReadFilesResult without stamps). */
  body: Uint8Array;
  stamps: Stamp[];
}

export interface IndexerHost {
  readonly inWorker: boolean;
  setPaths(s: PathSnapshot): void;
  setOptions(o: Required<IndexOptions>): void;
  page(cursor: string | null, maxBytes?: number): Promise<IndexPage>;
  pageRaw(cursor: string | null, maxBytes?: number): Promise<Raw>;
  readFiles(paths: string[]): Promise<ReadFilesResult>;
  readFilesRaw(paths: string[]): Promise<Raw>;
  ignoreRules(): Promise<IgnoreSet[]> | IgnoreSet[];
  readonly lastPass: { read: number; cached: number; written?: Promise<void> } | null;
  onPassStart(cb: () => void): void;
  warm(): void;
  dispose(): void;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class LocalIndexerHost implements IndexerHost {
  readonly inWorker = false;
  readonly ix: Indexer;
  constructor(cfg: IndexerConfig) {
    this.ix = new Indexer(cfg);
  }
  setPaths(s: PathSnapshot) {
    this.ix.setPaths(s);
  }
  setOptions(o: Required<IndexOptions>) {
    this.ix.setOptions(o);
  }
  async page(cursor: string | null, maxBytes?: number): Promise<IndexPage> {
    const p = await this.ix.page(cursor, maxBytes);
    return { ...p, files: p.files.map(({ utf8: _u, ...f }: FrameFile) => f) };
  }
  async pageRaw(cursor: string | null, maxBytes?: number): Promise<Raw> {
    const { stamps, files, ...meta } = await this.ix.page(cursor, maxBytes);
    return { body: encodeTextFrame(meta, files), stamps };
  }
  readFiles(paths: string[]) {
    return this.ix.readFiles(paths);
  }
  async readFilesRaw(paths: string[]): Promise<Raw> {
    const { stamps, ...res } = await this.ix.readFiles(paths);
    return { body: enc.encode(JSON.stringify(res)), stamps };
  }
  ignoreRules() {
    return this.ix.ignoreRules();
  }
  get lastPass() {
    return this.ix.lastPass;
  }
  onPassStart(cb: () => void) {
    this.ix.onPassStart(cb);
  }
  warm() {
    this.ix.warm();
  }
  dispose() {
    this.ix.dispose();
  }
}

type Reply = { id: number; error?: string; body?: Uint8Array; stamps?: Stamp[]; result?: unknown; lastPass?: { read: number; cached: number }; passOpen?: boolean };

/** An idle indexer thread is stopped (its heap — pass buffers, cache — goes with it) and restarted on demand. */
const IDLE_MS = Number(process.env.SEC_EDIT_INDEXER_IDLE_MS) || 10_000;

export class WorkerIndexerHost implements IndexerHost {
  readonly inWorker = true;
  private w: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: unknown) => void }>();
  private passCbs = new Set<() => void>();
  private idle: NodeJS.Timeout | null = null;
  /** Re-sent to a restarted thread. */
  private snap: PathSnapshot | null = null;
  private opts: Required<IndexOptions> | null = null;
  private disposed = false;
  /** A pass is part-way (e.g. paused while hidden): its state lives in the thread, so the thread stays. */
  private passOpen = false;
  lastPass: { read: number; cached: number } | null = null;

  constructor(
    private readonly src: string,
    private readonly cfg: IndexerConfig,
  ) {}

  private worker(): Worker {
    if (this.w) return this.w;
    const w = new Worker(this.src, { eval: true, workerData: this.opts ? { ...this.cfg, index: this.opts } : this.cfg });
    w.unref();
    w.on('message', (m: Reply & { type?: string }) => {
      if (m.type === 'passStart') return this.passCbs.forEach((f) => f());
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.lastPass) this.lastPass = m.lastPass;
      if (m.passOpen !== undefined) this.passOpen = m.passOpen;
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m);
      this.armIdle();
    });
    w.on('error', (err) => this.fail(w, err));
    w.on('exit', () => this.fail(w, new Error('indexer stopped')));
    if (this.snap) w.postMessage({ op: 'paths', snap: this.snap });
    this.w = w;
    return w;
  }

  private fail(w: Worker, err: unknown) {
    if (this.w !== w) return; // an idle thread we stopped on purpose
    this.w = null;
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const p of all) p.reject(err);
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (this.waiting.size || this.disposed || this.passOpen) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      const w = this.w;
      if (!w || this.waiting.size) return;
      this.w = null;
      void w.terminate();
    }, IDLE_MS);
    this.idle.unref?.();
  }

  private call(op: string, args: Record<string, unknown>): Promise<Reply> {
    const id = ++this.seq;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const w = this.worker();
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ id, op, ...args });
    });
  }

  setPaths(snap: PathSnapshot) {
    this.snap = snap;
    this.w?.postMessage({ op: 'paths', snap });
  }
  setOptions(opts: Required<IndexOptions>) {
    this.opts = opts;
    this.w?.postMessage({ op: 'options', opts });
  }
  async pageRaw(cursor: string | null, maxBytes?: number): Promise<Raw> {
    const r = await this.call('page', { cursor, maxBytes });
    return { body: r.body!, stamps: r.stamps ?? [] };
  }
  async page(cursor: string | null, maxBytes?: number): Promise<IndexPage> {
    const r = await this.pageRaw(cursor, maxBytes);
    return { ...decodeTextFrame<Omit<IndexPage, 'files' | 'stamps'>>(r.body), stamps: r.stamps };
  }
  async readFilesRaw(paths: string[]): Promise<Raw> {
    const r = await this.call('files', { paths });
    return { body: r.body!, stamps: r.stamps ?? [] };
  }
  async readFiles(paths: string[]): Promise<ReadFilesResult> {
    const r = await this.readFilesRaw(paths);
    return { ...JSON.parse(dec.decode(r.body)), stamps: r.stamps };
  }
  async ignoreRules(): Promise<IgnoreSet[]> {
    return (await this.call('ignore', {})).result as IgnoreSet[];
  }
  onPassStart(cb: () => void) {
    this.passCbs.add(cb);
  }
  warm() {
    this.worker().postMessage({ op: 'warm' });
    this.armIdle();
  }
  /** Is the thread running now (tests: it stops when idle). */
  get running() {
    return !!this.w;
  }
  dispose() {
    this.disposed = true;
    if (this.idle) clearTimeout(this.idle);
    const w = this.w;
    this.w = null;
    if (w) {
      w.postMessage({ op: 'dispose' });
      void w.terminate();
    }
  }
}
