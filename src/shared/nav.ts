// Back / forward navigation: what the main process and the renderer share.
// Mouse side buttons reach the app twice on Windows (a DOM mouse event AND a BrowserWindow
// `app-command`), so every input goes through one de-duplicator: one press = one step.

export type NavDir = 'back' | 'forward';
/** Where a request came from; the same press may arrive from two of them. */
export type NavSource = 'key' | 'mouse' | 'app';

/** preload channel: main → renderer, payload = NavDir. */
export const NAV_CHANNEL = 'app:navigate';

/** BrowserWindow `app-command` name → direction (null: not ours, e.g. media keys). */
export function navFromAppCommand(cmd: unknown): NavDir | null {
  return cmd === 'browser-backward' ? 'back' : cmd === 'browser-forward' ? 'forward' : null;
}

/** DOM `MouseEvent.button` → direction (3 = back, 4 = forward; wheel tilt / swipes are never bound). */
export function navFromMouseButton(button: number): NavDir | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null;
}

/** The echo of one press on the other channel arrives within a few ms; a human double press is slower. */
export const NAV_ECHO_MS = 250;

/**
 * Returns a filter: true = act on this request, false = it is the echo of the one just handled.
 * Only a *different* source repeating the same direction counts as an echo, so two quick presses of
 * the same button still make two steps (each press is then filtered against its own echo).
 */
export function createNavDeduper(windowMs = NAV_ECHO_MS): (dir: NavDir, source: NavSource, now: number) => boolean {
  let last: { dir: NavDir; source: NavSource; at: number } | null = null;
  return (dir, source, now) => {
    if (last && last.dir === dir && last.source !== source && source !== 'key' && last.source !== 'key' && now - last.at < windowMs) return false;
    last = { dir, source, at: now };
    return true;
  };
}
