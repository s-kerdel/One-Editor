// Shell commands + window-level behaviour (OS drag & drop, open requests, Ctrl-Tab MRU switching).
import { app } from './app';
import * as ui from './ui';
import { brandTitle } from '@shared/brand';
import { addCommandSource, loadCommandSources, registerCommands } from './commands';
import { openWorkspace } from './documents';
import { newNote, openAbsolutePaths } from './fileops';
import { toggleEditPreview, toggleSplit, zoom, activeIsMarkdown } from './settings';
import { afterBootIdle, holdKeys, lazyComponent } from './lazy';

// Settings UI loads on first open (one stable component, so the Mod-, toggle keeps working).
const SettingsOverlay = lazyComponent(() => import('./Settings').then((m) => m.SettingsOverlay));

const hasActive = () => !!app.activePath.value;
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
  // "notes.md — One :: folder": the file first, so taskbar entries stay tellable apart.
  document.title = [p?.split('/').pop(), brandTitle(ws?.name)].filter(Boolean).join(' — ');
}

export function installShell() {
  installDrop();
  app.events.on('active:changed', syncTitle);
  app.events.on('workspace:opened', syncTitle);
  app.backend.onOpenRequest((paths) => void openAbsolutePaths(paths));

  const isElectron = app.backend.kind === 'electron';
  registerCommands([
    { id: 'file.save', title: 'File: Save', keys: ['Mod-s'], run: () => void app.saveFile() },
    { id: 'file.close', title: 'Tabs: Close tab', keys: ['Mod-w'], when: hasActive, run: () => void app.closeTab(app.activePath.value!) },
    { id: 'tabs.next', title: 'Tabs: Next (recently used)', keys: ['Ctrl-Tab', 'Mod-Tab'], run: () => cycleTabs(1) },
    { id: 'tabs.prev', title: 'Tabs: Previous (recently used)', keys: ['Ctrl-Shift-Tab', 'Mod-Shift-Tab'], run: () => cycleTabs(-1) },
    { id: 'file.newNote', title: 'File: New note', keys: ['Mod-n'], keywords: ['create', 'untitled'], when: () => !!app.workspace.value, run: () => void newNote() },
    {
      id: 'view.toggleSidebar',
      title: 'View: Toggle sidebar',
      keys: ['Mod-Shift-b'],
      run: () => {
        app.sidebarVisible.value = !app.sidebarVisible.value;
      },
    },
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
    // Browser mode: Ctrl +/- is the browser's own zoom, so only bind these in the desktop app.
    { id: 'view.zoomIn', title: 'View: Zoom in', keys: isElectron ? ['Mod-=', 'Mod-+', 'Mod-Shift-+', 'Mod-Shift-='] : undefined, when: () => isElectron, run: () => zoom(1) },
    { id: 'view.zoomOut', title: 'View: Zoom out', keys: isElectron ? ['Mod--', 'Mod-_', 'Mod-Shift-_'] : undefined, when: () => isElectron, run: () => zoom(-1) },
    { id: 'view.zoomReset', title: 'View: Reset zoom', keys: isElectron ? ['Mod-0'] : undefined, when: () => isElectron, run: () => zoom(0) },
    { id: 'app.devtools', title: 'Developer: Toggle developer tools', keys: isElectron ? ['F12'] : undefined, when: () => isElectron, run: () => void app.backend.toggleDevTools?.() },
  ]);
  // Commands without keys (palette / menus only) live in ./shell-commands: no launch bytes.
  addCommandSource(() => import('./shell-commands').then((m) => m.registerShellCommands()));
  afterBootIdle(() => void loadCommandSources());
}
