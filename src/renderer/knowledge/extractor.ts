// Note metadata extraction off the main thread. Bulk index builds and edits of big notes go to Web
// Workers — a small pool that grows with the backlog (one page at a time stays on one worker, a big
// folder's pages spread over a few cores); when workers are unavailable (or one dies / never
// answers) the same code runs in-thread, in short slices, so typing and scrolling stay smooth.
import { extractNote, type NoteInfo } from '../../knowledge/extract';
import type { ExtractDoc, FromKnowledgeWorker, ToKnowledgeWorker } from '../../knowledge/protocol';

const SLICE_MS = 8;
/** No reply for this long while jobs are pending → the worker is wedged or never loaded. */
const WATCHDOG_MS = 15000;
/** Extraction workers are only needed for builds / big edits: idle ones are stopped (their heap with them). */
const IDLE_MS = 30_000;

interface Job {
  docs: ExtractDoc[];
  resolve: (infos: NoteInfo[]) => void;
  reject: (err: unknown) => void;
  worker: number;
}

const idle = (): Promise<void> =>
  new Promise((res) => {
    const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
    if (ric) ric(() => res(), { timeout: 300 });
    else setTimeout(res, 0);
  });

/** In-thread extraction, yielding every few ms (one huge note is still one slice). */
export async function extractInline(docs: readonly ExtractDoc[]): Promise<NoteInfo[]> {
  const out: NoteInfo[] = [];
  let t = performance.now();
  for (const d of docs) {
    out.push(extractNote(d.path, d.text));
    if (performance.now() - t > SLICE_MS) {
      await idle();
      t = performance.now();
    }
  }
  return out;
}

/** Extraction workers at most: a share of the cores (the search shards index at the same time). */
export function maxExtractors(): number {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(4, Math.floor(hc / 3)));
}

class Extractor {
  mode: 'none' | 'worker' | 'inline' = 'none';
  private workers: Worker[] = [];
  private busy: number[] = [];
  private jobs = new Map<number, Job>();
  private nextId = 1;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  /** Extracts `docs` (same order). Never rejects for transport reasons: falls back in-thread instead. */
  extract(docs: ExtractDoc[]): Promise<NoteInfo[]> {
    if (!docs.length) return Promise.resolve([]);
    if (this.mode === 'none') this.mode = typeof Worker === 'undefined' ? 'inline' : 'worker';
    if (this.mode !== 'worker') return extractInline(docs);
    const i = this.pick();
    if (i < 0) return extractInline(docs);
    const w = this.workers[i];
    return new Promise<NoteInfo[]>((resolve, reject) => {
      const id = this.nextId++;
      this.jobs.set(id, { docs, resolve, reject, worker: i });
      this.busy[i]++;
      this.arm();
      try {
        w.postMessage({ type: 'extract', id, docs } satisfies ToKnowledgeWorker);
      } catch (err) {
        console.warn('[knowledge] worker post failed, extracting in-thread', err);
        this.fallback();
      }
    });
  }

  private stopIdle() {
    this.idleTimer = null;
    if (this.jobs.size || this.mode !== 'worker') return;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
  }

  /** Least busy worker; another one only once every worker has a backlog (bulk builds, not edits). */
  private pick(): number {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    let best = -1;
    for (let i = 0; i < this.workers.length; i++) if (best < 0 || this.busy[i] < this.busy[best]) best = i;
    if ((best < 0 || this.busy[best] >= 2) && this.workers.length < maxExtractors()) {
      const w = this.spawn(this.workers.length);
      if (w) return this.workers.length - 1;
    }
    return best;
  }

  private spawn(i: number): Worker | null {
    try {
      const w = new Worker(new URL('../../knowledge/extract-worker.ts', import.meta.url), { type: 'module', name: i ? `sec-edit-knowledge-${i}` : 'sec-edit-knowledge' });
      w.onmessage = (e: MessageEvent<FromKnowledgeWorker>) => this.onMessage(e.data);
      w.onerror = (e) => {
        console.warn('[knowledge] worker failed, extracting in-thread', e.message);
        e.preventDefault?.();
        this.fallback();
      };
      w.onmessageerror = () => this.fallback();
      this.workers.push(w);
      this.busy.push(0);
      return w;
    } catch (err) {
      console.warn('[knowledge] Worker unavailable, extracting in-thread', err);
      if (!this.workers.length) this.mode = 'inline';
      return null;
    }
  }

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private onMessage(m: FromKnowledgeWorker) {
    const job = this.jobs.get(m.id);
    if (!job) return;
    this.jobs.delete(m.id);
    this.busy[job.worker] = Math.max(0, this.busy[job.worker] - 1);
    this.arm();
    if (!this.jobs.size) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stopIdle(), IDLE_MS);
    }
    if (m.type === 'extracted') job.resolve(m.infos);
    else job.reject(new Error(m.message));
  }

  /** (Re)starts the watchdog while jobs are pending; every reply proves the workers alive. */
  private arm() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = this.jobs.size
      ? setTimeout(() => {
          console.warn('[knowledge] worker did not answer, extracting in-thread');
          this.fallback();
        }, WATCHDOG_MS)
      : null;
  }

  private fallback() {
    if (this.mode === 'inline') return;
    this.mode = 'inline';
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.busy = [];
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const j of pending) extractInline(j.docs).then(j.resolve, j.reject);
  }
}

export const extractor = new Extractor();
