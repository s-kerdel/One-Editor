// Messages between the renderer (search client) and the search worker.
import type { HeadingHit, SearchDoc, SearchOptions, SearchResponse } from './types';
import type { CorpusStats, RankedResult, VocabInfo } from './engine';
import type { FeedSource } from './feeder';
import type { NoteInfo } from '../knowledge/extract';
import type { Mention, Snippet } from '../knowledge/index';

/** Note metadata a shard extracted while indexing (the knowledge index needs no text). */
export interface NoteItem {
  path: string;
  info: NoteInfo;
  /** Context line of each link (parallel to info.links), for backlinks. */
  snippets: Snippet[];
}

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
  /** `notes`: also report note metadata (file-event updates; editor edits are extracted by knowledge itself). */
  | { type: 'upsert'; docs: SearchDoc[]; notes?: boolean }
  | { type: 'remove'; paths: string[]; notes?: boolean }
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
  | { type: 'vocab'; id: number; words: string[] }
  // ---- feeding (shard 0 pulls text from the backend; MessagePorts arrive in event.ports) ----
  /** Shard 0: port to peer shard `index`. */
  | { type: 'peer'; index: number }
  /** Peers: port from shard 0's feeder. */
  | { type: 'feedPort' }
  /** Shard 0: run a full pass (the shards were just reset to `gen`). */
  | { type: 'feed'; gen: number; src: FeedSource; shards: number; maxBytes: number }
  /** Shard 0: incremental update of changed files; `shardOf` = coordinator routing for known paths. */
  | { type: 'refresh'; id: number; src: FeedSource; paths: string[]; shardOf: Record<string, number> }
  /** Shard 0: hold the feed while the window is hidden. */
  | { type: 'pause'; on: boolean }
  /** Re-send note metadata of every indexed note (a late subscriber, e.g. the knowledge module). */
  | { type: 'replay'; gen: number }
  /** Unlinked mentions of `names` in this shard's Markdown notes (except `exclude`). */
  | { type: 'mentions'; id: number; names: string[]; exclude: string; limit: number };

export type FromWorker =
  | { type: 'ready' }
  | { type: 'indexed'; gen: number; count: number; ms: number }
  | { type: 'result'; id: number; response: SearchResponse }
  | { type: 'cancelled'; id: number }
  | { type: 'headings'; id: number; hits: HeadingHit[] }
  | { type: 'matched'; id: number; df: number[]; totalFiles: number; totalMatches: number; N: number; totalLen: number }
  | { type: 'ranked'; id: number; results: RankedResult[] }
  | { type: 'vocab'; id: number; info: VocabInfo[] }
  | { type: 'progress'; gen: number; done: number; total: number }
  | { type: 'mentions'; id: number; items: Mention[] }
  | { type: 'replayed'; gen: number }
  | { type: 'feedError'; gen: number; message: string }
  | { type: 'refreshed'; id: number; files: number; removed: number; error?: string }
  /** `gen`: part of that rebuild; absent: an incremental update. */
  | { type: 'notes'; gen?: number; items: NoteItem[]; removed?: string[] }
  | { type: 'error'; id?: number; message: string };
