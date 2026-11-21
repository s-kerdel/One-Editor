// Labels for the back / forward buttons' recent-places list (right-click / long-press). Pure; loaded
// lazily the first time a list opens (heading extraction is not startup code).
import { basename, isMarkdown } from '@shared/paths';
import { extractHeadings } from '../../knowledge/extract';
import type { NavEntry } from './history';

const MAX_HINT = 36;

/** Text up to and including 0-based `line` (headings below the spot don't matter). */
function upTo(text: string, line: number): string {
  let at = -1;
  for (let n = 0; n <= line; n++) {
    at = text.indexOf('\n', at + 1);
    if (at < 0) return text;
  }
  return text.slice(0, at);
}

/**
 * File name + a hint of the spot: the heading the line sits under (Markdown, when its text is at hand:
 * an open doc), else the line; PDFs: the page.
 */
export function describePlace(e: NavEntry, text?: string): { label: string; hint: string } {
  const label = basename(e.path) || e.path;
  if (e.page) return { label, hint: `page ${e.page}` };
  if (e.line === undefined) return { label, hint: '' };
  let hint = '';
  if (text !== undefined && isMarkdown(e.path)) hint = extractHeadings(upTo(text, e.line)).at(-1)?.text ?? '';
  if (hint.length > MAX_HINT) hint = hint.slice(0, MAX_HINT - 1).trimEnd() + '…';
  return { label, hint: hint || `line ${e.line + 1}` };
}
