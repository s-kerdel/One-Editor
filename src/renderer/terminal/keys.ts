// Keyboard policy while a terminal has focus. Pure, so it is unit-tested per platform.
//
// 1. Terminal-local keys (handled by the view, never sent to the shell): copy / paste / find.
// 2. App shortcuts vs the shell: on Windows/Linux the app's Ctrl shortcuts collide with readline
//    (Ctrl+W delete word, Ctrl+E end of line, Ctrl+N/T/K/B…). Only a short allowlist of app keys wins
//    over the shell; everything else reaches it. On macOS the app uses Cmd, so all app keys win
//    except the terminal's own Cmd+C/V/F/A/K.

export type TerminalKeyAction = 'copy' | 'paste' | 'find' | 'selectAll' | 'clear' | 'none';

export interface KeyLike {
  type: string;
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Letter of a key event, also on non-Latin layouts (Cyrillic "с" on the C key → "c"). */
function letter(e: KeyLike): string {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  const m = /^Key([A-Z])$/.exec(e.code ?? '');
  return m ? m[1].toLowerCase() : e.key;
}

/**
 * What the terminal does itself with this key (null = let xterm.js send it to the shell).
 * 'none' = swallow (e.g. Ctrl+Shift+C without a selection must not reach the shell as ^C).
 */
export function terminalKeyAction(e: KeyLike, o: { os: string; hasSelection: boolean }): TerminalKeyAction | null {
  const mac = o.os === 'darwin';
  const k = letter(e);
  const sel = o.hasSelection;
  if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return 'paste';
  if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return sel ? 'copy' : 'none';
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.shiftKey) return null;
    return k === 'c' ? (sel ? 'copy' : 'none') : k === 'v' ? 'paste' : k === 'f' ? 'find' : k === 'a' ? 'selectAll' : k === 'k' ? 'clear' : null;
  }
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.shiftKey) return k === 'c' ? (sel ? 'copy' : 'none') : k === 'v' ? 'paste' : null;
  if (k === 'f') return 'find';
  // Windows Terminal convention: Ctrl+C copies when something is selected (else it is ^C), Ctrl+V pastes.
  if (o.os === 'win32') {
    if (k === 'c' && sel) return 'copy';
    if (k === 'v') return 'paste';
  }
  return null;
}

/** App shortcuts (normalised, see commands.normalizeKey) that still work inside a terminal on Windows/Linux. */
export const APP_KEYS_IN_TERMINAL = new Set([
  'Mod-`', // toggle the terminal panel
  'Mod-Shift-`',
  'Mod-Shift-~', // new terminal (US layouts report "~" with Shift)
  // Ctrl+` / Ctrl+Shift+` exist only on macOS (eventToKey: Ctrl stays 'Ctrl' there; Cmd+` is the OS's "cycle windows").
  // On Win/Linux Ctrl is Mod, so they are the Mod entries above. There are no other Ctrl-chords that win.
  'Mod-Shift-p', // command palette
  'Mod-p', // quick open (VS Code does the same; readline's ^P = ↑)
  'Mod-Shift-f', // find in files
  'Mod-Shift-h',
  'Mod-s', // save (in a shell ^S would freeze output via XOFF — a classic trap)
  'Mod-,', // settings
  'Mod-Shift-b', // sidebar
  'Mod-Alt-z', // zen mode (readline binds no Ctrl+Alt+Z)
  'Ctrl-Tab',
  'Ctrl-Shift-Tab',
  'Mod-=',
  'Mod-+',
  'Mod-Shift-+',
  'Mod-Shift-=',
  'Mod--',
  'Mod-0',
]);
const TERMINAL_OWN_MAC = new Set(['Mod-c', 'Mod-v', 'Mod-f', 'Mod-a', 'Mod-k']);
/** App keys that open an input (palette, quick open, find in files, settings): the terminal lets go of
 *  focus first, else keys typed right after would be replayed into xterm's textarea — i.e. the shell. */
export const APP_KEYS_TAKING_FOCUS = new Set(['Mod-Shift-p', 'Mod-p', 'Mod-Shift-f', 'Mod-Shift-h', 'Mod-,', 'F1']);

/** Global keymap filter (phase-2 hook in commands.installGlobalKeymap): may the app take `key` from a focused terminal? */
export function appKeyWinsInTerminal(key: string, os: string): boolean {
  if (os === 'darwin') return !TERMINAL_OWN_MAC.has(key);
  return APP_KEYS_IN_TERMINAL.has(key);
}
