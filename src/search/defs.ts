// Workspace symbol index: the contract between the search engine (one map per shard, exact merge) and
// Go to definition (renderer, lazy). Definitions come from extractDefs() (./symbols) — one extraction
// for the outline, the overview and the index. Types only: the values that go with them (DEF_LANGS,
// language families, the merge order) live in ./symbols, the chunk every consumer already loads (a module
// of its own here became one more tiny shared chunk in the entry's preload table).

/** A definition found in the index (or extracted from a file on demand). 0-based line / col. */
export interface DefHit {
  path: string;
  name: string;
  kind: string;
  line: number;
  col: number;
  /** Canonical language id of the file (shared/languages). */
  lang: string;
  container?: string;
  ns?: string;
  ext?: string;
  uses?: string[];
  end?: number;
  extra?: boolean;
  /** The trimmed source line (capped), for pickers. */
  text: string;
}

export interface DefQuery {
  /** Exact names (matched case-insensitively; callers prefer exact case). */
  names: string[];
  /** Only files of these languages (canonical ids). */
  langs?: string[];
  limit?: number;
  // Filters applied in the shards BEFORE the limit (a common name must not crowd out the right hit):
  /** PHP: only definitions in this namespace ('' = global; case-insensitive). */
  ns?: string;
  /** true: only class-likes; false: no class-likes. */
  classLike?: boolean;
  /** Only members of one of these classes (case-insensitive). */
  containers?: string[];
  /** Only definitions outside any class. */
  topLevel?: boolean;
  /** Only members (definitions inside a class). */
  member?: boolean;
  /** Nearest folders to this path first (then path / line), in every shard alike. */
  near?: string;
}
