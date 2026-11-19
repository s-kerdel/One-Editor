// Runs the Indexer in a worker thread when its bundled source is available (the Electron main and
// server bundles embed it; see scripts/build-node.mjs), otherwise in this thread (unit tests).
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { Indexer, type IndexOptions, type IndexPage, type IndexerConfig, type PathSnapshot, type ReadFilesResult, type Stamp } from './indexer';
import type { IgnoreSet } from './gitignore';

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
  /** UTF-8 JSON (a TextPage, or a ReadFilesResult without stamps). */
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
  page(cursor: string | null, maxBytes?: number) {
    return this.ix.page(cursor, maxBytes);
  }
  async pageRaw(cursor: string | null, maxBytes?: number): Promise<Raw> {
    const { stamps, ...page } = await this.ix.page(cursor, maxBytes);
    return { body: enc.encode(JSON.stringify(page)), stamps };
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

type Reply = { id: number; error?: string; body?: Uint8Array; stamps?: Stamp[]; result?: unknown; lastPass?: { read: number; cached: number } };

export class WorkerIndexerHost implements IndexerHost {
  readonly inWorker = true;
  private w: Worker;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: unknown) => void }>();
  private passCbs = new Set<() => void>();
  lastPass: { read: number; cached: number } | null = null;

  constructor(src: string, cfg: IndexerConfig) {
    this.w = new Worker(src, { eval: true, workerData: cfg });
    this.w.unref();
    this.w.on('message', (m: Reply & { type?: string }) => {
      if (m.type === 'passStart') return this.passCbs.forEach((f) => f());
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.lastPass) this.lastPass = m.lastPass;
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m);
    });
    this.w.on('error', (err) => this.fail(err));
    this.w.on('exit', () => this.fail(new Error('indexer stopped')));
  }

  private fail(err: unknown) {
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const p of all) p.reject(err);
  }

  private call(op: string, args: Record<string, unknown>): Promise<Reply> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.w.postMessage({ id, op, ...args });
    });
  }

  setPaths(snap: PathSnapshot) {
    this.w.postMessage({ op: 'paths', snap });
  }
  setOptions(opts: Required<IndexOptions>) {
    this.w.postMessage({ op: 'options', opts });
  }
  async pageRaw(cursor: string | null, maxBytes?: number): Promise<Raw> {
    const r = await this.call('page', { cursor, maxBytes });
    return { body: r.body!, stamps: r.stamps ?? [] };
  }
  async page(cursor: string | null, maxBytes?: number): Promise<IndexPage> {
    const r = await this.pageRaw(cursor, maxBytes);
    return { ...JSON.parse(dec.decode(r.body)), stamps: r.stamps };
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
    this.w.postMessage({ op: 'warm' });
  }
  dispose() {
    this.w.postMessage({ op: 'dispose' });
    void this.w.terminate();
  }
}
