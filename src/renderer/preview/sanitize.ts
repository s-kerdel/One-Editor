// DOMPurify configuration. Two instances: `user` for markdown (incl. raw HTML typed by the user or
// coming from cloned repos) and `lib` for output of Shiki / KaTeX / Mermaid.
//
// Contract (docs/llm/09-reference-browser-preview.md): the app's classes and data-* attributes drive behaviour — Copy / Run, embeds,
// task toggles, media paths — and some app classes are position: fixed overlays. They come from the
// markdown renderer only, never from raw HTML in a note: markdown.ts marks every element raw HTML creates
// (USER_MARK), and such an element keeps no data-* attribute and no class outside USER_CLASSES.
// Remote media (images from the internet) load only when the note's policy allows (./remote.ts).
import DOMPurify from 'dompurify';
import { dirname, normalize } from '@shared/paths';
import { resolveWikiTarget } from '@shared/wikilinks';

export interface SanitizeContext {
  path?: string;
  files?: readonly string[];
  resolveUrl?: (wsPath: string) => string;
  /** Remote media may load; otherwise they become placeholders (img.se-remote-blocked, no src). */
  remote?: boolean;
}

/** Attribute markdown.ts puts on every element that raw HTML in a note creates (removed here). */
export const USER_MARK = 'data-se-u';
/** The only classes raw HTML may carry: no behaviour, no positioning (Pandoc's page break). */
const USER_CLASSES = new Set(['page-break']);
/** App / editor class prefixes that library output (diagram labels are note text) never gets either. */
const APP_CLASS = /^(se-|cm-)/;

type Purify = typeof DOMPurify;
let user: Purify | null = null;
let lib: Purify | null = null;
let current: SanitizeContext = {};

// popover* opens an element in the top layer (over the whole app, whatever contains it); <area> is a link the
// click handlers would not see; background / poster load images from anywhere; ids and names are prefixed
// (user-content-…) so a note cannot shadow a global the app reads (DOM clobbering).
const NOT_IN_NOTES = ['formaction', 'contenteditable', 'autofocus', 'srcset', 'ping', 'popover', 'popovertarget', 'popovertargetaction', 'background', 'poster'];
const USER_CONFIG = {
  // <style> could restyle the whole app (UI redress); form controls other than checkboxes have no use in notes.
  FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'option', 'dialog', 'template', 'slot', 'link', 'meta', 'base', 'iframe', 'object', 'embed', 'map', 'area'],
  FORBID_ATTR: NOT_IN_NOTES,
  ADD_ATTR: ['data-line'],
  SANITIZE_NAMED_PROPS: true,
};
const BAD_STYLE = /url\s*\(|image(-set)?\s*\(|element\s*\(|position\s*:|expression|behavior|-moz-binding|@import|z-index/i;
// CSS escapes ("p\osition", "\75rl(") and comments ("position/**/:") would slip past the keyword test,
// and no legitimate inline style in a note needs either — so any of them drops the attribute.
const OBFUSCATED_STYLE = /\\|\/\*/;
/** SVG presentation attributes that may reference another document (`fill="url(https://…)"`). */
const URL_ATTRS = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
const FOREIGN_URL = /url\s*\(\s*['"]?\s*(?!#)/i;
/** Elements whose href / xlink:href is fetched (not a link). */
const FETCHED_HREF = new Set(['image', 'feImage', 'use', 'IMAGE', 'FEIMAGE', 'USE']);

/** An absolute or protocol-relative URL that is not inline data: loads from the network. */
export function isRemoteUrl(url: string): boolean {
  return /^\s*([a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(url) && !/^\s*(data|blob):/i.test(url);
}

/** Raw HTML from a note: no data-* (app state), no class but USER_CLASSES. */
function scrubUserElement(el: Element): void {
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) el.removeAttribute(a.name);
  if (!el.hasAttribute('class')) return;
  const keep = Array.from(el.classList).filter((c) => USER_CLASSES.has(c));
  if (keep.length) el.setAttribute('class', keep.join(' '));
  else el.removeAttribute('class');
}

/** <svg><image href="https://…"> and friends: never fetched from a note. */
function dropForeignRefs(el: Element): void {
  if (!FETCHED_HREF.has(el.nodeName)) return;
  for (const name of ['href', 'xlink:href']) {
    const v = el.getAttribute(name);
    if (v !== null && !/^\s*(#|data:)/i.test(v)) el.removeAttribute(name);
  }
}

/** Remote media the policy does not allow: a placeholder that keeps the element's size and alt text. */
function blockRemote(el: Element, src: string): void {
  el.removeAttribute('src');
  el.classList.add('se-remote-blocked');
  let host = '';
  try {
    host = new URL(src.trim(), 'https://invalid.invalid/').host;
  } catch {}
  el.setAttribute('title', `Image from ${host || 'the internet'} (not loaded)`);
}

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
  const foreignUrlAttr = (_node: Element, data: { attrName: string; attrValue: string; keepAttr: boolean }) => {
    if (URL_ATTRS.has(data.attrName) && FOREIGN_URL.test(data.attrValue)) data.keepAttr = false;
  };
  user.addHook('uponSanitizeAttribute', (node, data) => {
    // Inline styles are handy (colours, widths) but must not load resources or overlay the app UI.
    if (data.attrName === 'style' && (BAD_STYLE.test(data.attrValue) || OBFUSCATED_STYLE.test(data.attrValue))) data.keepAttr = false;
    foreignUrlAttr(node, data);
  });
  user.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute(USER_MARK)) scrubUserElement(node); // first: what follows trusts data-* again
    dropForeignRefs(node);
    const name = node.nodeName;
    if (name === 'INPUT') {
      if (node.getAttribute('type') !== 'checkbox') node.remove();
      return;
    }
    if (name !== 'IMG' && name !== 'AUDIO' && name !== 'VIDEO' && name !== 'SOURCE') return;
    // Local media: resolve against the note and hand out a backend URL (the note never names one itself).
    const src = node.getAttribute('src') ?? '';
    const ws = node.getAttribute('data-ws-src') ?? localPath(src);
    if (ws === null) {
      if (isRemoteUrl(src) && !current.remote) blockRemote(node, src);
      return;
    }
    const path = normalize(ws);
    node.setAttribute('data-ws-src', path);
    if (current.resolveUrl) node.setAttribute('src', current.resolveUrl(path));
    if (name === 'IMG' && !node.hasAttribute('loading')) node.setAttribute('loading', 'lazy');
  });
  // Library output: diagram labels are note text too — no app classes, no remote media, no top layer.
  lib.addHook('uponSanitizeAttribute', foreignUrlAttr);
  lib.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute('class')) {
      const keep = Array.from(node.classList).filter((c) => !APP_CLASS.test(c));
      if (keep.length !== node.classList.length) node.setAttribute('class', keep.join(' '));
    }
    dropForeignRefs(node);
    const src = node.getAttribute('src');
    if (src !== null && isRemoteUrl(src)) node.removeAttribute('src');
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
  return ensure().lib.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'map', 'area'], FORBID_ATTR: NOT_IN_NOTES, ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'] }) as string;
}

/** Mermaid output: SVG with an embedded <style> and (for HTML labels) foreignObject. */
export function sanitizeSvg(svg: string): string {
  return ensure().lib.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
    ADD_TAGS: ['foreignObject', 'style'],
    ADD_ATTR: ['dominant-baseline', 'transform-origin', 'marker-end', 'marker-start'],
    HTML_INTEGRATION_POINTS: { foreignobject: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'map', 'area'],
    FORBID_ATTR: NOT_IN_NOTES,
  }) as string;
}
