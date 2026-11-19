// Window frame (Settings → Appearance → Window frame). Pure helpers (no electron import) so the
// options, IPC validation and restart flow are unit-tested.
//  - 'integrated' (default): Electron's Window Controls Overlay. The native title bar is gone, the
//    tab strip doubles as the title bar, and the OS still draws min/max/close — Windows 11 Snap
//    Layouts, double-click-to-maximize and accessibility keep working.
//  - 'native': the operating system's title bar, as before.
import type { Settings } from '../shared/api';

export type WindowFrame = 'integrated' | 'native';

export interface TitleBarOverlay {
  /** Background of the controls area: the tab strip colour under it (#rrggbb). */
  color: string;
  /** Glyph colour of minimize / maximize / close (#rrggbb). */
  symbolColor: string;
  /** Window units (DIP): the tab strip's height above its bottom rule. */
  height: number;
}

/** Remembered overlay colours per theme brightness + last height, so the next launch paints right at once. */
export interface TitleBarCache {
  dark?: { color: string; symbolColor: string };
  light?: { color: string; symbolColor: string };
  height?: number;
}

export const frameOf = (s: Partial<Settings> | null | undefined): WindowFrame => (s?.windowFrame === 'native' ? 'native' : 'integrated');

const HEX = /^#[0-9a-f]{6}$/;
export const OVERLAY_MIN_H = 16;
export const OVERLAY_MAX_H = 160;

/** Renderer → main overlay update. Anything but the exact shape is refused (null). */
export function parseOverlay(v: unknown): TitleBarOverlay | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'color' && k !== 'symbolColor' && k !== 'height')) return null;
  const color = typeof o.color === 'string' ? o.color.toLowerCase() : '';
  const symbolColor = typeof o.symbolColor === 'string' ? o.symbolColor.toLowerCase() : '';
  const h = o.height;
  if (!HEX.test(color) || !HEX.test(symbolColor)) return null;
  if (typeof h !== 'number' || !Number.isInteger(h) || h < OVERLAY_MIN_H || h > OVERLAY_MAX_H) return null;
  return { color, symbolColor, height: h };
}

// First launch only (nothing cached yet): the tab strip colours of styles/app.css (--bg-sunken /
// --text-muted) and --tab-h per density. From then on the renderer reports the measured values.
const FALLBACK = { dark: { color: '#16181c', symbolColor: '#8f96a3' }, light: { color: '#f6f6f5', symbolColor: '#5f6670' } };
const TAB_H: Record<string, number> = { compact: 34, comfortable: 38, spacious: 42 };

/** The overlay to create the window with: cached from the last run, else derived from the settings. */
export function initialOverlay(s: Partial<Settings>, dark: boolean, cache?: TitleBarCache | null): TitleBarOverlay {
  const colors = (dark ? cache?.dark : cache?.light) ?? FALLBACK[dark ? 'dark' : 'light'];
  const zoom = typeof s.zoom === 'number' && s.zoom > 0 ? Math.min(3, Math.max(0.5, s.zoom)) : 1;
  const derived = Math.round(((TAB_H[s.uiDensity ?? ''] ?? 38) - 1) * zoom); // minus the strip's 1px bottom rule
  const cached = cache?.height;
  const height = typeof cached === 'number' && cached >= OVERLAY_MIN_H && cached <= OVERLAY_MAX_H ? cached : derived;
  return { ...colors, height };
}

/** Next cache after the renderer reported an overlay for the current theme brightness. */
export const rememberOverlay = (cache: TitleBarCache | null | undefined, o: TitleBarOverlay, dark: boolean): TitleBarCache => ({
  ...cache,
  [dark ? 'dark' : 'light']: { color: o.color, symbolColor: o.symbolColor },
  height: o.height,
});

/** BrowserWindow options for the frame. macOS keeps its traffic lights (inset) and only gains the WCO API. */
export function frameWindowOptions(frame: WindowFrame, platform: string, overlay: TitleBarOverlay): Record<string, unknown> {
  if (frame === 'native') return {};
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', titleBarOverlay: true };
  return { titleBarStyle: 'hidden', titleBarOverlay: { ...overlay } };
}

/**
 * "Restart now" (the frame can only be chosen when the window is created). The restart goes through the
 * normal close flow — flush autosaves, "Save changes?" — so it can never lose edits; a Cancel there
 * cancels the restart too.
 */
export function createRelaunch(hooks: { close: () => void; relaunch: () => void; exit: (code: number) => void }) {
  let requested = false;
  return {
    get requested() {
      return requested;
    },
    /** Renderer asked for a restart: close the window the normal way. */
    request() {
      requested = true;
      hooks.close();
    },
    /** The user cancelled the close ("Save changes?" → Cancel). */
    cancelled() {
      requested = false;
    },
    /** All windows are gone. Returns true when this was a restart (and the app is relaunching). */
    allClosed(): boolean {
      if (!requested) return false;
      hooks.relaunch();
      hooks.exit(0);
      return true;
    },
  };
}

/** Perceived brightness of #rrggbb below the midpoint (a dark theme's strip). */
export function isDarkColor(hex: string): boolean {
  const n = parseInt(hex.slice(1, 7), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}
