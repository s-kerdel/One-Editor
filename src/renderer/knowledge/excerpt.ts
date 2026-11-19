// What a link hover preview shows: the start of the note (first ~12 lines, frontmatter dropped, a
// leading H1 that only repeats the title dropped) or the linked `#heading` / `#^block` section. Pure.
// Section lookup is the preview's own (embeds.ts), so `![[note#x]]` and the preview agree.
import { extractSection, stripFrontmatter } from '../preview/embeds';

export interface Excerpt {
  markdown: string;
  /** The `#fragment` was not found: `markdown` is the start of the note instead. */
  missing: boolean;
  /** Lines were cut off. */
  truncated: boolean;
}

export const EXCERPT_LINES = 12;
export const SECTION_LINES = 40;

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function excerpt(text: string, fragment?: string, title?: string, maxLines = EXCERPT_LINES): Excerpt {
  const body = stripFrontmatter(text.replace(/\r\n?/g, '\n'));
  let part = body;
  let missing = false;
  let limit = maxLines;
  if (fragment) {
    const sec = extractSection(body, fragment);
    if (sec === null) missing = true;
    else {
      part = sec;
      limit = SECTION_LINES;
    }
  }
  let lines = part.split('\n');
  const skipBlank = () => {
    while (lines.length && !lines[0].trim()) lines.shift();
  };
  skipBlank();
  // The popup's head names the note already.
  if ((!fragment || missing) && title) {
    const h = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[0] ?? '');
    if (h && norm(h[1]) === norm(title)) {
      lines.shift();
      skipBlank();
    }
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let truncated = false;
  if (lines.length > limit) {
    lines = lines.slice(0, limit);
    truncated = true;
  }
  // A cut inside a code fence would turn everything after it into code: close it.
  let fence: string | null = null;
  for (const l of lines) {
    const m = FENCE_RE.exec(l);
    if (!m) continue;
    if (!fence) fence = m[1];
    else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
  }
  if (fence) lines.push(fence);
  // Block ids (`text ^id`) are anchors, not content.
  return { markdown: lines.join('\n').replace(/(^|[ \t])\^[\w-]+[ \t]*$/gm, '$1').trimEnd(), missing, truncated };
}
