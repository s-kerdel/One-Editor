// Splits a document into independently renderable sections (at ATX headings) so the preview can
// re-render only what changed and mount huge documents progressively.
//
// A split is only made where it is provably neutral: a column-0 `# heading` always terminates every
// open container, EXCEPT inside top-level fenced code, multi-line HTML blocks, `$$` math, `%%` comments
// and frontmatter. The scanner tracks those; whenever it is unsure it errs towards NOT splitting.
//
// Long stretches without headings (logs, exports, journals) also split at "soft" cuts: a column-0
// paragraph-like line after a blank line, outside every tracked construct and not a list item. After
// a blank line such a line can only start a new top-level block (list items need indented content,
// quotes and lazy continuations need no blank line), so the cut is neutral too. Soft cuts are
// content-defined (a hash of the line, above a minimum size): an edit moves at most the cuts next to
// it, so typing re-renders one section, not everything after the cursor.

export interface Section {
  text: string;
  /** 0-based line of the section's first line in the document. */
  start: number;
  lines: number;
  /** Ends inside an unterminated construct — nothing may be appended when rendering it. */
  open: boolean;
}
export interface SplitResult {
  sections: Section[];
  /** Link reference definitions (`[id]: url`), which must be visible to every section. */
  defs: string;
}

interface Fence {
  ch: string;
  len: number;
  kind: 'top' | 'list' | 'quote';
  indent: number; // list: content indent of the owning item
}

const FENCE_RE = /^( *)((?:> ?)+)?((?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/;
const LIST_RE = /^( {0,3})((?:[-*+]|\d{1,9}[.)])[ \t]+)/;
const HEADING_RE = /^#{1,6}(?:[ \t]|$)/;
const DEF_RE = /^ {0,3}\[(?!\^)[^\]]+\]:\s*\S/;
const MIN_SPLIT_SIZE = 6000;
/** Soft cuts: none before this many chars since the last cut; at the first eligible line after the max. */
const SOFT = { min: 8000, max: 32000 };
/** First char of a soft-cut line: prose-like (not `>` `[` `<` `$` `|` `:` `%` `-` `+` `=` `#` `~` `` ` ``…). */
const SOFT_START = /^[\p{L}\p{N}*_!("'\\]/u;
/** Cheap line hash (FNV-1a over the first 64 chars): picks which eligible lines cut, by content. */
/** A list item, also an empty one (`2.` alone continues a loose list after a blank line). */
const ANY_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
function lineHash(s: string): number {
  let h = 0x811c9dc5;
  for (let k = 0, n = Math.min(64, s.length); k < n; k++) h = Math.imul(h ^ s.charCodeAt(k), 0x01000193);
  return h >>> 0;
}

/** `soft`: soft-cut sizes (tests pass `max: 0` to cut at every eligible line). */
export function splitSections(src: string, soft = SOFT): SplitResult {
  const whole = (): SplitResult => ({ sections: [{ text: src, start: 0, lines: countLines(src), open: true }], defs: '' });
  // Small documents render in one go; footnotes need document-wide numbering.
  if (src.length < MIN_SPLIT_SIZE || /^ {0,3}\[\^[^\]]+\]:/m.test(src)) return whole();

  const lines = src.split('\n');
  const cuts: number[] = [0];
  const defs: string[] = [];
  let fence: Fence | null = null;
  let htmlEnd: RegExp | 'blank' | null = null;
  let math = false;
  let comment = false;
  let listIndent = -1; // content indent of the current top-level list item, -1 when not in a list
  let i = 0;
  let off = 0; // char offset of line i
  let cutOff = 0; // char offset of the last cut

  if (lines[0].trimEnd() === '---') {
    for (i = 1; i < lines.length; i++) {
      const t = lines[i].trimEnd();
      if (t === '---' || t === '...') break;
    }
    if (i >= lines.length) return whole();
    i++;
    for (let k = 0; k < i; k++) off += lines[k].length + 1;
  }

  for (; i < lines.length; off += lines[i].length + 1, i++) {
    const line = lines[i];
    const blank = line.trim() === '';
    const indent = line.length - line.trimStart().length;

    if (fence) {
      const m = FENCE_RE.exec(line);
      const closes = !!m && m[4][0] === fence.ch && m[4].length >= fence.len && m[5].trim() === '' && !m[3];
      if (fence.kind === 'top') {
        if (closes && indent <= 3 && !m![2]) fence = null;
        continue;
      }
      // A fence inside a list item / blockquote also ends when its container does.
      const containerEnded = fence.kind === 'quote' ? !/^ {0,3}>/.test(line) : !blank && indent < fence.indent;
      if (!containerEnded) {
        if (closes) fence = null;
        continue;
      }
      fence = null; // fall through: this line is ordinary top-level content
    }
    if (htmlEnd) {
      if (htmlEnd === 'blank' ? blank : htmlEnd.test(line)) htmlEnd = null;
      continue;
    }
    if (math) {
      if (line.trimEnd().endsWith('$$')) math = false;
      continue;
    }
    if (comment) {
      if (countOf(line, '%%') % 2 === 1) comment = false;
      continue;
    }
    if (blank) continue;

    const fm = FENCE_RE.exec(line);
    if (fm && !(fm[4][0] === '`' && fm[5].includes('`'))) {
      const col = fm[1].length;
      if (fm[2]) fence = { ch: fm[4][0], len: fm[4].length, kind: 'quote', indent: 0 };
      else if (fm[3]) fence = { ch: fm[4][0], len: fm[4].length, kind: 'list', indent: col + fm[3].length };
      else if (listIndent >= 0 && col >= listIndent) fence = { ch: fm[4][0], len: fm[4].length, kind: 'list', indent: listIndent };
      else if (col <= 3) fence = { ch: fm[4][0], len: fm[4].length, kind: 'top', indent: 0 };
      if (fm[3] && col <= 3) listIndent = col + fm[3].length;
      continue;
    }

    if (indent === 0) {
      const lm = LIST_RE.exec(line);
      listIndent = lm ? lm[1].length + lm[2].length : -1;
    } else if (indent <= 3 && listIndent < 0) {
      const lm = LIST_RE.exec(line);
      if (lm) listIndent = lm[1].length + lm[2].length;
    }

    if (indent <= 3) {
      const t = line.trimStart();
      if (t.startsWith('$$')) {
        const rest = t.slice(2).trimEnd();
        if (!(rest.length >= 2 && rest.endsWith('$$'))) math = true;
        continue;
      }
      if (t.startsWith('<')) {
        const raw = /^<(pre|script|style|textarea)(?:\s|>|$)/i.exec(t);
        if (raw) {
          const end = new RegExp(`</${raw[1]}>`, 'i');
          if (!end.test(t)) htmlEnd = end;
        } else if (t.startsWith('<!--')) {
          if (!t.includes('-->')) htmlEnd = /-->/;
        } else if (/^<[/?!a-zA-Z]/.test(t)) htmlEnd = 'blank';
        continue;
      }
      if (DEF_RE.test(line)) defs.push(line);
    }
    if (countOf(line, '%%') % 2 === 1) {
      comment = true;
      continue;
    }
    if (indent === 0 && i > 0 && HEADING_RE.test(line)) {
      cuts.push(i);
      cutOff = off;
    } else if (indent === 0 && i > 0 && listIndent < 0 && lines[i - 1].trim() === '' && SOFT_START.test(line) && !ANY_ITEM.test(line)) {
      const since = off - cutOff;
      if (since >= soft.max || (since >= soft.min && (lineHash(line) & 7) === 0)) {
        cuts.push(i);
        cutOff = off;
      }
    }
  }

  const open = !!fence || !!htmlEnd || math || comment;
  const sections: Section[] = [];
  for (let c = 0; c < cuts.length; c++) {
    const from = cuts[c];
    const to = c + 1 < cuts.length ? cuts[c + 1] : lines.length;
    sections.push({ text: lines.slice(from, to).join('\n'), start: from, lines: to - from, open: c === cuts.length - 1 && open });
  }
  return { sections, defs: defs.join('\n') };
}

function countOf(s: string, needle: string): number {
  let n = 0;
  for (let i = s.indexOf(needle); i !== -1; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
}

/** What to feed the renderer for one section: its text plus the shared reference definitions. */
export function sectionSource(sec: Section, defs: string): string {
  // Trailing newline: an unterminated fence at the end of a section must render like it does mid-document.
  return defs && !sec.open ? `${sec.text}\n\n${defs}\n` : `${sec.text}\n`;
}
