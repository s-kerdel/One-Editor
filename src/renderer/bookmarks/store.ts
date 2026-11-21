// Bookmarks of the open folder: the list, its changes and how it follows renames. Lazy: the idle Popups chunk
// imports it (tree / tab menu items, rename following), so it is loaded long before anyone bookmarks something.
// Storage is the backend's (`app.backend.bookmarks`, One's app data): every change is an op the backend applies
// to the file as it is on disk; the list here changes at once and then takes the backend's answer.
import { computed, signal } from '@preact/signals';
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { findNode } from '../app/tree-model';
import { applyOp, fsMoves, isUnder, type Bookmark, type BookmarkOp } from '@shared/bookmarks';

export const bookmarks = signal<Bookmark[]>([]);
/** The list of the open folder has arrived (until then a rename is sent blind, see renamed()). */
export const loaded = signal(false);
export const bookmarkedPaths = computed(() => new Set(bookmarks.value.map((b) => b.path)));
export const isBookmarked = (path: string) => bookmarkedPaths.value.has(path);
/** The target is gone from the tree (moved or deleted outside One): drawn greyed with "Remove". */
export const isMissing = (path: string) => !!app.tree.value && !findNode(app.tree.value, path);

// Answers can arrive out of order (a reload while a change is in flight): only the newest request's answer counts.
let seq = 0;

let root: string | null = null;

export async function reload(): Promise<void> {
  const n = ++seq;
  const ws = app.workspace.value;
  if ((ws?.root ?? null) !== root) {
    // Another folder: its own list (never the previous folder's for a moment).
    root = ws?.root ?? null;
    bookmarks.value = [];
    loaded.value = false;
  }
  if (!ws) return;
  try {
    const list = await app.backend.bookmarks();
    if (n === seq) bookmarks.value = list;
  } catch (err) {
    console.warn('[bookmarks] could not load', err);
  } finally {
    if (n === seq) loaded.value = true;
  }
}

export function change(op: BookmarkOp): void {
  if (!app.workspace.value) return;
  bookmarks.value = applyOp(bookmarks.value, op);
  const n = ++seq;
  app.backend.bookmarks(op).then(
    (list) => {
      if (n !== seq) return;
      bookmarks.value = list; // the whole list as on disk
      loaded.value = true;
    },
    (err) => {
      app.toast(`Could not save bookmarks: ${(err as Error)?.message ?? err}`, 'error');
      void reload();
    },
  );
}

export const addBookmarks = (paths: string[], before?: string) => paths.length && change({ op: 'add', paths, ...(before ? { before } : {}) });
export const removeBookmarks = (paths: string[]) => paths.length && change({ op: 'remove', paths });
export const moveBookmarks = (paths: string[], before?: string) => paths.length && change({ op: 'move', paths, ...(before ? { before } : {}) });
export const labelBookmark = (path: string, label: string) => change({ op: 'label', path, label });

/** All bookmarked → remove them all; else bookmark the rest. */
export function toggleBookmarks(paths: string[]) {
  if (paths.every(isBookmarked)) removeBookmarks(paths);
  else addBookmarks(paths.filter((p) => !isBookmarked(p)));
}

/** A file or folder was renamed / moved: bookmarks on it or inside it follow. `blind` (one call per move made in
 *  One, Popups' movePath): before the list has arrived the op still goes to the backend, which applies it on disk. */
export function renamed(from: string, to: string, blind = false) {
  if (from === to || (loaded.value ? !bookmarks.value.some((b) => isUnder(b.path, from)) : !blind)) return;
  change({ op: 'rename', from, to });
}

/** Palette commands (app/shell-commands waits for them); the panel's key is in app/shell.ts (startup). */
export function registerBookmarkCommands() {
  const active = () => app.activePath.value;
  registerCommands([
    { id: 'bookmarks.addCurrent', title: 'Bookmarks: Bookmark current file', keywords: ['favorite', 'favourite', 'pin', 'star'], when: () => !!active() && !isBookmarked(active()!), run: () => void addBookmarks([active()!]) },
    { id: 'bookmarks.removeCurrent', title: 'Bookmarks: Remove current file', keywords: ['unbookmark', 'favorite', 'unpin'], when: () => !!active() && isBookmarked(active()!), run: () => void removeBookmarks([active()!]) },
  ]);
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  app.events.on('workspace:opened', () => void reload());
  // Renames made in One emit this per file (Popups' movePath also reports the folder itself).
  app.events.on('file:renamed', (from, to) => renamed(from, to));
  // Outside the app a rename is an unlink + add in one watcher batch: follow the likely moves. (Optional call: a
  // stub backend without watcher events, as in unit tests that load this chunk, must not fail the import.)
  app.backend?.onFsEvents?.((events) => {
    if (!loaded.value || !bookmarks.value.length) return;
    for (const m of fsMoves(
      bookmarks.value.map((b) => b.path),
      events,
    ))
      renamed(m.from, m.to);
  });
  // The other kind of window (desktop ↔ browser mode) may have changed the shared list meanwhile.
  window.addEventListener('focus', () => void (app.workspace.value && reload()));
  void reload();
}
install();
