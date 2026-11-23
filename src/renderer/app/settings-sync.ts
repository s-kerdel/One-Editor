// Settings changed by another sec-edit process: the desktop app and browser mode share settings.json,
// and each backend watches it. Applied live like a change made here, never saved back. No startup code:
// installed with the idle Popups chunk. Electron delivers `settings:changed` over the preload bridge,
// browser mode a named `settings` event on the existing event stream (platform's __secEditEvents).
import type { Settings } from '@shared/api';
import { app } from './app';
import { applySettingsToDom, flushSettings } from './settings';
import { refreshTree } from './documents';

/** Settings that change what the indexers read (same list as SettingsOverlay.tsx). */
const INDEX_KEYS = ['search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB', 'search.workers', 'excludeGlobs', 'showHiddenFiles', 'files.associations'];

let installed = false;
export function installSettingsSync() {
  if (installed) return;
  installed = true;
  const g = globalThis as { secEditBridge?: { on(ch: string, cb: (p: unknown) => void): () => void }; __secEditEvents?: EventSource };
  if (g.secEditBridge) g.secEditBridge.on('settings:changed', () => void resync());
  else g.__secEditEvents?.addEventListener('settings', () => void resync());
}

// Coalesced: a burst of events is one round-trip.
let running: Promise<void> | null = null;
let again = false;
function resync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = resyncSettings()
    .catch((err) => console.warn('[settings] sync failed', err))
    .finally(() => {
      running = null;
      if (again) {
        again = false;
        void resync();
      }
    });
  return running;
}

/** The backend holds the merged truth; apply what differs from ours. */
export async function resyncSettings(): Promise<void> {
  // Our own unsaved change goes first: it is written after the other one, so it wins (and is not reverted here).
  await flushSettings();
  const fresh = (await app.backend.getSettings()) as Record<string, unknown>;
  const cur = app.settings.value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(cur), ...Object.keys(fresh)])) if (JSON.stringify(cur[k] ?? null) !== JSON.stringify(fresh[k] ?? null)) patch[k] = fresh[k];
  if (!Object.keys(patch).length) return;
  const next = { ...app.settings.value, ...patch } as Settings;
  app.settings.value = next;
  applySettingsToDom(next);
  app.editor?.applySettings(next);
  if ('viewMode' in patch) app.editor?.setViewMode(next.viewMode);
  app.events.emit('settings:changed', next);
  if ('excludeGlobs' in patch || 'showHiddenFiles' in patch) void refreshTree();
  if (INDEX_KEYS.some((k) => k in patch)) app.events.emit('index:stale');
}
