// Central command registry. Every feature exposes its actions here so the command palette,
// global keybindings and menus all stay in sync. Keys use CodeMirror notation: "Mod-Shift-p".

export interface Command {
  id: string; // 'search.openPanel'
  title: string; // 'Search: Find in files'
  category?: string;
  keys?: string[]; // bound GLOBALLY (capture phase, beats the editor)
  /** Shown in the palette only; the editor handles these keys itself (e.g. Mod-b bold). */
  displayKeys?: string[];
  keywords?: string[]; // extra palette search terms
  when?: () => boolean;
  run: () => void | Promise<void>;
  /** Hide from palette (internal commands). */
  hidden?: boolean;
}

const registry = new Map<string, Command>();
const listeners = new Set<() => void>();

export function registerCommand(cmd: Command): () => void {
  registry.set(cmd.id, cmd);
  listeners.forEach((l) => l());
  return () => {
    registry.delete(cmd.id);
    listeners.forEach((l) => l());
  };
}

export function registerCommands(cmds: Command[]): () => void {
  const offs = cmds.map(registerCommand);
  return () => offs.forEach((o) => o());
}

export function getCommand(id: string) {
  return registry.get(id);
}

/** `all`: also commands whose `when` is currently false (shortcut reference in Settings). */
export function listCommands(opts?: { all?: boolean }): Command[] {
  return [...registry.values()].filter((c) => !c.hidden && (opts?.all || !c.when || c.when()));
}

export function onCommandsChanged(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function runCommand(id: string): Promise<boolean> {
  const c = registry.get(id);
  if (!c || (c.when && !c.when())) return false;
  await c.run();
  return true;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** Normalises a KeyboardEvent to "Mod-Shift-p" form (Mod = Ctrl on Win/Linux, Cmd on Mac). */
export function eventToKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (mod) parts.push('Mod');
  if (isMac && e.ctrlKey) parts.push('Ctrl');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k.length === 1) k = k.toLowerCase();
  if (e.code?.startsWith('Digit')) k = e.code.slice(5);
  // macOS Option+letter yields symbols ("ƒ"); use the physical key instead.
  else if (e.altKey && e.code?.startsWith('Key')) k = e.code.slice(3).toLowerCase();
  parts.push(k);
  return parts.join('-');
}

const MOD_ORDER = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

/** Canonical modifier order so "Shift-Alt-f" and "Alt-Shift-f" are the same binding. */
export function normalizeKey(spec: string): string {
  const parts = spec.split('-');
  let key = parts.pop() ?? '';
  if (key === '' && spec.endsWith('-')) key = '-'; // "Mod--" (zoom out)
  const mods = parts.filter(Boolean).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, key.length === 1 ? key.toLowerCase() : key].join('-');
}

export function prettyKey(key: string): string {
  return key
    .split('-')
    .map((p) => (p === 'Mod' ? (isMac ? '⌘' : 'Ctrl') : p === 'Shift' ? (isMac ? '⇧' : 'Shift') : p === 'Alt' ? (isMac ? '⌥' : 'Alt') : p.length === 1 ? p.toUpperCase() : p))
    .join(isMac ? '' : '+');
}

/**
 * AltGr is reported as Ctrl+Alt on Windows: AltGr+B types "{" on a Hungarian layout, AltGr+L "ł" on a
 * Polish one. A key that produced a character other than its own letter is text, never a Ctrl+Alt shortcut.
 */
export function isAltGrText(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || !e.altKey || e.key.length !== 1 || !e.getModifierState?.('AltGraph')) return false;
  const letter = e.code?.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.code?.startsWith('Digit') ? e.code.slice(5) : '';
  return e.key.toLowerCase() !== letter;
}

/** false → the key goes to the focused widget, not to a global command (the terminal's shell gets Ctrl+W/E/N…). */
let keyFilter: ((e: KeyboardEvent, key: string) => boolean) | null = null;
export const setGlobalKeyFilter = (fn: typeof keyFilter) => void (keyFilter = fn);

/** Global keybinding dispatcher. Runs in capture phase only for Mod-chords so the editor keeps its own keys. */
export function installGlobalKeymap(target: Window = window) {
  target.addEventListener(
    'keydown',
    (e) => {
      if (!(e.ctrlKey || e.metaKey || e.altKey || /^F\d{1,2}$/.test(e.key))) return;
      if (isAltGrText(e)) return;
      const key = eventToKey(e);
      if (keyFilter && !keyFilter(e, key)) return;
      for (const c of registry.values()) {
        if (c.keys?.some((k) => normalizeKey(k) === key) && (!c.when || c.when())) {
          e.preventDefault();
          e.stopPropagation();
          void c.run();
          return;
        }
      }
    },
    true,
  );
}
