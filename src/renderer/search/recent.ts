// Recently opened files (per workspace) + tiny localStorage helpers. Kept apart from ./state so the
// startup stub (./index) can track the MRU without pulling the search UI state.
import { app } from '../app/app';

// ---- persistence helpers (localStorage may be unavailable) ----

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function save(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {}
}

const wsKey = (k: string) => `se-search:${k}:${app.workspace.value?.root ?? ''}`;

// ---- recently opened files (per workspace) ----
const RECENT_MAX = 50;
export function getRecentFiles(): string[] {
  return load<string[]>(wsKey('recent'), []);
}
export function touchRecentFile(path: string) {
  save(wsKey('recent'), [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, RECENT_MAX));
}
export function renameRecentFile(from: string, to: string) {
  save(
    wsKey('recent'),
    getRecentFiles().map((p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)),
  );
}
