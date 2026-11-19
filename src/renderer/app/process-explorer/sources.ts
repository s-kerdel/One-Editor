// UI-side rows for the process explorer (workers that live in the renderer). Register from your
// feature's lazy chunk — importing this from startup code would cost launch bytes. Rows are read only
// while the explorer is open (every 2 s); keep rows() cheap and side-effect free.
import type { ProcRow } from '@shared/processes';

export interface UiProcessSource {
  id: string;
  /** Parent `renderer` for anything running in this window. */
  rows(): ProcRow[];
}

const sources = new Map<string, UiProcessSource>();

export function registerUiProcessSource(s: UiProcessSource): () => void {
  sources.set(s.id, s);
  return () => void (sources.get(s.id) === s && sources.delete(s.id));
}

export function uiSourceRows(): ProcRow[] {
  const out: ProcRow[] = [];
  for (const s of sources.values()) {
    try {
      out.push(...s.rows());
    } catch (err) {
      out.push({ id: `err:${s.id}`, parent: 'renderer', kind: 'worker', name: s.id, state: `failed: ${(err as Error).message}` });
    }
  }
  return out;
}
