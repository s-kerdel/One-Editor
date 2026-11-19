// Following links from the editor: rendered links open on click, any link opens on Mod+click.
import { EditorView } from '@codemirror/view';
import { parseWikiLink } from '@shared/wikilinks';
import { docPath, getEditorHost, type LinkTarget } from './host';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

export function linkFromElement(el: HTMLElement): LinkTarget | null {
  const a = el.closest<HTMLElement>('[data-wiki],[data-href]');
  if (!a) return null;
  if (a.dataset.wiki !== undefined) {
    const w = parseWikiLink(a.dataset.wiki);
    return { kind: 'wiki', target: w.target, heading: w.heading };
  }
  let href = (a.dataset.href ?? '').trim();
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1);
  if (/^www\./i.test(href)) return { kind: 'url', target: `https://${href}` };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return { kind: 'url', target: href };
  if (href.startsWith('#')) return { kind: 'anchor', target: '', heading: safeDecode(href.slice(1)) };
  const hash = href.indexOf('#');
  const p = hash >= 0 ? href.slice(0, hash) : href;
  return { kind: 'file', target: safeDecode(p), heading: hash >= 0 ? safeDecode(href.slice(hash + 1)) : undefined };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Open the link represented by a rendered element. Returns false when it isn't a link. */
export function followLinkElement(view: EditorView, el: HTMLElement, e: MouseEvent): boolean {
  const link = linkFromElement(el);
  if (!link) return false;
  e.preventDefault();
  getEditorHost()?.openLink(link, view.state.facet(docPath), { newTab: e.button === 1 || (modKey(e) && e.shiftKey) });
  return true;
}

export const linkHandlers = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (e.button !== 0 && e.button !== 1) return false;
    const el = (e.target as HTMLElement).closest?.<HTMLElement>('.se-mdlink');
    if (!el || !view.contentDOM.contains(el)) return false;
    // Rendered (syntax hidden) links open on plain click; revealed ones need Mod so editing still works.
    if (!modKey(e) && el.dataset.live !== '1' && e.button !== 1) return false;
    return followLinkElement(view, el, e);
  },
  keydown(e, view) {
    if (e.key === (isMac ? 'Meta' : 'Control')) view.dom.classList.add('se-mod-down');
    return false;
  },
  keyup(e, view) {
    if (e.key === (isMac ? 'Meta' : 'Control')) view.dom.classList.remove('se-mod-down');
    return false;
  },
  blur(_e, view) {
    view.dom.classList.remove('se-mod-down');
    return false;
  },
});
