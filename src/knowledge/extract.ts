// Per-note metadata extraction (links, tags, headings, blocks, frontmatter, tasks).
// Pure + line-based (no markdown AST) so 5k notes index in well under a second.
import { parseWikiLink } from '@shared/wikilinks';
import { stem } from '@shared/paths';

export interface LinkRef {
  kind: 'wiki' | 'md';
  /** Wiki: target as written. Md: URL-decoded destination path (no #fragment). */
  target: string;
  heading?: string;
  block?: string;
  /** Wiki alias / markdown link text. */
  alias?: string;
  embed: boolean;
  line: number; // 0-based
  col: number;
  length: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number; // 0-based
  slug: string;
}

export interface NoteInfo {
  path: string;
  /** Filename without extension — what `[[links]]` use. */
  title: string;
  aliases: string[];
  links: LinkRef[];
  /** Unique tags without '#', original casing of first occurrence. */
  tags: string[];
  headings: Heading[];
  blocks: Array<{ id: string; line: number }>;
  props: Record<string, unknown>;
  tasks: { open: number; done: number };
}

export type LineKind = 'frontmatter' | 'code' | 'text';

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /(`+)(?:(?!\1)[^])*?\1(?!`)/g;
const blank = (s: string) => ' '.repeat(s.length);

/** Replaces inline code spans with spaces (same length, so columns stay valid). */
export function maskInlineCode(line: string): string {
  return line.indexOf('`') === -1 ? line : line.replace(INLINE_CODE_RE, blank);
}

/**
 * Walks a document line by line, classifying each line. `masked` (text lines only) has inline code
 * blanked out; `offset` is the line's start offset in `text`. The callback may return false to stop early.
 */
export function scanLines(text: string, cb: (line: string, lineNo: number, kind: LineKind, masked: string, offset: number) => void | false): void {
  let pos = 0;
  let lineNo = 0;
  let fence: { ch: string; len: number } | null = null;
  let inFm = false;
  const n = text.length;
  while (pos <= n) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = n;
    let line = text.slice(pos, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    let kind: LineKind = 'text';
    if (lineNo === 0 && line === '---') {
      inFm = true;
      kind = 'frontmatter';
    } else if (inFm) {
      kind = 'frontmatter';
      if (line === '---' || line === '...') inFm = false;
    } else if (fence) {
      kind = 'code';
      const m = FENCE_RE.exec(line);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !m[2].trim()) fence = null;
    } else if (line.indexOf('```') !== -1 || line.indexOf('~~~') !== -1) {
      const m = FENCE_RE.exec(line);
      // A backtick fence's info string may not contain backticks (that would be inline code).
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        fence = { ch: m[1][0], len: m[1].length };
        kind = 'code';
      }
    }
    if (cb(line, lineNo, kind, kind === 'text' ? maskInlineCode(line) : line, pos) === false) return;
    pos = end + 1;
    lineNo++;
  }
}

// ---------- frontmatter ----------

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

function scalar(s: string): unknown {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return unquote(t);
}

/** Splits `a, "b, c", d` on top-level commas. */
function splitFlow(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = '';
  let depth = 0;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = '';
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === '[') {
      depth++;
      cur += ch;
    } else if (ch === ']') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function stripComment(v: string): string {
  // `key: value # comment` — only when the # is preceded by whitespace and we're not in quotes.
  if (v.indexOf('#') === -1 || /^\s*["']/.test(v)) return v;
  const m = /(^|\s)#(\s|$)/.exec(v);
  return m ? v.slice(0, m.index) : v;
}

/** Deliberately small YAML subset: `key: scalar`, `key: [a, b]`, and `key:` + `- item` lists. */
export function parseFrontmatter(lines: readonly string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const raw of lines) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = /^\s*-\s+(.*)$/.exec(raw) ?? (/^\s*-\s*$/.test(raw) ? ['', ''] : null);
    if (item && listKey) {
      const arr = props[listKey];
      if (Array.isArray(arr)) arr.push(scalar(stripComment(item[1])));
      continue;
    }
    const kv = /^([A-Za-z0-9_][\w .-]*?)\s*:(?:\s+(.*))?$/.exec(raw);
    if (!kv) {
      listKey = null;
      continue;
    }
    const key = kv[1].trim();
    const val = stripComment(kv[2] ?? '').trim();
    if (val === '') {
      props[key] = [];
      listKey = key; // stays [] unless `- item` lines follow
    } else if (val.startsWith('[') && val.endsWith(']')) {
      props[key] = splitFlow(val.slice(1, -1)).map(scalar);
      listKey = null;
    } else {
      props[key] = scalar(val);
      listKey = null;
    }
  }
  for (const k of Object.keys(props)) if (Array.isArray(props[k]) && (props[k] as unknown[]).length === 0 && !/^(tags?|aliases|alias)$/i.test(k)) props[k] = null;
  return props;
}

function propList(props: Record<string, unknown>, keys: string[], splitSpaces: boolean): string[] {
  const out: string[] = [];
  for (const k of Object.keys(props)) {
    if (!keys.includes(k.toLowerCase())) continue;
    const v = props[k];
    const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(splitSpaces ? /[,\s]+/ : /,/) : v == null ? [] : [v];
    for (const p of parts) {
      const s = String(p ?? '').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

// ---------- body ----------

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
// [text](dest "title") / ![alt](dest) / [text](<dest with spaces>)
const MD_LINK_RE = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s\\]|\\.|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/g;
const REF_DEF_RE = /^ {0,3}\[([^\]\n]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/;
// Obsidian-style: a tag starts a line or follows whitespace / opening punctuation (so `foo#bar` and `&#39;` aren't tags).
// A tag = '#' + TAG_BODY, at line start or after whitespace / opening punctuation (TAG_PREFIX).
const TAG_BODY_RE = /[\p{L}\p{N}_][\p{L}\p{N}_\-/]*/uy;
const TAG_PREFIX_RE = /[\s(>,;:!?*_~=]/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const TASK_RE = /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/;
const BLOCK_RE = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

// Fast paths below skip unicode-aware regex passes for the common plain-ASCII heading.
const SLUG_PLAIN_RE = /^[a-z0-9 _-]*$/;
const EMPHASIS_RE = /[*_~=`]/;

export function slugify(text: string): string {
  const lower = text.toLowerCase();
  return (SLUG_PLAIN_RE.test(lower) ? lower : lower.replace(/[^\p{L}\p{N}\s_-]/gu, '')).trim().replace(/\s+/g, '-');
}

/** Strips inline markdown so `## **Bold** [[Link|x]]` reads "Bold x" in the outline. */
export function plainHeading(s: string): string {
  let r = s;
  if (r.indexOf('[[') !== -1) r = r.replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2');
  if (r.indexOf('](') !== -1) r = r.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  if (EMPHASIS_RE.test(r)) r = r.replace(/(\*\*|__|\*|_|~~|==|`)/g, '');
  return r.trim();
}

export function decodeTarget(dest: string): string {
  try {
    return decodeURIComponent(dest);
  } catch {
    return dest;
  }
}

/** Splits a markdown link destination into path + fragment; null for external / in-page links. */
export function parseMdDest(dest: string): { path: string; fragment?: string } | null {
  const d = dest.trim();
  if (!d || SCHEME_RE.test(d) || d.startsWith('#') || d.startsWith('mailto:')) return null;
  const hash = d.indexOf('#');
  const p = decodeTarget((hash === -1 ? d : d.slice(0, hash)).replace(/\?.*$/, ''));
  if (!p) return null;
  return { path: p, fragment: hash === -1 ? undefined : decodeTarget(d.slice(hash + 1)) };
}

export function extractHeadings(text: string): Heading[] {
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  scanLines(text, (line, lineNo, kind) => {
    if (kind !== 'text' || line.indexOf('#') === -1) return;
    const m = HEADING_RE.exec(line);
    if (!m) return;
    const t = plainHeading(m[2] ?? '');
    let slug = slugify(t);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n) slug = `${slug}-${n}`;
    out.push({ level: m[1].length, text: t, line: lineNo, slug });
  });
  return out;
}

// ---------- URLs ----------
// Same spans as /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, found in linear time: that regex retries at every
// word start of every line and was ~25% of all extraction time.

const isAlpha = (c: number) => (c | 32) >= 97 && (c | 32) <= 122;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isSchemeChar = (c: number) => isAlpha(c) || isDigit(c) || c === 43 || c === 45 || c === 46; // + - .
const isWordChar = (c: number) => isAlpha(c) || isDigit(c) || c === 95;
const WS_RE = /\s/;
const isSpace = (c: number) => (c <= 32 ? c === 32 || (c >= 9 && c <= 13) : c >= 0xa0 && WS_RE.test(String.fromCharCode(c)));

/** Calls `cb(from, to)` for every `scheme://…` URL in `s`, left to right. */
export function forEachUrl(s: string, cb: (from: number, to: number) => void): void {
  let floor = 0;
  let k = s.indexOf('://');
  while (k !== -1) {
    let j = k;
    while (j > floor && isSchemeChar(s.charCodeAt(j - 1))) j--;
    let start = -1;
    for (let x = j; x < k; x++) {
      if (isAlpha(s.charCodeAt(x)) && (x === 0 || !isWordChar(s.charCodeAt(x - 1)))) {
        start = x;
        break;
      }
    }
    let end = k + 3;
    while (end < s.length && !isSpace(s.charCodeAt(end))) end++;
    if (start !== -1 && end > k + 3) {
      cb(start, end);
      floor = end;
      k = s.indexOf('://', end);
    } else k = s.indexOf('://', k + 1);
  }
}

/** Blanks out URLs (same length, so columns stay valid). */
export function maskUrls(s: string): string {
  if (s.indexOf('://') === -1) return s;
  let out = '';
  let last = 0;
  forEachUrl(s, (from, to) => {
    out += s.slice(last, from) + ' '.repeat(to - from);
    last = to;
  });
  return last ? out + s.slice(last) : s;
}

/** Tag occurrences in one (already code-masked) text line: links and URLs don't count. */
export function findTagsInLine(masked: string): Array<{ tag: string; col: number }> {
  if (masked.indexOf('#') === -1) return [];
  let clean = masked;
  // indexOf guards: most lines have no links at all, and each replace() is a full regex pass.
  if (clean.indexOf('[[') !== -1) clean = clean.replace(WIKI_RE, blank);
  if (clean.indexOf('](') !== -1) clean = clean.replace(MD_LINK_RE, blank);
  clean = maskUrls(clean);
  const out: Array<{ tag: string; col: number }> = [];
  // Hop between '#'s instead of a global unicode regex retried at every position. `floor`: the
  // previous tag's characters can't serve as the next one's prefix (as with a global regex).
  let floor = 0;
  for (let k = clean.indexOf('#'); k !== -1; k = clean.indexOf('#', k + 1)) {
    if (k > 0 && (k - 1 < floor || !TAG_PREFIX_RE.test(clean[k - 1]))) continue;
    TAG_BODY_RE.lastIndex = k + 1;
    const m = TAG_BODY_RE.exec(clean);
    if (!m) continue;
    floor = k + 1 + m[0].length;
    const tag = m[0].replace(/\/+$/, '');
    // Pure numbers (#123) are issue refs, not tags.
    if (tag && !/^\d+$/.test(tag)) out.push({ tag, col: k });
    k = floor - 1;
  }
  return out;
}

export function extractNote(path: string, text: string): NoteInfo {
  const links: LinkRef[] = [];
  const headings: Heading[] = [];
  const blocks: Array<{ id: string; line: number }> = [];
  const tags: string[] = [];
  const tagSeen = new Set<string>();
  const slugSeen = new Map<string, number>();
  const fm: string[] = [];
  let open = 0;
  let done = 0;
  const addTag = (t: string) => {
    const k = t.toLowerCase();
    if (!tagSeen.has(k)) {
      tagSeen.add(k);
      tags.push(t);
    }
  };

  scanLines(text, (line, lineNo, kind, masked) => {
    if (kind === 'frontmatter') {
      if (line !== '---' && line !== '...') fm.push(line);
      return;
    }
    if (kind === 'code' || !line) return;
    const hasBracket = masked.indexOf('[') !== -1;
    const hasHash = masked.indexOf('#') !== -1;

    if (hasHash) {
      const h = HEADING_RE.exec(line);
      if (h) {
        const t = plainHeading(h[2] ?? '');
        let slug = slugify(t);
        const n = slugSeen.get(slug) ?? 0;
        slugSeen.set(slug, n + 1);
        if (n) slug = `${slug}-${n}`;
        headings.push({ level: h[1].length, text: t, line: lineNo, slug });
      }
    }
    if (hasBracket) {
      if (masked.indexOf('[[') !== -1) {
        WIKI_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = WIKI_RE.exec(masked))) {
          const w = parseWikiLink(m[2], m[1] === '!');
          links.push({ kind: 'wiki', target: w.target, heading: w.heading, block: w.block, alias: w.alias, embed: w.embed, line: lineNo, col: m.index, length: m[0].length });
        }
      }
      if (masked.indexOf('](') !== -1) {
        MD_LINK_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = MD_LINK_RE.exec(masked))) {
          const d = parseMdDest(m[3] ?? m[4] ?? '');
          if (!d) continue;
          const block = d.fragment?.startsWith('^') ? d.fragment.slice(1) : undefined;
          links.push({ kind: 'md', target: d.path, heading: block ? undefined : d.fragment, block, alias: m[2] || undefined, embed: m[1] === '!', line: lineNo, col: m.index, length: m[0].length });
        }
      }
      if (masked.indexOf(']:') !== -1) {
        const r = REF_DEF_RE.exec(masked);
        const d = r && parseMdDest(r[2] ?? r[3] ?? '');
        if (r && d) links.push({ kind: 'md', target: d.path, heading: d.fragment, embed: false, line: lineNo, col: 0, length: r[0].length });
      }
      const t = TASK_RE.exec(line);
      if (t) t[1] === ' ' ? open++ : done++;
    }
    if (hasHash) for (const t of findTagsInLine(masked)) addTag(t.tag);
    if (line.indexOf('^') !== -1) {
      const b = BLOCK_RE.exec(masked);
      if (b) blocks.push({ id: b[1], line: lineNo });
    }
  });

  const props = fm.length ? parseFrontmatter(fm) : {};
  for (const t of propList(props, ['tags', 'tag'], true)) addTag(t.replace(/^#/, ''));
  const aliases = [...new Set(propList(props, ['aliases', 'alias'], false))];
  return { path, title: stem(path), aliases, links, tags, headings, blocks, props, tasks: { open, done } };
}
