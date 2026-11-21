// Integrated window frame (desktop): the OS draws minimize / maximize / close over the right end of the
// tab strip (Electron's Window Controls Overlay). Keep them the strip's colour and height, read from the
// live CSS (theme, accent, density, zoom), so there is never a second palette to keep in sync.
// Lazy chunk: only loaded when the window really has the integrated frame.
import { app } from './app';
import * as ui from './ui';

/** CSS colour (as getComputedStyle reports it, or a token's literal value) → #rrggbb, else null. */
export function toHex(css: string): string | null {
  const s = css.trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + [...m[1]].map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s);
  if (m) return '#' + m[1];
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (!m) return null;
  return '#' + m.slice(1, 4).map((v) => Math.min(255, Math.round(Number(v))).toString(16).padStart(2, '0')).join('');
}

/** `transparent`, `rgba(0, 0, 0, 0)`, `rgb(0 0 0 / 0)` … */
export function isTransparent(c: string): boolean {
  const s = c.trim().toLowerCase();
  if (!s || s === 'transparent') return true;
  const parts = /^rgba?\(([^)]*)\)$/.exec(s)?.[1].split(/[\s,/]+/).filter(Boolean);
  return !!parts && parts.length === 4 && parseFloat(parts[3]) === 0;
}

/** The colour actually painted behind `el` (first opaque background up the tree). */
export function paintedBackground(el: Element | null): string {
  for (let e = el; e; e = e.parentElement) {
    const c = getComputedStyle(e).backgroundColor;
    if (!isTransparent(c)) return c;
  }
  return '';
}

/** What the overlay should look like now, or null when the strip is not rendered. */
export function measureTitleBar(): { color: string; symbolColor: string; height: number } | null {
  // Zen mode: an empty band takes the strip's place (app/zen.tsx), painted like the editor behind it.
  const bar = document.querySelector<HTMLElement>('.se-tabbar, .se-zen-bar');
  if (!bar) return null;
  const cs = getComputedStyle(bar);
  // File overview open: the controls sit over its top band (shelf: the backdrop; classic: the panel).
  const corner = document.querySelector('.se-overview .se-ov-head') ?? document.querySelector('.se-overview');
  const color = toHex(paintedBackground(corner ?? bar));
  const symbolColor = toHex(cs.getPropertyValue('--text-muted'));
  if (!color || !symbolColor) return null;
  // Overlay height is in window units: CSS px × zoom. Stop above the strip's bottom rule so it runs on under the controls.
  const z = Number(app.settings.value.zoom);
  const zoom = z > 0 ? Math.min(3, Math.max(0.5, z)) : 1;
  const css = bar.getBoundingClientRect().height - (parseFloat(cs.borderBottomWidth) || 0);
  return { color, symbolColor, height: Math.round(css * zoom) };
}

let last = '';
let queued = false;
export function syncTitleBar() {
  queued = false;
  const o = measureTitleBar();
  if (!o) return;
  const key = JSON.stringify(o);
  if (key === last) return;
  last = key;
  app.backend.setTitleBarOverlay?.(o);
}

// A settings change has already updated <html data-*> when the event fires; the re-render (sidebar style) lands right after.
const schedule = () => {
  if (queued) return;
  queued = true;
  setTimeout(syncTitleBar, 0);
};

export function installTitleBar() {
  if (app.backend.frame !== 'integrated' || !app.backend.setTitleBarOverlay) return;
  syncTitleBar();
  app.events.on('settings:changed', schedule);
  // Opening / closing the file overview moves the controls between the strip and the overview's top band.
  ui.overviewVisible.subscribe(schedule);
  ui.zen.subscribe(schedule);
  // Theme "System": the OS switched light/dark (also fires when main applies a new theme source).
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  // A drag region takes no drops: while a tab or file is dragged, the strip's empty end must accept it
  // (reorder to the end, open from the tree). styles/app.css turns the strip no-drag under html.se-dragging.
  const html = document.documentElement;
  addEventListener('dragstart', () => html.classList.add('se-dragging'), true);
  for (const t of ['dragend', 'drop']) addEventListener(t, () => html.classList.remove('se-dragging'), true);
}
