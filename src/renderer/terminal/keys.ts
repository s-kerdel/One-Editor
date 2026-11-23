// Keyboard policy while a terminal has focus. Pure, so it is unit-tested per platform.
//
// 1. Terminal-local keys (handled by the view, never sent to the shell): copy / paste / find.
// 2. App shortcuts vs the shell: on Windows/Linux the app's Ctrl shortcuts collide with readline
//    (Ctrl+W delete word, Ctrl+E end of line, Ctrl+N/T/K/B…). Only a short allowlist of app keys wins
//    over the shell; everything else reaches it. On macOS the app uses Cmd, so all app keys win
//    except the terminal's own Cmd+C/V/F/A/K.
// 3. macOS, decided by the modifiers the event carries (never by what the keyboard is labelled):
//    - a chord with the Control key is the shell's; only Ctrl+` and Ctrl+Tab are the app's (MAC_CTRL_KEYS);
//    - a Cmd chord that a keyboard remapper made out of a Ctrl chord (createCmdTracker below) IS that Ctrl
//      chord: the Windows/Linux rules of 1 and 2 apply and the view sends the control byte itself, because
//      xterm.js never encodes Cmd+letter. Setting `terminal.cmdSendsCtrl`: auto (detect) | on | off.

export type TerminalKeyAction = 'copy' | 'paste' | 'find' | 'selectAll' | 'clear' | 'none';
/** Bytes the view sends to the shell in place of the key (a Ctrl chord that arrived as a Cmd chord). */
export type TerminalKeySend = { send: string };

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

/** The byte Ctrl+<key> sends (what xterm.js sends for a real Ctrl chord): letters and [ \ ]. */
export function ctrlByte(k: string): string | null {
  if (/^[a-z]$/.test(k)) return String.fromCharCode(k.charCodeAt(0) - 96);
  return k === '[' ? '\x1b' : k === '\\' ? '\x1c' : k === ']' ? '\x1d' : null;
}

/**
 * What the terminal does itself with this key (null = let xterm.js send it to the shell).
 * 'none' = swallow (e.g. Ctrl+Shift+C without a selection must not reach the shell as ^C).
 * `cmdIsCtrl` (macOS, see createCmdTracker): this Cmd chord was typed as a Ctrl chord.
 */
export function terminalKeyAction(e: KeyLike, o: { os: string; hasSelection: boolean; cmdIsCtrl?: boolean }): TerminalKeyAction | TerminalKeySend | null {
  const mac = o.os === 'darwin';
  const k = letter(e);
  const sel = o.hasSelection;
  if (e.key === 'Insert' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) return 'paste';
  if (e.key === 'Insert' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) return sel ? 'copy' : 'none';
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    if (o.cmdIsCtrl) {
      // Windows Terminal rules with Cmd read as Ctrl: copy only with a selection (else ^C), paste, find;
      // every other letter goes to the shell as its control byte (^R, ^D, ^Z, ^L, ^A, ^E, ^W, ^U, ^K…).
      if (e.shiftKey) return k === 'c' ? (sel ? 'copy' : 'none') : k === 'v' ? 'paste' : null;
      if (k === 'c' && sel) return 'copy';
      if (k === 'v') return 'paste';
      if (k === 'f') return 'find';
      const send = ctrlByte(k);
      return send ? { send } : null;
    }
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
  'Mod-Alt-a', // AI changes panel (no readline binding either)
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

/** macOS: the only chords with the Control key (and no Cmd) that are the app's; every other one is the shell's. */
const MAC_CTRL_KEYS = new Set(['Ctrl-`', 'Ctrl-Shift-`', 'Ctrl-Shift-~', 'Ctrl-Tab', 'Ctrl-Shift-Tab']);

/**
 * Global keymap filter (phase-2 hook in commands.installGlobalKeymap): may the app take `key` from a focused terminal?
 * `cmdIsCtrl` (macOS): the Cmd of this chord stands for the Control key (createCmdTracker), so the
 * Windows/Linux allowlist decides — Cmd+W / E / N / K… then reach the shell as ^W / ^E / ^N / ^K.
 */
export function appKeyWinsInTerminal(key: string, os: string, cmdIsCtrl = false): boolean {
  if (os !== 'darwin') return APP_KEYS_IN_TERMINAL.has(key);
  if (key.startsWith('Ctrl-')) return MAC_CTRL_KEYS.has(key);
  if (cmdIsCtrl && key.startsWith('Mod-')) return APP_KEYS_IN_TERMINAL.has(key);
  return !TERMINAL_OWN_MAC.has(key);
}

// ---- macOS: a Ctrl chord that arrives as a Cmd chord ------------------------------------------------
// Windows-style keyboard remappers (Karabiner-Elements "Windows shortcuts" rules) turn Ctrl+<key> into
// Cmd+<key> in every app that is not on their list of terminal emulators. One is an editor with a
// terminal inside, so there Ctrl+C / Ctrl+R reached the page as Cmd+C / Cmd+R: "copy" / nothing, never
// ^C / ^R. A page cannot ask which physical key was pressed, but the remapper leaves a trace: it lets go
// of Control and presses Cmd for the user 5 ms apart (Karabiner's fixed spacing; left Control: keyup
// first, right Control: Cmd first). Fingers are slower. No trace (modifier keys swapped in System
// Settings, another tool) → the setting's "on" reads every Cmd chord in the terminal as a Ctrl chord.

/** Setting `terminal.cmdSendsCtrl`. */
export type CmdSendsCtrl = 'auto' | 'on' | 'off';
/** A Control keyup and a Cmd keydown at most this far apart (ms) were made by a remapper, not by two fingers. */
export const REMAP_GAP_MS = 30;

export interface ModifierEventLike {
  type: string;
  key: string;
  metaKey: boolean;
  timeStamp: number;
}

export function createCmdTracker() {
  let ctrlUp = -Infinity; // last keyup of a Control key
  let cmdDown = -Infinity; // keydown of the Cmd key that is held now
  let swapped = false; // the Cmd held now stands for a Control key
  const near = (a: number, b: number) => a >= b && a - b <= REMAP_GAP_MS;
  const t = {
    mode: 'auto' as CmdSendsCtrl,
    /** Takes every keydown / keyup of the window; only modifier keys change the state. */
    note(e: ModifierEventLike): void {
      if (e.key === 'Meta') {
        const down = e.type === 'keydown';
        cmdDown = down ? e.timeStamp : -Infinity;
        swapped = down && near(cmdDown, ctrlUp);
      } else if (e.key === 'Control') {
        if (e.type !== 'keyup') return; // pressed again between two chords of one hold: no news
        ctrlUp = e.timeStamp;
        if (e.metaKey && near(ctrlUp, cmdDown)) swapped = true;
      } else if (!e.metaKey) t.reset(); // Cmd was let go while the window did not see it
    },
    reset(): void {
      cmdDown = -Infinity;
      swapped = false;
    },
    /** Is this Cmd chord a Ctrl chord? (It stays one for as long as that Cmd is held.) */
    isCtrl(e: Pick<KeyLike, 'ctrlKey' | 'metaKey'>): boolean {
      return e.metaKey && !e.ctrlKey && (t.mode === 'on' || (t.mode === 'auto' && swapped));
    },
  };
  return t;
}

/** The app's one tracker: ./entry feeds it and sets its mode; the global key filter and ./view ask it. */
export const cmdTracker = createCmdTracker();

/** Feeds a tracker from a window's key events (capture: no handler can stop them first). Returns a remover. */
export function watchModifiers(target: Pick<Window, 'addEventListener' | 'removeEventListener'>, tracker: Pick<ReturnType<typeof createCmdTracker>, 'note' | 'reset'> = cmdTracker): () => void {
  const note = (e: Event) => tracker.note(e as KeyboardEvent);
  const reset = () => tracker.reset();
  target.addEventListener('keydown', note, true);
  target.addEventListener('keyup', note, true);
  target.addEventListener('blur', reset);
  return () => {
    target.removeEventListener('keydown', note, true);
    target.removeEventListener('keyup', note, true);
    target.removeEventListener('blur', reset);
  };
}
