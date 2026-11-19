// Public types of the format module. Plain data only: everything here crosses the worker boundary.

export interface FormatOptions {
  printWidth?: number;
  tabWidth?: number;
  useTabs?: boolean;
  singleQuote?: boolean;
  semi?: boolean;
  trailingComma?: 'all' | 'es5' | 'none';
  /** Minimum PHP version the output must run on ("8.3"). */
  phpVersion?: string;
  braceStyle?: 'per-cs' | 'psr-2' | '1tbs';
  sqlKeywordCase?: 'upper' | 'lower' | 'preserve';
  /** sql-formatter dialect; overrides the one implied by the fence alias. */
  sqlDialect?: string;
  /** "Format document" on a note also formats its fenced code blocks (default true). */
  markdownCodeBlocks?: boolean;
  /** Any other Prettier option (from .prettierrc) is passed through when whitelisted. */
  [key: string]: unknown;
}

export interface FormatIssue {
  kind: 'syntax' | 'unsupported' | 'timeout' | 'internal' | 'no-block';
  /** Ready to show: "PHP syntax error at 12:5: unexpected '{'". */
  message: string;
  language?: string;
  /** 1-based, relative to the whole document. */
  line?: number;
  col?: number;
}

export interface FormatRequest {
  path?: string;
  /** Language id or fence alias; wins over `path`. */
  lang?: string;
  options?: FormatOptions;
  /** Cursor to carry through the formatting. */
  cursorOffset?: number;
  /** Markdown only. 'codeblocks' = only fenced blocks; 'block' = only the block containing cursorOffset. */
  mode?: 'document' | 'codeblocks' | 'block';
  /** Text is a fragment (code block / selection): e.g. PHP may lack its `<?php` tag. */
  snippet?: boolean;
}

export interface FormatResult {
  text: string;
  changed: boolean;
  /** Canonical language id, null when unknown. */
  language: string | null;
  /** False when there is no formatter for the language (text returned untouched). */
  supported?: boolean;
  cursorOffset?: number;
  /** Set when nothing could be formatted; `text` is then the input. */
  error?: FormatIssue;
  /** Markdown: code blocks that were skipped (syntax errors). */
  warnings?: FormatIssue[];
  /** Markdown: number of code blocks rewritten. */
  blocksFormatted?: number;
}
