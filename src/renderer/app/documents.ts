// Document lifecycle: open/save/close, autosave, external-change reconciliation, session restore.
//
// Event contract (see AppEvents in app.ts): backend fs events are *external* changes only (our own
// writes/renames/deletes never echo), so this module emits file:updated / file:renamed for our own
// operations too — consumers (search, knowledge) see one consistent stream.
import { batch, signal } from '@preact/signals';
import type { FileData, SessionState } from '@shared/api';
import { isMarkdown } from '@shared/paths';
import { app, type DocState, type RevealTarget } from './app';
import { RpcError } from '../platform';
import * as ui from './ui';
import { isImagePath } from './icons';

const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Optional transform before save (e.g. format-on-save), registered by the format module. */
let beforeSave: ((path: string, content: string) => Promise<string>) | null = null;
export function setBeforeSave(fn: typeof beforeSave) {
  beforeSave = fn;
}

// ---- editor readiness (the editor chunk is loaded lazily so the shell paints first) -----------
let resolveEditor: () => void = () => {};
export const editorReady = new Promise<void>((r) => (resolveEditor = r));
export function markEditorReady() {
  resolveEditor();
}

export async function refreshTree() {
  if (!app.workspace.value) return;
  const tree = await app.backend.listTree();
  app.tree.value = tree;
  app.events.emit('tree:changed', tree);
  if (tree.truncated) app.toast('This folder is huge — only the first 200,000 entries are shown. Exclude big folders in Settings.', 'info', 8000);
}

// ---- session --------------------------------------------------------------------------------
let sessionTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRestored = false;

export function sessionSnapshot(): SessionState {
  return {
    openTabs: app.tabs.value.map((t) => t.path),
    activeTab: app.activePath.value,
    sidebarWidth: Math.round(ui.sidebarWidth.value),
    sidebarVisible: app.sidebarVisible.value,
    sidebarPanel: app.sidebarPanel.value,
    overviewVisible: ui.overviewVisible.value,
    overviewWidth: Math.round(ui.overviewWidth.value),
    splitRatio: Math.round(ui.splitRatio.value * 1000) / 1000,
    expanded: [...ui.expanded.value].slice(0, 2000),
    languageOverrides: ui.languageOverrides.value,
  };
}

/** Write a pending (debounced) session save now — used when the page is unloading. */
export function flushSession() {
  if (!sessionTimer) return;
  clearTimeout(sessionTimer);
  sessionTimer = null;
  void app.backend.saveSession(sessionSnapshot()).catch(() => {});
}

export function persistSession() {
  try {
    // Lets index.html's skeleton match the real layout on the next launch.
    localStorage.setItem('sec-edit-layout', JSON.stringify({ w: Math.round(ui.sidebarWidth.value), sb: app.sidebarVisible.value, ov: ui.overviewVisible.value, ow: Math.round(ui.overviewWidth.value) }));
  } catch {}
  if (!app.workspace.value || !sessionRestored) return;
  if (sessionTimer) clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    sessionTimer = null;
    void app.backend.saveSession(sessionSnapshot()).catch(() => {});
  }, 250);
}

function touchMru(path: string) {
  ui.mru.value = [path, ...ui.mru.value.filter((p) => p !== path)];
}

// ---- open -----------------------------------------------------------------------------------
const opening = new Map<string, Promise<DocState | null>>();

async function loadDoc(path: string): Promise<DocState | null> {
  const existing = app.docs.get(path);
  if (existing) return existing;
  if (!opening.has(path)) {
    opening.set(
      path,
      (async () => {
        try {
          const f = await app.backend.readFile(path);
          const doc = docFromFile(path, f);
          app.docs.set(path, doc);
          return doc;
        } catch (err) {
          app.toast(`Cannot open ${path}: ${(err as Error).message}`, 'error');
          return null;
        } finally {
          opening.delete(path);
        }
      })(),
    );
  }
  return opening.get(path)!;
}

function docFromFile(path: string, f: FileData): DocState {
  const doc: DocState = { path, saved: f.content, content: f.content, mtime: f.mtime, eol: f.eol, dirty: signal(false) };
  if (f.bom) doc.bom = true;
  if (f.encoding && f.encoding !== 'utf8') doc.encoding = f.encoding;
  if (f.binary || isImagePath(path)) doc.binary = true;
  return doc;
}

async function openFile(path: string, reveal?: RevealTarget) {
  const doc = await loadDoc(path);
  if (!doc) return;
  if (!app.tabs.value.some((t) => t.path === path)) {
    // New tabs open right of the active one (like every browser / VS Code).
    const tabs = [...app.tabs.value];
    const at = tabs.findIndex((t) => t.path === app.activePath.value);
    tabs.splice(at === -1 ? tabs.length : at + 1, 0, { path });
    app.tabs.value = tabs;
  }
  app.activePath.value = path;
  touchMru(path);
  if (!doc.binary) {
    await editorReady;
    if (app.activePath.value !== path) return; // user moved on while the editor loaded
    app.editor?.open(path, doc.content);
    // Language picked in the status bar for this file (kept in the session).
    const lang = ui.languageOverrides.value[path];
    if (lang) app.editor?.setLanguage?.(path, lang);
  }
  app.events.emit('doc:opened', path);
  app.events.emit('active:changed', path);
  if (reveal && !doc.binary) requestAnimationFrame(() => app.editor?.reveal(reveal));
  persistSession();
}

// ---- save -----------------------------------------------------------------------------------
async function save(path: string, opts: { force?: boolean; auto?: boolean; retry?: number } = {}): Promise<boolean> {
  const doc = app.docs.get(path);
  if (!doc || doc.binary) return false;
  clearTimeout(autosaveTimers.get(path));
  if (opts.auto && (ui.conflicts.value.has(path) || ui.deletedOnDisk.value.has(path))) return false;
  let content = app.editor?.getContent(path) ?? doc.content;
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

async function saveFile(path = app.activePath.value ?? ''): Promise<boolean> {
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

// ---- conflicts (non-blocking: banner in the editor, never a modal) -----------------------------
export function setConflict(path: string, disk: string, mtime: number) {
  const next = new Map(ui.conflicts.value);
  next.set(path, { disk, mtime });
  ui.conflicts.value = next;
}

export function clearConflict(path: string) {
  if (!ui.conflicts.value.has(path)) return;
  const next = new Map(ui.conflicts.value);
  next.delete(path);
  ui.conflicts.value = next;
}

/** Conflict resolution: overwrite disk with the editor version. */
export function keepMine(path: string) {
  return save(path, { force: true });
}

// ---- close ----------------------------------------------------------------------------------
async function confirmUnsaved(paths: string[]): Promise<boolean> {
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

/** Drops a doc + tab without any prompt (file deleted, workspace switch after confirmation). */
export function discardDoc(path: string) {
  clearTimeout(autosaveTimers.get(path));
  app.docs.delete(path);
  app.editor?.close(path);
  clearConflict(path);
  ui.setIn(ui.deletedOnDisk, path, false);
  ui.mru.value = ui.mru.value.filter((p) => p !== path);
  app.events.emit('doc:closed', path);
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

// ---- edits ----------------------------------------------------------------------------------
/** Called by the editor on every change. */
export function noteEdited(path: string, content: string) {
  const doc = app.docs.get(path);
  if (!doc) return;
  doc.content = content;
  doc.dirty.value = content !== doc.saved;
  app.events.emit('doc:changed', path, content);
  if (app.settings.value.autosave && doc.dirty.value && !ui.conflicts.value.has(path) && !ui.deletedOnDisk.value.has(path)) {
    clearTimeout(autosaveTimers.get(path));
    autosaveTimers.set(path, setTimeout(() => void save(path, { auto: true }), Math.max(150, app.settings.value.autosaveDelayMs)));
  }
}

/** Changes a doc's line endings (status bar toggle); saved on the next save. */
export function setDocEol(path: string, eol: 'lf' | 'crlf') {
  const doc = app.docs.get(path);
  if (!doc || doc.eol === eol) return;
  doc.eol = eol;
  doc.saved = `\u0000eol-changed\u0000${doc.saved}`; // forces dirty until saved
  doc.dirty.value = true;
  ui.docMetaVersion.value++;
  if (app.settings.value.autosave) void save(path, { auto: true });
}

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

// ---- external changes -----------------------------------------------------------------------
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

// ---- workspace ------------------------------------------------------------------------------
export async function openWorkspace(absPath: string) {
  const openTabs = app.tabs.value.map((t) => t.path);
  if (!(await confirmUnsaved(openTabs))) return;
  const ws = await app.backend.openWorkspace(absPath);
  sessionRestored = false;
  batch(() => {
    for (const t of openTabs) discardDoc(t);
    app.tabs.value = [];
    app.activePath.value = null;
    ui.mru.value = [];
    ui.expanded.value = new Set();
    ui.treeFilter.value = '';
    ui.treeSelection.value = null;
    ui.languageOverrides.value = {};
    app.workspace.value = ws;
    app.tree.value = null;
  });
  app.events.emit('active:changed', null);
  document.title = `${ws.name} — sec-edit`;
  await refreshTree();
  app.events.emit('workspace:opened', ws);
  await restoreSession(await app.backend.getSession().catch(() => null));
  ui.recentFolders.value = await app.backend.recentWorkspaces().catch(() => ui.recentFolders.value);
}

export function applySessionLayout(s: SessionState | null) {
  if (!s) return;
  batch(() => {
    if (typeof s.sidebarWidth === 'number') ui.sidebarWidth.value = Math.min(640, Math.max(170, s.sidebarWidth));
    if (typeof s.splitRatio === 'number') ui.splitRatio.value = Math.min(0.85, Math.max(0.15, s.splitRatio));
    if (typeof s.sidebarVisible === 'boolean') app.sidebarVisible.value = s.sidebarVisible;
    if (typeof s.overviewWidth === 'number') ui.overviewWidth.value = Math.min(ui.OVERVIEW_MAX, Math.max(ui.OVERVIEW_MIN, s.overviewWidth));
    if (typeof s.overviewVisible === 'boolean') ui.overviewVisible.value = s.overviewVisible;
    if (typeof s.sidebarPanel === 'string' && app.panels.value.some((p) => p.id === s.sidebarPanel)) app.sidebarPanel.value = s.sidebarPanel;
    if (Array.isArray(s.expanded)) ui.expanded.value = new Set(s.expanded.filter((x) => typeof x === 'string'));
    const langs = s.languageOverrides;
    if (langs && typeof langs === 'object') ui.languageOverrides.value = langs as Record<string, string>;
  });
}

export async function restoreSession(s: SessionState | null) {
  applySessionLayout(s);
  if (s) {
    const files = new Set(app.files.value);
    const tabs = s.openTabs.filter((p) => files.has(p));
    app.tabs.value = tabs.map((path) => ({ path }));
    ui.mru.value = s.activeTab && files.has(s.activeTab) ? [s.activeTab, ...tabs.filter((t) => t !== s.activeTab)] : tabs;
    const active = s.activeTab && files.has(s.activeTab) ? s.activeTab : tabs[0];
    if (active) await openFile(active);
  }
  sessionRestored = true;
}

export function installDocuments() {
  app.openFile = openFile;
  app.saveFile = saveFile;
  app.closeTab = closeTab;
  // Every way of showing / hiding the sidebar (shortcut, buttons, sash) is remembered across launches.
  app.sidebarVisible.subscribe(persistSession);
  ui.overviewVisible.subscribe(persistSession);
  // Reconciling external changes is not needed to paint: its code arrives with the first fs event.
  app.backend.onFsEvents(
    (e) =>
      void import('./disk-sync')
        .then((m) => m.handleFsEvents(e))
        .catch((err) => console.error('fs events', err)),
  );
  // A refresh / close within the debounce window must not lose the last tab change or setting:
  // flush now (Electron IPC is delivered after unload; browser mode uses keepalive requests).
  window.addEventListener('pagehide', flushSession); // settings.ts flushes its own pending save the same way
  // Browser mode only: we can't await here, so start the saves and let the browser ask.
  // (Electron closes through onCloseRequest below; a "Don't save" there must stay a don't-save.)
  if (app.backend.kind === 'web') {
    window.addEventListener('beforeunload', (e) => {
      const dirty = [...app.docs.values()].filter((d: DocState) => d.dirty.value);
      if (!dirty.length) return;
      for (const d of dirty) void save(d.path);
      e.preventDefault();
    });
  }
  // Electron: the main process asks before closing so autosaves can finish (or the user can decide).
  app.backend.onCloseRequest?.(async () => {
    // Always answer the main process: if anything here throws, the window must still be closable.
    let ok = true;
    try {
      ok = await confirmUnsaved([...app.docs.keys()]);
      if (sessionTimer) {
        clearTimeout(sessionTimer);
        await app.backend.saveSession(sessionSnapshot()).catch(() => {});
      }
    } catch (err) {
      console.error('close handler failed', err);
      ok = ![...app.docs.values()].some((d) => d.dirty.value); // never silently drop unsaved edits
    } finally {
      app.backend.approveClose?.(ok);
    }
  });
}

export const isMarkdownDoc = (p: string | null) => !!p && isMarkdown(p);
