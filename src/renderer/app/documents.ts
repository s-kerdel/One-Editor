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
import { afterBootIdle, lazy } from './lazy';

export const autosaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Optional transform before save (e.g. format-on-save), registered by the format module. */
let beforeSave: ((path: string, content: string) => Promise<string>) | null = null;
export function setBeforeSave(fn: typeof beforeSave) {
  beforeSave = fn;
}
export const getBeforeSave = () => beforeSave;

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
    processesOpen: ui.processesOpen.value,
    processesHeight: Math.round(ui.processesHeight.value),
    splitRatio: Math.round(ui.splitRatio.value * 1000) / 1000,
    expanded: [...ui.expanded.value].slice(0, 2000),
    languageOverrides: ui.languageOverrides.value,
    // Zen: what to restore on leaving (the terminal is memory only: it starts closed anyway).
    zen: zenSaved(ui.zen.value),
  };
}

const zenSaved = (z: ui.ZenSaved | null | undefined): SessionState['zen'] =>
  z && typeof z === 'object' ? { sidebarVisible: !!z.sidebarVisible, sidebarPanel: String(z.sidebarPanel), overviewVisible: !!z.overviewVisible, processesOpen: !!z.processesOpen } : undefined;

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
    localStorage.setItem('sec-edit-layout', JSON.stringify({ w: Math.round(ui.sidebarWidth.value), sb: app.sidebarVisible.value, ov: ui.overviewVisible.value && !ui.zen.value, ow: Math.round(ui.overviewWidth.value), z: ui.zenAttr(app.settings.value['zen.keepStatusBar'] === true) || undefined }));
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
const PDF_RE = /\.pdf$/i;

async function loadDoc(path: string): Promise<DocState | null> {
  const existing = app.docs.get(path);
  if (existing) return existing;
  if (PDF_RE.test(path)) {
    // A PDF is never read as text (it may be 50 MB): its viewer fetches the bytes itself.
    const doc = docFromFile(path, { path, content: '', mtime: 0, eol: 'lf', binary: true });
    app.docs.set(path, doc);
    return doc;
  }
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

export async function openFile(path: string, reveal?: RevealTarget) {
  const doc = await loadDoc(path);
  if (!doc) return;
  if (doc.binary && !doc.asText && reveal) doc.reveal = reveal; // the viewer consumes it (PDF page)
  if (!app.tabs.value.some((t) => t.path === path)) {
    // New tabs open right of the active one (like every browser / VS Code).
    const tabs = [...app.tabs.value];
    const at = tabs.findIndex((t) => t.path === app.activePath.value);
    tabs.splice(at === -1 ? tabs.length : at + 1, 0, { path });
    app.tabs.value = tabs;
  }
  app.activePath.value = path;
  touchMru(path);
  if (!doc.binary || doc.asText) {
    await editorReady;
    if (app.activePath.value !== path) return; // user moved on while the editor loaded
    app.editor?.open(path, doc.content, doc.binary ? { readOnly: true } : undefined); // binary here = shown as text
    // Language picked in the status bar for this file (kept in the session).
    const lang = ui.languageOverrides.value[path];
    if (lang) app.editor?.setLanguage?.(path, lang);
  }
  app.events.emit('doc:opened', path);
  app.events.emit('active:changed', path);
  if (doc.binary && !doc.asText && reveal) app.events.emit('viewer:reveal', path, reveal);
  if (reveal && (!doc.binary || doc.asText)) requestAnimationFrame(() => app.editor?.reveal(reveal));
  persistSession();
}

// ---- save / close: the code is in ./doc-save (loaded once idle after boot, or on first use) ----
type SaveOpts = { force?: boolean; auto?: boolean; retry?: number };
const actions = lazy<typeof import('./doc-save')>(() => import('./doc-save'));
export const save = (path: string, opts?: SaveOpts): Promise<boolean> => actions.load().then((m) => m.save(path, opts));
const saveFile = (path?: string): Promise<boolean> => actions.load().then((m) => m.saveFile(path));
export const saveAll = (): Promise<boolean> => actions.load().then((m) => m.saveAll());
const confirmUnsaved = (paths: string[]): Promise<boolean> => actions.load().then((m) => m.confirmUnsaved(paths));
export const closeTabs = (paths: string[], opts: { skipConfirm?: boolean } = {}): Promise<void> => actions.load().then((m) => m.closeTabs(paths, opts));
const closeTab = (path: string) => closeTabs([path]);

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

// ---- close ----------------------------------------------------------------------------------
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

// ---- edits ----------------------------------------------------------------------------------
/** Called by the editor on every change. */
export function noteEdited(path: string, content: string) {
  const doc = app.docs.get(path);
  // A binary doc shown as text is read only (the editor refuses edits): it never turns dirty, never
  // autosaves, and its text never goes out as doc:changed (the search index keeps it name-only).
  if (!doc || doc.binary) return;
  doc.content = content;
  doc.dirty.value = content !== doc.saved;
  app.events.emit('doc:changed', path, content);
  if (app.settings.value.autosave && doc.dirty.value && !ui.conflicts.value.has(path) && !ui.deletedOnDisk.value.has(path)) {
    clearTimeout(autosaveTimers.get(path));
    autosaveTimers.set(path, setTimeout(() => void save(path, { auto: true }), Math.max(150, app.settings.value.autosaveDelayMs)));
  }
}

// ---- external changes -----------------------------------------------------------------------
// ---- workspace ------------------------------------------------------------------------------
/** Opening another folder (a user action, never the launch): the code is in ./doc-save. */
export const openWorkspace = (absPath: string, o?: { newWindow?: boolean }): Promise<void> => actions.load().then((m) => m.openWorkspace(absPath, o));
/** doc-save's openWorkspace: the next restoreSession() restores the new folder's session. */
export const markSessionUnrestored = () => void (sessionRestored = false);

export function applySessionLayout(s: SessionState | null) {
  if (!s) return;
  batch(() => {
    if (typeof s.sidebarWidth === 'number') ui.sidebarWidth.value = Math.min(640, Math.max(170, s.sidebarWidth));
    if (typeof s.splitRatio === 'number') ui.splitRatio.value = Math.min(0.85, Math.max(0.15, s.splitRatio));
    if (typeof s.sidebarVisible === 'boolean') app.sidebarVisible.value = s.sidebarVisible;
    if (typeof s.overviewWidth === 'number') ui.overviewWidth.value = Math.min(ui.OVERVIEW_MAX, Math.max(ui.OVERVIEW_MIN, s.overviewWidth));
    if (typeof s.overviewVisible === 'boolean') ui.overviewVisible.value = s.overviewVisible;
    if (typeof s.processesHeight === 'number') ui.processesHeight.value = Math.max(120, s.processesHeight);
    if (typeof s.processesOpen === 'boolean') ui.processesOpen.value = s.processesOpen;
    // Not checked against the registered panels: this runs before they exist, and the saved panel must be in the
    // first frame (a hidden one shows in the bar while open). An unknown id draws the first panel (Layout).
    if (typeof s.sidebarPanel === 'string') app.sidebarPanel.value = s.sidebarPanel;
    ui.zen.value = zenSaved(s.zen as ui.ZenSaved | undefined) ?? null;
    // Zen: a shown sidebar / overview is a peek, never restored (also an old zen's kept file tree).
    if (ui.zen.value) app.sidebarVisible.value = ui.overviewVisible.value = false;
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
  afterBootIdle(() => void actions.load().catch(() => {})); // the first Ctrl+S must not wait for a chunk
  app.openFile = openFile;
  app.saveFile = saveFile;
  app.closeTab = closeTab;
  // Every way of showing / hiding the sidebar (shortcut, buttons, sash) is remembered across launches.
  app.sidebarVisible.subscribe(persistSession);
  app.sidebarPanel.subscribe(persistSession); // also when a shortcut / command switches it (a hidden panel too)
  ui.overviewVisible.subscribe(persistSession);
  ui.processesOpen.subscribe(persistSession);
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
