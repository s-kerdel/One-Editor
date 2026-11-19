// DOMPurify configuration. Two instances: `user` for markdown (incl. raw HTML typed by the user or
// coming from cloned repos) and `lib` for output of Shiki / KaTeX / Mermaid.
import DOMPurify from 'dompurify';
import { dirname, normalize } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';

export interface SanitizeContext {
  path?: string;
  files?: readonly string[];
  resolveUrl?: (wsPath: string) => string;
}

type Purify = typeof DOMPurify;
let user: Purify | null = null;
let lib: Purify | null = null;
let current: SanitizeContext = {};

const USER_CONFIG = {
  // <style> could restyle the whole app (UI redress); form controls other than checkboxes have no use in notes.
  FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'option', 'dialog', 'template', 'slot', 'link', 'meta', 'base', 'iframe', 'object', 'embed'],
  FORBID_ATTR: ['formaction', 'contenteditable', 'autofocus', 'srcset', 'ping'],
  ADD_ATTR: ['data-line'],
};
const BAD_STYLE = /url\s*\(|image(-set)?\s*\(|element\s*\(|position\s*:|expression|behavior|-moz-binding|@import|z-index/i;
// CSS escapes ("p\osition", "\75rl(") and comments ("position/**/:") would slip past the keyword test,
// and no legitimate inline style in a note needs either — so any of them drops the attribute.
const OBFUSCATED_STYLE = /\\|\/\*/;

/** Workspace path for a relative URL found in a note (image/link), or null if it is not a local path. */
export function resolveLocalPath(url: string, notePath: string | undefined, files?: readonly string[]): string | null {
  if (!url || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url)) return null;
  let clean = url.split(/[?#]/)[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {}
  if (!clean) return null;
  if (clean.startsWith('/')) return normalize(clean);
  const rel = normalize(`${notePath ? dirname(notePath) : ''}/${clean}`);
  if (!files || files.includes(rel)) return rel;
  const root = normalize(clean);
  if (files.includes(root)) return root;
  // Obsidian writes bare attachment names; fall back to wikilink-style lookup.
  return resolveWikiTarget(clean, files, notePath) ?? rel;
}
const localPath = (url: string) => resolveLocalPath(url, current.path, current.files);

function ensure(): { user: Purify; lib: Purify } {
  if (user && lib) return { user, lib };
  if (typeof window === 'undefined' || !DOMPurify.isSupported) throw new Error('Markdown preview needs a DOM (DOMPurify unsupported here)');
  user = DOMPurify(window);
  lib = DOMPurify(window);
  // Fail closed: some DOM emulations (happy-dom) make DOMPurify silently return its input.
  if (/onerror|<script/i.test(user.sanitize('<p><img src="x" onerror="1"><script>1</script></p>') as string)) {
    user = lib = null;
    throw new Error('DOMPurify does not sanitize in this environment; refusing to render HTML');
  }
  user.addHook('uponSanitizeAttribute', (_node, data) => {
    // Inline styles are handy (colours, widths) but must not load resources or overlay the app UI.
    if (data.attrName === 'style' && (BAD_STYLE.test(data.attrValue) || OBFUSCATED_STYLE.test(data.attrValue))) data.keepAttr = false;
  });
  user.addHook('afterSanitizeAttributes', (node) => {
    const name = node.nodeName;
    if (name === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      return;
    }
    if (name !== 'IMG' && name !== 'AUDIO' && name !== 'VIDEO' && name !== 'SOURCE') return;
    // Local media: resolve against the note and hand out a backend URL. Done after DOMPurify's URI
    // check on purpose — Electron needs file:// URLs, which we never accept from the document itself.
    const ws = node.getAttribute('data-ws-src') ?? localPath(node.getAttribute('src') ?? '');
    if (ws === null) return;
    const path = normalize(ws);
    node.setAttribute('data-ws-src', path);
    if (current.resolveUrl) node.setAttribute('src', current.resolveUrl(path));
    if (name === 'IMG' && !node.hasAttribute('loading')) node.setAttribute('loading', 'lazy');
  });
  return { user, lib };
}

export function sanitizeHtml(html: string, ctx: SanitizeContext = {}): string {
  const p = ensure().user;
  current = ctx;
  try {
    return p.sanitize(html, USER_CONFIG) as string;
  } finally {
    current = {};
  }
}

export function sanitizeToFragment(html: string, ctx: SanitizeContext = {}): DocumentFragment {
  const p = ensure().user;
  current = ctx;
  try {
    return p.sanitize(html, { ...USER_CONFIG, RETURN_DOM_FRAGMENT: true }) as unknown as DocumentFragment;
  } finally {
    current = {};
  }
}

/** Shiki / KaTeX output: spans with inline colour variables and layout styles. */
export function sanitizeLib(html: string): string {
  // semantics/annotation: KaTeX's MathML output (DOMPurify drops them by default and would leak the TeX source as text).
  return ensure().lib.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'], ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] }) as string;
}

/** Mermaid output: SVG with an embedded <style> and (for HTML labels) foreignObject. */
export function sanitizeSvg(svg: string): string {
  return ensure().lib.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', 'style'],
    ADD_ATTR: ['dominant-baseline', 'transform-origin', 'marker-end', 'marker-start'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
  }) as string;
}
