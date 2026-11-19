// Markdown parser extensions for Obsidian-flavoured syntax (lezer-markdown):
// YAML frontmatter, [[wikilinks]] / ![[embeds]], ==highlight==, $math$ / $$math$$, #tags.
// Pure (no DOM / app imports) so it can be unit tested in Node.
import type { MarkdownConfig, BlockContext, Line, InlineContext } from '@lezer/markdown';
import { GFM } from '@lezer/markdown';
import { tags as t, Tag } from '@lezer/highlight';
import { markdown, commonmarkLanguage, pasteURLAsLink } from '@codemirror/lang-markdown';
import { Language, LanguageDescription, LanguageSupport, foldNodeProp } from '@codemirror/language';
import type { MarkdownParser } from '@lezer/markdown';
import { languages } from '@codemirror/language-data';
import { languageForFence } from '@shared/languages';

/** Custom highlight tags (styled by theme.ts). */
export const mdTags = {
  wikilink: Tag.define(t.link),
  highlight: Tag.define(),
  math: Tag.define(),
  hashtag: Tag.define(),
  frontmatter: Tag.define(t.meta),
};

const Punctuation = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\xA1‐-‧]/;

// Internal parser state is not exposed in the typings; read defensively.
function inputOf(cx: BlockContext): { length: number; read(from: number, to: number): string } | null {
  const input = (cx as unknown as { input?: { length: number; read(from: number, to: number): string } }).input;
  return input && typeof input.read === 'function' ? input : null;
}
function lineDepthOk(cx: BlockContext, line: Line): boolean {
  const depth = (line as unknown as { depth?: number }).depth;
  const stack = (cx as unknown as { stack?: unknown[] }).stack;
  return depth === undefined || !stack ? true : depth >= stack.length;
}

/** `---\nkey: value\n---` at the very start of the document. */
const Frontmatter: MarkdownConfig = {
  defineNodes: [
    { name: 'Frontmatter', block: true, style: mdTags.frontmatter },
    { name: 'FrontmatterMark', style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || line.text.trimEnd() !== '---') return false;
        // Only commit when a closing fence exists, so a leading `---` rule followed by prose stays a rule.
        if (!/^([\w"'-][^:]*:(\s|$)|---|#)/.test(cx.peekLine())) return false;
        const input = inputOf(cx);
        if (input) {
          const head = input.read(0, Math.min(input.length, 64 * 1024));
          if (!/\n(---|\.\.\.)[ \t]*(\n|$)/.test(head)) return false;
        }
        const marks = [cx.elt('FrontmatterMark', 0, line.text.length)];
        while (cx.nextLine()) {
          if (/^(---|\.\.\.)\s*$/.test(line.text)) {
            marks.push(cx.elt('FrontmatterMark', cx.lineStart, cx.lineStart + line.text.length));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('Frontmatter', 0, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

/** [[target#heading|alias]] and ![[embed]]. */
const WikiLinks: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink', style: mdTags.wikilink },
    { name: 'WikiEmbed', style: mdTags.wikilink },
    { name: 'WikiMark', style: t.processingInstruction },
    { name: 'WikiTarget' },
    { name: 'WikiAlias' },
  ],
  parseInline: [
    {
      name: 'WikiLink',
      before: 'Link',
      parse(cx, next, pos) {
        const embed = next === 33 && cx.char(pos + 1) === 91 && cx.char(pos + 2) === 91;
        if (!embed && !(next === 91 && cx.char(pos + 1) === 91)) return -1;
        const open = pos + (embed ? 3 : 2);
        let pipe = -1;
        for (let i = open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 10 || c === 91) return -1;
          if (c === 124 && pipe < 0 && cx.char(i - 1) !== 92) pipe = i;
          if (c === 93) {
            if (cx.char(i + 1) !== 93 || i === open) return -1;
            const children = [cx.elt('WikiMark', pos, open)];
            const targetEnd = pipe >= 0 ? (cx.char(pipe - 1) === 92 ? pipe - 1 : pipe) : i;
            children.push(cx.elt('WikiTarget', open, targetEnd));
            if (pipe >= 0) {
              children.push(cx.elt('WikiMark', targetEnd, pipe + 1));
              if (pipe + 1 < i) children.push(cx.elt('WikiAlias', pipe + 1, i));
            }
            children.push(cx.elt('WikiMark', i, i + 2));
            return cx.addElement(cx.elt(embed ? 'WikiEmbed' : 'WikiLink', pos, i + 2, children));
          }
        }
        return -1;
      },
    },
  ],
};

const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
/** ==highlighted== (same flanking rules as GFM strikethrough). */
const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': mdTags.highlight } },
    { name: 'HighlightMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61 || cx.char(pos - 1) === 61) return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = Punctuation.test(before);
        const pAfter = Punctuation.test(after);
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
      },
    },
  ],
};

function mathElt(cx: InlineContext, from: number, open: number, close: number, end: number) {
  return cx.addElement(cx.elt('InlineMath', from, end, [cx.elt('MathMark', from, open), cx.elt('MathMark', close, end)]));
}

/** $inline$ and $$display$$ math (pandoc rules: no space inside the dollars, closing $ not followed by a digit). */
const MathExt: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath', style: mdTags.math },
    { name: 'BlockMath', block: true, style: mdTags.math },
    { name: 'MathMark', style: t.processingInstruction },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      after: 'InlineCode',
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const display = cx.char(pos + 1) === 36;
        const open = pos + (display ? 2 : 1);
        const first = cx.char(open);
        if (!display && (first === 32 || first === 9 || first === 10 || first === -1)) return -1;
        for (let i = open; i < cx.end; i++) {
          const c = cx.char(i);
          if (c === 92) {
            i++;
            continue;
          }
          if (c === 96) return -1;
          if (c === 10 && !display) return -1;
          if (c !== 36) continue;
          if (display) {
            if (cx.char(i + 1) !== 36) continue;
            return i === open ? -1 : mathElt(cx, pos, open, i, i + 2);
          }
          const prev = cx.char(i - 1);
          const nx = cx.char(i + 1);
          if (prev === 32 || prev === 9 || (nx >= 48 && nx <= 57)) return -1;
          return mathElt(cx, pos, open, i, i + 1);
        }
        return -1;
      },
    },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx, line) {
        const text = line.text.slice(line.pos);
        if (!text.startsWith('$$')) return false;
        const from = cx.lineStart + line.pos;
        const rest = text.slice(2);
        const marks = [cx.elt('MathMark', from, from + 2)];
        // One-liner: $$ x $$
        const closeIdx = rest.trimEnd().endsWith('$$') && rest.trim().length > 2 ? line.text.lastIndexOf('$$') : -1;
        if (closeIdx > line.pos + 1) {
          marks.push(cx.elt('MathMark', cx.lineStart + closeIdx, cx.lineStart + closeIdx + 2));
          cx.nextLine();
          cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks));
          return true;
        }
        // Require a closing $$ ahead so typing `$$` doesn't turn the rest of the note into math.
        const input = inputOf(cx);
        if (input) {
          const start = cx.lineStart + line.text.length;
          const ahead = input.read(start, Math.min(input.length, start + 32 * 1024));
          if (!/\$\$[ \t]*(\n|$)/.test(ahead)) return false;
        }
        while (cx.nextLine() && lineDepthOk(cx, line)) {
          const trimmed = line.text.trimEnd();
          if (trimmed.endsWith('$$')) {
            const idx = cx.lineStart + trimmed.length - 2;
            marks.push(cx.elt('MathMark', idx, idx + 2));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

const tagChar = /[\p{L}\p{N}_\-/]/u;
/** #tag and #nested/tag (must follow whitespace / line start, not all digits). */
const Hashtags: MarkdownConfig = {
  defineNodes: [{ name: 'Hashtag', style: mdTags.hashtag }],
  parseInline: [
    {
      name: 'Hashtag',
      parse(cx, next, pos) {
        if (next !== 35) return -1;
        if (pos > cx.offset) {
          const prev = cx.char(pos - 1);
          if (!(prev === 32 || prev === 9 || prev === 10 || prev === 40)) return -1;
        }
        let end = pos + 1;
        while (end < cx.end && tagChar.test(String.fromCharCode(cx.char(end)))) end++;
        const body = cx.slice(pos + 1, end);
        if (!body || /^[\d/-]+$/.test(body)) return -1;
        return cx.addElement(cx.elt('Hashtag', pos, end));
      },
    },
  ],
};

/** Obsidian %%comments%% (inline or block) and trailing ^block-ids. */
const Comments: MarkdownConfig = {
  defineNodes: [
    { name: 'ObsidianComment', style: t.comment },
    { name: 'ObsidianCommentBlock', block: true, style: t.comment },
    { name: 'CommentMark', style: t.processingInstruction },
    { name: 'BlockId', style: t.labelName },
  ],
  parseInline: [
    {
      name: 'ObsidianComment',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 37 || cx.char(pos + 1) !== 37) return -1;
        for (let i = pos + 2; i < cx.end - 1; i++) {
          if (cx.char(i) === 37 && cx.char(i + 1) === 37) {
            return cx.addElement(cx.elt('ObsidianComment', pos, i + 2, [cx.elt('CommentMark', pos, pos + 2), cx.elt('CommentMark', i, i + 2)]));
          }
        }
        return -1;
      },
    },
    {
      name: 'BlockId',
      parse(cx, next, pos) {
        if (next !== 94 || (pos > cx.offset && cx.char(pos - 1) !== 32 && cx.char(pos - 1) !== 9)) return -1;
        let end = pos + 1;
        while (end < cx.end && /[\w-]/.test(String.fromCharCode(cx.char(end)))) end++;
        if (end === pos + 1) return -1;
        let after = end;
        while (after < cx.end && (cx.char(after) === 32 || cx.char(after) === 9)) after++;
        if (after < cx.end && cx.char(after) !== 10) return -1;
        return cx.addElement(cx.elt('BlockId', pos, end));
      },
    },
  ],
  parseBlock: [
    {
      name: 'ObsidianCommentBlock',
      before: 'FencedCode',
      parse(cx, line) {
        if (line.text.slice(line.pos).trimEnd() !== '%%') return false;
        const input = inputOf(cx);
        if (input) {
          const start = cx.lineStart + line.text.length;
          const ahead = input.read(start, Math.min(input.length, start + 32 * 1024));
          if (!/%%[ \t]*(\n|$)/.test(ahead)) return false;
        }
        const from = cx.lineStart + line.pos;
        const marks = [cx.elt('CommentMark', from, from + 2)];
        while (cx.nextLine() && lineDepthOk(cx, line)) {
          const trimmed = line.text.trimEnd();
          if (trimmed.endsWith('%%')) {
            const idx = cx.lineStart + trimmed.length - 2;
            marks.push(cx.elt('CommentMark', idx, idx + 2));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('ObsidianCommentBlock', from, cx.prevLineEnd(), marks));
        return true;
      },
    },
  ],
};

const Folding: MarkdownConfig = {
  props: [
    foldNodeProp.add({
      Table: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
      BlockMath: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
      Frontmatter: (tree, state) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
    }),
  ],
};

export const markdownExtensions = [GFM, Frontmatter, WikiLinks, Highlight, MathExt, Hashtags, Comments, Folding];

/** ```info → language-data description (via the shared language table, with fuzzy fallback). */
export function fenceLanguage(info: string): LanguageDescription | null {
  const li = languageForFence(info);
  if (li?.cm) {
    const d = LanguageDescription.matchLanguageName(languages, li.cm, false);
    if (d) return d;
  }
  if (li && !li.cm) return null; // known language without a CM grammar (e.g. mermaid)
  return LanguageDescription.matchLanguageName(languages, info, true);
}

let mdSupport: LanguageSupport | null = null;
/** Shared Markdown LanguageSupport (keymap added separately so we control Enter/Backspace). */
export function markdownSupport(): LanguageSupport {
  return (mdSupport ??= markdown({
    base: commonmarkLanguage,
    extensions: markdownExtensions,
    codeLanguages: fenceLanguage,
    addKeymap: false,
    completeHTMLTags: false,
  }));
}

let liteSupport: LanguageSupport | null = null;
/**
 * Markdown without nested code-language parsing, for huge documents: lezer's parseMixed re-walks the
 * whole tree on every incremental parse, which makes typing laggy in multi-MB notes. Shares the
 * language-data facet so lang-markdown's list commands still recognise it.
 */
export function markdownSupportLite(): LanguageSupport {
  if (liteSupport) return liteSupport;
  const parser = (commonmarkLanguage.parser as MarkdownParser).configure(markdownExtensions);
  const lang = new Language(commonmarkLanguage.data, parser, [], 'markdown');
  return (liteSupport = new LanguageSupport(lang, [pasteURLAsLink]));
}

/** Documents above this size use markdownSupportLite(). */
export const HUGE_MARKDOWN = 1_000_000;
