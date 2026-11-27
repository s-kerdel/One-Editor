// Recently opened files (per workspace) + tiny localStorage helpers. Kept apart from ./state so the
// startup stub (./index) can track the MRU without pulling the search UI state.
import { app } from '../app/app';
import { folderValue, setFolderValue } from '../app/documents';

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

// ---- recently opened files (per workspace) ----
// In the folder's session (app/documents folderValue), never localStorage: every folder's page shares that.
const RECENT_MAX = 50;
const asList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string').slice(0, RECENT_MAX) : undefined);
// Older versions: localStorage `se-search:recent:<root>`, moved into the session on first use.
const legacy = () => ({ key: `se-search:recent:${app.workspace.value?.root ?? ''}`, parse: (raw: string) => asList(JSON.parse(raw)) });

export function getRecentFiles(): string[] {
  return asList(folderValue('recentFiles', legacy())) ?? [];
}
export function touchRecentFile(path: string) {
  setFolderValue('recentFiles', [path, ...getRecentFiles().filter((p) => p !== path)].slice(0, RECENT_MAX));
}
export function renameRecentFile(from: string, to: string) {
  setFolderValue(
    'recentFiles',
    getRecentFiles().map((p) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p)),
  );
}
