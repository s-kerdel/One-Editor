// Shell-only UI state (kept out of app.ts so the shared singleton stays small and stable).
import { batch, signal } from '@preact/signals';
import type { ComponentType } from 'preact';
import type { Settings } from '@shared/api';
import { isMarkdown } from '@shared/paths';

export const SIDEBAR_DEFAULT = 260;
export const sidebarWidth = signal(SIDEBAR_DEFAULT);
/** File overview column on the right (src/renderer/overview): shown + width, saved with the session. */
export const OVERVIEW_DEFAULT = 280;
export const OVERVIEW_MIN = 220;
export const OVERVIEW_MAX = 560;
export const overviewVisible = signal(false);
export const overviewWidth = signal(OVERVIEW_DEFAULT);
/** Process explorer dock (bottom of the editor card, app/process-explorer): shown + height, in the session. */
export const PROCESSES_DEFAULT = 240;
export const processesOpen = signal(false);
export const processesHeight = signal(PROCESSES_DEFAULT);
/** Set by the explorer's chunk when it loads (keeps its import out of startup code). */
export const processDock = signal<ComponentType | null>(null);
/** Zen mode (app/zen.tsx): null = off; else the layout to restore on leaving. While set, the sidebar and the
 *  file overview are strips; showing one (sidebarVisible / overviewVisible) is a peek over the text. A panel
 *  that opens itself (not on a user action) must not while this is set. */
export interface ZenSaved {
  sidebarVisible: boolean;
  sidebarPanel: string;
  overviewVisible: boolean;
  processesOpen: boolean;
  /** Terminal panel: memory only (terminals don't outlive the window). */
  terminal?: boolean;
}
export const zen = signal<ZenSaved | null>(null);
/** `<html data-zen>` (theme-boot.js → skeleton): 'on', + ' status' when zen keeps the status bar, + ' ov' when
 *  the file overview has its strip (it was open before zen); '' = off. */
export const zenAttr = (keepStatus: boolean) => (zen.value ? `on${keepStatus ? ' status' : ''}${zen.value.overviewVisible ? ' ov' : ''}` : '');
/** Shortcuts shown in the sidebar panel switchers' tooltips (shelf pills, classic icon bar, zen strip). */
export const PANEL_KEYS: Record<string, string> = { search: 'Mod-Shift-f', bookmarks: 'Mod-Alt-k', outline: 'Mod-Alt-o', backlinks: 'Mod-Alt-l', aichanges: 'Mod-Alt-a' };
/** The sidebar menu (shelf pills, classic icon bar, zen strip) from `pref` = setting `sidebar.panels` { order, hidden }
 *  (Settings → Appearance → Sidebar menu). A registered panel the order lacks (new in a later version) goes in right
 *  after its default predecessor, never hidden; ids nobody registers are skipped; `open` (the shown panel) stays
 *  while hidden; at least one entry is left. Pure: the first render already has the final bar. */
export function menuPanels<T extends { id: string }>(panels: T[], pref: any, open?: unknown): T[] {
  // concat: a hand-edited non-list value can never throw here (this draws the first frame).
  const order: unknown[] = [].concat(pref?.order ?? []);
  const hidden: unknown[] = [].concat(pref?.hidden ?? []);
  // Sort key: the stored index; a panel the order lacks gets its default predecessor's key + a hair.
  let k = -1;
  const out = panels
    .map((p) => [p, (k = order.includes(p.id) ? order.indexOf(p.id) : k + 1e-3)] as const)
    .sort((a, b) => a[1] - b[1])
    .map((x) => x[0]);
  const shown = out.filter((p) => p.id === open || !hidden.includes(p.id));
  return shown.length ? shown : out.slice(0, 1);
}
/** Editor share of the split view. */
export const splitRatio = signal(0.5);
/** Expanded folders in the file tree. */
export const expanded = signal<Set<string>>(new Set());
export const treeFilter = signal('');
/** Keyboard-focused row in the tree (distinct from the active editor file). Alone it is the selection. */
export const treeSelection = signal<string | null>(null);
/** Several rows selected (Ctrl / Shift + click or arrows; the steps are the lazy app/tree-select.ts). Belongs to its `focus`:
 *  anything that moves treeSelection elsewhere (arrows, reveal, new note) drops it. The focus may be unselected. */
export interface TreeSel {
  focus: string;
  anchor: string;
  paths: ReadonlySet<string>;
}
export const treeMulti = signal<TreeSel | null>(null);
treeSelection.subscribe((f) => {
  if (treeMulti.peek() && treeMulti.peek()!.focus !== f) treeMulti.value = null;
});
export const isTreeSelected = (p: string) => (treeMulti.value ? treeMulti.value.paths.has(p) : treeSelection.value === p);
export const setTreeSel = (s: TreeSel | null, focus = s?.focus ?? null) =>
  batch(() => {
    treeMulti.value = s;
    treeSelection.value = focus;
  });
/** Path currently being renamed inline in the tree. */
export const renaming = signal<string | null>(null);
/** Inline "new file / new folder" input. */
export const creating = signal<{ parent: string; kind: 'file' | 'dir' } | null>(null);
/** Most-recently-used tab order (front = current). */
export const mru = signal<string[]>([]);
/** Ctrl-Tab switcher state while Ctrl is held. */
export const tabSwitcher = signal<{ index: number; list: string[] } | null>(null);
/** Docs whose file changed on disk while they had unsaved edits. */
export const conflicts = signal<Map<string, { disk: string; mtime: number }>>(new Map());
/** Open docs whose file was deleted on disk. */
export const deletedOnDisk = signal<Set<string>>(new Set());
export const saving = signal<Set<string>>(new Set());
/** OS files dragged over the window. */
export const dropActive = signal(false);
/** Last edit mode, so Mod-e can return to it from preview. */
export const lastEditMode = signal<Exclude<Settings['viewMode'], 'preview'>>('live');
/** Recent folders (welcome screen). */
export const recentFolders = signal<string[]>([]);
/** Mirrors editor cursor/selection for the status bar. */
export const cursorInfo = signal<{ line: number; col: number; selectionLength: number } | null>(null);
/** Bumped whenever a doc's metadata (eol, encoding) changes. */
export const docMetaVersion = signal(0);
/** Per-file language overrides picked in the status bar (path → languages.ts id); saved with the session. */
export const languageOverrides = signal<Record<string, string>>({});
/** Bumped when a doc's language changes (status bar label). */
export const languageVersion = signal(0);
/** A .md file shown as Markdown (not switched to another language via the status bar). */
export const isMarkdownView = (path: string | null | undefined) => !!path && isMarkdown(path) && (languageOverrides.value[path] ?? 'markdown') === 'markdown';

export function setIn<T>(sig: { value: Set<T> }, item: T, on: boolean) {
  const has = sig.value.has(item);
  if (has === on) return;
  const next = new Set(sig.value);
  if (on) next.add(item);
  else next.delete(item);
  sig.value = next;
}

// ---- dialogs (non-blocking replacements for confirm()/prompt()) ------------------------------

export interface DialogButton {
  label: string;
  value: string;
  kind?: 'primary' | 'danger' | 'default';
}

export interface DialogSpec {
  title: string;
  message?: string;
  buttons: DialogButton[];
  /** Show a text input; its value is returned as `input`. */
  input?: { value: string; placeholder?: string; select?: [number, number] };
  /** Pressing Esc / clicking outside resolves with this value. */
  cancelValue?: string;
  details?: string[];
}

export interface DialogResult {
  value: string;
  input?: string;
}

export const dialog = signal<(DialogSpec & { resolve: (r: DialogResult) => void }) | null>(null);

export function ask(spec: DialogSpec): Promise<DialogResult> {
  // A new dialog cancels the previous one rather than stacking.
  dialog.value?.resolve({ value: dialog.value.cancelValue ?? 'cancel' });
  return new Promise((resolve) => {
    dialog.value = {
      ...spec,
      resolve: (r) => {
        dialog.value = null;
        resolve(r);
      },
    };
  });
}

export async function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  const r = await ask({
    title,
    message,
    cancelValue: 'cancel',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: okLabel, value: 'ok', kind: danger ? 'danger' : 'primary' },
    ],
  });
  return r.value === 'ok';
}

export async function promptDialog(title: string, value = '', placeholder = '', okLabel = 'OK'): Promise<string | null> {
  const r = await ask({ title, input: { value, placeholder }, cancelValue: 'cancel', buttons: [{ label: 'Cancel', value: 'cancel' }, { label: okLabel, value: 'ok', kind: 'primary' }] });
  return r.value === 'ok' ? (r.input ?? '').trim() || null : null;
}

// ---- context menu ---------------------------------------------------------------------------

export interface MenuItem {
  label?: string;
  icon?: string;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => unknown;
}

export const contextMenu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);

/** `items` may be a promise: menu definitions live in a lazily loaded chunk (./Popups). */
export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }, items: MenuItem[] | Promise<MenuItem[]>) {
  e.preventDefault();
  e.stopPropagation();
  const { clientX: x, clientY: y } = e;
  if (Array.isArray(items)) contextMenu.value = { x, y, items };
  else void items.then((list) => (contextMenu.value = { x, y, items: list }));
}

// ---- picker (searchable list: language mode, content width) -----------------------------------

export interface PickerItem {
  label: string;
  detail?: string;
  checked?: boolean;
  /** Draw a rule above this item (hidden while filtering). */
  separator?: boolean;
  run: () => unknown;
}

export interface PickerSpec {
  /** Accessible name + input placeholder. */
  title: string;
  items: PickerItem[];
  /** Element the popover hangs off (e.g. a status bar item); centred like the palette without one. */
  anchor?: Element | null;
}

export const picker = signal<PickerSpec | null>(null);

/** Background work running now, shown in the status bar ("Indexing 4,210 / 18,000"); see activity.ts. */
export const activityNow = signal<string | null>(null);
