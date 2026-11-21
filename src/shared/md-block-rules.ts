// One's own markdown-it block rules (pure; no DOM): frontmatter, %% comment blocks, $$ math blocks (which
// interrupt a paragraph), \pagebreak. Shared by the preview (renderer/preview/markdown.ts) and the MCP
// server's {{placeholder}} check (mcp/placeholders.ts), so both see the same code blocks in a note.
import type MarkdownIt from 'markdown-it';
import type { StateBlock } from 'markdown-it';

/** `env.opts.frontmatter === false` (preview option): a leading `---` block is not frontmatter. */
const frontmatterOff = (state: StateBlock) => (state.env as { opts?: { frontmatter?: boolean } } | undefined)?.opts?.frontmatter === false;

export function frontmatterRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if (startLine !== 0 || state.level !== 0 || frontmatterOff(state)) return false;
  const src = state.src;
  if (src.slice(state.bMarks[0], state.eMarks[0]).trimEnd() !== '---') return false;
  let line = 1;
  for (; line < endLine; line++) {
    const t = src.slice(state.bMarks[line], state.eMarks[line]).trimEnd();
    if (t === '---' || t === '...') break;
  }
  if (line >= endLine) return false;
  if (silent) return true;
  const token = state.push('frontmatter', 'div', 0);
  token.content = src.slice(state.bMarks[1] ?? src.length, state.bMarks[line]);
  token.map = [0, line + 1];
  token.block = true;
  state.line = line + 1;
  return true;
}

/** `%%` at line start opens a block comment that may span blank lines (Obsidian). */
export function commentBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (state.src.charCodeAt(pos) !== 0x25 || state.src.charCodeAt(pos + 1) !== 0x25) return false;
  const close = state.src.indexOf('%%', pos + 2);
  if (close !== -1 && close < max) return false; // closes on the same line → inline rule handles it
  if (silent) return true;
  let line = startLine + 1;
  for (; line < endLine; line++) if (state.src.slice(state.bMarks[line], state.eMarks[line]).includes('%%')) break;
  state.line = Math.min(line + 1, endLine);
  return true;
}

export function mathBlockRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const src = state.src;
  const pos = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (pos + 2 > max || src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x24) return false;
  const first = src.slice(pos + 2, max);
  let content: string;
  let next: number;
  if (first.trim().length >= 2 && first.trimEnd().endsWith('$$')) {
    content = first.trimEnd().slice(0, -2);
    next = startLine + 1;
  } else {
    const parts = [first];
    let line = startLine + 1;
    let found = false;
    for (; line < endLine; line++) {
      const l = src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
      if (l.trimEnd().endsWith('$$')) {
        parts.push(l.trimEnd().slice(0, -2));
        found = true;
        break;
      }
      parts.push(l);
    }
    if (!found) return false;
    content = parts.join('\n');
    next = line + 1;
  }
  if (!content.trim()) return false;
  if (silent) return true;
  const token = state.push('math_block', 'div', 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, next];
  state.line = next;
  return true;
}

/** A line holding only `\pagebreak` or `\newpage` (Pandoc / LaTeX habit): a page break in print and PDF. */
export function pageBreakRule(state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]).trimEnd();
  if (line !== '\\pagebreak' && line !== '\\newpage') return false;
  if (silent) return true;
  const token = state.push('page_break', 'div', 0);
  token.block = true;
  token.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

/** Registers the four rules where the preview has always had them. */
export function useOneBlockRules<M extends InstanceType<typeof MarkdownIt>>(md: M): M {
  md.block.ruler.before('table', 'frontmatter', frontmatterRule);
  md.block.ruler.before('fence', 'comment_block', commentBlockRule);
  md.block.ruler.before('fence', 'math_block', mathBlockRule, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  md.block.ruler.before('paragraph', 'page_break', pageBreakRule, { alt: ['paragraph'] });
  return md;
}
