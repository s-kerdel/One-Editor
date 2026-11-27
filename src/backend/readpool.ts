// Parallel file reads for the indexers: a few worker threads doing *blocking* reads. Measured on
// WSL (12k files): sync on one thread 182 ms, fs.promises pool 2.2 s (4 libuv round-trips per file),
// 4 threads 138 ms. On Windows every open is scanned by the antivirus: threads hide that latency.
// Workers only move bytes (transferred, not copied); decoding stays in the caller.
import { Worker } from 'node:worker_threads';
import os from 'node:os';

export interface ReadJob {
  abs: string;
  /** Cached stamp: when a plain stat (no open → no antivirus scan) still matches, nothing is read. */
  mtime?: number;
  size?: number;
}

export type ReadResult =
  | { kind: 'hit'; mtime: number; size: number }
  | { kind: 'data'; bytes: Uint8Array; mtime: number; size: number }
  /** Not a regular file, or over the size cap. */
  | { kind: 'skip'; mtime: number; size: number }
  | { kind: 'error' };

// Self-contained (eval'd): works unchanged from the Electron main bundle and the server CLI.
const WORKER_SRC = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const O = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
// Tests: latency injection on every stat / open (9P bridge to WSL, antivirus scanning), see fsdelay.ts.
const DELAY = Number(process.env.SEC_EDIT_TEST_FS_LATENCY_MS || process.env.SEC_EDIT_TEST_OPEN_DELAY_MS) || 0;
const nap = DELAY ? new Int32Array(new SharedArrayBuffer(4)) : null;
parentPort.on('message', (m) => {
  const out = [];
  const transfer = [];
  for (const j of m.jobs) {
    try {
      if (j.mtime !== undefined) {
        if (nap) Atomics.wait(nap, 0, 0, DELAY);
        const st = fs.statSync(j.abs);
        if (st.isFile() && st.mtimeMs === j.mtime && st.size === j.size) { out.push({ kind: 'hit', mtime: st.mtimeMs, size: st.size }); continue; }
      }
      if (nap) Atomics.wait(nap, 0, 0, DELAY);
      const fd = fs.openSync(j.abs, O);
      try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.size > m.max) { out.push({ kind: 'skip', mtime: st.mtimeMs, size: st.size }); continue; }
        const buf = new Uint8Array(st.size);
        let n = 0;
        while (n < st.size) { const r = fs.readSync(fd, buf, n, st.size - n, n); if (!r) break; n += r; }
        out.push({ kind: 'data', bytes: n === st.size ? buf : buf.subarray(0, n), mtime: st.mtimeMs, size: st.size });
        transfer.push(buf.buffer);
      } finally { fs.closeSync(fd); }
    } catch { out.push({ kind: 'error' }); }
  }
  parentPort.postMessage({ id: m.id, out }, transfer);
});`;

/** `\\wsl.localhost\…`, `\\wsl$\…` or any other UNC share: every file call crosses a network-ish bridge. */
export function isBridgeRoot(root: string): boolean {
  return /^(?:\\\\|\/\/)[^\\/]+[\\/]/.test(root) || process.env.SEC_EDIT_TEST_BRIDGE_ROOT === '1';
}

/**
 * Reader threads. Latency-bound file systems want many (each thread blocks on one open at a time):
 * a WSL / UNC root 32, Windows 8 (antivirus scans every open); elsewhere a few cores are plenty.
 */
export function defaultReadThreads(root = ''): number {
  const env = Number(process.env.SEC_EDIT_READ_THREADS);
  if (process.env.SEC_EDIT_READ_THREADS && Number.isFinite(env) && env >= 0) return Math.min(32, Math.floor(env));
  if (isBridgeRoot(root)) return 32;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return process.platform === 'win32' ? 8 : Math.max(2, Math.min(4, cores - 1));
}

const IDLE_MS = 5_000;

export class ReadPool {
  private workers: Worker[] = [];
  /** Batches in flight per thread (parallel to workers). */
  private load: number[] = [];
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: ReadResult[]) => void; reject: (e: unknown) => void; worker: Worker }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private broken = false;

  constructor(private readonly threads = defaultReadThreads()) {}

  get threadCount() {
    return this.threads;
  }

  /** Threads running now (they start on demand and stop when idle). */
  get running() {
    return this.workers.length;
  }

  /** Threads reading right now (process explorer). */
  get busy() {
    return this.load.filter((n) => n > 0).length;
  }

  /** False when threads are off (0) or could not start: callers read in-thread instead. */
  get available() {
    return this.threads > 0 && !this.broken;
  }

  /** Starts a few threads ahead of the first pass (they take a few ms each to boot). */
  warm() {
    if (!this.available) return;
    try {
      while (this.workers.length < Math.min(4, this.threads)) this.spawn();
      this.armIdle();
    } catch {
      this.broken = true;
    }
  }

  private spawn(): number {
    // These threads only move bytes (backing stores live outside the JS heap): small heaps.
    const w = new Worker(WORKER_SRC, { eval: true, resourceLimits: { maxYoungGenerationSizeMb: 1, maxOldGenerationSizeMb: 16, codeRangeSizeMb: 4, stackSizeMb: 1 } });
    w.unref(); // never keeps the process alive
    w.on('message', (m: { id: number; out: ReadResult[] }) => {
      const p = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      const i = this.workers.indexOf(w);
      if (i !== -1) this.load[i] = Math.max(0, this.load[i] - 1);
      p?.resolve(m.out);
      this.armIdle();
    });
    w.on('error', (err) => this.fail(err));
    w.on('exit', (code) => code !== 0 && this.workers.includes(w) && this.fail(new Error(`read worker exited (${code})`)));
    this.workers.push(w);
    this.load.push(0);
    return this.workers.length - 1;
  }

  /** An idle thread, else a new one (up to the limit), else the least loaded: a one-file update starts one thread, a pass all of them. */
  private pick(): number {
    let best = -1;
    for (let i = 0; i < this.workers.length; i++) {
      if (this.load[i] === 0) return i;
      if (best < 0 || this.load[i] < this.load[best]) best = i;
    }
    return this.workers.length < this.threads ? this.spawn() : best;
  }

  private fail(err: unknown) {
    this.broken = true;
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    this.close();
    for (const p of pending) p.reject(err);
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // Threads cost a few MB each: gone shortly after the last read.
    this.idleTimer = this.waiting.size ? null : setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer?.unref();
  }

  /** Reads a batch on an idle (or new, or the least busy) thread; results in job order. */
  read(jobs: ReadJob[], maxBytes: number): Promise<ReadResult[]> {
    if (!this.available) return Promise.reject(new Error('read pool unavailable'));
    let i: number;
    try {
      i = this.pick();
    } catch (err) {
      this.broken = true;
      return Promise.reject(err);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const id = ++this.seq;
    const w = this.workers[i];
    this.load[i]++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, worker: w });
      w.postMessage({ id, jobs, max: maxBytes });
    });
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ws = this.workers;
    this.workers = [];
    this.load = [];
    for (const w of ws) void w.terminate().catch(() => {});
  }
}
