// Go back / Go forward: the recorder and the restore (lazy chunk; ./install is the startup stub).
//
// One central hook instead of a call in every feature: whatever opens a file ends in
// `active:changed`, and whatever moves the cursor ends in the editor's cursor callback. Features whose
// moves those can't classify (a PDF link, a short but deliberate jump) call `app.markNavigation()`.
import type { Signal } from '@preact/signals';
import { createNavDeduper, type NavDir, type NavSource } from '@shared/nav';
import { app } from '../app/app';
import { editorReady } from '../app/documents';
import * as ui from '../app/ui';
import { NavHistory, type NavEntry } from './history';

const PDF_RE = /\.pdf$/i;
/** How long a markNavigation() waits for its move (a PDF link resolves its destination asynchronously). */
const MARK_MS = 1000;
/** Rows in a button's recent-places list. */
const PLACES_MAX = 10;

export const history = new NavHistory();
const dedupe = createNavDeduper();
/** Restoring an entry: nothing it causes may be recorded. */
let navigating = false;
let markedUntil = 0;
let queue: Promise<unknown> = Promise.resolve();
/** The buttons' state (./install owns the signals: they render before this chunk is in). */
let can: { back: Signal<boolean>; forward: Signal<boolean> } | undefined;

const isViewer = (path: string) => PDF_RE.test(path) || !!app.docs.get(path)?.binary;

function here(): NavEntry | null {
  const path = app.activePath.value;
  if (!path) return null;
  if (isViewer(path) || !app.editor) return { path };
  const c = app.editor.getCursor();
  return { path, line: c.line, col: c.col };
}

const exists = (path: string) => app.docs.has(path) || app.files.value.includes(path);

/** Greys the buttons out at either end. Only after the stack changed: typing and small moves never call it. */
function sync(): void {
  if (!can) return;
  can.back.value = history.places(-1, 1, exists).length > 0;
  can.forward.value = history.places(1, 1, exists).length > 0;
}

function record(loc: NavEntry | null, edit?: boolean, force?: boolean): void {
  if (navigating || !loc) return;
  const now = performance.now();
  const marked = now < markedUntil;
  if (!history.visit(loc, { now, edit, force: force || marked })) return;
  if (marked) markedUntil = 0;
  sync();
}

/** Opens an entry and puts its cursor / scroll back; false when it could not be shown. */
async function show(e: NavEntry): Promise<boolean> {
  navigating = true;
  try {
    await app.openFile(e.path, PDF_RE.test(e.path) ? { line: 0, page: e.page ?? 1 } : undefined);
    if (app.activePath.value !== e.path) return false;
    if (!isViewer(e.path) && app.editor && e.line !== undefined) {
      app.editor.reveal({ line: e.line, col: e.col });
      if (e.top !== undefined) app.editor.scrollToLine(e.top); // where the reader was looking, not just the cursor
    }
    return true;
  } catch (err) {
    console.warn('[nav]', err);
    return false;
  } finally {
    navigating = false;
  }
}

async function step(dir: NavDir): Promise<boolean> {
  const d = dir === 'back' ? -1 : 1;
  for (;;) {
    const e = history.step(d, exists);
    if (!e) return false;
    if (await show(e)) return true;
    history.dropCurrent(d); // could not be opened: try the next one
  }
}

/** Presses in a row are steps in a row, never interleaved. */
function queued(run: () => Promise<boolean>): Promise<boolean> {
  const p = queue.then(run).finally(sync);
  queue = p.catch(() => {});
  return p;
}

/** One step. A second request for the same press (mouse event + Windows app-command) is ignored. */
export function go(dir: NavDir, source: NavSource = 'key'): Promise<boolean> {
  if (!dedupe(dir, source, performance.now())) return Promise.resolve(false);
  return queued(() => step(dir));
}

/** Straight to one of the recent places (a button's list); one that can't be shown is forgotten. */
export function jump(entry: NavEntry): Promise<boolean> {
  return queued(async () => {
    const from = history.current;
    if (!history.goTo(entry)) return false;
    if (await show(entry)) return true;
    history.forget(entry, from);
    return false;
  });
}

/** Right-click / long-press on a back / forward button: the places that way, nearest first, above it. */
export async function openPlaces(dir: NavDir, anchor: HTMLElement): Promise<void> {
  const list = history.places(dir === 'back' ? -1 : 1, PLACES_MAX, exists);
  if (!list.length) return;
  const { describePlace } = await import('./places');
  const items: ui.MenuItem[] = list.map((e) => {
    const { label, hint } = describePlace(e, app.docs.get(e.path)?.content);
    return { label, keys: hint, icon: e.page || e.line === undefined ? 'file' : 'fileText', run: () => jump(e) };
  });
  const prev = document.activeElement as HTMLElement | null;
  const r = anchor.getBoundingClientRect();
  // The buttons sit in the status bar: the menu host flips the list up so it ends right over the button.
  ui.openContextMenu({ clientX: r.left, clientY: r.top - 4, preventDefault() {}, stopPropagation() {} }, items);
  // The shared menu host focuses itself while still hidden (it measures first), which never takes:
  // focus it once shown, so ↑ ↓ Enter work from the keyboard (Shift+F10 on the button).
  const focusMenu = (tries: number) =>
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>('.se-menu[role="menu"]');
      if (el && getComputedStyle(el).visibility === 'visible') el.contains(document.activeElement) || el.focus();
      else if (tries > 0 && ui.contextMenu.value) focusMenu(tries - 1);
    });
  focusMenu(20);
  // The menu took focus. Closed by Esc or a pick: focus goes back where it was (the editor, or the button
  // for keyboard use). A click elsewhere keeps it there (that click also moved the DOM selection away).
  let open = false;
  let away = false;
  const down = (e: Event) => void ((e.target as Element).closest?.('.se-menu') || (away = true));
  addEventListener('mousedown', down, true);
  const stop = ui.contextMenu.subscribe((m) => {
    if (m) return void (open = true);
    if (!open) return;
    queueMicrotask(() => stop());
    setTimeout(() => {
      removeEventListener('mousedown', down, true);
      const a = document.activeElement;
      if (away || (a && a !== document.body)) return;
      // The editor's own focus() keeps its cursor; a bare DOM focus would put it at the top (a jump).
      if (prev?.closest('.cm-editor')) app.editor?.focus();
      else if (prev?.isConnected) prev.focus();
    });
  });
}

const storeKey = () => `sec-edit-nav:${app.workspace.value?.root ?? ''}`;

/** Called once by the stub, with the files shown before this chunk arrived and the buttons' state. */
export function start(early: string[], state?: typeof can): void {
  can = state;
  // Per window, across reloads: sessionStorage is exactly that scope (and never crosses folders).
  try {
    history.restore(JSON.parse(sessionStorage.getItem(storeKey()) ?? 'null'));
  } catch {}
  const now = performance.now();
  for (const path of early) history.visit({ path }, { now });
  const loc = here();
  if (loc) history.visit(loc, { now, edit: true }); // same file as before the reload: the entry follows, no jump
  addEventListener('pagehide', () => {
    try {
      sessionStorage.setItem(storeKey(), JSON.stringify(history.snapshot()));
    } catch {}
  });

  app.markNavigation = () => void (markedUntil = performance.now() + MARK_MS);
  app.events.on('active:changed', () => record(here()));
  app.events.on('viewer:reveal', (path, t) => t.page && path === app.activePath.value && record({ path, page: t.page }, false, true));
  app.events.on('viewer:page', (path, page) => path === app.activePath.value && record({ path, page }));
  app.events.on('file:renamed', (from, to) => history.rename(from, to));
  app.events.on('workspace:opened', () => (history.clear(), sync()));
  app.files.subscribe(sync); // a deleted file is no place to go (also runs once now)
  void editorReady.then(() => {
    const ed = app.editor;
    if (!ed) return;
    ed.onCursor((edited) => record(here(), edited));
    ed.onScroll((top) => {
      const path = app.activePath.value;
      if (path && !navigating && !isViewer(path)) history.patch(path, { top });
    });
  });
  app.backend.onNavCommand?.((dir) => void go(dir, 'app'));
  (globalThis as { __secEditNav?: unknown }).__secEditNav = { history, go };
}
