// File type associations (setting `files.associations`): the pattern rules, shared by the renderer, the
// workers and the backend. Pure and tiny on purpose (no language table): the indexer thread needs only this.
//
// A pattern is matched against a file's lower-cased base name — never a folder — in one of three shapes:
//   *.ctp          suffix   the name ends with ".ctp" (compound too: *.tpl.php)
//   dockerfile.*   prefix   the name starts with "dockerfile."
//   jenkinsfile    name     the whole name
// No other wildcard and no regex: a lookup is a few Map reads, bounded by MAX_PATTERN whatever the name.

/** Rows kept from the setting (the rest of a longer, hand-edited list is ignored). */
export const MAX_ASSOCIATIONS = 100;
/** Longest pattern; also bounds the work of one lookup. */
export const MAX_PATTERN = 64;

export type PatternResult = { ok: true; pattern: string } | { ok: false; error: string };

const bad = (error: string): PatternResult => ({ ok: false, error });

/** Never re-mapped: Markdown notes (their own editor, links and preview key off the extension) and what opens in a viewer. */
const RESERVED = new Set(['md', 'markdown', 'mdx', 'pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp']);

/** A lower-cased base name whose type the app decides itself (see RESERVED). */
export function isReservedName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && RESERVED.has(name.slice(dot + 1));
}

/**
 * A stored pattern → its canonical form (lower case), or why it is refused. Strict: this is what
 * settings.json holds, so `ctp` here is the file named "ctp" (the Settings box accepts shorthand: patternFromInput).
 */
export function parsePattern(input: unknown): PatternResult {
  if (typeof input !== 'string') return bad('Not a pattern');
  const p = input.trim().normalize('NFC').toLowerCase();
  if (!p) return bad('Type an extension, for example ctp');
  if (p.length > MAX_PATTERN) return bad(`Too long (at most ${MAX_PATTERN} characters)`);
  if (/[/\\]/.test(p)) return bad('Folders are not part of a pattern: use the file name or extension only');
  if (/[\u0000-\u001f\u007f]/.test(p)) return bad('Control characters are not allowed');
  if (/[,;]/.test(p)) return bad('One pattern per row');
  if (/[?[\]{}!]/.test(p)) return bad('Only * is supported, as *.ext or name.*');
  const stars = p.split('*').length - 1;
  if (stars > 1) return bad('Only one * is supported, as *.ext or name.*');
  if (stars === 1) {
    const suffix = p.startsWith('*.');
    const prefix = p.endsWith('.*');
    if (!suffix && !prefix) return bad('Use * as *.ext or name.*');
    const body = suffix ? p.slice(2) : p.slice(0, -2);
    if (!body || body.startsWith('.') || body.endsWith('.')) return bad(suffix ? 'Type the extension after *.' : 'Type the name before .*');
  } else if (p === '.' || p === '..' || p.endsWith('.')) return bad('Not a file name');
  // Prefix patterns can match such a file too; those are sorted out per file (isReservedName).
  if (!p.endsWith('.*') && isReservedName(p)) return bad(/\.(md|markdown|mdx)$/.test(p) ? 'Markdown notes always open as notes' : 'This file type opens in a viewer, not as text');
  return { ok: true, pattern: p };
}

/**
 * What the user types in Settings → a pattern. Shorthand for the common case: `ctp` and `.ctp` mean `*.ctp`
 * (the leading dot is optional). Anything with a `*` or a dot inside is taken as written (`nginx.conf` is that file).
 */
export function patternFromInput(text: string): PatternResult {
  const t = text.trim();
  if (!t || t.includes('*')) return parsePattern(t);
  if (t.startsWith('.')) return parsePattern(`*${t}`);
  return parsePattern(t.includes('.') ? t : `*.${t}`);
}

/** "*.ctp" → "files ending in .ctp" (Settings rows, the status bar's picker). */
export function describePattern(pattern: string): string {
  if (pattern.startsWith('*.')) return `files ending in ${pattern.slice(1)}`;
  if (pattern.endsWith('.*')) return `files starting with ${pattern.slice(0, -1)}`;
  return `files named ${pattern}`;
}

/** The pattern that covers `name` and its kind: its last extension, or the whole name when it has none. Null: reserved. */
export function patternForName(name: string): string | null {
  const n = name.toLowerCase();
  const dot = n.lastIndexOf('.');
  const r = parsePattern(dot > 0 && dot < n.length - 1 ? `*${n.slice(dot)}` : n);
  return r.ok ? r.pattern : null;
}

/** Canonical patterns → values. Whole name first, then the longest suffix, then the longest prefix. */
export class PatternTable<T> {
  private names = new Map<string, T>();
  private suffixes = new Map<string, T>();
  private prefixes = new Map<string, T>();
  size = 0;

  /** `pattern` must be canonical (parsePattern); the first value of a pattern stays. */
  add(pattern: string, value: T): boolean {
    const [map, key] = pattern.startsWith('*.') ? [this.suffixes, pattern.slice(1)] : pattern.endsWith('.*') ? [this.prefixes, pattern.slice(0, -2)] : [this.names, pattern];
    if (map.has(key)) return false;
    map.set(key, value);
    this.size++;
    return true;
  }

  /** `name`: a lower-cased base name. */
  match(name: string): T | undefined {
    if (!this.size || isReservedName(name)) return undefined;
    let hit = this.names.get(name);
    if (hit !== undefined) return hit;
    // A key is never longer than MAX_PATTERN: dots further away cannot start / end a match.
    if (this.suffixes.size) {
      for (let i = name.indexOf('.', Math.max(0, name.length - MAX_PATTERN)); i !== -1; i = name.indexOf('.', i + 1)) {
        hit = this.suffixes.get(name.slice(i));
        if (hit !== undefined) return hit;
      }
    }
    if (this.prefixes.size) {
      for (let i = name.lastIndexOf('.', MAX_PATTERN); i > 0; i = name.lastIndexOf('.', i - 1)) {
        hit = this.prefixes.get(name.slice(0, i));
        if (hit !== undefined) return hit;
      }
    }
    return undefined;
  }
}
