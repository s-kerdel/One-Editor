// File operations driven by the UI (tree, commands, drag & drop). Each op updates the tree signal
// optimistically-but-after-success, then emits the matching app events (our own ops don't echo).
import { extDisplay, isExtPath } from '@shared/external';
import { basename, dirname, join } from '@shared/paths';
import { app } from './app';
import { RpcError } from '../platform';
import * as ui from './ui';
import { persistSession } from './documents';
import { ancestors, findNode, insertNode } from './tree-model';

// Name rules (validateName, trashName) and tree moves are in ./file-rules: only Popups' actions use them.

export const errText = (err: unknown) => (err instanceof RpcError && err.code === 'EEXIST' ? 'A file or folder with that name already exists' : (err as Error).message);

export function exists(path: string) {
  return !!findNode(app.tree.value, path);
}

export function setTree(fn: (t: NonNullable<typeof app.tree.value>) => NonNullable<typeof app.tree.value>) {
  const t = app.tree.value;
  if (!t) return;
  app.tree.value = fn(t);
  app.events.emit('tree:changed', app.tree.value);
}

export function expandTo(path: string, includeSelf = false) {
  const next = new Set(ui.expanded.value);
  for (const a of ancestors(path)) next.add(a);
  if (includeSelf && path) next.add(path);
  if (next.size !== ui.expanded.value.size) {
    ui.expanded.value = next;
    persistSession();
  }
}

/** Folder new items go into: the selected tree folder regardless of focus (like VS Code), else the active file's folder. */
export function currentFolder(): string {
  const sel = ui.treeSelection.value;
  if (sel !== null) {
    const n = findNode(app.tree.value, sel);
    if (n) return n.kind === 'dir' ? n.path : dirname(n.path);
  }
  if (app.activePath.value) return dirname(app.activePath.value);
  return '';
}

export function uniqueName(dir: string, base: string, ext: string, sep = '-'): string {
  for (let n = 1; n < 10000; n++) {
    const p = join(dir, `${base}${sep}${n}${ext}`);
    if (!exists(p) && !app.docs.has(p)) return p;
  }
  return join(dir, `${base}${sep}${Date.now()}${ext}`);
}

/** Create `untitled-N<ext>`, open it, and put its tree row into rename mode so you can type a name
 *  (the stem is pre-selected). `New note` and the tree's "New file …" picker both land here. */
export async function newFile(dir = currentFolder(), ext = '.md') {
  if (!app.workspace.value) return app.toast('Open a folder first', 'info');
  const path = uniqueName(dir, 'untitled', ext);
  try {
    await app.backend.createFile(path, '');
  } catch (err) {
    return app.toast(`Could not create note: ${errText(err)}`, 'error');
  }
  setTree((t) => insertNode(t, { name: basename(path), path, kind: 'file', mtime: Date.now() }));
  app.events.emit('file:updated', path, '');
  expandTo(path);
  await app.openFile(path);
  if (app.sidebarVisible.value && app.sidebarPanel.value === 'files') {
    ui.treeSelection.value = path;
    ui.renaming.value = path;
  } else app.editor?.focus();
}

/** Mod-n: create untitled-N.md, open it, and put its tree row into rename mode so you can type a title. */
export const newNote = (dir?: string) => newFile(dir);

/** Shows the inline name input in the tree. */
export function startCreate(kind: 'file' | 'dir', parent = currentFolder()) {
  if (!app.workspace.value) return;
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = 'files';
  ui.treeFilter.value = '';
  expandTo(parent, true);
  ui.creating.value = { parent, kind };
}

/** The lazy Popups chunk (dialogs, menus, rare file actions). Startup modules load it through this one
 *  `import()`: each call site repeats the chunk's preload list in the entry chunk (11 sites were ~0.9 kB). */
export const popups = () => import('./Popups');
// Rare, dialog-driven actions live in the lazily loaded ./Popups chunk (kept out of the startup path).
export const deletePaths = (paths: string[]): Promise<void> => popups().then((m) => m.deletePathsNow(paths));
export const duplicate = (path: string): Promise<void> => popups().then((m) => m.duplicateNow(path));
// Committing an inline create / rename and drag-moving files: same chunk (the inline input lives there too).
/** Creates the file/folder typed into the tree's inline input. Returns an error message for the input, or null. */
export const commitCreate = (parent: string, kind: 'file' | 'dir', rawName: string): Promise<string | null> => popups().then((m) => m.commitCreateNow(parent, kind, rawName));
/** Renames `from` to a new name in the same folder. Returns an error message for the inline editor. */
export const renameTo = (from: string, rawName: string): Promise<string | null> => popups().then((m) => m.renameToNow(from, rawName));
export const moveInto = (paths: string[], targetDir: string): Promise<void> => popups().then((m) => m.moveIntoNow(paths, targetDir));

export function revealLabel() {
  return app.backend?.os === 'win32' ? 'Reveal in File Explorer' : app.backend?.os === 'darwin' ? 'Reveal in Finder' : 'Open containing folder';
}

export async function revealInOs(path: string) {
  try {
    await app.backend.revealInFolder(path);
  } catch (err) {
    app.toast(`Cannot reveal: ${(err as Error).message}`, 'error');
  }
}

export function absolutePath(rel: string) {
  if (isExtPath(rel)) {
    const p = extDisplay(rel);
    return app.backend.os === 'win32' ? p.replace(/\//g, '\\') : p;
  }
  const root = app.workspace.value?.root ?? '';
  const sep = app.backend.os === 'win32' || /^[a-z]:\\/i.test(root) ? '\\' : '/';
  return rel ? `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}` : root;
}

export async function copyText(text: string, what = 'Path') {
  try {
    await navigator.clipboard.writeText(text);
    app.toast(`${what} copied`, 'success', 1800);
  } catch {
    app.toast('Clipboard not available', 'error');
  }
}

/** Reveal + highlight a file in the tree (switches to the Files panel). */
export function revealInTree(path: string) {
  app.sidebarVisible.value = true;
  app.sidebarPanel.value = 'files';
  ui.treeFilter.value = '';
  expandTo(path);
  ui.treeSelection.value = path;
}

/** Opens absolute paths handed to the app (CLI args, second instance, drag & drop). Implemented in the lazy Popups chunk. */
export const openAbsolutePaths = (paths: string[]): Promise<void> => popups().then((m) => m.openAbsolutePathsNow(paths));
