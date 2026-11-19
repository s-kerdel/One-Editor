// Link hover preview, editor side (live and source mode): finds the [[wikilink]] / [text](note.md)
// under the resting pointer — while Ctrl/Cmd is held, or always (host.hoverMode) — and reports it to
// the host. The knowledge module draws the popup (the same one as in the reading view).
import { EditorView } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import { parseWikiLink } from '@shared/wikilinks';
import { docPath, getEditorHost, type HoveredLink } from './host';
import { modKey } from './links';

export interface LinkHit {
  from: number;
  to: number;
  link: Omit<HoveredLink, 'rect'>;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The previewable link at `pos`: a wikilink / embed, or a Markdown link to a local file. */
export function linkAt(view: EditorView, pos: number): LinkHit | null {
  const tree = syntaxTree(view.state);
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'WikiLink' || n.name === 'WikiEmbed') {
        const t = n.getChild('WikiTarget');
        if (!t) return null;
        const w = parseWikiLink(view.state.sliceDoc(t.from, t.to));
        return { from: n.from, to: n.to, link: { kind: 'wiki', target: w.target, fragment: w.block ? `^${w.block}` : w.heading } };
      }
      if (n.name === 'Image') return null;
      if (n.name === 'Link') {
        const url = n.getChild('URL');
        if (!url) return null;
        let href = view.state.sliceDoc(url.from, url.to).trim();
        if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
        if (!href || href.startsWith('#') || /^([a-z][a-z0-9+.-]*:|\/\/|www\.)/i.test(href)) return null;
        const hash = href.indexOf('#');
        const fragment = hash < 0 ? undefined : safeDecode(href.slice(hash + 1)) || undefined;
        return { from: n.from, to: n.to, link: { kind: 'file', target: safeDecode(hash < 0 ? href : href.slice(0, hash)), fragment } };
      }
    }
  }
  return null;
}

/** The link under (x, y) — posAtCoords snaps to the nearest character, so check the link's box. */
function hitAt(view: EditorView, x: number, y: number): (LinkHit & { rect: HoveredLink['rect'] }) | null {
  const pos = view.posAtCoords({ x, y });
  if (pos == null) return null;
  const hit = linkAt(view, pos);
  if (!hit) return null;
  const a = view.coordsAtPos(hit.from, 1);
  const b = view.coordsAtPos(hit.to, -1);
  if (!a || !b || y < a.top - 1 || y > b.bottom + 1) return null;
  const oneLine = Math.abs(a.top - b.top) < 2;
  if (oneLine && (x < a.left - 1 || x > b.right + 1)) return null;
  return { ...hit, rect: { left: oneLine ? a.left : Math.min(a.left, b.left), top: a.top, right: Math.max(a.right, b.right), bottom: b.bottom } };
}

let pointer: { view: EditorView; x: number; y: number; mod: boolean; onText: boolean } | null = null;
let shown: { view: EditorView; from: number } | null = null;
let raf = 0;

function clear() {
  if (!shown) return;
  shown = null;
  getEditorHost()?.hoverLink?.(null, '');
}

function probe() {
  raf = 0;
  const p = pointer;
  const host = getEditorHost();
  if (!p || !host?.hoverLink) return;
  const mode = host.hoverMode?.() ?? 'mod';
  if (mode === 'off') return clear();
  const needMod = mode === 'mod' && !p.mod;
  if (needMod && !shown) return; // the common case: just moving the mouse
  // Widgets (note embeds, images) are not link text.
  const hit = p.onText ? hitAt(p.view, p.x, p.y) : null;
  if (hit && shown?.view === p.view && shown.from === hit.from) return;
  if (!hit || needMod) return clear();
  shown = { view: p.view, from: hit.from };
  host.hoverLink({ ...hit.link, rect: hit.rect }, p.view.state.facet(docPath));
}

export const pagePreview = EditorView.domEventHandlers({
  mousemove(e, view) {
    const t = e.target as Element | null;
    pointer = { view, x: e.clientX, y: e.clientY, mod: modKey(e), onText: !!t?.closest?.('.cm-line') && !t.closest('.cm-widgetBuffer, .se-note-embed') };
    if (!raf) raf = requestAnimationFrame(probe);
    return false;
  },
  mouseleave(_e, view) {
    if (pointer?.view === view) pointer = null;
    if (shown?.view === view) clear();
    return false;
  },
  keydown(e, view) {
    // Ctrl/Cmd pressed while the pointer already rests on a link.
    if ((e.key === 'Control' || e.key === 'Meta') && pointer?.view === view) {
      pointer.mod = true;
      probe();
    }
    return false;
  },
});
