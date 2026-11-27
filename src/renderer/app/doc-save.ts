// Saving and closing (unsaved-changes prompt, conflicts on save): not needed to paint the window.
// Loaded once the app is idle after boot, or by the first save / close (documents.ts keeps the
// same-named entry points as thin wrappers). Moved verbatim from documents.ts.
import { batch } from '@preact/signals';
import { app } from './app';
import { RpcError } from '../platform';
import * as ui from './ui';
import { brandTitle } from '@shared/brand';
import type { WorkspaceInfo } from '@shared/api';
import { autosaveTimers, clearConflict, discardDoc, getBeforeSave, openFile, persistSession, setConflict, suspendSession } from './documents';

// ---- save -----------------------------------------------------------------------------------
export async function save(path: string, opts: { force?: boolean; auto?: boolean; retry?: number } = {}): Promise<boolean> {
  const doc = app.docs.get(path);
  if (!doc || doc.binary) return false;
  clearTimeout(autosaveTimers.get(path));
  if (opts.auto && (ui.conflicts.value.has(path) || ui.deletedOnDisk.value.has(path))) return false;
  let content = app.editor?.getContent(path) ?? doc.content;
  const beforeSave = getBeforeSave();
  if (beforeSave) {
    try {
      const out = await beforeSave(path, content);
      if (out !== content) {
        app.editor?.setContent(path, out);
        content = out;
      }
    } catch (err) {
      console.warn('beforeSave failed', err);
    }
  }
  const force = opts.force || ui.conflicts.value.has(path) || ui.deletedOnDisk.value.has(path);
  ui.setIn(ui.saving, path, true);
  try {
    const { mtime } = await app.backend.writeFile(path, content, {
      expectedMtime: force ? undefined : doc.mtime,
      eol: doc.eol,
      bom: !!doc.bom,
      encoding: doc.encoding ?? 'utf8',
    });
    doc.mtime = mtime;
    doc.saved = content;
    doc.content = app.editor?.getContent(path) ?? content;
    doc.dirty.value = doc.content !== content;
    clearConflict(path);
    ui.setIn(ui.deletedOnDisk, path, false);
    app.events.emit('doc:saved', path, content);
    app.events.emit('file:updated', path, content);
    return true;
  } catch (err) {
    if (err instanceof RpcError && err.code === 'EXTERNAL_CHANGE' && (opts.retry ?? 0) < 2) {
      const disk = await app.backend.readFile(path).catch(() => null);
      // Only the timestamp moved (sync client, `touch`), or disk already has our text: not a conflict.
      if (disk && (disk.content === doc.saved || disk.content === content)) {
        doc.mtime = disk.mtime;
        return save(path, { ...opts, retry: (opts.retry ?? 0) + 1 });
      }
      if (disk) setConflict(path, disk.content, disk.mtime);
      return false;
    }
    const msg = err instanceof RpcError && err.code === 'EACCES' ? `${path} is read-only` : `Save failed: ${(err as Error).message}`;
    app.toast(msg, 'error', 6000);
    return false;
  } finally {
    ui.setIn(ui.saving, path, false);
  }
}

export async function saveFile(path = app.activePath.value ?? ''): Promise<boolean> {
  const hadConflict = ui.conflicts.value.has(path);
  const ok = await save(path);
  if (ok && hadConflict) app.toast(`Overwrote the disk version of ${path}`, 'info');
  return ok;
}

export async function saveAll(): Promise<boolean> {
  const dirty = [...app.docs.values()].filter((d) => d.dirty.value && !d.binary);
  const results = await Promise.all(dirty.map((d) => save(d.path)));
  return results.every(Boolean);
}

export async function confirmUnsaved(paths: string[]): Promise<boolean> {
  const dirty = paths.filter((p) => app.docs.get(p)?.dirty.value);
  if (!dirty.length) return true;
  if (app.settings.value.autosave && dirty.every((p) => !ui.conflicts.value.has(p))) {
    const ok = (await Promise.all(dirty.map((p) => save(p)))).every(Boolean);
    if (ok) return true;
  }
  const r = await ui.ask({
    title: dirty.length === 1 ? `Save changes to ${dirty[0].split('/').pop()}?` : `Save changes to ${dirty.length} files?`,
    message: 'Your changes will be lost if you don’t save them.',
    details: dirty.length > 1 ? dirty : undefined,
    cancelValue: 'cancel',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Don’t save', value: 'discard', kind: 'danger' },
      { label: 'Save', value: 'save', kind: 'primary' },
    ],
  });
  if (r.value === 'cancel') return false;
  if (r.value === 'save') return (await Promise.all(dirty.map((p) => save(p, { force: true })))).every(Boolean);
  return true;
}

export async function closeTabs(paths: string[], opts: { skipConfirm?: boolean } = {}) {
  const list = paths.filter((p) => app.tabs.value.some((t) => t.path === p));
  if (!list.length) return;
  if (!opts.skipConfirm && !(await confirmUnsaved(list))) return;
  const wasActive = app.activePath.value;
  const idx = app.tabs.value.findIndex((t) => t.path === wasActive);
  const closing = new Set(list);
  batch(() => {
    app.tabs.value = app.tabs.value.filter((t) => !closing.has(t.path));
    for (const p of list) discardDoc(p);
  });
  if (wasActive && closing.has(wasActive)) {
    // Like VS Code: fall back to the most recently used remaining tab.
    const remaining = new Set(app.tabs.value.map((t) => t.path));
    const next = ui.mru.value.find((p) => remaining.has(p)) ?? app.tabs.value[Math.min(idx, app.tabs.value.length - 1)]?.path;
    app.activePath.value = null;
    if (next) await openFile(next);
    else app.events.emit('active:changed', null);
  }
  persistSession();
}

async function closeTab(path: string) {
  await closeTabs([path]);
}

// ---- rename / external changes / switching folders (moved from documents.ts) -------------------
/** Moves open docs/tabs after a rename of `from` (a file or a folder) and emits file:renamed per file. */
export function renameDocs(from: string, to: string, filesMoved: string[]) {
  const mapPath = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
  batch(() => {
    for (const p of [...app.docs.keys()]) {
      const q = mapPath(p);
      if (q === p) continue;
      const doc = app.docs.get(p)!;
      app.docs.delete(p);
      doc.path = q;
      app.docs.set(q, doc);
      app.editor?.rename(p, q);
    }
    app.tabs.value = app.tabs.value.map((t) => ({ path: mapPath(t.path) }));
    ui.mru.value = ui.mru.value.map(mapPath);
    ui.expanded.value = new Set([...ui.expanded.value].map(mapPath));
    ui.languageOverrides.value = Object.fromEntries(Object.entries(ui.languageOverrides.value).map(([k, v]) => [mapPath(k), v]));
    if (ui.treeSelection.value) ui.treeSelection.value = mapPath(ui.treeSelection.value);
    const c = new Map<string, { disk: string; mtime: number }>();
    for (const [k, v] of ui.conflicts.value) c.set(mapPath(k), v);
    ui.conflicts.value = c;
    if (app.activePath.value) app.activePath.value = mapPath(app.activePath.value);
  });
  for (const f of filesMoved) app.events.emit('file:renamed', f, mapPath(f));
  app.events.emit('active:changed', app.activePath.value);
  persistSession();
}

/** Smallest single edit turning `a` into `b` (common prefix/suffix). */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  return { from: start, to: a.length - end, insert: b.slice(start, b.length - end) };
}

/** Replace a doc's text from disk, keeping cursor/scroll (minimal edit) when the editor supports it. */
export function replaceFromDisk(path: string, next: string) {
  const ed = app.editor;
  const cur = ed?.getContent(path);
  if (cur === undefined || cur === next) return;
  if (ed?.applyChanges) ed.applyChanges(path, [minimalChange(cur, next)]);
  else ed?.setContent(path, next);
}

/** The page reload after an in-place folder switch (a seam for the unit tests). */
export const pageReload = { run: () => location.reload() };

/** `newWindow` (Shift+click / Shift+Enter): in a new window instead of switching this one. */
export async function openWorkspace(absPath: string, o: { newWindow?: boolean } = {}) {
  // Multiple windows: main decides. A folder another window has open only brings that window up ('focused');
  // Shift opens a new one ('new'); else this window switches ('here'). Every in-app folder open comes through here.
  if (app.backend.openFolderWindow && (await app.backend.openFolderWindow(absPath, o.newWindow ? 'new' : 'here')) !== 'here') return;
  const openTabs = app.tabs.value.map((t) => t.path);
  if (!(await confirmUnsaved(openTabs))) return;
  const resume = await suspendSession();
  let ws: WorkspaceInfo;
  try {
    ws = await app.backend.openWorkspace(absPath);
  } catch (err) {
    resume();
    throw err;
  }
  // A fresh page for the new folder: nothing a note of the old folder ran, or left in memory, carries over, and
  // bootstrap restores the new folder's session the way a launch does (the old page is shown until it paints).
  // Until then nothing of the old folder may land in the new one: no autosave, and no unload-time save
  // (browser mode) of a doc kept unsaved with "Don't save".
  for (const t of autosaveTimers.values()) clearTimeout(t);
  autosaveTimers.clear();
  app.docs.clear();
  document.title = brandTitle(ws.name);
  pageReload.run();
}
