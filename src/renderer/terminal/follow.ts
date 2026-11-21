// "Follow Claude's edits" (preview), UI side — its own lazy chunk, fetched with the first edit event.
// Main (main/terminal-follow.ts) only ever sends workspace-relative paths of files inside the open
// folder. This module shows the file, scrolls to the edited lines, flashes them and leaves a
// "changed this turn" mark. It never takes the keyboard focus (the user is typing to Claude) and never
// changes a document: a clean one is re-read from disk by the watcher's own code path, a dirty one is left alone.
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { TerminalFollowEvent } from '@shared/terminal';
import { app } from '../app/app';
import { findHint, probeMatches } from './claude';
import { followAdd, followField, followLines, followSync, type Lines } from './follow-marks';
import './follow.css';

const FLASH_MS = 4200;
/** Fallback only: how long to wait for the file watcher when the re-read document does not show the edit. */
const RELOAD_WAIT_MS = 800;
/** Claude hopping between files faster than this: go to the newest file, the others only get their marks. */
const SWITCH_MS = 1000;
const TOAST_MS = 5000;

export const FOLLOW_LIMITS = {
  /** Edits waiting to be shown; the oldest beyond it only leaves its marks. */
  queue: 50,
  /** Files per turn that are counted / keep marks for later. */
  files: 200,
  /** Line ranges kept per file that is not on screen. */
  ranges: 200,
  /** Line ranges taken from one event. */
  eventRanges: 20,
} as const;

const editorView = () => app.editor?.getView?.() as EditorView | undefined;
const now = () => Date.now();

// ---------------------------------------------------------------- marks + flashes

/** Claude's turn: marks of an older turn are dropped when their document is next looked at. */
let turnNo = 1;
/** Marks for files that are not on screen, applied when the file is shown. */
const pending = new Map<string, Lines>();

function later(path: string, lines: Lines | null | undefined) {
  if (!lines?.length) return;
  let list = pending.get(path);
  if (!list) {
    if (pending.size >= FOLLOW_LIMITS.files) return;
    pending.set(path, (list = []));
  }
  for (const r of lines) if (list.length < FOLLOW_LIMITS.ranges) list.push(r);
}

/** Drops ended flashes and marks of an earlier turn in the document on screen. */
function sync(view: EditorView) {
  if (view.state.field(followField, false) !== undefined) view.dispatch({ effects: followSync.of({ now: now(), turn: turnNo }) });
}

function mark(view: EditorView, lines: Lines | null, o: { flash?: boolean; scrollTo?: number } = {}) {
  // The field joins the document's state on first use (a config change and its effect cannot share a transaction).
  if (view.state.field(followField, false) === undefined) view.dispatch({ effects: StateEffect.appendConfig.of(followField) });
  const doc = view.state.doc;
  const t = now();
  const fx: StateEffect<unknown>[] = [followSync.of({ now: t, turn: turnNo })];
  if (lines?.length) fx.push(followAdd.of({ lines, turn: turnNo, until: o.flash ? t + FLASH_MS : 0 }));
  if (o.scrollTo) fx.push(EditorView.scrollIntoView(doc.line(Math.min(Math.max(o.scrollTo, 1), doc.lines)).from, { y: 'center' }));
  view.dispatch({ effects: fx });
  // Each flash ends on its own timer; a document that is not on screen then is tidied when it is shown again.
  if (o.flash && lines?.length)
    setTimeout(() => {
      const v = editorView();
      if (v) sync(v);
    }, FLASH_MS + 30);
}

/** The document `path` is on screen now: tidy it and add the marks that waited for it. */
function onShown(path: string | null) {
  const view = editorView();
  if (!path || !view || app.activePath.value !== path) return;
  const lines = pending.get(path);
  pending.delete(path);
  if (lines) mark(view, lines);
  else sync(view);
}
app.events.on('active:changed', (p) => {
  try {
    onShown(p);
  } catch {}
});

/** Palette "Claude: Clear change marks", and every new prompt. Returns whether a mark was on screen. */
export function clearChangeMarks(): boolean {
  turnNo++;
  pending.clear();
  const view = editorView();
  const had = !!view && followLines(view.state).marks.length > 0;
  if (view) sync(view); // other open documents: when they are shown (onShown)
  return had;
}

// ---------------------------------------------------------------- showing one edit

/** Resolves at the next disk reload of `path` (the watcher), or after `ms`. */
const diskUpdate = (path: string, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      off();
      clearTimeout(t);
      resolve();
    };
    const off = app.events.on('file:updated', (p) => p === path && done());
    const t = setTimeout(done, ms);
  });

/**
 * The hook proves the file changed: read it now instead of waiting for the file watcher (1–2 s on a WSL
 * folder). This is the watcher's own entry point, so the rules are the same: a clean document follows
 * the disk with a minimal change, unsaved edits are never replaced (the caller does not even ask then).
 */
async function reload(path: string) {
  const doc = app.docs.get(path);
  if (!doc || doc.binary || doc.dirty.value) return;
  await (await import('../app/disk-sync')).handleFsEvents([{ type: 'change', path }]);
}

let toasted = { path: '', at: 0 };
/** Toast with a "Diff" button when the folder is a git repository (the usual staging diff view). Once per run of edits to a file. */
async function announce(path: string) {
  const t = now();
  const again = toasted.path === path && t - toasted.at < TOAST_MS;
  toasted = { path, at: t };
  if (again) return;
  let actions: Array<{ label: string; run: () => void }> | undefined;
  try {
    const store = (await import('../git/index')).getGitStore();
    if (store?.status.peek()?.ok) actions = [{ label: 'Diff', run: () => void import('../git/diff-open').then((m) => m.openFileDiff(store, path)) }];
  } catch {}
  app.toast(`Claude edited ${path}`, 'info', TOAST_MS, actions);
}

const validLines = (v: unknown): Lines | null => {
  if (!Array.isArray(v)) return null;
  const out = v.filter((r): r is [number, number] => Array.isArray(r) && r.length === 2 && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 1 && r[1] >= r[0]).slice(0, FOLLOW_LIMITS.eventRanges);
  return out.length ? out : null;
};

const queue: TerminalFollowEvent[] = [];
let running = false;
let lastSwitch = 0;

async function show(e: TerminalFollowEvent) {
  const path = e.path!;
  const lines = validLines(e.lines);
  const newer = () => queue.some((q) => q.path === path); // a later edit of this file is waiting
  void announce(path);
  if (app.activePath.value !== path) {
    // Typing in another file: tell, but leave the editor where it is.
    if (editorView()?.hasFocus) return later(path, lines);
    if (queue.some((q) => q.path !== path) && now() - lastSwitch < SWITCH_MS) return later(path, lines);
    lastSwitch = now();
  }
  // Marks that waited for this file belong to the text on disk: hold them back until it is re-read.
  const waited = pending.get(path);
  pending.delete(path);
  const giveUp = () => (later(path, waited), later(path, lines));
  const had = app.docs.has(path);
  if (app.activePath.value !== path) await app.openFile(path); // no reveal target: reveal() would move the focus into the editor
  const onScreen = () => app.activePath.value === path;
  const view = editorView();
  if (!onScreen() || !view) return giveUp();
  // Unsaved edits: the document is the user's, Claude's line numbers do not apply. The usual
  // "changed on disk" banner follows from the file watcher.
  if (app.docs.get(path)?.dirty.value) return;
  if (had) await reload(path);
  if (!onScreen()) return giveUp();
  if (waited) mark(view, waited);

  const locate = (): { lines: Lines | null; at?: number } | null => {
    const doc = view.state.doc;
    const probe = e.probe;
    if (lines && (!probe || probeMatches(probe.line <= doc.lines ? doc.line(probe.line).text : undefined, probe))) return { lines, at: lines[0][0] };
    if (e.kind === 'write' && !e.lines) return { lines: [[1, doc.lines]] }; // a new file: all of it
    // No usable patch: find the new text, but trust only a single occurrence.
    const hit = findHint(doc.toString(), e.hint);
    if (!hit) return null;
    const first = doc.lineAt(hit.from).number;
    return { lines: hit.unique ? [[first, doc.lineAt(hit.to).number]] : null, at: first }; // several places: go to the first, mark none
  };
  let found = locate();
  // Not there (yet)? Later edits of the same file explain it; otherwise give the watcher a moment.
  if (!found?.lines && !newer()) {
    await diskUpdate(path, RELOAD_WAIT_MS);
    if (!onScreen()) return giveUp();
    found = locate();
  }
  if (found) mark(view, found.lines, { flash: true, scrollTo: newer() ? undefined : found.at }); // scroll once, to the newest edit
}

async function pump() {
  if (running) return;
  running = true;
  try {
    // In order, one at a time: a newer edit never cancels an older one.
    for (let e = queue.shift(); e; e = queue.shift()) await show(e).catch(() => {});
  } finally {
    running = false;
  }
}

const turn = new Map<number, Set<string>>(); // files per Claude terminal since its last Stop

export function onFollowEvent(e: TerminalFollowEvent) {
  if (typeof e?.id !== 'number') return;
  if (e.kind === 'stop') {
    const n = turn.get(e.id)?.size ?? 0;
    turn.delete(e.id);
    if (n > 1) app.toast(`Claude changed ${n} files this turn`, 'info', TOAST_MS);
    return;
  }
  if (e.kind === 'prompt') {
    // The user's next prompt: the marks of the turn before it go.
    turn.delete(e.id);
    clearChangeMarks();
    return;
  }
  if ((e.kind !== 'edit' && e.kind !== 'write') || typeof e.path !== 'string' || !e.path) return;
  let files = turn.get(e.id);
  if (!files) turn.set(e.id, (files = new Set()));
  if (files.size < FOLLOW_LIMITS.files) files.add(e.path);
  if (queue.length >= FOLLOW_LIMITS.queue) {
    const old = queue.shift()!;
    later(old.path!, validLines(old.lines));
  }
  queue.push(e);
  void pump();
}
