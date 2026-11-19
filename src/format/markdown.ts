// Markdown-specific pieces: locating fenced code blocks (incl. inside lists and blockquotes),
// rewriting their bodies, and shielding Obsidian syntax from Prettier's markdown printer.
import type { FormatIssue, FormatResult } from './types';

export interface CodeBlock {
  /** 0-based line of the opening fence. */
  openLine: number;
  /** 0-based line of the closing fence. */
  closeLine: number;
  info: string;
  /** Literal text put before every body line ("> ", "    ", ">   "). */
  prefix: string;
  /** Body with the container prefix removed, lines joined by \n (no trailing newline). */
  code: string;
  /** Offsets of the body (first body line start … closing fence line start). */
  from: number;
  to: number;
  /** Offsets spanning both fence lines (for hit-testing the cursor). */
  outerFrom: number;
  outerTo: number;
}

const OPEN_RE = /^((?:[ \t]*>)*[ \t]*)((?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(`{3,}|~{3,})(.*)$/;

interface Container {
  depth: number; // number of blockquote markers
  indent: number; // columns of indentation after the last marker
}

function containerOf(quotePart: string, markerLen: number): Container {
  const depth = (quotePart.match(/>/g) ?? []).length;
  let rest = quotePart.slice(quotePart.lastIndexOf('>') + 1);
  if (depth && rest.startsWith(' ')) rest = rest.slice(1);
  return { depth, indent: rest.replace(/\t/g, '    ').length + markerLen };
}

/** Removes the container prefix from a body line; null when the line left the container. */
function stripContainer(line: string, c: Container): string | null {
  let i = 0;
  for (let d = 0; d < c.depth; d++) {
    let sp = 0;
    while (sp < 3 && line[i] === ' ') {
      i++;
      sp++;
    }
    if (line[i] !== '>') return null;
    i++;
    if (line[i] === ' ') i++;
  }
  let cols = 0;
  while (cols < c.indent && i < line.length) {
    if (line[i] === ' ') cols++;
    else if (line[i] === '\t') cols += 4;
    else break;
    i++;
  }
  return line.slice(i);
}

/** Line ranges of YAML frontmatter: [0, closingLine] or null. */
function frontmatterEnd(lines: string[]): number {
  if (lines[0] !== '---') return -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---' || lines[i] === '...') return i;
  return -1;
}

/** All properly closed fenced code blocks, in document order. */
export function findCodeBlocks(text: string): CodeBlock[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) {
    starts.push(off);
    off += l.length + 1;
  }
  const blocks: CodeBlock[] = [];
  let i = frontmatterEnd(lines) + 1;
  while (i < lines.length) {
    const m = OPEN_RE.exec(lines[i]);
    if (!m || (m[3][0] === '`' && m[4].includes('`'))) {
      i++;
      continue;
    }
    const marker = m[2] ?? '';
    const cont = containerOf(m[1], marker.length);
    const prefix = m[1] + ' '.repeat(marker.length);
    const fenceChar = m[3][0];
    const fenceLen = m[3].length;
    const body: string[] = [];
    let close = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const stripped = stripContainer(lines[j], cont);
      if (stripped === null) break; // left the blockquote: the block was never closed
      const t = stripped.trimStart();
      if (stripped.length - t.length <= 3 && t[0] === fenceChar) {
        const run = /^(`+|~+)[ \t]*$/.exec(t);
        if (run && run[1].length >= fenceLen) {
          close = j;
          break;
        }
      }
      body.push(stripped);
    }
    if (close === -1) {
      // Unclosed fence: per CommonMark it runs to the end of its container — nothing safe to format after it.
      i = j === i + 1 ? i + 1 : j;
      if (j >= lines.length) break;
      continue;
    }
    blocks.push({ openLine: i, closeLine: close, info: m[4].trim(), prefix, code: body.join('\n'), from: starts[i + 1], to: starts[close], outerFrom: starts[i], outerTo: starts[close] + lines[close].length });
    i = close + 1;
  }
  return blocks;
}

function indentBody(code: string, prefix: string): string {
  const bare = prefix.trimEnd();
  const body = code.replace(/\n+$/, '');
  if (body === '') return '';
  return (
    body
      .split('\n')
      .map((l) => (l === '' ? bare : prefix + l))
      .join('\n') + '\n'
  );
}

export type BlockFormatter = (code: string, info: string) => Promise<FormatResult>;

export interface CodeBlocksResult {
  text: string;
  formatted: number;
  /** Blocks whose language has a formatter (formatted or not). */
  candidates: number;
  warnings: FormatIssue[];
  /** True when `onlyAt` pointed at no block. */
  noBlock?: boolean;
}

/**
 * Formats fenced blocks by their fence language. Fence lines, info strings and container
 * indentation stay exactly as written; blocks with unknown languages or syntax errors are skipped.
 */
export async function formatCodeBlocks(text: string, format: BlockFormatter, onlyAt?: number): Promise<CodeBlocksResult> {
  let blocks = findCodeBlocks(text);
  if (onlyAt !== undefined) {
    blocks = blocks.filter((b) => onlyAt >= b.outerFrom && onlyAt <= b.outerTo);
    if (!blocks.length) return { text, formatted: 0, candidates: 0, warnings: [], noBlock: true };
  }
  const warnings: FormatIssue[] = [];
  let out = '';
  let pos = 0;
  let formatted = 0;
  let candidates = 0;
  for (const b of blocks) {
    if (!b.info) continue;
    const r = await format(b.code, b.info);
    if (r.supported === false || r.language === null) continue;
    candidates++;
    if (r.error) {
      const e = r.error;
      const line = e.line !== undefined ? e.line + b.openLine + 1 : b.openLine + 1;
      const col = e.col !== undefined ? e.col + b.prefix.length : undefined;
      const where = col !== undefined ? `${line}:${col}` : `${line}`;
      // Re-point the message at the document line; the block-relative one would mislead.
      const message = e.line !== undefined ? e.message.replace(/ at \d+(:\d+)?:/, ` at ${where}:`) : e.message.replace(/: /, ` in block at line ${line}: `);
      warnings.push({ ...e, line, col, message });
      continue;
    }
    const body = indentBody(r.text, b.prefix);
    if (body === text.slice(b.from, b.to)) continue;
    out += text.slice(pos, b.from) + body;
    pos = b.to;
    formatted++;
  }
  return { text: out + text.slice(pos), formatted, candidates, warnings };
}

// ---------- Obsidian syntax protection ----------

// Private-use characters: Prettier treats them as ordinary word characters of width 1,
// so a same-length token keeps table alignment intact.
const T_OPEN = '';
const T_FILL = '';
const T_CLOSE = '';
const T_DIGIT0 = 0xe100;
const T_BASE = 0x1000;
const TOKEN_RE = /([-]+)*/g;
const HAS_PUA = /[-]/;

// Alternatives, in priority order: inline code (left alone) | %%comment%% | [[wikilink]] / ![[embed]] | $inline math$
const PROTECT_RE = /(`+)(?!`)[^\n]*?[^`\n]\1(?!`)|%%[\s\S]*?%%|!?\[\[[^[\]\n]+\]\]|(?<![\\$\w])\$(?![\s$])(?:[^$\n\\]|\\.)*?(?<![\s\\])\$(?![\d$])/g;

function token(index: number, length: number): string {
  let digits = '';
  let n = index;
  do {
    digits = String.fromCharCode(T_DIGIT0 + (n % T_BASE)) + digits;
    n = Math.floor(n / T_BASE);
  } while (n > 0);
  return T_OPEN + digits + T_FILL.repeat(Math.max(0, length - digits.length - 2)) + T_CLOSE;
}

export interface Protection {
  text: string;
  /** Puts the originals back; returns null if Prettier lost or duplicated a token. */
  restore(formatted: string): string | null;
}

/**
 * Replaces Obsidian constructs Prettier would mangle (`[[a|b]]` in tables, `%%comments%%`,
 * `$a|b$`) with opaque tokens. Code blocks, inline code and frontmatter are not touched.
 */
export function protectObsidian(text: string): Protection {
  if (HAS_PUA.test(text)) return { text, restore: (s) => s };
  const saved: string[] = [];
  // Regions Prettier keeps verbatim anyway; tokens inside them would only risk mismatches.
  const skip: Array<[number, number]> = [];
  const fm = /^---\n[\s\S]*?\n(?:---|\.\.\.)(?=\n|$)/.exec(text);
  if (fm) skip.push([0, fm[0].length]);
  for (const b of findCodeBlocks(text)) skip.push([b.outerFrom, b.outerTo]);

  const protectSegment = (seg: string) =>
    seg.replace(PROTECT_RE, (m) => {
      if (m[0] === '`') return m;
      const multiline = m.includes('\n');
      saved.push(m);
      return token(saved.length - 1, multiline ? 0 : m.length);
    });

  let out = '';
  let pos = 0;
  for (const [from, to] of skip) {
    out += protectSegment(text.slice(pos, from)) + text.slice(from, to);
    pos = to;
  }
  out += protectSegment(text.slice(pos));

  return {
    text: out,
    restore(formatted) {
      const seen = new Set<number>();
      let ok = true;
      const restored = formatted.replace(TOKEN_RE, (_m, digits: string) => {
        let idx = 0;
        for (const ch of digits) idx = idx * T_BASE + (ch.charCodeAt(0) - T_DIGIT0);
        if (idx >= saved.length || seen.has(idx)) ok = false;
        seen.add(idx);
        return saved[idx] ?? '';
      });
      return ok && seen.size === saved.length && !HAS_PUA.test(restored) ? restored : null;
    },
  };
}
