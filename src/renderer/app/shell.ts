// Shell commands + window-level behaviour (OS drag & drop, open requests, Ctrl-Tab MRU switching).
import { app } from './app';
import * as ui from './ui';
import { registerCommands } from './commands';
import { closeTabs, openWorkspace, saveAll } from './documents';
import {
  absolutePath,
  copyText,
  deletePaths,
  duplicate,
  newNote,
  openAbsolutePaths,
  revealInOs,
  revealInTree,
  revealLabel,
  startCreate,
} from './fileops';
import { setViewMode, toggleEditPreview, toggleSplit, updateSettings, zoom, activeIsMarkdown } from './settings';
import { holdKeys, lazyComponent } from './lazy';
import { primeClassic } from './classic-loader';
import { collapseAll } from './FileTree';
import { closeAll } from './Tabs';

// Settings UI loads on first open (one stable component, so the Mod-, toggle keeps working).
const SettingsOverlay = lazyComponent(() => import('./Settings').then((m) => m.SettingsOverlay));

const hasActive = () => !!app.activePath.value;
/** Pickers live in the lazy Popups chunk; keys typed while it loads are replayed into the picker's input. */
const openPicker = (fn: (m: typeof import('./Popups')) => void) => holdKeys(import('./Popups').then(fn));
const INTERNAL_DRAG = ['application/x-sec-edit-paths', 'application/x-sec-edit-tab'];

export async function openFolderInteractive() {
  let p = await app.backend.pickFolder().catch(() => null);
  if (!p && app.backend.kind === 'web') {
    p = await ui.promptDialog('Open folder', ui.recentFolders.value[0] ?? '', app.backend.os === 'win32' ? 'C:\\Users\\me\\notes' : '/home/me/notes', 'Open');
  }
  if (!p) return;
  try {
    await openWorkspace(p);
  } catch (err) {
    app.toast(`Cannot open folder: ${(err as Error).message}`, 'error');
  }
}

// ---- Ctrl-Tab: most-recently-used switching, committed when Ctrl is released --------------------
function mruList(): string[] {
  const open = new Set(app.tabs.value.map((t) => t.path));
  const list = ui.mru.value.filter((p) => open.has(p));
  for (const t of app.tabs.value) if (!list.includes(t.path)) list.push(t.path);
  return list;
}

function commitSwitcher() {
  const s = ui.tabSwitcher.value;
  ui.tabSwitcher.value = null;
  window.removeEventListener('keyup', onSwitcherKeyUp, true);
  window.removeEventListener('blur', commitSwitcher);
  const target = s?.list[s.index];
  if (target && target !== app.activePath.value) void app.openFile(target).then(() => app.editor?.focus());
}

function onSwitcherKeyUp(e: KeyboardEvent) {
  if (e.key === 'Control' || e.key === 'Meta') commitSwitcher();
}

export function cycleTabs(dir: 1 | -1) {
  const s = ui.tabSwitcher.value;
  if (s) {
    ui.tabSwitcher.value = { ...s, index: (s.index + dir + s.list.length) % s.list.length };
    return;
  }
  const list = mruList();
  if (list.length < 2) return;
  ui.tabSwitcher.value = { list, index: dir === 1 ? 1 : list.length - 1 };
  window.addEventListener('keyup', onSwitcherKeyUp, true);
  window.addEventListener('blur', commitSwitcher);
}

// ---- OS drag & drop: drop a folder (switch workspace) or files (open) ---------------------------
function installDrop() {
  let depth = 0;
  const isOsDrag = (e: DragEvent) => {
    const t = e.dataTransfer?.types ?? [];
    return t.includes('Files') && !INTERNAL_DRAG.some((x) => t.includes(x));
  };
  window.addEventListener('dragenter', (e) => {
    if (!isOsDrag(e)) return;
    depth++;
    ui.dropActive.value = true;
  });
  window.addEventListener('dragleave', (e) => {
    if (!isOsDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) ui.dropActive.value = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!isOsDrag(e)) return;
    e.preventDefault(); // otherwise the browser navigates to the file
    e.dataTransfer!.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    depth = 0;
    ui.dropActive.value = false;
    if (!isOsDrag(e) || e.defaultPrevented) return;
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    const paths = files.map((f) => app.backend.getPathForFile?.(f) ?? null).filter((p): p is string => !!p);
    if (!paths.length) {
      app.toast(app.backend.kind === 'web' ? 'Drag & drop opening works in the desktop app. In the browser use “Open folder”.' : 'Nothing to open', 'info', 5000);
      return;
    }
    void openAbsolutePaths(paths);
  });
}

function syncTitle() {
  const ws = app.workspace.value;
  const p = app.activePath.value;
  document.title = [p?.split('/').pop(), ws?.name, 'sec-edit'].filter(Boolean).join(' — ');
}

export function installShell() {
  installDrop();
  app.events.on('active:changed', syncTitle);
  app.events.on('workspace:opened', syncTitle);
  app.backend.onOpenRequest((paths) => void openAbsolutePaths(paths));

  const isElectron = app.backend.kind === 'electron';
  registerCommands([
    { id: 'file.save', title: 'File: Save', keys: ['Mod-s'], run: () => void app.saveFile() },
    { id: 'file.saveAll', title: 'File: Save all', run: () => void saveAll() },
    { id: 'file.close', title: 'Tabs: Close tab', keys: ['Mod-w'], when: hasActive, run: () => void app.closeTab(app.activePath.value!) },
    { id: 'tabs.closeOthers', title: 'Tabs: Close others', when: hasActive, run: () => void closeTabs(app.tabs.value.map((t) => t.path).filter((p) => p !== app.activePath.value)) },
    { id: 'tabs.closeAll', title: 'Tabs: Close all', when: () => app.tabs.value.length > 0, run: () => void closeAll() },
    { id: 'tabs.next', title: 'Tabs: Next (recently used)', keys: ['Ctrl-Tab', 'Mod-Tab'], run: () => cycleTabs(1) },
    { id: 'tabs.prev', title: 'Tabs: Previous (recently used)', keys: ['Ctrl-Shift-Tab', 'Mod-Shift-Tab'], run: () => cycleTabs(-1) },
    { id: 'file.newNote', title: 'File: New note', keys: ['Mod-n'], keywords: ['create', 'untitled'], when: () => !!app.workspace.value, run: () => void newNote() },
    { id: 'file.newFolder', title: 'File: New folder', when: () => !!app.workspace.value, run: () => startCreate('dir') },
    { id: 'file.rename', title: 'File: Rename…', when: hasActive, run: () => { revealInTree(app.activePath.value!); ui.renaming.value = app.activePath.value; } },
    { id: 'file.delete', title: 'File: Delete', when: hasActive, run: () => void deletePaths([app.activePath.value!]) },
    { id: 'file.duplicate', title: 'File: Duplicate', when: hasActive, run: () => void duplicate(app.activePath.value!) },
    { id: 'file.revealInSidebar', title: 'File: Reveal in sidebar', when: hasActive, run: () => revealInTree(app.activePath.value!) },
    { id: 'file.revealInOs', title: `File: ${revealLabel()}`, when: hasActive, run: () => void revealInOs(app.activePath.value!) },
    { id: 'file.copyPath', title: 'File: Copy path', when: hasActive, run: () => void copyText(absolutePath(app.activePath.value!)) },
    { id: 'file.copyRelativePath', title: 'File: Copy relative path', when: hasActive, run: () => void copyText(app.activePath.value!, 'Relative path') },
    { id: 'workspace.open', title: 'Open folder…', keywords: ['workspace', 'project'], run: openFolderInteractive },
    { id: 'files.collapseAll', title: 'Files: Collapse all folders', run: collapseAll },
    {
      id: 'view.toggleSidebar',
      title: 'View: Toggle sidebar',
      keys: ['Mod-Shift-b'],
      run: () => {
        app.sidebarVisible.value = !app.sidebarVisible.value;
      },
    },
    { id: 'view.contentWidth', title: 'View: Content width…', keywords: ['readable', 'wide', 'full', 'column', 'margin', 'line length'], when: activeIsMarkdown, run: () => openPicker((m) => m.openWidthPicker()) },
    { id: 'editor.changeLanguage', title: 'Change language mode…', keywords: ['syntax', 'highlighting', 'file type', 'plain text'], when: hasActive, run: () => openPicker((m) => m.openLanguagePicker()) },
    {
      id: 'view.sidebarStyle',
      title: 'View: Switch sidebar style (Shelf ↔ Classic)',
      keywords: ['layout', 'activity bar', 'left menu', 'vscode', 'shelf', 'classic'],
      run: async () => {
        const next = app.settings.value.sidebarStyle === 'classic' ? 'shelf' : 'classic';
        // Resolve classic's lazy parts first, so the switch lands in one frame (no pop-in).
        if (next === 'classic') await primeClassic().catch(() => {});
        updateSettings({ sidebarStyle: next });
      },
    },
    ...(['live', 'source', 'split', 'preview'] as const).map((m) => ({
      id: `view.mode.${m}`,
      title: `View: ${{ live: 'Live preview', source: 'Source mode', split: 'Split editor + preview', preview: 'Reading view' }[m]}`,
      run: () => setViewMode(m),
    })),
    { id: 'view.toggleEditPreview', title: 'View: Toggle edit / reading view', keys: ['Mod-e'], when: activeIsMarkdown, run: toggleEditPreview },
    { id: 'view.toggleSplit', title: 'View: Toggle split preview', keys: ['Mod-\\'], when: activeIsMarkdown, run: toggleSplit },
    {
      id: 'app.settings',
      title: 'Preferences: Open settings',
      keys: ['Mod-,'],
      keywords: ['preferences', 'options', 'config'],
      run: () => {
        const open = app.overlay.value !== SettingsOverlay;
        app.overlay.value = open ? SettingsOverlay : null;
        // Keys pressed before the (lazy) dialog has focus — Escape, typing — are replayed into it.
        if (open) holdKeys(Promise.resolve());
      },
    },
    {
      id: 'theme.toggle',
      title: 'Preferences: Toggle dark / light theme',
      run: () => {
        const dark = app.settings.value.theme === 'dark' || (app.settings.value.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        updateSettings({ theme: dark ? 'light' : 'dark' });
      },
    },
    // Browser mode: Ctrl +/- is the browser's own zoom, so only bind these in the desktop app.
    { id: 'view.zoomIn', title: 'View: Zoom in', keys: isElectron ? ['Mod-=', 'Mod-+', 'Mod-Shift-+', 'Mod-Shift-='] : undefined, when: () => isElectron, run: () => zoom(1) },
    { id: 'view.zoomOut', title: 'View: Zoom out', keys: isElectron ? ['Mod--', 'Mod-_', 'Mod-Shift-_'] : undefined, when: () => isElectron, run: () => zoom(-1) },
    { id: 'view.zoomReset', title: 'View: Reset zoom', keys: isElectron ? ['Mod-0'] : undefined, when: () => isElectron, run: () => zoom(0) },
    { id: 'app.devtools', title: 'Developer: Toggle developer tools', keys: isElectron ? ['F12'] : undefined, when: () => isElectron, run: () => void app.backend.toggleDevTools?.() },
    { id: 'app.gpuStatus', title: 'Developer: Show GPU status', keywords: ['hardware acceleration', 'graphics'], run: () => void import('./gpu-status').then((m) => m.showGpuStatus()) },
  ]);
}
