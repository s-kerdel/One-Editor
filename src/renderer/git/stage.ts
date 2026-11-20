// Choose what to commit, glue (lazy SCM chunk): the file boxes' batcher bound to the store (through
// ./actions: saves first, refreshes the status, toasts failures), and the diff view opened from the pane
// with a box per changed block (git('hunks') / git('stageHunks')). The index stays the only selection.
import { computed, signal, type ReadonlySignal } from '@preact/signals';
import type { GitActionResult, GitEntry, GitFileHunks, GitHunk, GitHunkPick, GitWholeFileReason } from '@shared/git';
import { app } from '../app/app';
import type { GitStore } from './store';
import type { StagingProps } from './DiffView';
import { runGit } from './actions';
import { git } from './rpc';
import { openChange, showDiff } from './diff-open';
import { checkOf, StageBatcher, togglePaths, wantOf, type Check } from './selection';

/** Paths per git call (the backend takes up to 20k; long lists go over stdin there). */
const CHUNK = 10_000;
const parts = <T>(l: T[]): T[][] => Array.from({ length: Math.ceil(l.length / CHUNK) }, (_, i) => l.slice(i * CHUNK, (i + 1) * CHUNK));

let bound: { store: GitStore; batcher: StageBatcher } | null = null;

/** The pane's batcher (one per store: pane and diff view share the optimistic state). */
export function stager(s: GitStore): StageBatcher {
  if (bound?.store === s) return bound.batcher;
  const batcher = new StageBatcher(async (stage, unstage) => {
    const r = await runGit(
      s,
      'Staging',
      async (): Promise<GitActionResult> => {
        for (const p of parts(stage)) {
          const r = await git('stage', p);
          if (!r.ok) return r;
        }
        for (const p of parts(unstage)) {
          const r = await git('unstage', p);
          if (!r.ok) return r;
        }
        return { ok: true };
      },
      { quiet: true },
    );
    return r.ok;
  });
  bound = { store: s, batcher };
  return batcher;
}

/** A file's box as shown: a click not yet in git wins over the status. Reads signals (re-renders). */
export function shownCheck(b: StageBatcher, e: GitEntry): Check | null {
  const c = checkOf(e);
  if (c === null) return null;
  const p = b.pending.value.get(e.path);
  return p === undefined ? c : p ? 'on' : 'off';
}

/** Click on a file's box. */
export function toggleEntry(b: StageBatcher, e: GitEntry) {
  const c = shownCheck(b, e);
  if (!c) return;
  const want = wantOf(c);
  b.request([{ path: e.path, want, paths: togglePaths(e, want) }]);
}

/** Everything ticked in the list in or out at once (header box): only rows that change. */
export function toggleAll(b: StageBatcher, list: readonly GitEntry[], want: boolean) {
  const items = [];
  for (const e of list) {
    const c = shownCheck(b, e);
    if (c && (want ? c !== 'on' : c !== 'off')) items.push({ path: e.path, want, paths: togglePaths(e, want) });
  }
  b.request(items);
}

const WHY: Partial<Record<GitWholeFileReason, string>> = {
  untracked: 'new file: it goes in as a whole',
  added: 'new file: it goes in as a whole',
  deleted: 'deleted: it goes in as a whole',
  binary: 'binary file: whole file only',
  'too-large': 'too large to pick parts',
  lfs: 'Git LFS file: whole file only',
  filter: 'a git filter applies: whole file only',
  special: 'whole file only',
};

const entryOf = (s: GitStore, path: string): GitEntry | null => {
  const st = s.status.value;
  return st?.ok ? (st.entries.find((x) => x.path === path) ?? null) : null;
};

/**
 * Pane row → the file's changes, with "Include in commit" for the file and, where git can split it,
 * for each block. Blocks keep their ranges when staged or not, so they are the picks' identity.
 */
export async function openStaging(s: GitStore, e: GitEntry): Promise<void> {
  const b = stager(s);
  const file: ReadonlySignal<Check | null> = computed(() => {
    const cur = entryOf(s, e.path);
    return cur ? shownCheck(b, cur) : null;
  });
  const busy = signal(false);
  const hunks = signal<readonly GitHunk[] | null>(null);
  const from = e.from ?? null;
  let ranges: Array<Omit<GitHunkPick, 'include'>> = [];
  let texts = { head: '', work: '' };
  const queue = new Map<number, boolean>();
  let running = false;

  /** Fresh states; queued clicks stay on top. A file changed on disk opens again. */
  const refetch = async () => {
    if (hunks.peek() === null) return;
    const n = await git('hunks', e.path, from).catch(() => null);
    if (!n || n.mode !== 'hunks') return;
    const same = n.head === texts.head && n.work === texts.work && n.hunks.length === ranges.length && n.hunks.every((h, i) => h.a0 === ranges[i].a0 && h.a1 === ranges[i].a1 && h.b0 === ranges[i].b0 && h.b1 === ranges[i].b1);
    if (!same) return void (app.overlay.peek() === shown && show(n));
    hunks.value = n.hunks.map((h, i) => (queue.has(i) ? { ...h, state: queue.get(i) ? 'staged' : 'unstaged' } : h));
  };
  const flush = async () => {
    if (running || !queue.size) return;
    running = true;
    busy.value = true;
    const picks = [...queue].map(([i, include]) => ({ ...ranges[i], include }));
    queue.clear();
    try {
      await runGit(s, 'Staging', () => git('stageHunks', e.path, picks, from), { save: false, quiet: true });
      await refetch();
    } finally {
      running = false;
      busy.value = false;
      if (queue.size) void flush();
    }
  };
  const staging: StagingProps = {
    hunks,
    file,
    busy,
    toggleHunk(i) {
      const list = hunks.peek();
      const h = list?.[i];
      if (!list || !h) return;
      const include = h.state !== 'staged';
      queue.set(i, include);
      hunks.value = list.map((x, k) => (k === i ? { ...x, state: include ? 'staged' : 'unstaged' } : x));
      setTimeout(() => void flush(), 30);
    },
    toggleFile() {
      const cur = entryOf(s, e.path);
      if (!cur) return;
      toggleEntry(b, cur);
      void b.drain().then(refetch);
    },
  };
  let shown: unknown = null;
  const show = (r: Extract<GitFileHunks, { mode: 'hunks' }>) => {
    ranges = r.hunks.map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }));
    texts = { head: r.head, work: r.work };
    queue.clear();
    hunks.value = r.hunks;
    const oid = s.repoOf(e.path)?.branch?.oid;
    showDiff({ path: e.path, base: r.head, current: r.work, baseLabel: `Last commit${oid ? ` (${oid.slice(0, 7)})` : ''}`, currentLabel: 'Working copy', staging });
    shown = app.overlay.peek();
  };

  // Unsaved edits: the view shows them, but git only knows the file on disk → whole file only.
  const dirty = !!app.docs.get(e.path)?.dirty.peek();
  const r = !dirty && checkOf(e) && !e.dir && !e.submodule ? await git('hunks', e.path, from).catch(() => null) : null;
  if (r?.mode === 'hunks' && r.hunks.length) return show(r);
  const note = dirty ? 'save the file to pick parts of it' : r?.mode === 'file' ? WHY[r.reason] : undefined;
  await openChange(s, e.path, checkOf(e) ? { staging: { ...staging, note } } : undefined);
}
