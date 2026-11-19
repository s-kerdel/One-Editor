// Search UI state that survives panel switches, plus small persisted MRU lists.
import { signal } from '@preact/signals';
import type { SearchResponse } from '../../search/types';
import { load, save } from './recent';

export const query = signal('');
export const replaceText = signal('');
export const showReplace = signal(false);
export const matchCase = signal(false);
export const wholeWord = signal(false);
export const useRegex = signal(false);
export const response = signal<SearchResponse | null>(null);
export const searching = signal(false);
export const collapsed = signal<Set<string>>(new Set());
/** Index into the flat list of visible rows (see SearchPanel). */
export const selected = signal(-1);
/** Bumped to ask the panel input to focus/select. */
export const focusTick = signal(0);

export { getRecentFiles, renameRecentFile, touchRecentFile } from './recent';

// ---- search history ----
const HISTORY_MAX = 40;
export function getHistory(): string[] {
  return load<string[]>('se-search:history', []);
}
export function pushHistory(q: string) {
  q = q.trim();
  if (!q) return;
  save('se-search:history', [q, ...getHistory().filter((x) => x !== q)].slice(0, HISTORY_MAX));
}

// ---- recently used commands ----
export function getRecentCommands(): string[] {
  return load<string[]>('se-search:recent-commands', []);
}
export function touchRecentCommand(id: string) {
  save('se-search:recent-commands', [id, ...getRecentCommands().filter((x) => x !== id)].slice(0, 20));
}
