// Renderer-side client for the format worker. The worker (and with it Prettier) is created on
// the first format request, never at startup. Every call resolves — failures come back as
// `result.error` so callers have a single code path.
import type { FormatIssue, FormatRequest, FormatResult } from './types';
import type { WorkerRequest, WorkerResponse } from './worker';

interface Pending {
  resolve(r: FormatResult): void;
  text: string;
  req: FormatRequest;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let workerBroken = false; // Worker unavailable (CSP, old runtime): format on the main thread instead
let warmed = false;
let nextId = 1;
const pending = new Map<number, Pending>();

const failure = (text: string, error: FormatIssue): FormatResult => ({ text, changed: false, language: null, error });

function settleAll(kind: FormatIssue['kind'], message: string) {
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(failure(p.text, { kind, message }));
    pending.delete(id);
  }
}

function killWorker() {
  worker?.terminate();
  worker = null;
  warmed = false;
}

function getWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[format] worker unavailable, formatting on the main thread', err);
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    clearTimeout(p.timer);
    warmed = true;
    if (e.data.result) p.resolve(e.data.result);
    else p.resolve(failure(p.text, { kind: 'internal', message: `Formatter failed: ${e.data.error ?? 'unknown error'}` }));
  };
  worker.onerror = (e) => {
    // Script failed to load or crashed: don't leave callers hanging, and don't retry a worker that can't start.
    console.warn('[format] worker error', e.message);
    const neverWorked = !warmed;
    killWorker();
    if (neverWorked) {
      // The worker script itself can't run here: redo the waiting jobs on the main thread.
      workerBroken = true;
      for (const [id, p] of pending) {
        pending.delete(id);
        clearTimeout(p.timer);
        void formatOnMainThread(p.text, p.req).then(p.resolve);
      }
    } else settleAll('internal', `Formatter crashed${e.message ? `: ${e.message}` : ''}`);
  };
  return worker;
}

async function formatOnMainThread(text: string, req: FormatRequest): Promise<FormatResult> {
  try {
    const { formatText } = await import('./core');
    return await formatText(text, req);
  } catch (err) {
    return failure(text, { kind: 'internal', message: `Formatter failed: ${(err as Error)?.message ?? err}` });
  }
}

export interface FormatCallOptions {
  /** Give up after this long (default 10s; the first call gets extra time to load Prettier). */
  timeoutMs?: number;
}

/** Formats in the worker. Never rejects. */
export function formatInWorker(text: string, req: FormatRequest, opts: FormatCallOptions = {}): Promise<FormatResult> {
  const w = getWorker();
  if (!w) return formatOnMainThread(text, req);
  const timeoutMs = (opts.timeoutMs ?? 10_000) + (warmed ? 0 : 10_000);
  return new Promise<FormatResult>((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      resolve(failure(text, { kind: 'timeout', message: `Formatting timed out after ${Math.round(timeoutMs / 1000)}s` }));
      // The worker is single-threaded: a stuck job blocks everything behind it, so start fresh.
      killWorker();
      settleAll('timeout', 'Formatting was cancelled');
    }, timeoutMs);
    pending.set(id, { resolve, text, req, timer });
    const msg: WorkerRequest = { id, text, req };
    w.postMessage(msg);
  });
}

/** Test hook / shutdown. */
export function disposeFormatWorker() {
  killWorker();
  settleAll('internal', 'Formatter stopped');
}
