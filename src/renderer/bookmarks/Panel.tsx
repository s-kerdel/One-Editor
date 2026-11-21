// Bookmarks panel (sidebar, lazy chunk): files and folders the user pinned, in their order. A file opens on click,
// a folder unfolds as a mini tree drawn like the Files tree (its rows, icons, folder hues and git colours). Drag to
// reorder; drop files, folders or tabs to add; ✕, Delete or the menu remove; F2 names a bookmark (not the file).
import { useEffect, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { TreeNode } from '@shared/api';
import { basename, dirname, isMarkdown, stem } from '@shared/paths';
import type { Bookmark } from '@shared/bookmarks';
import { app } from '../app/app';
import * as ui from '../app/ui';
import { FileIcon, FolderIcon, Icon } from '../app/icons';
import { findNode, flattenTree } from '../app/tree-model';
import { topLevel } from '../app/tree-select';
import { absolutePath, copyText, revealInTree } from '../app/fileops';
import { isMac } from '../app/commands';
import { gitUi } from '../git/install';
import { addBookmarks, bookmarks, isBookmarked, isMissing, labelBookmark, loaded, moveBookmarks, removeBookmarks, toggleBookmarks } from './store';
import './bookmarks.css';

// One chunk for the panel and its store: Popups and the palette load this module for the store's API.
export * from './store';

const TREE_MIME = 'application/x-sec-edit-paths'; // rows dragged from the Files tree (JSON list)
const TAB_MIME = 'application/x-sec-edit-tab'; // a tab (its path)
const BM_MIME = 'application/x-sec-edit-bookmark'; // rows dragged in this panel: { paths, reorder }
/** Shelf's hueOf (a top-level folder's colour), copied: a static import of app/Shelf from a lazy chunk made the
 *  bundler split commands / fileops / settings into extra startup chunks (+2.5 kB gzip, measured). Kept equal by
 *  tests/unit/bookmarks/panel.test.tsx. */
export function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}
/** Rows a folder bookmark shows at most; the rest is one "show in Files" row. */
const MINI_MAX = 300;

/** Bookmarked folders shown open, and folders opened inside them (memory only, like a scroll position). */
const openBm = signal<ReadonlySet<string>>(new Set());
const openDirs = signal<ReadonlySet<string>>(new Set());
/** Keyboard focus: the row's key (top level = its path; inside a folder bookmark = "bookmark\npath"). */
const focusKey = signal<string | null>(null);
/** Drop position while dragging: in front of this bookmark; null = at the end; undefined = no drag over us. */
const dropBefore = signal<string | null | undefined>(undefined);

const flip = (sig: typeof openBm, key: string, on = !sig.value.has(key)) => {
  const next = new Set(sig.value);
  if (on) next.add(key);
  else next.delete(key);
  sig.value = next;
};

interface VRow {
  key: string;
  path: string;
  /** The top-level bookmark this row belongs to. */
  bm: Bookmark;
  top: boolean;
  depth: number;
  node: TreeNode | null;
  dir: boolean;
  open: boolean;
  /** "N more": the folder holds more than MINI_MAX rows. */
  more?: number;
}

const nameOf = (path: string, dir: boolean) => (dir || !isMarkdown(path) ? basename(path) : stem(path));
/** A missing target's kind is unknown: a name without an extension reads as a folder. */
const looksDir = (path: string) => !/\.[^./]+$/.test(basename(path));

function rowsOf(list: Bookmark[], tree: TreeNode | null): VRow[] {
  const out: VRow[] = [];
  for (const bm of list) {
    const node = tree ? findNode(tree, bm.path) : null;
    const dir = node ? node.kind === 'dir' : looksDir(bm.path);
    const open = !!node && dir && openBm.value.has(bm.path);
    out.push({ key: bm.path, path: bm.path, bm, top: true, depth: 0, node, dir, open });
    if (!open) continue;
    const sub = flattenTree(node, openDirs.value);
    for (const r of sub.slice(0, MINI_MAX)) {
      const d = r.node.kind === 'dir';
      out.push({ key: `${bm.path}\n${r.node.path}`, path: r.node.path, bm, top: false, depth: r.depth + 1, node: r.node, dir: d, open: d && r.expanded });
    }
    if (sub.length > MINI_MAX) out.push({ key: `${bm.path}\n…`, path: bm.path, bm, top: false, depth: 1, node, dir: true, open: false, more: sub.length - MINI_MAX });
  }
  return out;
}

function dragText(path: string) {
  // Into a note: a link, like a row dragged from the Files tree.
  return isMarkdown(path) ? `[[${stem(path)}]]` : path;
}

/** What a drop brings: bookmarks moved inside the panel, or paths to add (tree rows, a tab). */
function readDrop(dt: DataTransfer | null): { paths: string[]; reorder: boolean } | null {
  if (!dt) return null;
  try {
    if (dt.types.includes(BM_MIME)) return JSON.parse(dt.getData(BM_MIME));
    if (dt.types.includes(TREE_MIME)) return { paths: topLevel(JSON.parse(dt.getData(TREE_MIME)) as string[]), reorder: false };
    if (dt.types.includes(TAB_MIME)) return { paths: [dt.getData(TAB_MIME)], reorder: false };
  } catch {}
  return null;
}
const accepts = (dt: DataTransfer | null) => !!dt && [BM_MIME, TREE_MIME, TAB_MIME].some((t) => dt.types.includes(t));

function drop(e: DragEvent, before: string | null) {
  const d = readDrop(e.dataTransfer);
  dropBefore.value = undefined;
  if (!d?.paths?.length) return;
  e.preventDefault();
  e.stopPropagation();
  const where = before ?? undefined;
  const fresh = d.paths.filter((p) => !isBookmarked(p));
  // Already bookmarked (a reorder, or a tree row dropped again): they move to the drop place.
  if (d.reorder || !fresh.length) moveBookmarks(d.paths.filter(isBookmarked), where);
  else addBookmarks(fresh, where);
}

/** Files-tree rows or a tab dropped on the Bookmarks pill / icon (shelf, classic, zen strip) are bookmarked; resting
 *  on it while dragging opens the panel (to drop at a place). Delegated from here, so the startup bar has no code
 *  for it; this chunk loads with the idle Popups chunk. */
function installPillDrop() {
  const pill = (e: DragEvent) => (e.target as Element | null)?.closest?.('button[data-panel="bookmarks"]') ?? null;
  const takes = (e: DragEvent) => !!e.dataTransfer && (e.dataTransfer.types.includes(TREE_MIME) || e.dataTransfer.types.includes(TAB_MIME));
  let over: { el: Element; since: number } | null = null;
  const leave = () => {
    over?.el.classList.remove('se-bm-pill-drop');
    over = null;
  };
  document.addEventListener('dragover', (e) => {
    const el = pill(e);
    if (!el || !takes(e)) return leave(); // over anything else (dragleave's relatedTarget is unreliable)
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
    if (over?.el !== el) {
      leave();
      over = { el, since: e.timeStamp };
      el.classList.add('se-bm-pill-drop');
    } else if (e.timeStamp - over.since > 700 && app.sidebarPanel.value !== 'bookmarks') {
      app.sidebarPanel.value = 'bookmarks';
      app.sidebarVisible.value = true;
    }
  });
  document.addEventListener('dragend', leave);
  document.addEventListener('drop', (e) => {
    const el = pill(e);
    leave();
    if (!el || !takes(e)) return;
    const d = readDrop(e.dataTransfer);
    e.preventDefault();
    const fresh = (d?.paths ?? []).filter((p) => !isBookmarked(p));
    if (!fresh.length) return;
    addBookmarks(fresh);
    app.toast(fresh.length === 1 ? `Bookmarked “${basename(fresh[0])}”` : `Bookmarked ${fresh.length} items`, 'success', 2000);
  });
}
installPillDrop();

async function renameBookmark(bm: Bookmark) {
  const name = nameOf(bm.path, findNode(app.tree.value, bm.path)?.kind === 'dir');
  const r = await ui.ask({
    title: 'Rename bookmark',
    message: 'Only the bookmark gets the new name; the file keeps its own. Empty = the file name.',
    input: { value: bm.label ?? name, placeholder: name },
    cancelValue: 'cancel',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Rename', value: 'ok', kind: 'primary' },
    ],
  });
  if (r.value !== 'ok') return;
  const label = (r.input ?? '').trim();
  labelBookmark(bm.path, label === name ? '' : label);
}

function neighbour(path: string, dir: 1 | -1): string | undefined {
  const list = bookmarks.value;
  const i = list.findIndex((b) => b.path === path);
  // Up: in front of the previous one; down: in front of the one after the next (or the end).
  if (dir < 0) return i > 0 ? list[i - 1].path : undefined;
  return i >= 0 && i < list.length - 1 ? (list[i + 2]?.path ?? '') : undefined;
}

function moveBy(path: string, dir: 1 | -1) {
  const before = neighbour(path, dir);
  if (before === undefined) return;
  moveBookmarks([path], before || undefined);
}

function openRow(r: VRow, focusEditor = false) {
  if (r.more) return revealInTree(r.bm.path);
  if (r.dir) return r.top ? flip(openBm, r.path) : flip(openDirs, r.path);
  if (!isMissing(r.path)) void app.openFile(r.path).then(() => focusEditor && app.editor?.focus());
}

function rowMenu(r: VRow): ui.MenuItem[] {
  const missing = r.top && isMissing(r.path);
  const items: ui.MenuItem[] = [];
  if (!missing) items.push(r.dir ? { label: r.open ? 'Collapse' : 'Expand', run: () => openRow(r) } : { label: 'Open', icon: 'file', run: () => openRow(r) });
  if (r.top) {
    const list = bookmarks.value;
    const i = list.findIndex((b) => b.path === r.path);
    items.push(
      { label: 'Rename bookmark…', icon: 'rename', keys: 'F2', run: () => renameBookmark(r.bm) },
      ...(r.bm.label ? [{ label: 'Use the file name', run: () => labelBookmark(r.path, '') }] : []),
      { separator: true },
      { label: 'Move up', keys: 'Alt+↑', disabled: i <= 0, run: () => moveBy(r.path, -1) },
      { label: 'Move down', keys: 'Alt+↓', disabled: i < 0 || i >= list.length - 1, run: () => moveBy(r.path, 1) },
    );
  } else items.push({ label: isBookmarked(r.path) ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', run: () => toggleBookmarks([r.path]) });
  items.push({ separator: true });
  if (!missing) items.push({ label: 'Reveal in Files', icon: 'files', run: () => revealInTree(r.path) });
  items.push({ label: 'Copy path', icon: 'copy', run: () => copyText(absolutePath(r.path)) }, { label: 'Copy relative path', run: () => copyText(r.path, 'Relative path') });
  if (r.top) items.push({ separator: true }, { label: 'Remove bookmark', icon: 'close', keys: 'Del', run: () => removeBookmarks([r.path]) });
  return items;
}

function Row({ r, rows, index }: { r: VRow; rows: VRow[]; index: number }) {
  const classic = app.settings.value.sidebarStyle === 'classic';
  const indent = classic ? 12 : 14;
  const g = gitUi.value; // git colours / marks (lazy chunk; respects git.treeColors)
  const missing = r.top && isMissing(r.path);
  const active = !r.dir && app.activePath.value === r.path;
  const name = r.more ? `${r.more.toLocaleString()} more… show in Files` : r.top && r.bm.label ? r.bm.label : nameOf(r.path, r.dir);
  // Labelled: the real path; else the parent folder, so two "index.md" stay tellable apart.
  const hint = r.top && !r.more ? (r.bm.label ? r.path : dirname(r.path)) : '';
  const nextTop = rows.slice(index + 1).find((x) => x.top);
  const cls = ['se-tree-row', r.dir ? 'dir' : 'file', r.top ? 'se-bm-top' : 'se-bm-sub'];
  if (active) cls.push('active');
  if (missing) cls.push('missing');
  if (r.more) cls.push('se-bm-more');
  if (focusKey.value === r.key) cls.push('focused');
  if (r.top && dropBefore.value === r.path) cls.push('drop-before');
  return (
    <div
      class={`${cls.join(' ')}${g && !missing && !r.more ? g.row(r.path, r.dir) : ''}`}
      style={{ paddingLeft: `${r.depth * indent + (classic ? 6 : 8)}px`, '--hue': String(hueOf(r.path.split('/')[0])) }}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={r.dir && !missing && !r.more ? r.open : undefined}
      aria-selected={focusKey.value === r.key}
      data-bm={r.top ? r.path : undefined}
      data-path={r.top ? undefined : r.path}
      title={missing ? `${r.path}\nNot found: moved or deleted outside One?` : r.path}
      draggable={!r.more}
      onClick={(e) => {
        focusKey.value = r.key;
        (e.currentTarget as HTMLElement).closest<HTMLElement>('.se-bm-list')?.focus({ preventScroll: true });
        openRow(r);
      }}
      onDblClick={() => !r.dir && app.editor?.focus()}
      onContextMenu={(e) => {
        focusKey.value = r.key;
        ui.openContextMenu(e, rowMenu(r));
      }}
      onDragStart={(e) => {
        const dt = e.dataTransfer!;
        dt.setData(BM_MIME, JSON.stringify({ paths: [r.path], reorder: r.top }));
        dt.setData('text/plain', dragText(r.path));
        dt.effectAllowed = 'copyMove';
      }}
      onDragOver={(e) => {
        if (!accepts(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer!.dropEffect = 'move';
        // Upper half of a bookmark: in front of it; anything lower (its folder rows too): in front of the next one.
        const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const before = r.top && e.clientY < box.top + box.height / 2 ? r.path : (nextTop?.path ?? null);
        if (dropBefore.value !== before) dropBefore.value = before;
      }}
      onDrop={(e) => drop(e, dropBefore.value ?? null)}
    >
      {classic && <span class={`se-tree-caret${r.dir && !r.more ? '' : ' none'}`}>{r.dir && !r.more && <Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={14} />}</span>}
      <span class="se-tree-lead">
        {r.more ? null : r.dir ? (
          <>
            <FolderIcon open={r.open} />
            {!classic && !missing && <Icon name={r.open ? 'chevronDown' : 'chevronRight'} size={14} class="se-tree-chev" />}
          </>
        ) : (
          <FileIcon path={r.path} />
        )}
      </span>
      <span class="se-tree-name">{name}</span>
      {hint && <span class="se-bm-hint">{hint}</span>}
      {g && !missing && !r.more && <g.Mark path={r.path} dir={r.dir} />}
      {missing ? (
        <button class="se-btn small se-bm-remove" title="Remove this bookmark" onClick={(e) => (e.stopPropagation(), removeBookmarks([r.path]))}>
          Remove
        </button>
      ) : (
        r.top && (
          <button class="se-icon-btn tiny se-bm-x" aria-label="Remove bookmark" title="Remove bookmark" tabIndex={-1} onClick={(e) => (e.stopPropagation(), removeBookmarks([r.path]))}>
            <Icon name="close" size={12} />
          </button>
        )
      )}
    </div>
  );
}

function Empty() {
  const active = app.activePath.value;
  return (
    <div class="se-bm-empty">
      <Icon name="bookmark" size={22} />
      <p>No bookmarks yet</p>
      <p class="se-bm-empty-hint">Right-click a file, folder or tab and pick Bookmark, or drag them here or onto the Bookmarks icon.</p>
      {active && (
        <button class="se-btn small" onClick={() => addBookmarks([active])}>
          Bookmark current file
        </button>
      )}
    </div>
  );
}

export function BookmarksPanel() {
  const list = useRef<HTMLDivElement>(null);
  const ws = app.workspace.value;
  const rows = rowsOf(bookmarks.value, app.tree.value);
  const active = app.activePath.value;

  const onKeyDown = (e: KeyboardEvent) => {
    const i = rows.findIndex((r) => r.key === focusKey.value);
    const r = rows[i];
    const go = (k: number) => {
      const t = rows[Math.max(0, Math.min(rows.length - 1, k))];
      if (t) focusKey.value = t.key;
    };
    const mod = isMac ? e.metaKey : e.ctrlKey;
    let handled = true;
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && r?.top) moveBy(r.path, e.key === 'ArrowUp' ? -1 : 1);
    else if (e.altKey || mod) handled = false;
    else if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'ArrowRight' && r?.dir) r.open ? go(i + 1) : openRow(r);
    else if (e.key === 'ArrowLeft' && r) {
      if (r.dir && r.open) openRow(r);
      else if (!r.top) focusKey.value = rows.slice(0, i).reverse().find((x) => x.top || (x.dir && x.path === dirname(r.path)))?.key ?? null;
    } else if ((e.key === 'Enter' || e.key === ' ') && r) openRow(r, e.key === 'Enter');
    else if (e.key === 'Delete' && r?.top) {
      go(i + 1 < rows.length ? i + 1 : i - 1);
      removeBookmarks([r.path]);
    } else if (e.key === 'F2' && r?.top) void renameBookmark(r.bm);
    else if (e.key === 'Escape') app.editor?.focus();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // The focused row stays on screen (keyboard moves).
  useEffect(() => {
    list.current?.querySelector('.se-tree-row.focused')?.scrollIntoView({ block: 'nearest' });
  }, [focusKey.value]);

  if (!ws) return <div class="se-bm"><div class="se-bm-empty"><p>Open a folder to use bookmarks.</p></div></div>;
  const last = dropBefore.value === null;
  return (
    <div class="se-bm" data-testid="bookmarks">
      <div class="se-bm-head">
        <span class="se-bm-title">Bookmarks</span>
        <button class="se-icon-btn small" title="Bookmark current file" aria-label="Bookmark current file" disabled={!active || isBookmarked(active)} onClick={() => active && addBookmarks([active])}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <div
        ref={list}
        class={`se-bm-list${last ? ' drop-end' : ''}${dropBefore.value !== undefined ? ' dropping' : ''}`}
        role="tree"
        aria-label="Bookmarks"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() => focusKey.value === null && rows[0] && (focusKey.value = rows[0].key)}
        onDragOver={(e) => {
          if (!accepts(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer!.dropEffect = 'move';
          dropBefore.value = null;
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropBefore.value = undefined;
        }}
        onDrop={(e) => drop(e, null)}
        onDragEnd={() => (dropBefore.value = undefined)}
      >
        {rows.map((r, i) => (
          <Row key={r.key} r={r} rows={rows} index={i} />
        ))}
        {loaded.value && !rows.length && <Empty />}
      </div>
    </div>
  );
}
