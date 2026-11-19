// Page preview: Mod+hover over a [[wikilink]] shows the start of the linked note (Obsidian style).
import { hoverTooltip, EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { basename, stem } from '@shared/paths';
import { parseWikiLink } from '@shared/wikilinks';
import { docPath, getEditorHost } from './host';
import { renderInline } from './inline-render';
import { modKey } from './links';

let modHeld = false;
const trackMod = EditorView.domEventHandlers({
  mousemove(e) {
    modHeld = modKey(e);
    return false;
  },
});

/** First lines of a note as light DOM (headings, lists, paragraphs, code), frontmatter stripped. */
export function renderSnippet(text: string, into: HTMLElement, maxLines = 24) {
  const body = text.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\s*(\n|$)/, '');
  const lines = body.split('\n');
  let inFence = false;
  let count = 0;
  let pre: HTMLElement | null = null;
  for (const line of lines) {
    if (count >= maxLines) break;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      pre = inFence ? into.appendChild(document.createElement('pre')) : null;
      continue;
    }
    if (inFence && pre) {
      pre.textContent += (pre.textContent ? '\n' : '') + line;
      count++;
      continue;
    }
    if (!line.trim()) continue;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    const q = /^\s*>\s?(.*)$/.exec(line);
    let el: HTMLElement;
    if (h) {
      el = document.createElement('div');
      el.className = `se-hp-h se-hp-h${h[1].length}`;
      renderInline(h[2], el);
    } else if (li) {
      el = document.createElement('div');
      el.className = 'se-hp-li' + (li[1] && li[1] !== ' ' ? ' se-hp-done' : '');
      el.textContent = li[1] !== undefined ? (li[1] === ' ' ? '☐ ' : '☑ ') : '• ';
      renderInline(li[2], el);
    } else if (q) {
      el = document.createElement('div');
      el.className = 'se-hp-quote';
      renderInline(q[1].replace(/^\[!([\w-]+)\][+-]?\s*/, (_m, t: string) => `${t.toUpperCase()}: `), el);
    } else {
      el = document.createElement('p');
      renderInline(line, el);
    }
    into.appendChild(el);
    count++;
  }
  if (!into.childElementCount) into.textContent = 'Empty note';
}

const preview = hoverTooltip(
  (view, pos, side) => {
    if (!modHeld) return null;
    const host = getEditorHost();
    if (!host?.resolveWiki || !host.readNote) return null;
    let node = syntaxTree(view.state).resolveInner(pos, side);
    while (node && node.name !== 'WikiLink' && node.name !== 'WikiEmbed' && node.parent) node = node.parent;
    if (!node || (node.name !== 'WikiLink' && node.name !== 'WikiEmbed')) return null;
    const t = node.getChild('WikiTarget');
    if (!t) return null;
    const link = parseWikiLink(view.state.sliceDoc(t.from, t.to));
    const from = view.state.facet(docPath);
    const path = host.resolveWiki(link.target, from);
    if (!path || !/\.(md|markdown|mdx)$/i.test(path)) return null;
    return {
      pos: node.from,
      end: node.to,
      above: false,
      create() {
        const dom = document.createElement('div');
        dom.className = 'se-hover-preview';
        const title = document.createElement('div');
        title.className = 'se-hp-title';
        title.textContent = stem(basename(path));
        const meta = document.createElement('span');
        meta.className = 'se-hp-path';
        meta.textContent = path;
        title.appendChild(meta);
        const body = document.createElement('div');
        body.className = 'se-hp-body';
        body.textContent = 'Loading…';
        dom.append(title, body);
        void host.readNote!(path).then((text) => {
          body.textContent = '';
          if (text == null) body.textContent = 'Cannot read note';
          else renderSnippet(link.heading ? text.slice(Math.max(0, text.search(new RegExp(`^#{1,6}\\s+${link.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm')))) : text, body);
        });
        return { dom };
      },
    };
  },
  { hoverTime: 350 },
);

export const pagePreview = [trackMod, preview];
