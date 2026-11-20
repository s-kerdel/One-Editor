// Go back / Go forward: the recorder and the restore (lazy chunk; ./install is the startup stub).
//
// One central hook instead of a call in every feature: whatever opens a file ends in
// `active:changed`, and whatever moves the cursor ends in the editor's cursor callback. Features whose
// moves those can't classify (a PDF link, a short but deliberate jump) call `app.markNavigation()`.
import { createNavDeduper, type NavDir, type NavSource } from '@shared/nav';
import { app } from '../app/app';
import { editorReady } from '../app/documents';
import { NavHistory, type NavEntry } from './history';

const PDF_RE = /\.pdf$/i;
/** How long a markNavigation() waits for its move (a PDF link resolves its destination asynchronously). */
const MARK_MS = 1000;

export const history = new NavHistory();
const dedupe = createNavDeduper();
/** Restoring an entry: nothing it causes may be recorded. */
let navigating = false;
let markedUntil = 0;
let queue: Promise<unknown> = Promise.resolve();

const isViewer = (path: string) => PDF_RE.test(path) || !!app.docs.get(path)?.binary;

function here(): NavEntry | null {
  const path = app.activePath.value;
  if (!path) return null;
  if (isViewer(path) || !app.editor) return { path };
  const c = app.editor.getCursor();
  return { path, line: c.line, col: c.col };
}

function record(loc: NavEntry | null, edit?: boolean, force?: boolean): void {
  if (navigating || !loc) return;
  const now = performance.now();
  const marked = now < markedUntil;
  if (history.visit(loc, { now, edit, force: force || marked }) && marked) markedUntil = 0;
}

const exists = (path: string) => app.docs.has(path) || app.files.value.includes(path);

async function step(dir: NavDir): Promise<boolean> {
  const d = dir === 'back' ? -1 : 1;
  for (;;) {
    const e = history.step(d, exists);
    if (!e) return false;
    navigating = true;
    try {
      await app.openFile(e.path, PDF_RE.test(e.path) ? { line: 0, page: e.page ?? 1 } : undefined);
      if (app.activePath.value === e.path) {
        if (!isViewer(e.path) && app.editor && e.line !== undefined) {
          app.editor.reveal({ line: e.line, col: e.col });
          if (e.top !== undefined) app.editor.scrollToLine(e.top); // where the reader was looking, not just the cursor
        }
        return true;
      }
    } catch (err) {
      console.warn('[nav]', err);
    } finally {
      navigating = false;
    }
    history.dropCurrent(d); // could not be opened: try the next one
  }
}

/** One step. A second request for the same press (mouse event + Windows app-command) is ignored. */
export function go(dir: NavDir, source: NavSource = 'key'): Promise<boolean> {
  if (!dedupe(dir, source, performance.now())) return Promise.resolve(false);
  const p = queue.then(() => step(dir)); // presses in a row are steps in a row, never interleaved
  queue = p.catch(() => {});
  return p;
}

const storeKey = () => `sec-edit-nav:${app.workspace.value?.root ?? ''}`;

/** Called once by the stub, with the files shown before this chunk arrived. */
export function start(early: string[]): void {
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
  app.events.on('workspace:opened', () => history.clear());
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
