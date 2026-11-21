// Files panel: virtualized tree (fixed row height → smooth with 50k files), inline create/rename,
// drag & drop moves, context menu, keyboard navigation, filter, auto-reveal of the active file.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { TreeNode } from '@shared/api';
import { dirname, extname, isMarkdown, stem } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { flattenTree, findNode, type Row } from './tree-model';
import { FileIcon, FolderIcon, Icon } from './icons';
import {
  absolutePath,
  commitCreate,
  copyText,
  deletePaths,
  duplicate,
  expandTo,
  moveInto,
  newNote,
  renameTo,
  revealInOs,
  revealLabel,
  startCreate,
} from './fileops';
import { persistSession, refreshTree } from './documents';
import { isMac, runCommand } from './commands';
import { holdKeys, lazyComponent } from './lazy';
import { hueOf } from './Shelf';
import { loadClassic } from './classic-loader';
import { gitUi } from '../git/install';

export const ClassicFilesHead = lazyComponent<{ ws: import('@shared/api').WorkspaceInfo }>(() => loadClassic().then((m) => m.ClassicFilesHead));

// Shelf style: airy 28px rows, no guides, folders carry their notebook colour.
// Classic style (Settings → Appearance → Sidebar style): dense 24px IDE rows with guides and carets.
const classicUi = () => app.settings.value.sidebarStyle === 'classic';
// Keep in sync with --row-h / --row-h-classic in styles/app.css (density: compact / comfortable / spacious).
const ROW_HEIGHTS: Record<string, [number, number]> = { compact: [24, 22], spacious: [32, 28] };
const rowHeight = () => (ROW_HEIGHTS[app.settings.value.uiDensity ?? ''] ?? [28, 24])[classicUi() ? 1 : 0];
const indentWidth = () => (classicUi() ? 12 : 14);
const DRAG_MIME = 'application/x-sec-edit-paths';
const dropTarget = signal<string | null>(null);
/** Paths of the drag that started in this tree: lets a row refuse a folder dropped into itself. */
let dragged: string[] | null = null;
/** Rows as last rendered: selection ranges, Ctrl+A and actions follow what is on screen. */
let shown: Row[] = [];
const order = () => shown.filter((r) => !r.create).map((r) => r.node.path);
/** The selection, top to bottom: what the tree's actions work on. */
const selection = () => order().filter(ui.isTreeSelected);
/** Selection steps are lazy (./tree-select). They run in order and read focus + `order` when they run. */
const step = (fn: (m: typeof import('./tree-select'), order: string[]) => unknown) => void import('./tree-select').then((m) => fn(m, order()));

function toggleDir(path: string, open?: boolean) {
  ui.setIn(ui.expanded, path, open ?? !ui.expanded.value.has(path));
  persistSession();
}

export function collapseAll() {
  ui.expanded.value = new Set();
  persistSession();
}

// Inline rename/create input: lazy (./Popups); keys typed before it has focus are replayed into it.
const InlineNameLazy = lazyComponent<InlineNameProps>(() => import('./Popups').then((m) => m.InlineName));
type InlineNameProps = { initial: string; selectStem: boolean; onCommit: (name: string) => Promise<string | null>; onDone: (committed: boolean) => void };
function InlineName(props: InlineNameProps) {
  useLayoutEffect(() => holdKeys(Promise.resolve()), []);
  return <InlineNameLazy {...props} />;
}

// Menu definitions load with the popups chunk (first right-click / idle), not at launch.
const rowMenu = (node: TreeNode | null, sel?: string[]) => import('./Popups').then((m) => m.rowMenu(node, sel));

function dragText(path: string) {
  // Dropping a tree item into a note inserts a link (the editor's default text drop).
  if (isMarkdown(path)) return `[[${stem(path)}]]`;
  return path;
}

function readDragPaths(dt: DataTransfer | null): string[] | null {
  if (!dt || !dt.types.includes(DRAG_MIME)) return null;
  try {
    return JSON.parse(dt.getData(DRAG_MIME)) as string[];
  } catch {
    return [];
  }
}

function TreeRow({ row, index }: { row: Row; index: number }) {
  const ROW_H = rowHeight();
  const INDENT = indentWidth();
  const classic = classicUi();
  const { node, depth } = row;
  const isDir = node.kind === 'dir';
  const active = !isDir && app.activePath.value === node.path;
  const selected = ui.isTreeSelected(node.path);
  const dirty = !isDir && app.docs.get(node.path)?.dirty.value;
  const g = gitUi.value; // git marks (lazy chunk): nothing until it has loaded
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (row.create) {
    return (
      <div class="se-tree-row creating" style={{ top: `${index * ROW_H}px`, paddingLeft: `${depth * INDENT + (classic ? 22 : 8)}px` }}>
        {row.create === 'dir' ? <FolderIcon open={false} /> : <FileIcon path="new.md" />}
        <InlineName
          initial=""
          selectStem={false}
          onCommit={(name) => commitCreate(dirname(node.path), row.create!, name)}
          onDone={(ok) => {
            if (!ok) ui.creating.value = null;
          }}
        />
      </div>
    );
  }

  const target = isDir ? node.path : dirname(node.path);
  const isDrop = dropTarget.value !== null && dropTarget.value === target;
  return (
    <div
      class={`se-tree-row ${isDir ? 'dir' : 'file'}${active ? ' active' : ''}${selected ? ' selected' : ''}${ui.treeSelection.value === node.path ? ' focused' : ''}${isDrop ? ' drop' : ''}${dirty ? ' dirty' : ''}${g ? g.row(node.path, isDir) : ''}`}
      style={{ top: `${index * ROW_H}px`, paddingLeft: `${depth * INDENT + (classic ? 6 : 8)}px`, '--hue': String(hueOf(node.path.split('/')[0])) }}
      data-path={node.path}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? row.expanded : undefined}
      aria-selected={selected}
      title={node.path}
      draggable={ui.renaming.value !== node.path}
      onClick={(e) => {
        (e.currentTarget as HTMLElement).closest<HTMLElement>('.se-tree')?.focus({ preventScroll: true });
        const mod = isMac ? e.metaKey : e.ctrlKey;
        if (mod || e.shiftKey) return step((m, o) => m.pick(o, node.path, e.shiftKey, mod));
        ui.setTreeSel(null, node.path);
        if (isDir) toggleDir(node.path);
        else void app.openFile(node.path);
      }}
      onDblClick={() => {
        if (!isDir) app.editor?.focus();
      }}
      onContextMenu={(e) => {
        // Inside a multi-selection: its menu; elsewhere the row alone becomes the selection.
        if (!(ui.treeMulti.value && selected)) ui.setTreeSel(null, node.path);
        ui.openContextMenu(e, rowMenu(node, selection()));
      }}
      onDragStart={(e) => {
        // A selected row drags the whole selection.
        dragged = selected ? selection() : [node.path];
        e.dataTransfer!.setData(DRAG_MIME, JSON.stringify(dragged));
        e.dataTransfer!.setData('text/plain', dragged.map(dragText).join('\n'));
        e.dataTransfer!.effectAllowed = 'copyMove';
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
        e.stopPropagation();
        // A dragged folder into itself / its subfolder: refused (no preventDefault), the root zone must not take it either.
        if (dragged?.some((p) => target === p || target.startsWith(p + '/'))) return void (dropTarget.value = null);
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dropTarget.value !== target) dropTarget.value = target;
        if (isDir && !row.expanded && !hoverTimer.current) hoverTimer.current = setTimeout(() => toggleDir(node.path, true), 650);
      }}
      onDragLeave={() => {
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = null;
      }}
      onDrop={(e) => {
        const paths = readDragPaths(e.dataTransfer);
        if (!paths) return;
        e.preventDefault();
        e.stopPropagation();
        dropTarget.value = dragged = null;
        void moveInto(
          paths.filter((p) => target !== p && !target.startsWith(p + '/')),
          target,
        );
      }}
    >
      {classic &&
        Array.from({ length: depth }, (_, i) => <span class="se-tree-guide" style={{ left: `${i * INDENT + 13}px` }} />)}
      {classic && <span class={`se-tree-caret${isDir ? '' : ' none'}`}>{isDir && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={14} />}</span>}
      {/* Shelf: folder icon at rest, disclosure chevron on hover (keeps files and folders aligned). */}
      <span class="se-tree-lead">
        {isDir ? (
          <>
            <FolderIcon open={row.expanded} />
            {!classic && <Icon name={row.expanded ? 'chevronDown' : 'chevronRight'} size={14} class="se-tree-chev" />}
          </>
        ) : (
          <FileIcon path={node.path} />
        )}
      </span>
      {ui.renaming.value === node.path ? (
        <InlineName
          initial={node.name}
          selectStem={!isDir}
          onCommit={(name) => renameTo(node.path, name)}
          onDone={() => {
            ui.renaming.value = null;
            // Mod-n flow: after naming the open note, continue typing in it.
            if (active) app.editor?.focus();
            else document.querySelector<HTMLElement>('.se-tree')?.focus({ preventScroll: true });
          }}
        />
      ) : (
        <span class="se-tree-name">
          {isDir || !isMarkdown(node.name) ? node.name : stem(node.name)}
          {!isDir && isMarkdown(node.name) && <span class="se-tree-ext">{extname(node.name)}</span>}
        </span>
      )}
      {g && <g.Mark path={node.path} dir={isDir} />}
      {isDir && !classic && ui.renaming.value !== node.path && <span class="se-tree-count">{node.children?.length ?? 0}</span>}
      {node.symlink && <span class="se-tree-badge" title="Symbolic link">↪</span>}
      {dirty && <span class="se-tree-dirty" title="Unsaved changes" />}
    </div>
  );
}

function FileTree() {
  const ROW_H = rowHeight();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(800);
  const typeahead = useRef({ text: '', at: 0 });
  const tree = app.tree.value;
  const g = gitUi.value;
  // Git "show changes": a reduced tree with its folders open (memoised by the git chunk).
  const v = tree && g?.view(tree);
  const view = v ? v.tree : tree;
  const open = v ? v.expanded : ui.expanded.value;
  const rows = useMemo(() => flattenTree(view, open, ui.treeFilter.value, ui.creating.value), [view, open, ui.treeFilter.value, ui.creating.value]);
  shown = rows;
  // Refreshes, watcher events, collapse, filter: rows that vanished leave a multi-selection.
  useEffect(() => {
    if (ui.treeMulti.peek()) step((m, o) => m.prune(o));
  }, [rows]);

  const mounted = !!tree;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [mounted]);

  // Auto-reveal the active file: expand its folders and scroll it into view.
  const active = app.activePath.value;
  useEffect(() => {
    if (!active || !findNode(app.tree.value, active)) return;
    expandTo(active);
    if (!document.activeElement?.closest('.se-tree') && !ui.isTreeSelected(active)) ui.treeSelection.value = active;
  }, [active]);

  const sel = ui.treeSelection.value;
  useEffect(() => {
    if (sel === null) return;
    const i = rows.findIndex((r) => r.node.path === sel);
    const el = scroller.current;
    if (i < 0 || !el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top - ROW_H;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top - el.clientHeight + ROW_H * 2;
  }, [sel, rows]);

  // Creating/renaming rows must be on screen for their input to exist.
  useEffect(() => {
    const target = ui.renaming.value ?? (ui.creating.value ? `${ui.creating.value.parent ? ui.creating.value.parent + '/' : ''}\u0000new` : null);
    if (!target) return;
    const i = rows.findIndex((r) => r.node.path === target);
    const el = scroller.current;
    if (i >= 0 && el && (i * ROW_H < el.scrollTop || (i + 1) * ROW_H > el.scrollTop + el.clientHeight)) el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 3);
  }, [ui.renaming.value, ui.creating.value, rows]);

  const count = ui.treeMulti.value?.paths.size ?? 0;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + 8);
  const visible = rows.slice(first, last);

  const onKeyDown = (e: KeyboardEvent) => {
    if (ui.renaming.value || ui.creating.value) return;
    const i = rows.findIndex((r) => r.node.path === ui.treeSelection.value);
    const cur = rows[i]?.node;
    // `to` maps the focused index to the target; Shift extends from the focus as it is when the step runs.
    const select = (to: (k: number) => number) => {
      if (e.shiftKey) return step((m, o) => m.pick(o, o[Math.max(0, Math.min(o.length - 1, to(o.indexOf(ui.treeSelection.value!))))], true, false));
      const r = rows[Math.max(0, Math.min(rows.length - 1, to(i)))];
      if (r && !r.create) ui.treeSelection.value = r.node.path;
    };
    const key = e.key;
    const many = ui.treeMulti.value && selection();
    let handled = true;
    const page = Math.floor(height / ROW_H);
    if (key === 'ArrowDown') select((k) => k + 1);
    else if (key === 'ArrowUp') select((k) => (k < 0 ? 0 : k - 1));
    else if (key === 'Home') select(() => 0);
    else if (key === 'End') select(() => rows.length);
    else if (key === 'PageDown') select((k) => k + page);
    else if (key === 'PageUp') select((k) => k - page);
    else if (key === 'ArrowRight' && cur?.kind === 'dir') {
      if (!rows[i].expanded) toggleDir(cur.path, true);
      else select((k) => k + 1);
    } else if (key === 'ArrowLeft' && cur) {
      if (cur.kind === 'dir' && rows[i].expanded) toggleDir(cur.path, false);
      else if (dirname(cur.path) || cur.path.includes('/')) ui.treeSelection.value = dirname(cur.path);
    } else if (key === 'Enter' && many) step((m) => m.openPaths(many).then(() => app.editor?.focus()));
    else if ((key === 'Enter' || key === ' ') && cur) {
      if (cur.kind === 'dir') toggleDir(cur.path);
      else {
        void app.openFile(cur.path).then(() => key === 'Enter' && app.editor?.focus());
      }
    } else if (key === 'F2' && cur) ui.setTreeSel(null, (ui.renaming.value = cur.path));
    else if ((key === 'Delete' || (key === 'Backspace' && e.metaKey)) && cur) void deletePaths(many || [cur.path]);
    else if (key.toLowerCase() === 'a' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey) step((m, o) => m.selectAll(o));
    else if (key === 'Escape') {
      if (ui.treeMulti.value) ui.treeMulti.value = null; // back to the focused row
      else if (ui.treeFilter.value) ui.treeFilter.value = '';
      else app.editor?.focus();
    } else if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead: jump to the next row starting with the typed prefix.
      const t = typeahead.current;
      t.text = performance.now() - t.at > 700 ? key.toLowerCase() : t.text + key.toLowerCase();
      t.at = performance.now();
      const order = [...rows.slice(i + (t.text.length === 1 ? 1 : 0)), ...rows];
      const hit = order.find((r) => !r.create && r.node.name.toLowerCase().startsWith(t.text));
      if (hit) ui.treeSelection.value = hit.node.path;
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (!tree) return <div class="se-tree-loading" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div class="se-skel-row" style={{ width: `${50 + ((i * 37) % 40)}%` }} />)}</div>;

  return (
    <>
    {g && <g.Banner />}
    <div
      ref={scroller}
      class={`se-tree${count > 1 ? ' multi' : ''}`}
      role="tree"
      aria-label="Files"
      aria-multiselectable="true"
      tabIndex={0}
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLElement).scrollTop)}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => ui.openContextMenu(e, rowMenu(null))}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dropTarget.value = '';
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropTarget.value = null;
      }}
      onDrop={(e) => {
        const paths = readDragPaths(e.dataTransfer);
        dropTarget.value = dragged = null;
        if (!paths) return;
        e.preventDefault();
        void moveInto(paths, '');
      }}
      onDragEnd={() => (dropTarget.value = dragged = null)}
    >
      <div class={`se-tree-inner${dropTarget.value === '' ? ' drop-root' : ''}`} style={{ height: `${Math.max(rows.length * ROW_H, 1)}px` }}>
        {visible.map((r, k) => (
          <TreeRow key={r.node.path} row={r} index={first + k} />
        ))}
      </div>
      {!rows.length && !ui.treeFilter.value && !v && (
        <div class="se-tree-empty">
          <p>This folder is empty.</p>
          <button class="se-btn primary small" onClick={() => newNote('')}>
            <Icon name="filePlus" size={14} /> New note
          </button>
        </div>
      )}
      {!rows.length && ui.treeFilter.value && <div class="se-tree-empty">No files match “{ui.treeFilter.value}”.</div>}
    </div>
    {count > 1 && (
      <div class="se-tree-sel" role="status">
        {count} selected
      </div>
    )}
    </>
  );
}

const filterOpen = signal(false);
const recentOpen = signal(true);

function RecentSection() {
  const files = new Set(app.files.value);
  const items = ui.mru.value.filter((p) => files.has(p)).slice(0, 4);
  if (!items.length || ui.treeFilter.value) return null;
  return (
    <div class="se-shelf-recent">
      <button class="se-section-head se-section-toggle" aria-expanded={recentOpen.value} onClick={() => (recentOpen.value = !recentOpen.value)}>
        <span class="se-section-title">Recent</span>
        <Icon name={recentOpen.value ? 'chevronDown' : 'chevronRight'} size={12} class="se-section-chev" />
      </button>
      {recentOpen.value &&
        items.map((p) => (
          <button class={`se-shelf-recent-row${app.activePath.value === p ? ' active' : ''}`} title={p} onClick={() => void app.openFile(p)}>
            <FileIcon path={p} />
            <span class="se-shelf-recent-name">{isMarkdown(p) ? stem(p) : p.split('/').pop()}</span>
            {dirname(p) && <span class="se-shelf-recent-dir">{dirname(p).split('/').pop()}</span>}
          </button>
        ))}
    </div>
  );
}

function FilterBox() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (filterOpen.value && !ui.treeFilter.value) ref.current?.focus();
  }, []);
  return (
    <div class="se-filter">
      <Icon name="filter" size={13} class="se-filter-icon" />
      <input
        ref={ref}
        class="se-filter-input"
        placeholder="Filter files"
        aria-label="Filter files"
        value={ui.treeFilter.value}
        spellcheck={false}
        onInput={(e) => (ui.treeFilter.value = (e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            ui.treeFilter.value = '';
            filterOpen.value = false;
            ref.current?.blur();
          } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
            e.preventDefault();
            const first = flattenTree(app.tree.value, ui.expanded.value, ui.treeFilter.value).find((r) => r.node.kind === 'file');
            if (first) {
              ui.treeSelection.value = first.node.path;
              if (e.key === 'Enter') void app.openFile(first.node.path);
            }
            document.querySelector<HTMLElement>('.se-tree')?.focus();
          }
        }}
      />
      {ui.treeFilter.value && (
        <button class="se-icon-btn tiny" title="Clear filter" onClick={() => (ui.treeFilter.value = '')}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

export function FilesPanel() {
  const ws = app.workspace.value;
  if (!ws) {
    return (
      <div class="se-files">
        <div class="se-tree-empty">
          <p>No folder open.</p>
          <button class="se-btn primary small" onClick={() => runCommand('workspace.open')}>
            <Icon name="folderOpen" size={14} /> Open folder
          </button>
        </div>
      </div>
    );
  }
  return (
    <div class="se-files">
      {classicUi() ? (
        <>
          <ClassicFilesHead ws={ws} />
          <FilterBox />
          <FileTree />
        </>
      ) : (
        <ShelfFiles />
      )}
    </div>
  );
}

/** Shelf-style Files panel: Recent, then the tree under a quiet "Files" head with a filter toggle. */
function ShelfFiles() {
  return (
    <>
      <RecentSection />
      <div class="se-section-head">
        <span class="se-section-title">Files</span>
        <span class="se-panel-actions">
          <button
            class={`se-icon-btn small${filterOpen.value || ui.treeFilter.value ? ' on' : ''}`}
            title="Filter files"
            aria-label="Show file filter"
            aria-pressed={filterOpen.value}
            onClick={() => {
              filterOpen.value = !filterOpen.value;
              if (!filterOpen.value) ui.treeFilter.value = '';
            }}
          >
            <Icon name="filter" size={14} />
          </button>
          <button class="se-icon-btn small" title="New folder" aria-label="New folder" onClick={() => startCreate('dir')}>
            <Icon name="folderPlus" size={14} />
          </button>
          <button class="se-icon-btn small" title="Collapse all" aria-label="Collapse all" onClick={collapseAll}>
            <Icon name="collapse" size={14} />
          </button>
        </span>
      </div>
      {(filterOpen.value || !!ui.treeFilter.value) && <FilterBox />}
      <FileTree />
    </>
  );
}

