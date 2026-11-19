// Terminal startup stub — kept tiny (startup budget): Ctrl+`, app.runInTerminal and the
// panel slot. Everything else (all commands, Claude glue, the keymap filter, manager + panel) is in
// ./entry, loaded on idle or first use; xterm.js only with the first terminal.
import { app } from '../app/app';
import { registerCommand } from '../app/commands';
import { afterBootIdle, lazy, lazyComponent } from '../app/lazy';
import { panelOpen } from './state';
export { panelOpen };

type Entry = typeof import('./entry');
const entry = lazy<Entry>(() => import('./entry'));
const go = (f: (m: Entry) => unknown) => () => void entry.load().then(f);

/** The bottom panel (rendered while `panelOpen.value`). */
export const TerminalPanelSlot = lazyComponent(() => entry.load().then((m) => m.panelSlot()));

export function installTerminal() {
  if ((globalThis as { secEditBridge?: { terminal?: unknown } }).secEditBridge?.terminal) app.runInTerminal = (code, o) => entry.load().then((m) => m.runInTerminal(code, o));
  // Same id / title / key as ./entry, which replaces it when it loads on idle together with every other
  // terminal command (tests/unit/terminal guards this). Only Ctrl+` is live before that: startup budget.
  registerCommand({ id: 'terminal.toggle', title: 'Toggle panel', category: 'Terminal', keys: ['Mod-`'], run: go((m) => m.toggleTerminal()) });
  afterBootIdle(go(() => {}), 3000);
}
