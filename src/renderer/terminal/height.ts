// Terminal panel height (lazy chunk): remembered per device.
import { signal } from '@preact/signals';

export const PANEL_DEFAULT_HEIGHT = 260;
export const PANEL_MIN_HEIGHT = 120;
const KEY = 'se-term-height';

function saved(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return n >= PANEL_MIN_HEIGHT && n <= 4000 ? n : PANEL_DEFAULT_HEIGHT;
  } catch {
    return PANEL_DEFAULT_HEIGHT;
  }
}

/** CSS px (the panel clamps it to the window when drawn). */
export const panelHeight = signal(typeof localStorage === 'undefined' ? PANEL_DEFAULT_HEIGHT : saved());

export function setPanelHeight(px: number, persist = false) {
  panelHeight.value = Math.round(px);
  if (!persist) return;
  try {
    localStorage.setItem(KEY, String(panelHeight.value));
  } catch {}
}

/** Panel fills the editor area (the editor is collapsed, not unmounted); restore = back to `panelHeight`. */
export const panelMax = signal(false);
