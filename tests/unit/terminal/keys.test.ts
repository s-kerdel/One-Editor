// @vitest-environment happy-dom
// macOS terminal keys, decided by the modifiers an event carries — for both keyboards:
//  - the standard Mac layout: Ctrl+R / Ctrl+C… arrive with ctrlKey;
//  - a Windows-style remap (Karabiner-Elements): the same chords arrive as Cmd+R / Cmd+C, because the
//    remapper swaps Control for Cmd in every app that is not on its list of terminal emulators.
// Regression: Cmd+R did nothing and Cmd+C was "copy", so ^R / ^C never reached the shell.
import { beforeEach, describe, expect, it, vi } from 'vitest';

// commands.ts reads the platform once, at import: this file runs as a Mac.
vi.hoisted(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true }));

import { APP_KEYS_IN_TERMINAL, REMAP_GAP_MS, appKeyWinsInTerminal, cmdTracker, createCmdTracker, ctrlByte, terminalKeyAction, watchModifiers, type KeyLike } from '../../../src/renderer/terminal/keys';
import { readCmdSendsCtrl, TERMINAL_SETTING_DEFS } from '../../../src/renderer/terminal/settings';
import { createXtermView } from '../../../src/renderer/terminal/view';
import type { TerminalViewOptions } from '../../../src/renderer/terminal/types';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({ type: 'keydown', key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });
const mac = (e: KeyLike, o: { sel?: boolean; cmdIsCtrl?: boolean } = {}) => terminalKeyAction(e, { os: 'darwin', hasSelection: !!o.sel, cmdIsCtrl: o.cmdIsCtrl });
const CTRL = { ctrlKey: true };
const CMD = { metaKey: true };
/** readline / tty chords that must reach the shell, with the byte each one is. */
const SHELL_CHORDS: Array<[string, string]> = [['r', '\x12'], ['c', '\x03'], ['d', '\x04'], ['z', '\x1a'], ['l', '\x0c'], ['a', '\x01'], ['e', '\x05'], ['w', '\x17'], ['u', '\x15'], ['k', '\x0b'], ['n', '\x0e'], ['t', '\x14'], ['b', '\x02'], ['q', '\x11']];

type Mods = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; keyCode?: number; code?: string };
/** A key event with a chosen time: the tracker tells a remapper from fingers by the gap between modifier events. */
function fire(target: EventTarget, type: 'keydown' | 'keyup', k: string, at: number, mods: Mods = {}): KeyboardEvent {
  const e = new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...mods });
  Object.defineProperty(e, 'timeStamp', { value: at });
  target.dispatchEvent(e);
  return e;
}
/**
 * What Karabiner-Elements posts when Control is held and a key is pressed ("control+<key> → command+<key>"):
 * Control goes up, Cmd goes down, 5 ms apart — left Control: keyup first; right Control: Cmd first.
 * Returns the time at which the key itself is due.
 */
function remapperSwapsCtrlForCmd(target: EventTarget, at: number, side: 'left' | 'right' = 'left'): number {
  fire(target, 'keydown', 'Control', at - 150, CTRL); // the finger went down long before
  if (side === 'left') {
    fire(target, 'keyup', 'Control', at);
    fire(target, 'keydown', 'Meta', at + 5, CMD);
  } else {
    fire(target, 'keydown', 'Meta', at, { ctrlKey: true, metaKey: true });
    fire(target, 'keyup', 'Control', at + 5, CMD);
  }
  return at + 10;
}

beforeEach(() => {
  cmdTracker.reset();
  cmdTracker.mode = 'auto';
});

describe('macOS key policy: standard Mac layout', () => {
  it('every chord with the Control key is the shell’s (xterm.js sends it); only Ctrl+` and Ctrl+Tab are the app’s', () => {
    for (const [k] of SHELL_CHORDS) {
      expect(mac(key(k, CTRL), { sel: true }), `Ctrl+${k}`).toBeNull(); // null = xterm.js encodes it (^C even with a selection)
      expect(appKeyWinsInTerminal(`Ctrl-${k}`, 'darwin'), `Ctrl-${k}`).toBe(false); // a global command bound to it could never steal it
    }
    for (const k of ['Ctrl-ArrowLeft', 'Ctrl-ArrowRight', 'Ctrl-Alt-c', 'Ctrl-Shift-r']) expect(appKeyWinsInTerminal(k, 'darwin'), k).toBe(false);
    for (const k of ['Ctrl-`', 'Ctrl-Shift-`', 'Ctrl-Shift-~', 'Ctrl-Tab', 'Ctrl-Shift-Tab']) expect(appKeyWinsInTerminal(k, 'darwin'), k).toBe(true);
  });

  it('a real Cmd chord keeps the Mac conventions: Cmd+C/V/F/A/K are the terminal’s, the rest is the app’s, nothing is sent', () => {
    expect(mac(key('c', CMD), { sel: true })).toBe('copy');
    expect(mac(key('c', CMD))).toBe('none'); // Cmd+C without a selection is never ^C
    expect(mac(key('v', CMD))).toBe('paste');
    expect(mac(key('f', CMD))).toBe('find');
    expect(mac(key('a', CMD))).toBe('selectAll');
    expect(mac(key('k', CMD))).toBe('clear');
    for (const k of ['r', 'd', 'z', 'l', 'w', 'e', 'u']) expect(mac(key(k, CMD)), `Cmd+${k}`).toBeNull();
    for (const k of ['Mod-w', 'Mod-e', 'Mod-n', 'Mod-p', 'Mod-s', 'Mod-[', 'F1', 'Alt-ArrowLeft']) expect(appKeyWinsInTerminal(k, 'darwin'), k).toBe(true);
    for (const k of ['Mod-c', 'Mod-v', 'Mod-f', 'Mod-a', 'Mod-k']) expect(appKeyWinsInTerminal(k, 'darwin'), k).toBe(false);
  });
});

describe('macOS key policy: a Ctrl chord that arrives as a Cmd chord (Windows-style remap)', () => {
  it('goes to the shell as its control byte: ^R, ^C, ^D, ^Z, ^L, ^A, ^E, ^W, ^U, ^K…', () => {
    for (const [k, byte] of SHELL_CHORDS) expect(mac(key(k, CMD), { cmdIsCtrl: true }), `Cmd+${k}`).toEqual({ send: byte });
    expect(mac(key('[', CMD), { cmdIsCtrl: true })).toEqual({ send: '\x1b' }); // Ctrl+[ = Esc (vi)
    expect(mac(key('с', { metaKey: true, code: 'KeyC' }), { cmdIsCtrl: true })).toEqual({ send: '\x03' }); // Cyrillic layout
    expect(ctrlByte('\\')).toBe('\x1c');
    expect(ctrlByte(']')).toBe('\x1d');
    for (const k of ['1', 'ArrowLeft', 'Enter', '`', ',']) expect(ctrlByte(k), k).toBeNull();
  });

  it('copy / paste / find follow Windows Terminal: Ctrl+C copies only with a selection, else it is ^C', () => {
    expect(mac(key('c', CMD), { cmdIsCtrl: true, sel: true })).toBe('copy');
    expect(mac(key('c', CMD), { cmdIsCtrl: true, sel: false })).toEqual({ send: '\x03' });
    expect(mac(key('v', CMD), { cmdIsCtrl: true })).toBe('paste');
    expect(mac(key('f', CMD), { cmdIsCtrl: true })).toBe('find');
    expect(mac(key('C', { metaKey: true, shiftKey: true }), { cmdIsCtrl: true, sel: true })).toBe('copy');
    expect(mac(key('C', { metaKey: true, shiftKey: true }), { cmdIsCtrl: true })).toBe('none'); // never a stray ^C
    expect(mac(key('V', { metaKey: true, shiftKey: true }), { cmdIsCtrl: true })).toBe('paste');
    expect(mac(key('R', { metaKey: true, shiftKey: true }), { cmdIsCtrl: true })).toBeNull();
    expect(mac(key('r', { metaKey: true, altKey: true }), { cmdIsCtrl: true })).toBeNull();
  });

  it('the app keeps exactly the shortcuts it keeps on Windows/Linux (APP_KEYS_IN_TERMINAL)', () => {
    for (const k of ['Mod-w', 'Mod-e', 'Mod-n', 'Mod-t', 'Mod-k', 'Mod-a', 'Mod-b', 'Mod-r', 'Mod-c', 'Mod-d', 'Mod-z', 'Mod-l', 'Mod-u', 'Mod-o', 'Mod-[', 'Mod-]']) expect(appKeyWinsInTerminal(k, 'darwin', true), k).toBe(false);
    for (const k of APP_KEYS_IN_TERMINAL) if (k.startsWith('Mod-')) expect(appKeyWinsInTerminal(k, 'darwin', true), k).toBe(true);
    for (const k of ['Mod-p', 'Mod-Shift-p', 'Mod-s', 'Mod-,', 'Mod-Shift-f', 'Mod-Alt-z', 'Mod-=', 'Mod-0']) expect(APP_KEYS_IN_TERMINAL.has(k), k).toBe(true);
    expect(appKeyWinsInTerminal('F1', 'darwin', true)).toBe(true); // not a Cmd chord: as before
  });

  it('other platforms never look at the flag', () => {
    expect(terminalKeyAction(key('r', CMD), { os: 'linux', hasSelection: false, cmdIsCtrl: true })).toBeNull();
    expect(terminalKeyAction(key('c', CTRL), { os: 'win32', hasSelection: false, cmdIsCtrl: true })).toBeNull();
    expect(appKeyWinsInTerminal('Mod-w', 'win32', true)).toBe(false);
    expect(appKeyWinsInTerminal('Mod-p', 'linux', true)).toBe(true);
  });
});

describe('telling a remapper from fingers (createCmdTracker)', () => {
  const ev = (type: string, k: string, timeStamp: number, metaKey = false) => ({ type, key: k, metaKey, timeStamp });
  const cmdChord = { ctrlKey: false, metaKey: true };

  it('left Control: keyup, then Cmd down 5 ms later → the Cmd chords of that hold are Ctrl chords', () => {
    const t = createCmdTracker();
    t.note(ev('keydown', 'Control', 1000));
    expect(t.isCtrl(cmdChord)).toBe(false);
    t.note(ev('keyup', 'Control', 1200));
    t.note(ev('keydown', 'Meta', 1205, true));
    expect(t.isCtrl(cmdChord)).toBe(true);
    // Control still held: the remapper may press it again between two chords, and let go of it again.
    t.note(ev('keydown', 'r', 1210, true));
    t.note(ev('keydown', 'Control', 1400, true));
    t.note(ev('keyup', 'Control', 1900, true));
    t.note(ev('keydown', 'c', 1910, true));
    expect(t.isCtrl(cmdChord)).toBe(true);
    t.note(ev('keyup', 'Meta', 2000));
    expect(t.isCtrl(cmdChord)).toBe(false);
  });

  it('right Control: Cmd goes down first, Control up 5 ms later', () => {
    const t = createCmdTracker();
    t.note(ev('keydown', 'Control', 1000));
    t.note(ev('keydown', 'Meta', 1200, true));
    expect(t.isCtrl(cmdChord)).toBe(false);
    t.note(ev('keyup', 'Control', 1205, true));
    expect(t.isCtrl(cmdChord)).toBe(true);
  });

  it('fingers are slower: Ctrl+C, then Cmd+K is a real Cmd chord (at any human gap)', () => {
    for (const gap of [REMAP_GAP_MS + 1, 80, 400, 60_000]) {
      const t = createCmdTracker();
      t.note(ev('keydown', 'Control', 1000));
      t.note(ev('keydown', 'c', 1100));
      t.note(ev('keyup', 'c', 1150));
      t.note(ev('keyup', 'Control', 1200));
      t.note(ev('keydown', 'Meta', 1200 + gap, true));
      expect(t.isCtrl(cmdChord), `${gap} ms`).toBe(false);
    }
    const t = createCmdTracker();
    t.note(ev('keydown', 'Meta', 1000, true)); // Cmd alone, Control tapped much later while Cmd is held
    t.note(ev('keydown', 'Control', 1500, true));
    t.note(ev('keyup', 'Control', 1600, true));
    expect(t.isCtrl(cmdChord)).toBe(false);
  });

  it('forgets the hold when Cmd is released, the window loses focus, or a key arrives without Cmd', () => {
    const swap = () => {
      const t = createCmdTracker();
      t.note(ev('keyup', 'Control', 1000));
      t.note(ev('keydown', 'Meta', 1005, true));
      expect(t.isCtrl(cmdChord)).toBe(true);
      return t;
    };
    let t = swap();
    t.note(ev('keyup', 'Meta', 1100));
    expect(t.isCtrl(cmdChord)).toBe(false);
    t = swap();
    t.reset(); // window blur: the keyup went to another app
    expect(t.isCtrl(cmdChord)).toBe(false);
    t = swap();
    t.note(ev('keydown', 'x', 5000)); // no Cmd on it: that keyup was missed
    expect(t.isCtrl(cmdChord)).toBe(false);
  });

  it('a chord that carries both Control and Cmd is never read as a Ctrl chord; the setting overrides detection', () => {
    const t = createCmdTracker();
    t.note(ev('keyup', 'Control', 1000));
    t.note(ev('keydown', 'Meta', 1005, true));
    expect(t.isCtrl({ ctrlKey: true, metaKey: true })).toBe(false);
    expect(t.isCtrl({ ctrlKey: true, metaKey: false })).toBe(false);
    t.mode = 'off';
    expect(t.isCtrl(cmdChord)).toBe(false);
    const forced = createCmdTracker();
    forced.mode = 'on'; // no trace to detect (modifier keys swapped in System Settings): every Cmd chord
    expect(forced.isCtrl(cmdChord)).toBe(true);
    expect(forced.isCtrl({ ctrlKey: false, metaKey: false })).toBe(false);
  });

  it('watchModifiers feeds it from a window (capture) and resets on blur', () => {
    const t = createCmdTracker();
    const off = watchModifiers(window, t);
    const box = document.createElement('textarea');
    document.body.append(box);
    box.addEventListener('keydown', (e) => e.stopPropagation()); // a widget that swallows keys cannot hide them
    remapperSwapsCtrlForCmd(box, 1000);
    expect(t.isCtrl(cmdChord)).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(t.isCtrl(cmdChord)).toBe(false);
    off();
    remapperSwapsCtrlForCmd(box, 3000);
    expect(t.isCtrl(cmdChord)).toBe(false);
    box.remove();
  });

  it('setting terminal.cmdSendsCtrl: auto by default, validated', () => {
    expect(readCmdSendsCtrl({})).toBe('auto');
    expect(readCmdSendsCtrl({ 'terminal.cmdSendsCtrl': 'on' })).toBe('on');
    expect(readCmdSendsCtrl({ 'terminal.cmdSendsCtrl': 'off' })).toBe('off');
    expect(readCmdSendsCtrl({ 'terminal.cmdSendsCtrl': true })).toBe('auto');
    const def = TERMINAL_SETTING_DEFS.find((d) => d.key === 'terminal.cmdSendsCtrl')!;
    expect(def.default).toBe('auto');
    expect(def.control).toMatchObject({ type: 'segmented', options: [{ v: 'auto' }, { v: 'on' }, { v: 'off' }] });
  });
});

describe('the app’s global keymap with a focused terminal on a Mac (entry.ts filter)', () => {
  it('standard layout and remap: the shell gets its chords, the app keeps its own', async () => {
    const { app } = await import('../../../src/renderer/app/app');
    (app as { backend: unknown }).backend = { os: 'darwin', kind: 'browser' };
    const { installGlobalKeymap, registerCommands, isMac } = await import('../../../src/renderer/app/commands');
    expect(isMac).toBe(true);
    await import('../../../src/renderer/terminal/entry'); // installs the filter, watches the window's modifier keys
    installGlobalKeymap(window);
    const ran: string[] = [];
    const cmd = (id: string, keys: string[]) => ({ id: `test.${id}`, title: id, keys, run: () => void ran.push(id) });
    // Ctrl-r / Ctrl-c: nothing binds them today — if a command ever does, the terminal must still win.
    const off = registerCommands([cmd('closeTab', ['Mod-w']), cmd('quickOpen', ['Mod-p']), cmd('save', ['Mod-s']), cmd('ctrlR', ['Ctrl-r']), cmd('ctrlC', ['Ctrl-c']), cmd('nextTab', ['Ctrl-Tab'])]);
    const view = document.createElement('div');
    view.className = 'se-term-view';
    const term = view.appendChild(document.createElement('textarea'));
    const editor = document.createElement('textarea');
    document.body.append(view, editor);
    const press = (target: EventTarget, k: string, at: number, mods: Mods) => {
      ran.length = 0;
      const e = fire(target, 'keydown', k, at, mods);
      return { ran: [...ran], taken: e.defaultPrevented };
    };

    // Standard Mac layout.
    expect(press(term, 'r', 1000, CTRL)).toEqual({ ran: [], taken: false }); // → xterm.js → ^R
    expect(press(term, 'c', 1100, CTRL)).toEqual({ ran: [], taken: false });
    expect(press(term, 'Tab', 1200, CTRL)).toEqual({ ran: ['nextTab'], taken: true }); // one of the app's few Control chords
    expect(press(editor, 'r', 1300, CTRL)).toEqual({ ran: ['ctrlR'], taken: true }); // only the terminal is special
    fire(term, 'keydown', 'Meta', 2000, CMD); // a finger on the real Cmd key
    expect(press(term, 'w', 2100, CMD)).toEqual({ ran: ['closeTab'], taken: true });
    expect(press(term, 'p', 2200, CMD)).toEqual({ ran: ['quickOpen'], taken: true });
    fire(term, 'keyup', 'Meta', 2300);

    // Windows-style remap: the same physical Ctrl+W / Ctrl+R arrive as Cmd+W / Cmd+R.
    for (const side of ['left', 'right'] as const) {
      const t0 = side === 'left' ? 5000 : 8000;
      const at = remapperSwapsCtrlForCmd(term, t0, side);
      expect(press(term, 'w', at, CMD), side).toEqual({ ran: [], taken: false }); // not "close tab": the view sends ^W
      expect(press(term, 'r', at + 300, CMD), side).toEqual({ ran: [], taken: false });
      expect(press(term, 'p', at + 600, CMD), side).toEqual({ ran: ['quickOpen'], taken: true }); // as Ctrl+P on Windows
      expect(press(term, 's', at + 900, CMD), side).toEqual({ ran: ['save'], taken: true });
      expect(press(editor, 'w', at + 1200, CMD), side).toEqual({ ran: ['closeTab'], taken: true }); // outside the terminal Cmd is Cmd
      fire(term, 'keyup', 'Meta', at + 1500);
    }

    // The setting: off = never, on = always (no trace to detect).
    (app.settings as { value: Record<string, unknown> }).value = { ...app.settings.value, 'terminal.cmdSendsCtrl': 'off' };
    app.events.emit('settings:changed', app.settings.value);
    expect(press(term, 'w', remapperSwapsCtrlForCmd(term, 20000), CMD)).toEqual({ ran: ['closeTab'], taken: true });
    fire(term, 'keyup', 'Meta', 20500);
    (app.settings as { value: Record<string, unknown> }).value = { ...app.settings.value, 'terminal.cmdSendsCtrl': 'on' };
    app.events.emit('settings:changed', app.settings.value);
    fire(term, 'keydown', 'Meta', 30000, CMD);
    expect(press(term, 'w', 30100, CMD)).toEqual({ ran: [], taken: false });
    expect(press(term, 'p', 30200, CMD)).toEqual({ ran: ['quickOpen'], taken: true });
    (app.settings as { value: Record<string, unknown> }).value = { ...app.settings.value, 'terminal.cmdSendsCtrl': 'auto' };
    app.events.emit('settings:changed', app.settings.value);

    off();
    view.remove();
    editor.remove();
  });
});

describe('xterm view on a Mac: what the shell receives', () => {
  const opts = (over: Partial<TerminalViewOptions> = {}): TerminalViewOptions => ({ os: 'darwin', fontSize: 13, fontFamily: 'monospace', scrollback: 100, theme: null, openUrl: () => {}, resolvePath: () => null, openPath: () => {}, onFind: () => {}, onClipboardError: () => {}, ...over });
  const code = (k: string) => k.toUpperCase().charCodeAt(0); // KeyboardEvent.keyCode of a letter (xterm.js reads it)

  it('Ctrl+R / Ctrl+C reach it as ^R / ^C on both keyboards; a real Cmd chord sends nothing', () => {
    const off = watchModifiers(window); // what entry.ts does on a Mac
    let found = 0;
    const v = createXtermView(opts({ onFind: () => found++ }));
    document.body.append(v.element);
    v.focus(); // opens xterm.js: its key handling lives on the helper textarea
    const ta = v.element.querySelector('textarea')!;
    expect(ta).toBeTruthy();
    const sent: string[] = [];
    v.onInput((d) => sent.push(d));
    const press = (k: string, at: number, mods: Mods) => {
      sent.length = 0;
      const e = fire(ta, 'keydown', k, at, { keyCode: code(k), code: `Key${k.toUpperCase()}`, ...mods });
      return { sent: sent.join(''), taken: e.defaultPrevented };
    };

    // Standard Mac layout: xterm.js encodes the Control chord itself.
    for (const [k, byte] of SHELL_CHORDS) expect(press(k, 1000, CTRL).sent, `Ctrl+${k}`).toBe(byte);
    // A finger on the real Cmd key: nothing reaches the shell (Cmd+C without a selection is not ^C).
    fire(ta, 'keydown', 'Meta', 2000, CMD);
    for (const k of ['r', 'c', 'd', 'z', 'w', 'k', 'a']) expect(press(k, 2100, CMD).sent, `Cmd+${k}`).toBe('');
    fire(ta, 'keyup', 'Meta', 2200);

    // Windows-style remap: Ctrl+<key> arrives as Cmd+<key> — same bytes, and the event is taken
    // (else the macOS menu would also run Cmd+W "Close Window", Cmd+Z, Cmd+A…).
    const at = remapperSwapsCtrlForCmd(ta, 5000);
    for (const [k, byte] of SHELL_CHORDS) expect(press(k, at, CMD), `Cmd+${k}`).toEqual({ sent: byte, taken: true });
    expect(press('f', at, CMD)).toEqual({ sent: '', taken: true }); // find, as Ctrl+F on Windows/Linux
    expect(found).toBe(1);
    fire(ta, 'keyup', 'Meta', at + 500);
    expect(press('r', at + 600, CMD).sent).toBe(''); // Cmd let go: a later Cmd+R is a Cmd chord again

    // Setting "Always": every Cmd chord, no trace needed.
    cmdTracker.mode = 'on';
    expect(press('r', 9000, CMD)).toEqual({ sent: '\x12', taken: true });
    v.dispose();
    off();
  });

  it('other platforms: a Meta chord is never turned into a control byte', () => {
    cmdTracker.mode = 'on';
    const v = createXtermView(opts({ os: 'linux' }));
    document.body.append(v.element);
    v.focus();
    const ta = v.element.querySelector('textarea')!;
    const sent: string[] = [];
    v.onInput((d) => sent.push(d));
    fire(ta, 'keydown', 'r', 1000, { metaKey: true, keyCode: 82 });
    expect(sent).toEqual([]);
    fire(ta, 'keydown', 'r', 1100, { ctrlKey: true, keyCode: 82 });
    expect(sent).toEqual(['\x12']);
    v.dispose();
  });
});
