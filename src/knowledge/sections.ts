// Document map of one Markdown note: heading sections with their line ranges, block ids (^id) with the
// block they name, and the frontmatter span with its keys. Pure + line-based (same classification as
// extract.ts: code fences and frontmatter never count as headings or blocks). Used by the MCP server
// (read_file's heading / block / frontmatter_key, get_outline); line numbers are 0-based, ranges inclusive.
import { extractHeadings, parseFrontmatter, scanLines } from './extract';
import { MAX_STRUCTURE_LINE, parseKeyLine } from '@shared/markdown-lines';

export interface SectionRange {
  level: number;
  text: string;
  slug: string;
  /** The heading line. */
  line: number;
  /** Last line of the section: before the next heading of the same or a higher level (trailing blank lines left out). */
  end: number;
}

export interface BlockRange {
  id: string;
  /** Line that carries `^id`. */
  line: number;
  /** The block it names: the paragraph / list item ending there, or the block above a lone `^id` line. */
  start: number;
  end: number;
}

export interface FrontmatterKey {
  key: string;
  line: number;
  end: number;
}

export interface DocumentMap {
  lineCount: number;
  /** From the opening `---` to the closing one (both included); null without frontmatter. */
  frontmatter: { start: number; end: number; keys: FrontmatterKey[] } | null;
  headings: SectionRange[];
  blocks: BlockRange[];
}

const BLOCK_RE = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/;
const LONE_BLOCK_RE = /^\s*\^[A-Za-z0-9-]+\s*$/;
const LIST_RE = /^(\s*)(?:[-*+]|\d+[.)])\s/;
const isHeading = (l: string) => /^ {0,3}#{1,6}(\s|$)/.test(l);

/** Linear in the text: every range comes from forward passes (no per-block walk back). */
export function documentMap(text: string): DocumentMap {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const n = lines.length;
  const blankAt = lines.map((l) => !l.trim());
  let fmStart = -1;
  let fmEnd = -1;
  const keys: FrontmatterKey[] = [];
  const blocks: BlockRange[] = [];
  const kinds: string[] = [];
  scanLines(text, (line, i, kind, masked) => {
    kinds[i] = kind;
    if (kind === 'frontmatter') {
      if (fmStart === -1) fmStart = i;
      else if (line === '---' || line === '...') fmEnd = i;
      else if (fmEnd === -1) {
        const m = parseKeyLine(line);
        if (m) {
          if (keys.length) keys[keys.length - 1].end = i - 1;
          keys.push({ key: m.key, line: i, end: i });
        }
      }
      return;
    }
    if (kind !== 'text' || line.length > MAX_STRUCTURE_LINE || line.indexOf('^') === -1) return;
    const b = BLOCK_RE.exec(masked);
    if (b) blocks.push({ id: b[1], line: i, start: i, end: i });
  });
  // Unclosed frontmatter is not frontmatter for the reader either: keep the span, but it runs to the end.
  const frontmatter = fmStart === 0 ? { start: 0, end: fmEnd === -1 ? n - 1 : fmEnd, keys } : null;
  if (frontmatter && keys.length) {
    const last = keys[keys.length - 1];
    last.end = Math.max(last.line, frontmatter.end - (fmEnd === -1 ? 0 : 1));
    for (const k of keys) while (k.end > k.line && blankAt[k.end]) k.end--;
  }

  const hs = extractHeadings(text);
  const headings: SectionRange[] = hs.map((h, i) => {
    let next = n;
    for (let j = i + 1; j < hs.length; j++)
      if (hs[j].level <= h.level) {
        next = hs[j].line;
        break;
      }
    let end = next - 1;
    while (end > h.line && blankAt[end]) end--;
    return { level: h.level, text: h.text, slug: h.slug, line: h.line, end };
  });

  if (blocks.length) {
    // One forward pass: where the run of text lines ending at each line starts (for a lone ^id: the block
    // above it), where its paragraph starts (stops after a list item), the last non-blank line before it,
    // and where each list item ends (a stack of open items by indent).
    const textNb = (i: number) => kinds[i] === 'text' && !blankAt[i] && lines[i].length <= MAX_STRUCTURE_LINE;
    const runStart = new Int32Array(n);
    const paraStart = new Int32Array(n);
    const prevNb = new Int32Array(n);
    const itemEnd = new Int32Array(n).fill(-1);
    const open: Array<{ line: number; indent: number }> = [];
    let lastNb = -1;
    for (let i = 0; i < n; i++) {
      prevNb[i] = lastNb;
      const prevOk = i > 0 && textNb(i - 1) && !isHeading(lines[i - 1]);
      runStart[i] = prevOk ? runStart[i - 1] : i;
      paraStart[i] = prevOk && !LIST_RE.test(lines[i - 1]) ? paraStart[i - 1] : i;
      if (blankAt[i]) {
        while (open.length) itemEnd[open.pop()!.line] = i - 1;
      } else {
        const indent = lines[i].length - lines[i].trimStart().length;
        while (open.length && open[open.length - 1].indent >= indent) itemEnd[open.pop()!.line] = i - 1;
        const li = lines[i].length <= MAX_STRUCTURE_LINE ? LIST_RE.exec(lines[i]) : null;
        if (li) open.push({ line: i, indent: li[1].length });
        lastNb = i;
      }
    }
    while (open.length) itemEnd[open.pop()!.line] = n - 1;
    for (const b of blocks) {
      if (LONE_BLOCK_RE.test(lines[b.line])) {
        // `^id` on its own line names the block right above it (a list, a table, a quote).
        const e = prevNb[b.line];
        if (e < 0) continue;
        b.start = runStart[e];
        b.end = e;
      } else if (itemEnd[b.line] >= 0) {
        b.end = itemEnd[b.line]; // a list item: the item and the lines indented below it
      } else {
        b.start = paraStart[b.line]; // a paragraph: back to the previous blank line (or heading)
      }
    }
  }
  return { lineCount: n, frontmatter, headings, blocks };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * A heading by its text, or by a path through nested headings (`["Plans", "2026"]` = "2026" under
 * "Plans"). Matching is loose like Obsidian's (case, punctuation); an exact text match of the whole
 * path joined with " > " wins, so a heading that itself contains " > " is still found.
 */
export function findSection(map: DocumentMap, path: readonly string[]): SectionRange | null {
  const parts = path.map(norm).filter(Boolean);
  if (!parts.length) return null;
  const whole = norm(path.join(' > '));
  const exact = map.headings.find((h) => norm(h.text) === whole);
  if (exact && parts.length > 1) return exact;
  let scope: SectionRange | null = null;
  for (const part of parts) {
    const inScope = map.headings.filter((h) => !scope || (h.line > scope.line && h.line <= scope.end && h.level > scope.level));
    const hit = inScope.find((h) => norm(h.text) === part) ?? inScope.find((h) => h.slug === part.replace(/\s+/g, '-'));
    if (!hit) return null;
    scope = hit;
  }
  return scope;
}

export function findBlock(map: DocumentMap, id: string): BlockRange | null {
  const want = id.replace(/^\^/, '').toLowerCase();
  return map.blocks.find((b) => b.id.toLowerCase() === want) ?? null;
}

/** A frontmatter key's value (parsed like the knowledge index does) and its line range. */
export function frontmatterValue(text: string, map: DocumentMap, key: string): { key: string; value: unknown; line: number; end: number } | null {
  if (!map.frontmatter) return null;
  const k = map.frontmatter.keys.find((x) => x.key.toLowerCase() === key.trim().toLowerCase());
  if (!k) return null;
  const lines = text.split('\n').slice(k.line, k.end + 1).map((l) => l.replace(/\r$/, ''));
  const props = parseFrontmatter(lines);
  return { key: k.key, value: props[k.key] ?? null, line: k.line, end: k.end };
}

/** Lines start..end (inclusive, 0-based) of an LF text. */
export function sliceLines(text: string, start: number, end: number): string {
  return text.split('\n').slice(start, end + 1).join('\n');
}
