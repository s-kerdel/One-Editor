// Settings: applied optimistically (instant UI), persisted to the backend debounced.
import type { Settings } from '@shared/api';
import { app } from './app';
import * as ui from './ui';
import { refreshTree } from './documents';

export const ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Partial<Settings> = {};

const CONTENT_WIDTH: Record<string, string> = { wide: '1200px', full: 'none' };

export function applySettingsToDom(s: Settings) {
  const root = document.documentElement;
  // Attributes drive the CSS; the same values are cached for theme-boot.js (applied before first paint).
  const attrs: Record<string, string> = {
    theme: s.theme,
    ui: s.sidebarStyle === 'classic' ? 'classic' : 'shelf',
    corners: s.cornerStyle === 'square' ? 'square' : '',
    density: s.uiDensity === 'compact' || s.uiDensity === 'spacious' ? s.uiDensity : '',
    folders: s['tree.folderColors'] === 'one' ? 'one' : '',
  };
  // Picked colours → derived per-theme stylesheets (app/accent.ts): the accent and the one folder colour.
  const sheets = { accent: s.accentColor, folder: s['tree.folderColor'] } as Record<'accent' | 'folder', unknown>;
  try {
    for (const k in attrs) {
      if (attrs[k]) root.dataset[k] = attrs[k];
      else delete root.dataset[k];
      if (attrs[k]) localStorage.setItem(`sec-edit-${k}`, attrs[k]);
      else localStorage.removeItem(`sec-edit-${k}`);
    }
  } catch {}
  // The derived tokens live in cached stylesheets; the colour maths only load when one is stale.
  for (const k of ['accent', 'folder'] as const) {
    const v = sheets[k];
    const hex = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : '';
    const sheet = document.getElementById(`se-${k}`);
    if (!hex) {
      sheet?.remove();
      try {
        localStorage.removeItem(`sec-edit-${k}`);
      } catch {}
    } else if (!sheet?.textContent?.startsWith(`/*${hex}*/`)) void import('./accent').then((m) => m.applyColorSheet(k, hex));
  }
  root.style.setProperty('--editor-font-size', `${s.fontSize}px`);
  if (s.editorFont?.trim()) root.style.setProperty('--font-editor', s.editorFont.trim());
  else root.style.removeProperty('--font-editor');
  root.style.setProperty('--content-width', CONTENT_WIDTH[s.contentWidth ?? ''] ?? '860px');
  const lh = Number(s.editorLineHeight);
  root.style.setProperty('--editor-line-height', String(lh >= 1 && lh <= 3 ? lh : 1.65));
  const zoom = typeof s.zoom === 'number' && s.zoom > 0 ? s.zoom : 1;
  app.backend?.setZoom?.(zoom);
}

export function updateSettings(patch: Partial<Settings>, debounceMs = 0) {
  const next = { ...app.settings.value, ...patch } as Settings;
  app.settings.value = next;
  applySettingsToDom(next);
  app.editor?.applySettings(next);
  if ('viewMode' in patch) app.editor?.setViewMode(next.viewMode);
  app.events.emit('settings:changed', next);
  Object.assign(pending, patch);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSettings(), debounceMs);
}

export async function flushSettings() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  const patch = pending;
  pending = {};
  if (!Object.keys(patch).length) return;
  try {
    await app.backend.saveSettings(patch);
    if ('excludeGlobs' in patch || 'showHiddenFiles' in patch) await refreshTree();
  } catch (err) {
    app.toast(`Could not save settings: ${(err as Error).message}`, 'error');
  }
}

// A refresh / close inside the save debounce must not drop the last change (keepalive in browser mode).
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => void flushSettings());

// ---- view modes -----------------------------------------------------------------------------
type Mode = Settings['viewMode'];
let lastSingle: 'live' | 'source' = 'live';

export function setViewMode(m: Mode) {
  const cur = app.settings.value.viewMode;
  if (cur === 'live' || cur === 'source') lastSingle = cur;
  if (cur !== 'preview') ui.lastEditMode.value = cur;
  if (m === cur) return;
  updateSettings({ viewMode: m });
  // Leaving reading view hides the focused element, which drops focus to <body>; keyboard users
  // must land back in the editor. Never steal focus from an input/dialog the user is in.
  if (m !== 'preview') {
    requestAnimationFrame(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el.closest('.se-editor-area')) app.editor?.focus();
    });
  }
}

/** Mod-e: preview ↔ the mode you were editing in. */
export function toggleEditPreview() {
  const cur = app.settings.value.viewMode;
  setViewMode(cur === 'preview' ? ui.lastEditMode.value : 'preview');
}

/** Mod-\: split ↔ single editor. */
export function toggleSplit() {
  setViewMode(app.settings.value.viewMode === 'split' ? lastSingle : 'split');
}

export const activeIsMarkdown = () => ui.isMarkdownView(app.activePath.value);

// ---- zoom -----------------------------------------------------------------------------------
export function zoom(dir: 1 | -1 | 0) {
  const cur = app.settings.value.zoom ?? 1;
  let next = 1;
  if (dir !== 0) {
    const i = ZOOM_STEPS.findIndex((z) => z >= cur - 0.001);
    const at = i === -1 ? ZOOM_STEPS.length - 1 : i;
    next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))];
  }
  updateSettings({ zoom: next }, 300);
  app.toast(`Zoom ${Math.round(next * 100)}%`, 'info', 1200);
}

// ---- content width (markdown) -----------------------------------------------------------------
export const WIDTHS = ['readable', 'wide', 'full'] as const;
export const currentWidth = () => WIDTHS.find((w) => w === app.settings.value.contentWidth) ?? 'readable';
/** Tab-strip button: readable → wide → full → readable. */
export const cycleContentWidth = () => updateSettings({ contentWidth: WIDTHS[(WIDTHS.indexOf(currentWidth()) + 1) % 3] });
