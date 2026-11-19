// Shell commands without keys: reachable from the palette, menus and runCommand() only, so they load
// with the palette / once idle after boot (addCommandSource in shell.ts) instead of at launch.
import { app } from './app';
import * as ui from './ui';
import { registerCommands } from './commands';
import { closeTabs, saveAll } from './documents';
import { absolutePath, copyText, deletePaths, duplicate, revealInOs, revealInTree, revealLabel, startCreate } from './fileops';
import { setViewMode, updateSettings, activeIsMarkdown } from './settings';
import { holdKeys } from './lazy';
import { primeClassic } from './classic-loader';
import { collapseAll } from './FileTree';
import { closeAll } from './Tabs';
import { openFolderInteractive } from './shell';

const hasActive = () => !!app.activePath.value;
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
    { id: 'file.rename', title: 'File: Rename…', when: hasActive, run: () => { revealInTree(app.activePath.value!); ui.renaming.value = app.activePath.value; } },
    { id: 'file.delete', title: 'File: Delete', when: hasActive, run: () => void deletePaths([app.activePath.value!]) },
    { id: 'file.duplicate', title: 'File: Duplicate', when: hasActive, run: () => void duplicate(app.activePath.value!) },
    { id: 'file.revealInSidebar', title: 'File: Reveal in sidebar', when: hasActive, run: () => revealInTree(app.activePath.value!) },
    { id: 'file.revealInOs', title: `File: ${revealLabel()}`, when: hasActive, run: () => void revealInOs(app.activePath.value!) },
    { id: 'file.copyPath', title: 'File: Copy path', when: hasActive, run: () => void copyText(absolutePath(app.activePath.value!)) },
    { id: 'file.copyRelativePath', title: 'File: Copy relative path', when: hasActive, run: () => void copyText(app.activePath.value!, 'Relative path') },
    { id: 'workspace.open', title: 'Open folder…', keywords: ['workspace', 'project'], run: openFolderInteractive },
    { id: 'files.collapseAll', title: 'Files: Collapse all folders', run: collapseAll },
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
  ]);
}
