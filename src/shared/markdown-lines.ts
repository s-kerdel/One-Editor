// Line-level Markdown structure without backtracking regexes. The regex forms these replace
// (`^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`, `^(\s*(?:>\s?)*\s*)(`{3,}|~{3,})(.*)$`) are
// ambiguous: a crafted line of spaces made them quadratic (a 40 KB heading blocked indexing for seconds).
// These are single forward scans with the same results. Used by search (markdown.ts) and knowledge
// (extract.ts, sections.ts), in the app and in the MCP server alike.

/** Longer lines are never headings, fences, blocks or frontmatter keys (structure parsing skips them). */
export const MAX_STRUCTURE_LINE = 10_000;

const spaceTab = (c: number) => c === 32 || c === 9;

/** An ATX heading line ("## Title ##") → level + text (closing #s and surrounding blanks removed), else null. */
export function parseAtxHeading(line: string): { level: number; text: string } | null {
  if (line.length > MAX_STRUCTURE_LINE) return null;
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === 35) j++;
  const level = j - i;
  if (level < 1 || level > 6) return null;
  if (j < line.length && !spaceTab(line.charCodeAt(j))) return null;
  let end = line.length;
  while (end > j && spaceTab(line.charCodeAt(end - 1))) end--;
  // A closing sequence: #s at the end, after a blank.
  let k = end;
  while (k > j && line.charCodeAt(k - 1) === 35) k--;
  if (k < end && (k === j || spaceTab(line.charCodeAt(k - 1)))) end = k;
  let s = j;
  while (s < end && spaceTab(line.charCodeAt(s))) s++;
  let e = end;
  while (e > s && spaceTab(line.charCodeAt(e - 1))) e--;
  return { level, text: line.slice(s, e) };
}

const ws = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** A code fence, possibly inside block quotes ("> ```js") → the quote prefix, the fence run, the info text. */
export function parseQuotedFence(line: string): { prefix: string; fence: string; info: string } | null {
  if (line.length > MAX_STRUCTURE_LINE) return null;
  let i = 0;
  while (ws(line[i])) i++;
  while (line[i] === '>') {
    i++;
    if (ws(line[i])) i++;
  }
  while (ws(line[i])) i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let j = i;
  while (line[j] === ch) j++;
  if (j - i < 3) return null;
  return { prefix: line.slice(0, i), fence: line.slice(i, j), info: line.slice(j) };
}

/** `key: value` / `key:` at the start of a frontmatter line (keys: letters, digits, _ . - and spaces). */
export function parseKeyLine(line: string): { key: string; value: string | undefined } | null {
  if (line.length > MAX_STRUCTURE_LINE) return null;
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const key = line.slice(0, colon).trimEnd();
  if (!/^[A-Za-z0-9_][\w .-]*$/.test(key)) return null;
  const after = line.slice(colon + 1);
  if (after && !ws(after[0])) return null; // "a:b" is not a key line
  return { key, value: after ? after.trimStart() : undefined };
}

/**
 * Inline code spans of one line, as [start, end) pairs in order. CommonMark rule: a backtick run opens a
 * span that closes at the next run of exactly the same length; without one the run is literal. Linear:
 * a table of runs, each run's next same-length run found in one pass from the right (the backreference
 * regexes this replaces took seconds on a line of runs of 1, 2, 3… backticks).
 */
export function codeSpans(line: string): Array<[number, number]> {
  if (line.indexOf('`') === -1) return [];
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < line.length; ) {
    if (line.charCodeAt(i) !== 96) {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line.charCodeAt(j) === 96) j++;
    starts.push(i);
    lens.push(j - i);
    i = j;
  }
  const next = new Int32Array(starts.length);
  const nearest = new Map<number, number>();
  for (let r = starts.length - 1; r >= 0; r--) {
    next[r] = nearest.get(lens[r]) ?? -1;
    nearest.set(lens[r], r);
  }
  const out: Array<[number, number]> = [];
  for (let r = 0; r < starts.length; ) {
    const c = next[r];
    if (c === -1) {
      r++;
      continue;
    }
    out.push([starts[r], starts[c] + lens[c]]);
    r = c + 1;
  }
  return out;
}

/** `line` with its code spans (backticks included) blanked to spaces, same length. Lines over the
 *  structure cap are returned as they are. */
export function blankCodeSpans(line: string): string {
  if (line.length > MAX_STRUCTURE_LINE || line.indexOf('`') === -1) return line;
  const spans = codeSpans(line);
  if (!spans.length) return line;
  let out = '';
  let at = 0;
  for (const [a, b] of spans) {
    out += line.slice(at, a) + ' '.repeat(b - a);
    at = b;
  }
  return out + line.slice(at);
}
