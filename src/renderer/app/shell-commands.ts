// Shell commands without keys: reachable from the palette, menus and runCommand() only, so they load
// with the palette / once idle after boot (addCommandSource in shell.ts) instead of at launch.
import { app } from './app';
import * as ui from './ui';
import { registerCommands } from './commands';
import { closeTabs, openWorkspace, saveAll } from './documents';
import { isExtPath } from '@shared/external';
import { absolutePath, openAbsolutePaths, copyText, deletePaths, duplicate, revealInOs, revealInTree, revealLabel, startCreate } from './fileops';
import { setViewMode, updateSettings, activeIsMarkdown } from './settings';
import { holdKeys } from './lazy';
import { primeClassic } from './classic-loader';
import { collapseAll } from './FileTree';
import { closeAll } from './Tabs';

const hasActive = () => !!app.activePath.value;
/** An open file of the folder (not an outside one: no rename / delete / tree there). */
const hasActiveInFolder = () => !!app.activePath.value && !isExtPath(app.activePath.value);

/** `newWindow`: Shift on "Open folder…" (the folder switcher, the start screen). */
export async function openFolderInteractive(o: { newWindow?: boolean } = {}) {
  let p = await app.backend.pickFolder().catch(() => null);
  if (!p && app.backend.kind === 'web') {
    p = await ui.promptDialog('Open folder', ui.recentFolders.value[0] ?? '', app.backend.os === 'win32' ? 'C:\\Users\\me\\notes' : '/home/me/notes', 'Open');
  }
  if (!p) return;
  try {
    await openWorkspace(p, o);
  } catch (err) {
    app.toast(`Cannot open folder: ${(err as Error).message}`, 'error');
  }
}
/** Any file of the machine as a tab; the folder (if one is open) stays. */
export async function openFileInteractive() {
  const p = await app.backend.pickFile().catch(() => null);
  if (p) await openAbsolutePaths([p]);
}
/** Pickers live in the lazy Popups chunk; keys typed while it loads are replayed into the picker's input. */
const openPicker = (fn: (m: typeof import('./Popups')) => void) => holdKeys(import('./Popups').then(fn));

let registered = false;
export function registerShellCommands() {
  if (registered) return;
  registered = true;
  // The process explorer dock's chunk registers ui.processDock when it loads: load it whenever the
  // dock is (or was restored from the session as) open. Startup code only renders the signal.
  ui.processesOpen.subscribe((open) => void (open && !ui.processDock.peek() && import('./process-explorer/ProcessExplorer')));
  registerCommands([
    { id: 'file.saveAll', title: 'File: Save all', run: () => void saveAll() },
    { id: 'tabs.closeOthers', title: 'Tabs: Close others', when: hasActive, run: () => void closeTabs(app.tabs.value.map((t) => t.path).filter((p) => p !== app.activePath.value)) },
    { id: 'tabs.closeAll', title: 'Tabs: Close all', when: () => app.tabs.value.length > 0, run: () => void closeAll() },
    { id: 'file.newFolder', title: 'File: New folder', when: () => !!app.workspace.value, run: () => startCreate('dir') },
    { id: 'file.rename', title: 'File: Rename…', when: hasActiveInFolder, run: () => { revealInTree(app.activePath.value!); ui.renaming.value = app.activePath.value; } },
    { id: 'file.delete', title: 'File: Delete', when: hasActiveInFolder, run: () => void deletePaths([app.activePath.value!]) },
    { id: 'file.duplicate', title: 'File: Duplicate', when: hasActiveInFolder, run: () => void duplicate(app.activePath.value!) },
    { id: 'file.revealInSidebar', title: 'File: Reveal in sidebar', when: hasActiveInFolder, run: () => revealInTree(app.activePath.value!) },
    { id: 'file.revealInOs', title: `File: ${revealLabel()}`, when: hasActiveInFolder, run: () => void revealInOs(app.activePath.value!) },
    { id: 'file.copyPath', title: 'File: Copy path', when: hasActive, run: () => void copyText(absolutePath(app.activePath.value!)) },
    { id: 'file.copyRelativePath', title: 'File: Copy relative path', when: hasActive, run: () => void copyText(app.activePath.value!, 'Relative path') },
    { id: 'file.openFile', title: 'File: Open file…', keywords: ['open', 'outside'], when: () => app.backend.kind === 'electron', run: () => void openFileInteractive() },
    { id: 'workspace.open', title: 'Open folder…', keywords: ['workspace', 'project'], run: () => openFolderInteractive() },
    { id: 'files.collapseAll', title: 'Files: Collapse all folders', run: collapseAll },
    {
      id: 'files.toggleGitColors',
      title: 'Files: Toggle git colours in file tree',
      keywords: ['git', 'status', 'marks', 'letters', 'modified', 'calm', 'focus', 'colors'],
      run: () => {
        // Drawing only (git/index.ts): no git run, the Source control pane and change bars stay.
        const on = app.settings.value['git.treeColors'] === false;
        updateSettings({ 'git.treeColors': on });
        app.toast(`Git colours in the file tree: ${on ? 'on' : 'off'}`, 'info', 1500);
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
    {
      id: 'theme.toggle',
      title: 'Preferences: Toggle dark / light theme',
      run: () => {
        const dark = app.settings.value.theme === 'dark' || (app.settings.value.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
        updateSettings({ theme: dark ? 'light' : 'dark' });
      },
    },
    { id: 'app.gpuStatus', title: 'Developer: Show GPU status', keywords: ['hardware acceleration', 'graphics'], run: () => void import('./gpu-status').then((m) => m.showGpuStatus()) },
    { id: 'view.customizeSidebar', title: 'View: Customize sidebar menu…', keywords: ['panels', 'reorder', 'hide', 'pills', 'activity bar', 'icons'], run: () => void import('./SettingsOverlay').then((m) => m.customizeSidebar()) },
    // Every panel without a key of its own: reachable from the palette even while hidden from the sidebar menu.
    ...app.panels.value
      .filter((p) => !ui.PANEL_KEYS[p.id])
      .map((p) => ({
        id: `view.panel.${p.id}`,
        title: `View: Show ${p.title}`,
        keywords: ['sidebar', 'panel'],
        run: () => {
          app.sidebarPanel.value = p.id;
          app.sidebarVisible.value = true;
        },
      })),
  ]);
  // The Bookmarks commands come with the panel's chunk: the palette waits for it (this source's promise).
  return import('../bookmarks/Panel').then((m) => m.registerBookmarkCommands());
}
