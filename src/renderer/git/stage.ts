// Choose what to commit, glue (lazy SCM chunk): the file boxes' batcher bound to the store (through
// ./actions: saves first, refreshes the status, toasts failures), and the diff view opened from the pane
// with a box per changed block (git('hunks') / git('stageHunks')). The index stays the only selection.
import { batch, computed, signal, type ReadonlySignal } from '@preact/signals';
import type { GitActionResult, GitEntry, GitFileHunks, GitHunk, GitHunkPick, GitWholeFileReason } from '@shared/git';
import { app } from '../app/app';
import * as ui from '../app/ui';
import type { GitStore } from './store';
import type { StagingProps } from './DiffView';
import { runGit } from './actions';
import { git } from './rpc';
import { openChange, showDiff } from './diff-open';
import { saveThenPick } from './diff-edit';
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
 * The working copy can be edited in the view: git only knows the file on disk, so the blocks are read
 * again after every save, and a box clicked on unsaved edits saves first (./diff-edit `saveThenPick`).
 */
export async function openStaging(s: GitStore, e: GitEntry): Promise<void> {
  const b = stager(s);
  const file: ReadonlySignal<Check | null> = computed(() => {
    const cur = entryOf(s, e.path);
    return cur ? shownCheck(b, cur) : null;
  });
  const busy = signal(false);
  const hunks = signal<readonly GitHunk[] | null>(null);
  /** The working-copy text the blocks refer to (the view's bars follow it). */
  const work = signal('');
  const from = e.from ?? null;
  let ranges: Array<Omit<GitHunkPick, 'include'>> = [];
  let head: string | null = null; // null: git cannot split this file (whole file only)
  const queue = new Map<number, boolean>();
  let running = false;
  let saving = false;
  let shown: unknown = null;
  /** The open document's text; undefined: no tab holds the file. */
  const live = () => (app.docs.has(e.path) ? (app.editor?.getContent(e.path) ?? app.docs.get(e.path)!.content) : undefined);
  const unsaved = () => !!app.docs.get(e.path)?.dirty.peek();

  const adopt = (r: Extract<GitFileHunks, { mode: 'hunks' }>) => {
    ranges = r.hunks.map(({ a0, a1, b0, b1 }) => ({ a0, a1, b0, b1 }));
    head = r.head;
    batch(() => {
      work.value = r.work;
      hunks.value = r.hunks.map((h, i) => (queue.has(i) ? { ...h, state: queue.get(i) ? 'staged' : 'unstaged' } : h));
    });
  };
  /** Fresh blocks; queued clicks stay on top. One at a time (a save and a click may both ask). */
  let chain: Promise<void> = Promise.resolve();
  const refetch = () => (chain = chain.then(load, load));
  const load = async () => {
    if (head === null || app.overlay.peek() !== shown) return;
    const n = await git('hunks', e.path, from).catch(() => null);
    if (!n || n.mode !== 'hunks' || app.overlay.peek() !== shown) return;
    const now = live();
    // Edited again since the save: the bars wait for the next one.
    if (now !== undefined && now !== n.work) return;
    const sameRanges = n.hunks.length === ranges.length && n.hunks.every((h, i) => h.a0 === ranges[i].a0 && h.a1 === ranges[i].a1 && h.b0 === ranges[i].b0 && h.b1 === ranges[i].b1);
    if (!sameRanges) queue.clear(); // the picks' identity is gone
    // The view shows the open document (or the same file as before): it keeps its editors, cursor and
    // undo history, only the bars move. Another commit or a file changed on disk opens again.
    if (n.head === head && (now !== undefined || n.work === work.peek())) adopt(n);
    else show(n);
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
  const pick = (i: number) => {
    const list = hunks.peek();
    const h = list?.[i];
    if (!list || !h) return;
    const include = h.state !== 'staged';
    queue.set(i, include);
    hunks.value = list.map((x, k) => (k === i ? { ...x, state: include ? 'staged' : 'unstaged' } : x));
    setTimeout(() => void flush(), 30);
  };
  const staging: StagingProps = {
    hunks,
    work,
    file,
    busy,
    toggleHunk(i, line) {
      // Edited in the view since the blocks were read (unsaved, or saved a moment ago): git has to
      // see the file first, and the block is found again by where its bar is.
      const now = live();
      const moved = now !== undefined && now !== work.peek();
      if (!line || !(moved || unsaved())) return pick(i);
      if (saving) return;
      if (ui.conflicts.value.has(e.path) || ui.deletedOnDisk.value.has(e.path)) {
        // Saving would overwrite what is on disk: that is the user's call, in the editor.
        return void app.toast('The file changed on disk. Decide in the editor which version to keep, then pick blocks.', 'info', 6000);
      }
      saving = true;
      busy.value = true;
      void saveThenPick({ save: async () => !unsaved() || app.saveFile(e.path), line, hunks: () => refetch().then(() => (unsaved() ? null : hunks.peek())) })
        .then((k) => k !== null && pick(k))
        .finally(() => {
          saving = false;
          if (!running) busy.value = false;
        });
    },
    toggleFile() {
      const cur = entryOf(s, e.path);
      if (!cur) return;
      toggleEntry(b, cur);
      void b.drain().then(refetch);
    },
  };
  const label = () => {
    const oid = s.repoOf(e.path)?.branch?.oid;
    return `Last commit${oid ? ` (${oid.slice(0, 7)})` : ''}`;
  };
  const watch = () => {
    shown = app.overlay.peek();
    // Saved from the diff, its tab or by autosave: git sees the new file now.
    const off = app.events.on('doc:saved', (p) => {
      if (app.overlay.peek() !== shown) return off();
      if (p === e.path && !saving) void refetch();
    });
    const mine = shown;
    const stop = app.overlay.subscribe((o) => o !== mine && (off(), queueMicrotask(() => stop())));
  };
  const show = (r: Extract<GitFileHunks, { mode: 'hunks' }>) => {
    queue.clear();
    adopt(r);
    showDiff({ path: e.path, base: r.head, current: r.work, baseLabel: label(), currentLabel: 'Working copy', staging, editable: true });
    watch();
  };

  const r = checkOf(e) && !e.dir && !e.submodule ? await git('hunks', e.path, from).catch(() => null) : null;
  const text = live();
  if (r?.mode === 'hunks' && unsaved() && text !== undefined && text !== r.work) {
    // Unsaved edits: the view shows (and edits) them, git's blocks belong to the file on disk. They
    // appear with the next save; until then the file's box works (it saves first).
    head = r.head;
    work.value = r.work;
    showDiff({ path: e.path, base: r.head, current: text, baseLabel: label(), currentLabel: 'Working copy', staging: { ...staging, note: 'blocks to pick appear once saved' }, editable: true });
    return watch();
  }
  if (r?.mode === 'hunks' && r.hunks.length) return show(r);
  const note = r?.mode === 'file' ? WHY[r.reason] : undefined;
  await openChange(s, e.path, checkOf(e) ? { staging: { ...staging, note } } : undefined);
}
