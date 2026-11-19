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
parentPort.on('message', (m) => {
  const out = [];
  const transfer = [];
  for (const j of m.jobs) {
    try {
      if (j.mtime !== undefined) {
        const st = fs.statSync(j.abs);
        if (st.isFile() && st.mtimeMs === j.mtime && st.size === j.size) { out.push({ kind: 'hit', mtime: st.mtimeMs, size: st.size }); continue; }
      }
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

/** Threads: Windows benefits from more (latency, not CPU); elsewhere a few cores are plenty. */
export function defaultReadThreads(): number {
  const env = Number(process.env.SEC_EDIT_READ_THREADS);
  if (Number.isFinite(env) && env >= 0) return Math.min(16, Math.floor(env));
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return process.platform === 'win32' ? 8 : Math.max(2, Math.min(4, cores - 1));
}

const IDLE_MS = 15_000;

export class ReadPool {
  private workers: Worker[] = [];
  private next = 0;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: ReadResult[]) => void; reject: (e: unknown) => void }>();
  private idleTimer: NodeJS.Timeout | null = null;
  private broken = false;

  constructor(private readonly threads = defaultReadThreads()) {}

  get threadCount() {
    return this.threads;
  }

  /** False when threads are off (0) or could not start: callers read in-thread instead. */
  get available() {
    return this.threads > 0 && !this.broken;
  }

  private ensure() {
    if (this.workers.length) return;
    for (let i = 0; i < this.threads; i++) {
      const w = new Worker(WORKER_SRC, { eval: true });
      w.unref(); // never keeps the process alive
      w.on('message', (m: { id: number; out: ReadResult[] }) => {
        const p = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        p?.resolve(m.out);
        this.armIdle();
      });
      w.on('error', (err) => this.fail(err));
      w.on('exit', (code) => code !== 0 && this.workers.includes(w) && this.fail(new Error(`read worker exited (${code})`)));
      this.workers.push(w);
    }
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
    // Threads cost a few MB each: gone shortly after the last index pass.
    this.idleTimer = this.waiting.size ? null : setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer?.unref();
  }

  /** Reads a batch on the next thread (round robin); results in job order. */
  read(jobs: ReadJob[], maxBytes: number): Promise<ReadResult[]> {
    if (!this.available) return Promise.reject(new Error('read pool unavailable'));
    try {
      this.ensure();
    } catch (err) {
      this.broken = true;
      return Promise.reject(err);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const id = ++this.seq;
    const w = this.workers[this.next++ % this.workers.length];
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      w.postMessage({ id, jobs, max: maxBytes });
    });
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const ws = this.workers;
    this.workers = [];
    for (const w of ws) void w.terminate().catch(() => {});
  }
}
