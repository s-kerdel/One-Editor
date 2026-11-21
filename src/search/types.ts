// Search engine contract (pure TS; runs in a Web Worker in the app, directly in Node for tests).

export interface SearchDoc {
  path: string;
  content: string;
  mtime?: number;
}

export type MatchContext = 'text' | 'heading' | 'code' | 'inline-code' | 'frontmatter' | 'link' | 'path';

export interface MatchRange {
  start: number;
  end: number;
}

/** One result row = one line with ≥1 hit. */
export interface SearchMatch {
  line: number; // 0-based
  start: number; // char offset within lineText (first hit on the line)
  end: number;
  lineText: string;
  context: MatchContext;
  lang?: string; // fenced code block language as written ("bash"), or a code file's language id
  /** All hit ranges on this line, relative to lineText (merged, sorted). */
  ranges?: MatchRange[];
  /** Column of the first hit in the full line (lineText may be a window of a long line). */
  col?: number;
  /** Length of the first hit (for selecting it in the editor). */
  length?: number;
  /** Absolute char offset of the first hit in the (LF-normalised) document. */
  offset?: number;
  /** Where lineText starts within the full line when the line was truncated. */
  lineTextOffset?: number;
  headingLevel?: number;
}

export interface SearchResult {
  path: string;
  score: number;
  matches: SearchMatch[];
  /** Total hits in the file (may exceed matches.length, which is capped per file). */
  totalMatches: number;
  /** Ranges of the path that matched query terms (file-name hits). */
  pathRanges?: MatchRange[];
  /** Frontmatter title or first H1. */
  title?: string;
  /** Found via typo-tolerant fallback. */
  fuzzy?: boolean;
}

export interface SearchOptions {
  /** true = sensitive, false = insensitive, 'smart' (default) = sensitive only if the term has uppercase. */
  caseSensitive?: boolean | 'smart';
  wholeWord?: boolean;
  /** Whole query (minus filters) is one regex. */
  regex?: boolean;
  /** Whole query (minus filters) is one literal string (used by replace). */
  literal?: boolean;
  limit?: number; // max files
  maxMatchesPerFile?: number; // max rows (lines) per file
  /** Fold diacritics when the term has none: `naive` finds `naïve` (default true). */
  diacritics?: boolean;
  /** Typo-tolerant fallback when nothing matches exactly (default true). */
  fuzzy?: boolean;
  /** Let terms match file paths too (default true). */
  matchPaths?: boolean;
  /** No regular expressions: `/…/` is plain text, `regex` is ignored (MCP server). */
  noRegex?: boolean;
}

export interface SearchResponse {
  results: SearchResult[];
  totalFiles: number;
  totalMatches: number;
  tookMs: number;
  error?: string; // e.g. invalid regex
  /** More files matched than `limit`. */
  truncated?: boolean;
  /** Results come from the typo-tolerant fallback. */
  fuzzy?: boolean;
  corrections?: Array<{ from: string; to: string[] }>;
  /** Exact hits were few; a much more common near-spelling exists ("Did you mean …?"). */
  suggestions?: Array<{ from: string; to: string }>;
  warnings?: string[];
  /** Number of indexed documents. */
  indexed?: number;
  /** Answered while the index was still being built (more results may follow). */
  partial?: boolean;
}

export interface FuzzyMatch {
  score: number;
  positions: number[]; // indices into target that matched
}

export interface HeadingHit {
  path: string;
  line: number;
  level: number;
  text: string;
  score: number;
  positions: number[]; // into text
}
