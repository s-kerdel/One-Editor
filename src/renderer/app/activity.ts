// Background activity: what runs now (status bar indicator) and a log of the last runs
// ("Developer: Show activity log"). Any module may log: index passes, incremental index batches,
// tree refreshes, git status runs …  Only lazy modules import this (the status bar reads ui.activityNow).
import { signal } from '@preact/signals';

export interface ActivityEntry {
  /** What ran: 'index' | 'index-update' | 'tree' | 'git' | … */
  kind: string;
  /** Why: 'workspace-open' | 'settings' | 'fs-events' | 'focus' | … */
  trigger: string;
  ms: number;
  /** e.g. "12,003 files". */
  detail?: string;
  /** Date.now() when it finished. */
  at: number;
}

const MAX = 200;
export const activityLog = signal<ActivityEntry[]>([]);
/** Shown in the status bar while set, e.g. "Indexing 4,210 / 18,000" (lives in ui.ts: startup chunk). */
export { activityNow } from './ui';

export function logActivity(e: Omit<ActivityEntry, 'at'> & { at?: number }): void {
  const list = activityLog.value;
  activityLog.value = [...(list.length >= MAX ? list.slice(list.length - MAX + 1) : list), { ...e, at: e.at ?? Date.now(), ms: Math.round(e.ms) }];
}
