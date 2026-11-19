// Dialogs, context menus, Ctrl-Tab switcher, OS drag & drop target, toasts. All of these only appear
// after something happened, so the chunk loads on idle / first use, not at launch (Layout keeps the
// toasts' empty aria-live container in the first frame, so screen readers still announce them).
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { basename, dirname } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import type { TreeNode } from '@shared/api';
import { addIcons, FileIcon, Icon } from './icons';
import { prettyKey } from './commands';
import { closeTabs, openWorkspace, persistSession, refreshTree } from './documents';
import { runCommand } from './commands';
import { updateSettings, currentWidth, WIDTHS } from './settings';
import { LANGUAGES } from '@shared/languages';

// Icons only this lazily loaded chunk draws (see addIcons).
addIcons({ history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5|M12 7v5l4 2', trash: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6', rename: 'M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z', reveal: 'M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', exportPdf: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z|M14 3v5h5|M12 11v6|m9 14 3 3 3-3', arrowUp: 'M12 19V5|m5 12 7-7 7 7' });
import { absolutePath, copyText, deletePaths, duplicate, errText, exists, expandTo, newNote, revealInOs, revealInTree, revealLabel, setTree, trashName, startCreate, validateName } from './fileops';
import { RpcError } from '../platform';
import { extname, join, stem } from '@shared/paths';
import { filesUnder, findNode, insertNode, moveNode, removeNode } from './tree-model';
import { discardDoc, renameDocs } from './documents';
import { batch } from '@preact/signals';
import { collapseAll } from './FileTree';
import { closeAll } from './Tabs';
import { gitUi } from '../git/install';

import { installSettingsSync } from './settings-sync';

// Settings written by another sec-edit process (desktop ↔ browser mode) apply live: wired here, not at startup.
installSettingsSync();

// Desktop "Start web server" (palette commands, status-bar pill): its chunk follows this idle-loaded one,
// so the startup bundle carries none of it. The browser build has no bridge and never fetches it.
if ((globalThis as { secEditBridge?: { webServer?: unknown } }).secEditBridge?.webServer)
  void import('../webserver/web-server-ui').then(
    (m) => m.install(),
    (err) => console.warn('[webserver] failed to load', err),
  );

// ---- file actions behind a dialog / menu ----

export async function deletePathsNow(paths: string[]) {
  if (!paths.length) return;
  const label = paths.length === 1 ? `“${basename(paths[0])}”` : `${paths.length} items`;
  if (app.settings.value.confirmDelete !== false) {
    const isDir = paths.length === 1 && findNode(app.tree.value, paths[0])?.kind === 'dir';
    const ok = await ui.confirmDialog(`Delete ${label}?`, `${isDir ? 'The folder and everything in it' : 'It'} will be moved to the ${trashName()}.`, `Move to ${trashName()}`, true);
    if (!ok) return;
  }
  for (const p of paths) {
    const node = findNode(app.tree.value, p);
    const files = node?.kind === 'dir' ? filesUnder(node) : [p];
    try {
      await app.backend.remove(p);
    } catch (err) {
      if (err instanceof RpcError && err.code === 'ETRASH') {
        const really = await ui.confirmDialog(`The ${trashName()} is not available`, `Delete “${basename(p)}” permanently? This cannot be undone.`, 'Delete permanently', true);
        if (!really) continue;
        try {
          await app.backend.remove(p, { permanent: true });
        } catch (e2) {
          app.toast(`Delete failed: ${errText(e2)}`, 'error');
          continue;
        }
      } else {
        // Not there (any more): a stale row must not linger, but an open tab keeps its unsaved text.
        if (err instanceof RpcError && err.code === 'ENOENT') setTree((t) => removeNode(t, p));
        app.toast(`Delete failed: ${errText(err)}`, 'error');
        continue;
      }
    }
    const open = app.tabs.value.map((t) => t.path).filter((t) => files.includes(t));
    await closeTabs(open, { skipConfirm: true });
    for (const f of files) if (app.docs.has(f)) discardDoc(f);
    dropLanguageOverrides(files);
    setTree((t) => removeNode(t, p));
    for (const f of files) app.events.emit('file:updated', f, undefined);
  }
}

export async function duplicateNow(path: string) {
  try {
    const f = await app.backend.readFile(path);
    if (f.binary) return void app.toast('Duplicating binary files is not supported', 'info');
    const ext = extname(path);
    let target = join(dirname(path), `${stem(path)} copy${ext}`);
    for (let n = 2; exists(target); n++) target = join(dirname(path), `${stem(path)} copy ${n}${ext}`);
    await app.backend.createFile(target, f.content);
    setTree((t) => insertNode(t, { name: basename(target), path: target, kind: 'file' }));
    app.events.emit('file:updated', target, f.content);
    await app.openFile(target);
  } catch (err) {
    app.toast(`Duplicate failed: ${errText(err)}`, 'error');
  }
}

// ---- create / rename / move (committed from the tree's inline input or a drag) ----

/** "Note.md" and "note.md" are one file in this folder: the backend probes each folder (a WSL root on
 *  Windows tells them apart, NTFS does not), never the OS. */
export const foldsCase = () => app.workspace.value?.caseSensitive === false;

/** On a case-insensitive folder: the tree's sibling that `path` would silently hit ("Note.md" for "note.md"). */
export function caseTwin(path: string): string | null {
  if (!foldsCase()) return null;
  const name = basename(path);
  const l = name.toLowerCase();
  return findNode(app.tree.value, dirname(path))?.children?.find((c) => c.name !== name && c.name.toLowerCase() === l)?.path ?? null;
}

const caseTwinText = (twin: string) => `“${basename(twin)}” already exists — names that differ only in case are the same file in this folder`;

export async function commitCreateNow(parent: string, kind: 'file' | 'dir', rawName: string): Promise<string | null> {
  let name = rawName.trim();
  const invalid = validateName(name);
  if (invalid) return invalid;
  if (kind === 'file' && !extname(name)) name += '.md'; // notes app: bare names are notes
  const path = join(parent, name);
  if (exists(path)) return 'A file or folder with that name already exists';
  const twin = caseTwin(path);
  if (twin) return caseTwinText(twin);
  try {
    if (kind === 'dir') await app.backend.createDir(path);
    else await app.backend.createFile(path, '');
  } catch (err) {
    return errText(err);
  }
  ui.creating.value = null;
  setTree((t) => insertNode(t, kind === 'dir' ? { name, path, kind: 'dir', children: [] } : { name, path, kind: 'file', mtime: Date.now() }));
  ui.treeSelection.value = path;
  if (kind === 'file') {
    app.events.emit('file:updated', path, '');
    await app.openFile(path);
    app.editor?.focus();
  } else expandTo(path, true);
  return null;
}

/** Renames `from` to a new name in the same folder. Returns an error message for the inline editor. */
export async function renameToNow(from: string, rawName: string): Promise<string | null> {
  let name = rawName.trim();
  if (name === basename(from)) return null;
  const invalid = validateName(name);
  if (invalid) return invalid;
  const node = findNode(app.tree.value, from);
  if (node?.kind === 'file' && extname(from) === '.md' && !extname(name)) name += '.md';
  return movePath(from, join(dirname(from), name));
}

async function movePath(from: string, to: string): Promise<string | null> {
  if (from === to) return null;
  if (to.startsWith(from + '/')) return 'Cannot move a folder into itself';
  // Case-only renames only exist where the folder folds case; elsewhere "A.md" is another file.
  const caseOnly = foldsCase() && from.toLowerCase() === to.toLowerCase();
  if (!caseOnly && exists(to)) return 'A file or folder with that name already exists';
  const twin = caseTwin(to);
  if (twin && twin !== from) return caseTwinText(twin);
  const node = findNode(app.tree.value, from);
  const files = node?.kind === 'dir' ? filesUnder(node) : [from];
  try {
    await app.backend.rename(from, to);
  } catch (err) {
    return errText(err);
  }
  batch(() => {
    setTree((t) => moveNode(t, from, to));
    renameDocs(from, to, files);
  });
  return null;
}

export async function moveIntoNow(paths: string[], targetDir: string) {
  for (const p of paths) {
    if (dirname(p) === targetDir) continue;
    const err = await movePath(p, join(targetDir, basename(p)));
    if (err) app.toast(`Move ${basename(p)}: ${err}`, 'error');
    else expandTo(join(targetDir, basename(p)));
  }
}

// ---- paths handed to the app ----

function parentOfAbs(abs: string) {
  const m = abs.replace(/[\\/]+$/, '');
  const i = Math.max(m.lastIndexOf('/'), m.lastIndexOf('\\'));
  if (i < 0) return m;
  const p = m.slice(0, i);
  if (/^[a-z]:$/i.test(p)) return p + '\\';
  return p || '/';
}

/** Opens absolute paths handed to the app (CLI args, second instance, drag & drop). */
export async function openAbsolutePathsNow(paths: string[]) {
  for (const abs of paths) {
    let r = await app.backend.resolvePath(abs).catch(() => null);
    if (!r) {
      app.toast(`Not found: ${abs}`, 'error');
      continue;
    }
    if (r.kind === 'dir') {
      if (r.rel !== '') await openWorkspace(r.abs);
      continue;
    }
    if (r.rel === null) {
      await openWorkspace(parentOfAbs(r.abs));
      r = await app.backend.resolvePath(abs).catch(() => null);
      if (!r?.rel) continue;
    }
    // Hidden/excluded files (e.g. .env) are still openable, just not listed in the tree.
    await app.openFile(r.rel);
    revealInTree(r.rel);
  }
}

// ---- inline rename / create input (file tree) ----

export function InlineName({ initial, selectStem, onCommit, onDone }: { initial: string; selectStem: boolean; onCommit: (name: string) => Promise<string | null>; onDone: (committed: boolean) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const finished = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = selectStem ? initial.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, []);
  const finish = (committed: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(committed);
  };
  const commit = async (fromBlur = false) => {
    if (busy.current || finished.current) return;
    const v = ref.current!.value;
    if (!v.trim() || v === initial) return finish(false);
    busy.current = true;
    const err = await onCommit(v);
    busy.current = false;
    if (!err) return finish(true);
    if (fromBlur) {
      app.toast(err, 'error');
      return finish(false);
    }
    setError(err);
    ref.current?.focus();
  };
  return (
    <span class="se-tree-edit">
      <input
        ref={ref}
        class={`se-tree-input${error ? ' invalid' : ''}`}
        defaultValue={initial}
        spellcheck={false}
        aria-label="Name"
        aria-invalid={!!error}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onInput={() => error && setError(null)}
        onBlur={() => void commit(true)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
      {error && <span class="se-tree-error" role="alert">{error}</span>}
    </span>
  );
}

// ---- context menu definitions (file tree rows, tabs) ----

/** "Export to PDF…" for a Markdown file (also when it is not the active tab). */
function pdfItems(path: string): ui.MenuItem[] {
  if (!/\.(md|markdown|mdx)$/i.test(path)) return [];
  const run = () =>
    import('../preview/pdf')
      .then((m) => m.exportPdf(path))
      .catch((err) => app.toast(`PDF export failed: ${(err as Error)?.message ?? err}`, 'error'));
  return [{ separator: true }, { label: 'Export to PDF…', icon: 'exportPdf', run }];
}

/** Switch the workspace to another folder on disk (absolute path). */
function openAsProject(abs: string) {
  return openWorkspace(abs).catch((err) => app.toast(String(err?.message || err), 'error'));
}

/** Parent of the workspace root, or null at a filesystem / drive root (C:\, /, \\server\share). */
function parentOfRoot(): string | null {
  const root = (app.workspace.value?.root ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(root.lastIndexOf('/'), root.lastIndexOf('\\'));
  if (i <= 0) return root.startsWith('/') && root.length > 1 ? '/' : null;
  const parent = root.slice(0, i);
  if (/^[a-z]:$/i.test(parent)) return parent + '\\'; // C:\notes → C:\
  if (/^\\\\[^\\]+$/.test(parent)) return null; // \\server\share has no openable parent
  return parent;
}

export function rowMenu(node: TreeNode | null): ui.MenuItem[] {
  const isDir = node?.kind === 'dir';
  const folder = node ? (isDir ? node.path : dirname(node.path)) : '';
  const items: ui.MenuItem[] = [];
  if (node && !isDir) items.push({ label: 'Open', icon: 'file', run: () => app.openFile(node.path) });
  if (node && isDir) items.push({ label: 'Open as project', icon: 'folderOpen', run: () => openAsProject(absolutePath(node.path)) }, { separator: true });
  items.push({ label: 'New note', icon: 'filePlus', keys: 'Ctrl+N', run: () => newNote(folder) }, { label: 'New folder', icon: 'folderPlus', run: () => startCreate('dir', folder) });
  if (node) {
    items.push(
      { separator: true },
      { label: 'Rename', icon: 'rename', keys: 'F2', run: () => void (ui.renaming.value = node.path) },
      ...(isDir ? [] : [{ label: 'Duplicate', icon: 'copy', run: () => duplicate(node.path) }]),
      { label: 'Delete', icon: 'trash', keys: 'Del', danger: true, run: () => deletePaths([node.path]) },
      { separator: true },
      { label: 'Copy path', icon: 'copy', run: () => copyText(absolutePath(node.path)) },
      { label: 'Copy relative path', run: () => copyText(node.path, 'Relative path') },
      { label: revealLabel(), icon: 'reveal', run: () => revealInOs(node.path) },
      ...(isDir ? [] : pdfItems(node.path)),
      ...(gitUi.value?.menu(node.path) ?? []), // Diff with last commit, stage / unstage
    );
  } else {
    items.push({ separator: true }, { label: 'Collapse all', icon: 'collapse', run: collapseAll }, { label: 'Refresh', icon: 'refresh', run: () => refreshTree() });
    const up = parentOfRoot();
    if (up) items.push({ separator: true }, { label: 'Open parent folder as project', icon: 'arrowUp', run: () => openAsProject(up) });
  }
  return items;
}

function closeOthers(path: string) {
  return closeTabs(app.tabs.value.map((t) => t.path).filter((p) => p !== path));
}
function closeRight(path: string) {
  const i = app.tabs.value.findIndex((t) => t.path === path);
  return closeTabs(app.tabs.value.slice(i + 1).map((t) => t.path));
}
export function tabMenu(path: string): ui.MenuItem[] {
  return [
    { label: 'Close', keys: prettyKey('Mod-w'), run: () => app.closeTab(path) },
    { label: 'Close others', run: () => closeOthers(path) },
    { label: 'Close to the right', run: () => closeRight(path) },
    { label: 'Close all', run: closeAll },
    { separator: true },
    { label: 'Copy path', icon: 'copy', run: () => copyText(absolutePath(path)) },
    { label: 'Copy relative path', run: () => copyText(path, 'Relative path') },
    { label: 'Reveal in sidebar', icon: 'files', run: () => revealInTree(path) },
    { label: revealLabel(), icon: 'reveal', run: () => revealInOs(path) },
    ...pdfItems(path),
    ...(gitUi.value?.menu(path) ?? []),
  ];
}

// ---- folder switcher (shelf workspace card, classic header / activity bar) ----

export function openWorkspaceMenu(anchor: HTMLElement, placement: 'below' | 'right' | 'above' = 'below', extra: ui.MenuItem[] = []) {
  const ws = app.workspace.value;
  const recent = ui.recentFolders.value.filter((r) => r !== ws?.root).slice(0, 6);
  // Parent path as a hint, so two folders with the same name are distinguishable.
  const parentHint = (p: string) => {
    const segs = p.split(/[\\/]/).filter(Boolean).slice(0, -1);
    return segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : segs.join('/');
  };
  const items: ui.MenuItem[] = [
    ...extra,
    ...(extra.length ? [{ separator: true } as ui.MenuItem] : []),
    { label: 'Open folder…', icon: 'folderOpen', run: () => runCommand('workspace.open') },
    ...(recent.length ? [{ separator: true } as ui.MenuItem] : []),
    ...recent.map((r) => ({
      label: r.split(/[\\/]/).filter(Boolean).pop() || r,
      icon: 'history',
      keys: parentHint(r),
      run: () => openWorkspace(r).catch((err) => app.toast(String(err?.message || err), 'error')),
    })),
  ];
  const r = anchor.getBoundingClientRect();
  // 'above' (status bar): the menu host flips it up so it sits right over the anchor.
  const at = placement === 'right' ? { clientX: r.right + 6, clientY: r.top } : placement === 'above' ? { clientX: r.left, clientY: r.top - 4 } : { clientX: r.left, clientY: r.bottom + 4 };
  ui.openContextMenu({ ...at, preventDefault() {}, stopPropagation() {} }, items);
}

// ---- hosts ----


export function DialogHost() {
  const d = ui.dialog.value;
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!d) return;
    if (input.current) {
      input.current.focus();
      const [a, b] = d.input?.select ?? [0, input.current.value.length];
      input.current.setSelectionRange(a, b);
    } else box.current?.querySelector<HTMLButtonElement>('.se-btn.primary, .se-btn.danger')?.focus();
  }, [d]);
  if (!d) return null;
  const primary = d.buttons.find((b) => b.kind === 'primary') ?? d.buttons.find((b) => b.kind === 'danger') ?? d.buttons[d.buttons.length - 1];
  const done = (value: string) => d.resolve({ value, input: input.current?.value });
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(d.cancelValue ?? 'cancel')}>
      <div
        ref={box}
        class="se-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={d.title}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') done(d.cancelValue ?? 'cancel');
          else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') done(primary.value);
        }}
      >
        <h2 class="se-dialog-title">{d.title}</h2>
        {d.message && <p class="se-dialog-msg">{d.message}</p>}
        {d.details && (
          <ul class="se-dialog-details">
            {d.details.slice(0, 8).map((x) => (
              <li>{x}</li>
            ))}
            {d.details.length > 8 && <li>…and {d.details.length - 8} more</li>}
          </ul>
        )}
        {d.input && <input ref={input} class="se-input" defaultValue={d.input.value} placeholder={d.input.placeholder} spellcheck={false} />}
        <div class="se-dialog-buttons">
          {d.buttons.map((b) => (
            <button class={`se-btn ${b.kind ?? ''}`} onClick={() => done(b.value)} data-value={b.value}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ContextMenuHost() {
  const m = ui.contextMenu.value;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [sel, setSel] = useState(-1);
  useLayoutEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    // Keep the menu inside the window (flip up/left near edges).
    const x = m.x + r.width > innerWidth - 4 ? Math.max(4, m.x - r.width) : m.x;
    const y = m.y + r.height > innerHeight - 4 ? Math.max(4, m.y - r.height) : m.y;
    setPos({ x, y });
    setSel(-1);
    ref.current.focus();
  }, [m]);
  useEffect(() => {
    if (!m) return;
    const close = () => (ui.contextMenu.value = null);
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    // Escape closes the menu even if focus never reached it (e.g. the editor grabbed it back).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [m]);
  if (!m) return null;
  const actionable = m.items.map((it, i) => (!it.separator && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const run = (i: number) => {
    const it = m.items[i];
    ui.contextMenu.value = null;
    if (it?.run) void it.run();
  };
  return (
    <div
      ref={ref}
      class="se-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: `${pos?.x ?? m.x}px`, top: `${pos?.y ?? m.y}px`, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const at = actionable.indexOf(sel);
        if (e.key === 'Escape') ui.contextMenu.value = null;
        else if (e.key === 'ArrowDown') setSel(actionable[(at + 1) % actionable.length]);
        else if (e.key === 'ArrowUp') setSel(actionable[(at - 1 + actionable.length) % actionable.length]);
        else if (e.key === 'Enter' && sel >= 0) run(sel);
        else return;
        e.preventDefault();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {m.items.map((it, i) =>
        it.separator ? (
          <div class="se-menu-sep" role="separator" />
        ) : (
          <button
            class={`se-menu-item${it.danger ? ' danger' : ''}${i === sel ? ' selected' : ''}`}
            role="menuitem"
            disabled={it.disabled}
            onMouseEnter={() => setSel(i)}
            onClick={() => run(i)}
          >
            <span class="se-menu-icon">{it.icon && <Icon name={it.icon} size={14} />}</span>
            <span class="se-menu-label">{it.label}</span>
            {it.keys && <span class="se-menu-keys">{it.keys}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function TabSwitcher() {
  const s = ui.tabSwitcher.value;
  if (!s) return null;
  return (
    <div class="se-overlay se-switcher-backdrop">
      <div class="se-switcher" role="listbox" aria-label="Switch tab">
        {s.list.map((p, i) => (
          <div class={`se-switcher-item${i === s.index ? ' selected' : ''}`} role="option" aria-selected={i === s.index}>
            <FileIcon path={p} size={15} />
            <span class="se-switcher-name">{basename(p)}</span>
            <span class="se-switcher-dir">{dirname(p)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function DropOverlay() {
  if (!ui.dropActive.value) return null;
  return (
    <div class="se-drop-overlay">
      <div class="se-drop-card">
        <Icon name="folderOpen" size={32} />
        <span>Drop a folder or file to open it</span>
      </div>
    </div>
  );
}

// ---- language mode (status bar) + content width pickers ----

/** Sets (or with null clears) the language override of a file; remembered in the session. */
export function setLanguage(path: string, id: string | null) {
  const next = { ...ui.languageOverrides.value };
  if (id) next[path] = id;
  else delete next[path];
  ui.languageOverrides.value = next;
  app.editor?.setLanguage?.(path, id);
  ui.languageVersion.value++;
  persistSession();
}

function dropLanguageOverrides(paths: string[]) {
  const cur = ui.languageOverrides.value;
  if (!paths.some((p) => p in cur)) return;
  const next = { ...cur };
  for (const p of paths) delete next[p];
  ui.languageOverrides.value = next;
  persistSession();
}

/** Languages the editor can highlight, A→Z ("Plain text" and auto-detect are listed first, separately). */
export const pickableLanguages = () => LANGUAGES.filter((l) => l.cm).sort((a, b) => a.name.localeCompare(b.name));

export function openLanguagePicker(anchor?: Element | null) {
  const path = app.activePath.value;
  const doc = path ? app.docs.get(path) : undefined;
  if (!path || !doc || doc.binary) return;
  const override = ui.languageOverrides.value[path] ?? null;
  const current = app.editor?.getLanguage?.(path);
  // Without editor support for getLanguage, the override (if any) is what we know.
  const currentId = current ? (current.auto ? null : current.id) : override;
  const pick = (id: string | null) => () => setLanguage(path, id);
  ui.picker.value = {
    title: 'Select language mode',
    anchor,
    items: [
      { label: 'Auto-detect', detail: 'by extension', checked: currentId === null, run: pick(null) },
      { label: 'Plain text', checked: currentId === 'text', run: pick('text') },
      ...pickableLanguages().map((l, i) => ({ label: l.name, detail: l.extensions[0], checked: currentId === l.id, separator: i === 0, run: pick(l.id) })),
    ],
  };
}

const WIDTH_ITEMS = { readable: ['Readable', 'about 80 characters'], wide: ['Wide', 'for tables and code'], full: ['Full width', 'edge to edge'] } as const;

export function openWidthPicker() {
  const cur = currentWidth();
  ui.picker.value = {
    title: 'Content width',
    items: WIDTHS.map((w) => ({ label: WIDTH_ITEMS[w][0], detail: WIDTH_ITEMS[w][1], checked: w === cur, run: () => updateSettings({ contentWidth: w }) })),
  };
}

/** Case-insensitive match: substring first, then letters in order ("tsc" → TypeScript). */
export function filterPickerItems<T extends { label: string; detail?: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  const sub = items.filter((it) => it.label.toLowerCase().includes(q) || it.detail?.toLowerCase().includes(q));
  const starts = sub.filter((it) => it.label.toLowerCase().startsWith(q));
  const fuzzy = items.filter((it) => {
    if (sub.includes(it)) return false;
    let i = 0;
    for (const ch of it.label.toLowerCase()) if (ch === q[i]) i++;
    return i === q.length;
  });
  return [...starts, ...sub.filter((it) => !starts.includes(it)), ...fuzzy];
}

export function PickerHost() {
  const p = ui.picker.value;
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  // Captured before our input takes focus, so closing hands the keyboard back.
  const returnFocus = useRef<Element | null>(null);

  useLayoutEffect(() => {
    if (!p) return;
    returnFocus.current = document.activeElement;
    setQuery('');
    setSel(Math.max(0, p.items.findIndex((it) => it.checked)));
    const a = p.anchor?.getBoundingClientRect();
    const w = box.current?.offsetWidth ?? 270;
    if (a) {
      // Hang off the anchor, right-aligned; open upwards from a status-bar item.
      const left = Math.min(Math.max(8, a.right - w), innerWidth - w - 8);
      setPos(a.top > innerHeight / 2 ? { left, bottom: innerHeight - a.top + 6 } : { left, top: a.bottom + 6 });
    } else setPos(null);
  }, [p]);
  // After positioning: an anchored picker is hidden until then, and hidden inputs cannot take focus.
  useLayoutEffect(() => {
    if (p) input.current?.focus();
  }, [p, pos]);
  useEffect(() => {
    list.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [sel, query, p]);
  useEffect(() => {
    if (!p) return;
    const close = () => (ui.picker.value = null);
    window.addEventListener('resize', close);
    return () => window.removeEventListener('resize', close);
  }, [p]);
  if (!p) return null;

  const shown = filterPickerItems(p.items, query);
  const close = (refocus = true) => {
    ui.picker.value = null;
    if (!refocus) return;
    const prev = returnFocus.current as HTMLElement | null;
    // From the status bar or the palette the keyboard belongs in the editor afterwards.
    if (prev && prev.isConnected && prev !== document.body && !prev.closest('.se-status, .se-overlay')) prev.focus();
    else app.editor?.focus();
  };
  const run = (it: ui.PickerItem | undefined) => {
    if (!it) return;
    close();
    void it.run();
  };
  const move = (to: number) => shown.length && setSel((to + shown.length) % shown.length);
  return (
    <>
      <div class="se-picker-backdrop" onMouseDown={() => close()} />
      <div
        ref={box}
        class={`se-picker${p.anchor ? '' : ' centered'}`}
        role="dialog"
        aria-label={p.title}
        data-testid="picker"
        style={p.anchor ? { left: `${pos?.left ?? 0}px`, top: pos?.top !== undefined ? `${pos.top}px` : undefined, bottom: pos?.bottom !== undefined ? `${pos.bottom}px` : undefined, visibility: pos ? 'visible' : 'hidden' } : undefined}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') close();
          else if (e.key === 'ArrowDown') move(sel + 1);
          else if (e.key === 'ArrowUp') move(sel - 1);
          else if (e.key === 'Home') move(0);
          else if (e.key === 'End') move(shown.length - 1);
          else if (e.key === 'PageDown') setSel(Math.min(shown.length - 1, sel + 8));
          else if (e.key === 'PageUp') setSel(Math.max(0, sel - 8));
          else if (e.key === 'Enter') run(shown[sel]);
          else if (e.key === 'Tab') close();
          else return;
          e.preventDefault();
        }}
      >
        <input
          ref={input}
          class="se-picker-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="se-picker-list"
          aria-label={p.title}
          placeholder={`${p.title}…`}
          spellcheck={false}
          value={query}
          onInput={(e) => {
            setQuery((e.currentTarget as HTMLInputElement).value);
            setSel(0);
          }}
        />
        <div ref={list} id="se-picker-list" class="se-picker-list" role="listbox" aria-label={p.title}>
          {shown.map((it, i) => (
            <>
              {it.separator && !query.trim() && <div class="se-picker-sep" role="separator" />}
              <div class={`se-picker-item${i === sel ? ' selected' : ''}`} role="option" aria-selected={i === sel} aria-checked={!!it.checked} onMouseMove={() => i !== sel && setSel(i)} onClick={() => run(it)}>
                <span class="se-picker-check">{it.checked && <Icon name="check" size={14} />}</span>
                <span class="se-picker-label">{it.label}</span>
                {it.detail && <span class="se-picker-detail">{it.detail}</span>}
              </div>
            </>
          ))}
          {!shown.length && <div class="se-picker-empty">No match</div>}
        </div>
      </div>
    </>
  );
}

const TOAST_ICON = { info: 'info', error: 'alert', success: 'check' } as const;

/** The toasts inside Layout's `.se-toasts` live region (mounted only while there are any). */
export function ToastList() {
  return (
    <>
      {app.toasts.value.map((t) => (
        <div class={`se-toast ${t.kind}`} key={t.id} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span class="se-toast-icon">
            <Icon name={TOAST_ICON[t.kind]} size={15} />
          </span>
          <span class="se-toast-msg">{t.message}</span>
          {t.actions?.map((a) => (
            <button
              class="se-btn small"
              onClick={() => {
                app.dismissToast(t.id);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
          <button class="se-icon-btn tiny se-toast-close" aria-label="Dismiss" onClick={() => app.dismissToast(t.id)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </>
  );
}
