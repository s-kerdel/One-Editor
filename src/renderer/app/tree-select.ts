// File tree multi-selection and keyboard: pure steps + the few writes the tree makes with them. Lazy (FileTree
// imports it on the tree's focus and the first Ctrl / Shift click; the idle Popups chunk carries it too), so launch
// pays only for drawing. State is `ui.treeMulti` (set + anchor + focus) next to `ui.treeSelection` (the focused
// row); `order` is the visible row paths, top to bottom.
import { batch } from '@preact/signals';
import { dirname } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { ancestors, findNode, type Row } from './tree-model';
import { deletePaths } from './fileops';
import { isMac } from './commands';

type Sel = ui.TreeSel;

/** Ctrl / Cmd + click: flip one row; it becomes focus and anchor. */
export function toggleSel(s: Sel, p: string): Sel {
  const paths = new Set(s.paths);
  if (!paths.delete(p)) paths.add(p);
  return { focus: p, anchor: p, paths };
}

/** Shift + click / arrows: anchor … p in row order (the anchor stays); `add` keeps the rest (Ctrl + Shift). */
export function rangeSel(order: readonly string[], s: Sel, p: string, add = false): Sel {
  const b = order.indexOf(p);
  if (b < 0) return s;
  let a = order.indexOf(s.anchor);
  if (a < 0) a = b; // the anchor row is gone: start over here
  const paths = new Set(add ? s.paths : []);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) paths.add(order[i]);
  return { focus: p, anchor: order[a], paths };
}

/** Rows that vanished (deleted, moved, collapsed, filtered out) leave the selection; null when none is left. */
export function pruneSel(order: readonly string[], s: Sel): Sel | null {
  const shown = new Set(order);
  const paths = new Set([...s.paths].filter((p) => shown.has(p)));
  const focus = shown.has(s.focus) ? s.focus : [...paths].pop();
  return focus === undefined ? null : { focus, anchor: shown.has(s.anchor) ? s.anchor : focus, paths };
}

/** Drops paths inside another listed folder: acting on the folder covers them. */
export function topLevel(paths: readonly string[]): string[] {
  const all = new Set(paths);
  return paths.filter((p) => !ancestors(p).some((a) => all.has(a)));
}

/** The selection to extend: the multi one, else the focused row alone (when it is still shown). */
function current(order: readonly string[]): Sel {
  const f = ui.treeSelection.value ?? '';
  return ui.treeMulti.value ?? { focus: f, anchor: f, paths: new Set(order.includes(f) ? [f] : []) };
}

/** Ctrl + click (toggle), Shift + click / arrows (range), Ctrl + Shift + click (add a range). */
export function pick(order: readonly string[], p: string, range: boolean, add: boolean) {
  const s = current(order);
  ui.setTreeSel(range ? rangeSel(order, s, p, add) : toggleSel(s, p));
}

/** Ctrl + A in the tree: every visible row; the focus stays. */
export function selectAll(order: readonly string[]) {
  const f = ui.treeSelection.value;
  const focus = f !== null && order.includes(f) ? f : order[0];
  if (focus !== undefined) ui.setTreeSel({ focus, anchor: focus, paths: new Set(order) });
}

/** More tabs than this from one action is a mistake more often than a wish. */
export const OPEN_MAX = 20;

/** Opens the files among `paths` as tabs (folders are skipped); the first one is shown. */
export async function openPaths(paths: readonly string[]) {
  const files = paths.filter((p) => findNode(app.tree.value, p)?.kind === 'file');
  const pick = files.slice(0, OPEN_MAX);
  if (!pick.length) return;
  // Tabs without a read, like a restored session: only the shown one loads now.
  const have = new Set(app.tabs.value.map((t) => t.path));
  const add = pick.filter((p) => !have.has(p));
  const tabs = [...app.tabs.value];
  const at = tabs.findIndex((t) => t.path === app.activePath.value);
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, ...add.map((path) => ({ path })));
  batch(() => {
    app.tabs.value = tabs;
    ui.mru.value = [...ui.mru.value, ...add]; // Ctrl+Tab reaches them
  });
  await app.openFile(pick[0]);
  if (files.length > pick.length) app.toast(`Opened ${pick.length} of ${files.length} files (at most ${OPEN_MAX} at once)`, 'info');
}

/** After the rows changed: writes only when something actually left. */
export function prune(order: readonly string[]) {
  const m = ui.treeMulti.value;
  if (!m) return;
  const n = pruneSel(order, m);
  if (!n || n.paths.size !== m.paths.size || n.focus !== m.focus) ui.setTreeSel(n, n?.focus ?? ui.treeSelection.value);
}

/** The tree as FileTree last rendered it: rows (inline-create row included), rows per page, its folder toggle. */
export interface TreeView {
  rows: readonly Row[];
  page: number;
  toggle(path: string, open?: boolean): void;
}

/** Type-ahead: the prefix typed so far and when its last key came (one tree on screen at a time). */
const typeahead = { text: '', at: 0 };

/** The file tree's keys (FileTree's onKeyDown once this chunk is in). True when the key was the tree's. */
export function treeKey(e: KeyboardEvent, { rows, page, toggle }: TreeView): boolean {
  const order = rows.filter((r) => !r.create).map((r) => r.node.path);
  const i = rows.findIndex((r) => r.node.path === ui.treeSelection.value);
  const cur = rows[i]?.node;
  // `to` maps the focused index to the target; Shift extends from the focus.
  const select = (to: (k: number) => number) => {
    if (e.shiftKey) return pick(order, order[Math.max(0, Math.min(order.length - 1, to(order.indexOf(ui.treeSelection.value!))))], true, false);
    const r = rows[Math.max(0, Math.min(rows.length - 1, to(i)))];
    if (r && !r.create) ui.treeSelection.value = r.node.path;
  };
  const key = e.key;
  const many = ui.treeMulti.value && order.filter(ui.isTreeSelected);
  if (key === 'ArrowDown') select((k) => k + 1);
  else if (key === 'ArrowUp') select((k) => (k < 0 ? 0 : k - 1));
  else if (key === 'Home') select(() => 0);
  else if (key === 'End') select(() => rows.length);
  else if (key === 'PageDown') select((k) => k + page);
  else if (key === 'PageUp') select((k) => k - page);
  else if (key === 'ArrowRight' && cur?.kind === 'dir') {
    if (!rows[i].expanded) toggle(cur.path, true);
    else select((k) => k + 1);
  } else if (key === 'ArrowLeft' && cur) {
    if (cur.kind === 'dir' && rows[i].expanded) toggle(cur.path, false);
    else if (dirname(cur.path) || cur.path.includes('/')) ui.treeSelection.value = dirname(cur.path);
  } else if (key === 'Enter' && many) void openPaths(many).then(() => app.editor?.focus());
  else if ((key === 'Enter' || key === ' ') && cur) {
    if (cur.kind === 'dir') toggle(cur.path);
    else void app.openFile(cur.path).then(() => key === 'Enter' && app.editor?.focus());
  } else if (key === 'F2' && cur) ui.setTreeSel(null, (ui.renaming.value = cur.path));
  else if ((key === 'Delete' || (key === 'Backspace' && e.metaKey)) && cur) void deletePaths(many || [cur.path]);
  else if (key.toLowerCase() === 'a' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey) selectAll(order);
  else if (key === 'Escape') {
    if (ui.treeMulti.value) ui.treeMulti.value = null; // back to the focused row
    else if (ui.treeFilter.value) ui.treeFilter.value = '';
    else app.editor?.focus();
  } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Type-ahead: jump to the next row starting with the typed prefix.
    const t = typeahead;
    t.text = performance.now() - t.at > 700 ? key.toLowerCase() : t.text + key.toLowerCase();
    t.at = performance.now();
    const next = [...rows.slice(i + (t.text.length === 1 ? 1 : 0)), ...rows];
    const hit = next.find((r) => !r.create && r.node.name.toLowerCase().startsWith(t.text));
    if (hit) ui.treeSelection.value = hit.node.path;
  } else return false;
  return true;
}
