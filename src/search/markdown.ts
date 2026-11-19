// Lightweight Markdown structure scan for search: which lines are frontmatter / fenced code (and in which
// language) / headings, plus tags and title. Deliberately line-based and forgiving (fences inside lists and
// blockquotes count) — it classifies matches, it doesn't render.
import { languageForFence, languageForPath } from '@shared/languages';
import { isMarkdown } from '@shared/paths';
import { computeLineStarts } from './text';
import type { MatchContext } from './types';

export const K_TEXT = 0;
export const K_HEADING = 1;
export const K_CODE = 2; // inside a fenced block
export const K_FENCE = 3; // the ``` marker lines themselves
export const K_FM = 4; // frontmatter body
export const K_FM_DELIM = 5;

export interface CodeBlock {
  /** Fence info word as written, lowercased ("bash"). '' when none. */
  lang: string;
  /** Canonical language id from shared/languages ("shell"), or the raw word if unknown. */
  langId: string;
  startLine: number;
  endLine: number; // inclusive (closing fence, or last line if unclosed)
}

export interface HeadingInfo {
  line: number;
  level: number;
  text: string;
}

export interface DocStructure {
  lineStarts: Int32Array;
  kinds: Uint8Array;
  /** Per line: index into blocks, -1 when not in a fenced block. */
  block: Int32Array;
  blocks: CodeBlock[];
  headings: HeadingInfo[];
  /** Lowercased, without '#', e.g. "tag/project". */
  tags: string[];
  title?: string;
  /** 'markdown' | 'code' | 'text' — how matches are classified. */
  mode: 'markdown' | 'code' | 'text';
  /** Canonical language of a code file. */
  fileLang?: string;
  /** Canonical ids of all fenced languages (for lang: filters). */
  langs: Set<string>;
}

const FENCE_RE = /^(\s*(?:>\s?)*\s*)(`{3,}|~{3,})(.*)$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const TAG_RE = /(^|[\s(\[,;])#([\p{L}\p{N}_\-\/]*[\p{L}_\-\/][\p{L}\p{N}_\-\/]*)/gu;

export function parseStructure(path: string, content: string): DocStructure {
  const lineStarts = computeLineStarts(content);
  const n = lineStarts.length;
  const kinds = new Uint8Array(n);
  const block = new Int32Array(n).fill(-1);
  const blocks: CodeBlock[] = [];
  const headings: HeadingInfo[] = [];
  const tags = new Set<string>();
  const langs = new Set<string>();
  const lineAt = (i: number) => content.slice(lineStarts[i], i + 1 < n ? lineStarts[i + 1] - 1 : content.length);

  if (!isMarkdown(path)) {
    const lang = languageForPath(path);
    const isText = !lang || lang.id === 'text';
    if (!isText) {
      kinds.fill(K_CODE);
      langs.add(lang!.id);
    }
    return { lineStarts, kinds, block, blocks, headings, tags: [], mode: isText ? 'text' : 'code', fileLang: isText ? undefined : lang!.id, langs };
  }

  let i = 0;
  let title: string | undefined;
  // Frontmatter: must start on the very first line and be closed.
  if (n > 1 && /^---[ \t]*$/.test(lineAt(0))) {
    let end = -1;
    for (let j = 1; j < n; j++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lineAt(j))) {
        end = j;
        break;
      }
    }
    if (end > 0) {
      kinds[0] = K_FM_DELIM;
      kinds[end] = K_FM_DELIM;
      let inTags = false;
      for (let j = 1; j < end; j++) {
        kinds[j] = K_FM;
        const l = lineAt(j);
        const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(l);
        if (kv) {
          const key = kv[1].toLowerCase();
          const val = kv[2].trim();
          inTags = (key === 'tags' || key === 'tag') && !val;
          if (key === 'title' && val) title = val.replace(/^(['"])(.*)\1$/, '$2');
          if ((key === 'tags' || key === 'tag') && val) {
            for (const t of val.replace(/^\[|\]$/g, '').split(/[,\s]+/)) {
              const c = t.replace(/^['"#]+|['"]+$/g, '').toLowerCase();
              if (c) tags.add(c);
            }
          }
        } else if (inTags) {
          const item = /^\s*-\s*(.+)$/.exec(l);
          if (item) {
            const c = item[1].trim().replace(/^['"#]+|['"]+$/g, '').toLowerCase();
            if (c) tags.add(c);
          } else if (l.trim()) inTags = false;
        }
      }
      i = end + 1;
    }
  }

  let fence: { ch: string; len: number; block: number } | null = null;
  for (; i < n; i++) {
    const l = lineAt(i);
    if (fence) {
      block[i] = fence.block;
      const m = FENCE_RE.exec(l);
      if (m && m[2][0] === fence.ch && m[2].length >= fence.len && !m[3].trim()) {
        kinds[i] = K_FENCE;
        blocks[fence.block].endLine = i;
        fence = null;
      } else kinds[i] = K_CODE;
      continue;
    }
    const c0 = l.trimStart()[0];
    if (c0 === undefined) continue;
    if (c0 === '`' || c0 === '~' || c0 === '>') {
      const m = FENCE_RE.exec(l);
      if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
        const info = m[3].trim();
        const word = info.split(/[\s{,]/)[0].replace(/^\./, '').toLowerCase();
        const li = word ? languageForFence(word) : null;
        const b: CodeBlock = { lang: word, langId: li?.id ?? word, startLine: i, endLine: n - 1 };
        if (b.langId) langs.add(b.langId);
        blocks.push(b);
        fence = { ch: m[2][0], len: m[2].length, block: blocks.length - 1 };
        kinds[i] = K_FENCE;
        block[i] = fence.block;
        continue;
      }
    }
    if (c0 === '#') {
      const m = ATX_RE.exec(l);
      if (m) {
        kinds[i] = K_HEADING;
        const text = (m[2] ?? '').trim();
        headings.push({ line: i, level: m[1].length, text });
        if (!title && m[1].length === 1 && text) title = text;
        collectTags(text, tags);
        continue;
      }
    }
    if ((c0 === '=' || c0 === '-') && i > 0 && kinds[i - 1] === K_TEXT) {
      const prev = lineAt(i - 1);
      if (SETEXT_RE.test(l) && prev.trim() && !LIST_RE.test(prev) && !/^\s*>/.test(prev)) {
        kinds[i - 1] = K_HEADING;
        const level = l.trim()[0] === '=' ? 1 : 2;
        headings.push({ line: i - 1, level, text: prev.trim() });
        if (!title && level === 1) title = prev.trim();
        kinds[i] = K_HEADING;
        continue;
      }
    }
    collectTags(l, tags);
  }
  headings.sort((a, b) => a.line - b.line);
  return { lineStarts, kinds, block, blocks, headings, tags: [...tags], title, mode: 'markdown', langs };
}

function collectTags(line: string, out: Set<string>) {
  if (line.indexOf('#') === -1) return;
  const stripped = line.indexOf('`') === -1 ? line : line.replace(/(`+)[^`]*?\1/g, (s) => ' '.repeat(s.length));
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(stripped); m; m = TAG_RE.exec(stripped)) out.add(m[2].toLowerCase());
}

// ---- inline spans (computed lazily per line when a match needs classifying) ----

export interface InlineSpan {
  start: number;
  end: number;
  kind: 'inline-code' | 'link';
}

export function inlineSpans(line: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  if (line.indexOf('`') === -1 && line.indexOf('[') === -1 && line.indexOf('://') === -1) return out;
  // 1) code spans (take precedence: links inside backticks are code)
  const codeMask: Array<[number, number]> = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === '`') j++;
    const runLen = j - i;
    let k = j;
    let close = -1;
    while (k < line.length) {
      const p = line.indexOf('`', k);
      if (p === -1) break;
      let q = p;
      while (line[q] === '`') q++;
      if (q - p === runLen) {
        close = p;
        break;
      }
      k = q;
    }
    if (close === -1) {
      i = j;
      continue;
    }
    out.push({ start: i, end: close + runLen, kind: 'inline-code' });
    codeMask.push([i, close + runLen]);
    i = close + runLen;
  }
  const inCode = (s: number) => codeMask.some(([a, b]) => s >= a && s < b);
  // 2) links: [[wiki]], [text](url), <url>, bare urls
  const linkRe = /!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<https?:\/\/[^>\s]+>|https?:\/\/[^\s<>()\]]+/g;
  for (let m = linkRe.exec(line); m; m = linkRe.exec(line)) {
    if (inCode(m.index)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, kind: 'link' });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Classification {
  context: MatchContext;
  lang?: string;
  langId?: string;
  headingLevel?: number;
}

/** Context of a match starting at `col` on `line`. `lineText` is the full line. */
export function classifyAt(s: DocStructure, line: number, col: number, lineText: string, spansCache?: Map<number, InlineSpan[]>): Classification {
  if (s.mode === 'code') return { context: 'code', lang: s.fileLang, langId: s.fileLang };
  const k = s.kinds[line];
  if (k === K_CODE || k === K_FENCE) {
    const b = s.blocks[s.block[line]];
    return { context: 'code', lang: b?.lang || undefined, langId: b?.langId || undefined };
  }
  if (k === K_FM || k === K_FM_DELIM) return { context: 'frontmatter' };
  let spans = spansCache?.get(line);
  if (!spans) {
    spans = inlineSpans(lineText);
    spansCache?.set(line, spans);
  }
  for (const sp of spans) {
    if (col >= sp.start && col < sp.end) return { context: sp.kind };
    if (sp.start > col) break;
  }
  if (k === K_HEADING) {
    const h = s.headings.find((x) => x.line === line);
    return { context: 'heading', headingLevel: h?.level ?? (lineText.trim()[0] === '=' ? 1 : 2) };
  }
  return { context: 'text' };
}
