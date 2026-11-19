// Messages between the renderer (search client) and the search worker.
import type { HeadingHit, SearchDoc, SearchOptions, SearchResponse } from './types';
import type { CorpusStats, RankedResult, VocabInfo } from './engine';

export interface HeadingQuery {
  query: string;
  limit?: number;
  path?: string;
  fileQuery?: string;
}

export type ToWorker =
  /** `more`: further docs follow in `append` messages (big workspaces are sent in slices so neither
   *  thread stalls on one huge structured clone); `indexed` is then posted after the last slice. */
  | { type: 'reset'; gen: number; docs: SearchDoc[]; more?: boolean }
  | { type: 'append'; gen: number; docs: SearchDoc[]; done: boolean }
  | { type: 'upsert'; docs: SearchDoc[] }
  | { type: 'remove'; paths: string[] }
  | { type: 'rename'; from: string; to: string }
  /** `channel`: independent consumers (panel, palette) — a newer search cancels older ones on the same channel. */
  | { type: 'search'; id: number; channel: string; query: string; options: SearchOptions }
  | { type: 'cancel'; id: number }
  | { type: 'headings'; id: number; q: HeadingQuery }
  // ---- sharded search (see shards.ts): match on every shard, then rank with corpus-wide stats ----
  /** Phase 1: find this shard's candidates (kept until ranked or superseded on the channel).
   *  `fuzzy`: run the typo-corrected query, variants decided from the merged vocabulary. */
  | { type: 'match'; id: number; channel: string; query: string; options: SearchOptions; fuzzy?: { df: number[]; variants: Record<string, string[]> } }
  /** Phase 2: score the stored candidates of match `id` with summed stats; reply with the best `limit`. */
  | { type: 'rank'; id: number; stats: CorpusStats; options: SearchOptions }
  /** Vocabulary facts for typo correction / "did you mean". */
  | { type: 'vocab'; id: number; words: string[] };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'indexed'; gen: number; count: number; ms: number }
  | { type: 'result'; id: number; response: SearchResponse }
  | { type: 'cancelled'; id: number }
  | { type: 'headings'; id: number; hits: HeadingHit[] }
  | { type: 'matched'; id: number; df: number[]; totalFiles: number; totalMatches: number; N: number; totalLen: number }
  | { type: 'ranked'; id: number; results: RankedResult[] }
  | { type: 'vocab'; id: number; info: VocabInfo[] }
  | { type: 'error'; id?: number; message: string };
