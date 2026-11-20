// Go back / Go forward — the startup part only: two key bindings, the mouse side buttons and a note of
// which files were shown before the recorder (./impl, a lazy chunk) took over. Keep this tiny.
import { navFromMouseButton, type NavDir, type NavSource } from '@shared/nav';
import { app } from '../app/app';
import { isMac, registerCommands } from '../app/commands';
import { afterBootIdle } from '../app/lazy';

let impl: Promise<typeof import('./impl')> | undefined;

export function installNav(): void {
  const early: string[] = [];
  const off = app.events.on('active:changed', (p) => void (p && early.push(p)));
  const load = () => (impl ??= import('./impl').then((m) => (off(), m.start(early), m)));
  const go = (dir: NavDir, source?: NavSource) => void load().then((m) => m.go(dir, source));
  // Global keys beat CodeMirror's Alt-Left/Right (cursorSyntaxLeft/Right; macOS: Cmd-[ / ] indent), as in VS Code.
  registerCommands([
    { id: 'nav.back', title: 'Go back', keys: [isMac ? 'Mod-[' : 'Alt-ArrowLeft'], run: () => go('back') },
    { id: 'nav.forward', title: 'Go forward', keys: [isMac ? 'Mod-]' : 'Alt-ArrowRight'], run: () => go('forward') },
  ]);
  // Mouse side buttons, anywhere in the window. Cancelled on every phase of the press so browser mode
  // never walks the page's own history (which would leave the app).
  const side = (e: Event) => {
    const dir = navFromMouseButton((e as MouseEvent).button);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'mouseup') go(dir, 'mouse');
  };
  for (const type of ['mousedown', 'mouseup', 'auxclick']) addEventListener(type, side, true);
  afterBootIdle(() => void load());
}
