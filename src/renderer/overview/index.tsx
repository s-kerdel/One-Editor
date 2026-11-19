// File overview (right sidebar) — startup stub: the toggle command, the toggle button's icon and the
// lazy panel the shell's Layout puts in the right column. Everything visible is ./OverviewPanel.
import * as ui from '../app/ui';
import { addIcons } from '../app/icons';
import { afterBootIdle, lazyComponent } from '../app/lazy';
import { registerCommand } from '../app/commands';

// Used by the tab strip's toggle button, so it must exist at startup (a few bytes).
addIcons({ 'ov-panel': 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z|M15 3v18' });

/** The panel as a lazy component; `preload()` first to have it in the very first frame. */
export const OverviewPanelLazy = lazyComponent(() => import('./OverviewPanel').then((m) => m.OverviewPanel));

/** Resolve the panel chunk ahead of the first render (when the overview is open at launch). */
export const preloadOverview = () => OverviewPanelLazy.preload();

export function installOverview() {
  registerCommand({
    id: 'view.toggleOverview',
    title: 'View: Toggle file overview',
    keys: ['Mod-Alt-b'],
    keywords: ['outline', 'symbols', 'code blocks', 'tasks', 'backlinks', 'right sidebar'],
    run: () => void (ui.overviewVisible.value = !ui.overviewVisible.value), // persisted by documents.ts
  });
  // Closed at launch: warm the chunk once idle, so the first Ctrl+Alt+B fills the column at once.
  if (!ui.overviewVisible.value) afterBootIdle(() => void preloadOverview().catch(() => {}), 5000);
}
