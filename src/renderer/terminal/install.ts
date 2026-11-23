// Terminal startup stub — kept tiny (startup budget): Ctrl+`, app.runInTerminal and the
// panel slot. Everything else (all commands, Claude glue, the keymap filter, manager + panel) is in
// ./entry, loaded on idle or first use; xterm.js only with the first terminal.
import { app } from '../app/app';
import { registerCommand } from '../app/commands';
import { addIcons } from '../app/icons';
import { afterBootIdle, lazy, lazyComponent } from '../app/lazy';
import { panelOpen } from './state';
export { panelOpen };

type Entry = typeof import('./entry');
const entry = lazy<Entry>(() => import('./entry'));
const go = (f: (m: Entry) => unknown) => () => void entry.load().then(f);

/** The bottom panel (rendered while `panelOpen.value`). */
export const TerminalPanelSlot = lazyComponent(() => entry.load().then((m) => m.panelSlot()));

export function installTerminal() {
  if ((globalThis as { secEditBridge?: { terminal?: unknown } }).secEditBridge?.terminal) {
    // "AI changes" (lazy chunk): what Claude Code / Opencode terminals changed — desktop only, like the terminals it is fed by. Key: ui.PANEL_KEYS.aichanges.
    addIcons({ aiChanges: 'M12 3l1.9 5.6L19.5 10.5l-5.6 1.9L12 18l-1.9-5.6L4.5 10.5l5.6-1.9z|M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z' });
    app.registerPanel({ id: 'aichanges', title: 'AI changes', icon: 'aiChanges', order: 14, component: lazyComponent(() => import('./changes/Panel').then((m) => m.AiChanges)) });
    registerCommand({
      id: 'view.aichanges',
      title: 'View: Show AI changes',
      keys: ['Mod-Alt-a'],
      run: () => {
        app.sidebarPanel.value = 'aichanges';
        app.sidebarVisible.value = true;
      },
    });
  }
  if ((globalThis as { secEditBridge?: { terminal?: unknown } }).secEditBridge?.terminal) app.runInTerminal = (code, o) => entry.load().then((m) => m.runInTerminal(code, o));
  // Same id / title / key as ./entry, which replaces it when it loads on idle together with every other
  // terminal command (tests/unit/terminal guards this). Only Ctrl+` is live before that: startup budget.
  registerCommand({ id: 'terminal.toggle', title: 'Toggle panel', category: 'Terminal', keys: ['Mod-`', 'Ctrl-`'], run: go((m) => m.toggleTerminal()) });
  afterBootIdle(go(() => {}), 3000);
}
