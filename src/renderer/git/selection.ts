// Choose what to commit, pure part (lazy SCM chunk, unit-tested): a file's checkbox IS its index state —
// ticked = staged = goes into the commit; no selection is kept beside git, so a terminal sees the same.
// Tri-state from the status, what a click stages / unstages, and the batcher that flips boxes at once
// (optimistic) while rapid clicks become one git call.
import { signal } from '@preact/signals';
import type { GitEntry } from '@shared/git';

export type Check = 'on' | 'off' | 'mixed';

/** null: no checkbox (conflicts keep "Mark resolved"; ignored files are not listed). */
export function checkOf(e: GitEntry): Check | null {
  if (e.state === 'conflicted' || e.state === 'ignored') return null;
  if (e.state === 'untracked') return 'off';
  if (e.staged && e.unstaged) return 'mixed'; // some changes staged, some not
  return e.staged ? 'on' : 'off';
}

/** A click on a box: anything not fully in the commit goes in whole (a partly staged file too). */
export const wantOf = (c: Check): boolean => c !== 'on';

/** Paths one click touches: taking a rename out also takes the old name's removal out of the index. */
export function togglePaths(e: GitEntry, want: boolean): string[] {
  return !want && e.state === 'renamed' && e.from ? [e.path, e.from] : [e.path];
}

/** The header box over several files. */
export function allOf(checks: readonly Check[]): Check {
  if (!checks.length || checks.every((c) => c === 'off')) return 'off';
  return checks.every((c) => c === 'on') ? 'on' : 'mixed';
}

/** Files that go (at least partly) into the next commit. */
export const selectedCount = (checks: readonly Check[]) => checks.filter((c) => c !== 'off').length;

export const ariaChecked = (c: Check) => (c === 'on' ? 'true' : c === 'mixed' ? 'mixed' : 'false');

/** Stages `stage`, unstages `unstage`; false when git refused (the caller already said why). */
export type StageRun = (stage: string[], unstage: string[]) => Promise<boolean>;

export interface StageRequest {
  /** The row's path (key of the optimistic state). */
  path: string;
  /** Staged afterwards? */
  want: boolean;
  /** What git gets (default: the path; renames add their source when unstaged). */
  paths?: string[];
}

/**
 * Rapid clicks → one stage and one unstage call: the first click waits `delayMs` for company, clicks
 * while git runs go into the next call. `pending` holds the flipped boxes until the refreshed status
 * (which `run` waits for) takes over — or, on failure, shows the old state again.
 */
export class StageBatcher {
  readonly pending = signal<ReadonlyMap<string, boolean>>(new Map());
  private queue = new Map<string, { want: boolean; paths: string[] }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly run: StageRun,
    private readonly delayMs = 30,
  ) {}

  request(items: readonly StageRequest[]) {
    if (!items.length) return;
    const p = new Map(this.pending.peek());
    for (const it of items) {
      this.queue.set(it.path, { want: it.want, paths: it.paths ?? [it.path] });
      p.set(it.path, it.want);
    }
    this.pending.value = p;
    if (!this.running && !this.timer) this.timer = setTimeout(() => ((this.timer = null), void this.flush()), this.delayMs);
  }

  /** Resolves once everything asked for so far is in git (commit waits for this). */
  async drain(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      void this.flush();
    }
    while (this.running) await this.running;
  }

  get idle(): boolean {
    return !this.running && !this.timer && !this.queue.size;
  }

  private flush(): Promise<void> {
    if (this.running || !this.queue.size) return this.running ?? Promise.resolve();
    const batch = this.queue;
    this.queue = new Map();
    const stage = new Set<string>();
    const unstage = new Set<string>();
    for (const { want, paths } of batch.values()) for (const p of paths) (want ? stage : unstage).add(p);
    this.running = (async () => {
      try {
        await this.run([...stage], [...unstage]);
      } catch {}
      // The status is in: drop what this batch settled, unless a box was clicked again meanwhile.
      const p = new Map(this.pending.peek());
      for (const [path, it] of batch) if (!this.queue.has(path) && p.get(path) === it.want) p.delete(path);
      this.pending.value = p;
    })().finally(() => {
      this.running = null;
      if (this.queue.size) void this.flush();
    });
    return this.running;
  }
}
