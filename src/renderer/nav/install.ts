// Go back / Go forward — the startup part only: two key bindings, the mouse side buttons, the status
// bar buttons' state and a note of which files were shown before the recorder (./impl, a lazy chunk)
// took over. Keep this tiny.
import { signal } from '@preact/signals';
import { navFromMouseButton, type NavDir, type NavSource } from '@shared/nav';
import { app } from '../app/app';
import { isMac, registerCommands } from '../app/commands';
import { afterBootIdle } from '../app/lazy';

/** Somewhere to go back / forward to (./buttons greys out at the ends); ./impl keeps it current once in. */
export const navCan = { back: signal(false), forward: signal(false) };
/** [binding, as the buttons' tooltips show it]. */
export const NAV_KEYS = isMac ? { back: ['Mod-[', '⌘['], forward: ['Mod-]', '⌘]'] } : { back: ['Alt-ArrowLeft', 'Alt+←'], forward: ['Alt-ArrowRight', 'Alt+→'] };

let impl: Promise<typeof import('./impl')> | undefined;
const early: string[] = [];
let off = () => {};
const load = () => (impl ??= import('./impl').then((m) => (off(), m.start(early, navCan), m)));
export const navGo = (dir: NavDir, source?: NavSource) => void load().then((m) => m.go(dir, source));
/** A button's recent-places list (right-click / long-press), under `anchor`. */
export const navPlaces = (dir: NavDir, anchor: HTMLElement) => void load().then((m) => m.openPlaces(dir, anchor));

export function installNav(): void {
  off = app.events.on('active:changed', (p) => void (p && early.push(p)));
  // Global keys beat CodeMirror's Alt-Left/Right (cursorSyntaxLeft/Right; macOS: Cmd-[ / ] indent), as in VS Code.
  registerCommands([
    { id: 'nav.back', title: 'Go back', keys: [NAV_KEYS.back[0]], run: () => navGo('back') },
    { id: 'nav.forward', title: 'Go forward', keys: [NAV_KEYS.forward[0]], run: () => navGo('forward') },
  ]);
  // Mouse side buttons, anywhere in the window. Cancelled on every phase of the press so browser mode
  // never walks the page's own history (which would leave the app).
  const side = (e: Event) => {
    const dir = navFromMouseButton((e as MouseEvent).button);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'mouseup') navGo(dir, 'mouse');
  };
  for (const type of ['mousedown', 'mouseup', 'auxclick']) addEventListener(type, side, true);
  afterBootIdle(() => void load());
}
