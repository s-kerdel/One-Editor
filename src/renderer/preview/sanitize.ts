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
/** Mermaid output of a note that may load remote media keeps remote images (sanitizeSvg). */
let libRemote = false;

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
// Inline styles in raw HTML: an allowlist of properties. A wrapper's inherited styles reach the code blocks
// rendered inside it, and whatever moves, hides or covers (position, transform, negative margins, opacity,
// filter, -webkit-text-fill-color, custom properties the app's CSS reads) could draw a block that is not what
// Copy / Run hand out. Colours, type, sizes, spacing, borders and simple layout stay.
const STYLE_PROPS = new Set([
  'color', 'background', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-align', 'text-decoration', 'text-decoration-color', 'text-decoration-line', 'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset', 'vertical-align',
  'width', 'min-width', 'max-width', 'min-height', 'aspect-ratio', 'object-fit',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse', 'border-spacing',
  'display', 'float', 'clear', 'gap', 'row-gap', 'column-gap', 'flex', 'flex-basis', 'flex-direction', 'flex-grow', 'flex-shrink', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'list-style-type', 'overflow-wrap', 'word-break',
]);
/** Only on media (an image's own box): on a wrapper they would let the next block overlap the code inside. */
const MEDIA_STYLE_PROPS = new Set(['height', 'max-height']);
const STYLED_MEDIA = new Set(['IMG', 'VIDEO', 'AUDIO', 'PICTURE']);
const STYLE_VALUE: Record<string, RegExp> = {
  display: /^(none|inline|block|inline-block|flex|inline-flex|list-item)$/i,
  // A length would lift an inline box (an image) over the lines above it.
  'vertical-align': /^(baseline|sub|super|text-top|text-bottom|middle|top|bottom)$/i,
};

/** The allowed declarations of a raw-HTML style attribute ('' = none). Margins: no minus, no functions
 *  (calc(0px - 9em) is negative too). Splitting on ';' is safe: a dropped part is gone, and a declaration
 *  can only start right after a ';', i.e. at the start of a part that was kept. */
export function allowedStyle(style: string, tag: string): string {
  if (BAD_STYLE.test(style) || OBFUSCATED_STYLE.test(style)) return '';
  const keep: string[] = [];
  for (const part of style.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    const bare = value.replace(/\s*!\s*important$/i, '');
    if (!value || !(STYLE_PROPS.has(prop) || (MEDIA_STYLE_PROPS.has(prop) && STYLED_MEDIA.has(tag)))) continue;
    if (STYLE_VALUE[prop] && !STYLE_VALUE[prop].test(bare)) continue;
    if (prop.startsWith('margin') && /[-(]/.test(bare)) continue;
    keep.push(part.trim());
  }
  return keep.join('; ');
}
/** SVG presentation attributes that may reference another document (`fill="url(https://…)"`). */
const URL_ATTRS = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
const FOREIGN_URL = /url\s*\(\s*['"]?\s*(?!#)/i;
/** CSS that fetches: url() of anything but a #fragment, image-set() / image() / cross-fade() / element(), @import. */
const FETCHING_CSS = /url\s*\(\s*['"]?\s*(?!#)|(?:image-set|image|cross-fade|element)\s*\(|@import/i;

/** CSS text with its escapes decoded, as the CSS parser reads it ("\\75rl(" and "u\\rl(" are url(). */
function cssUnescape(css: string): string {
  if (!css.includes('\\')) return css;
  return css.replace(/\\(?:([0-9a-f]{1,6})[ \t\n\r\f]?|([\s\S]))/gi, (_m, hex?: string, ch?: string) => {
    if (!hex) return ch === '\n' ? '' : (ch ?? '');
    const n = parseInt(hex, 16);
    return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : '\ufffd';
  });
}

/** CSS of library output (mermaid's <style>, style attributes): every fetching form made inert. */
function inertCss(css: string): string {
  const out = cssUnescape(css)
    .replace(/url\s*\(\s*(['"]?)\s*(?!#)/gi, 'url($1#') // a #fragment: nothing is fetched
    .replace(/(image-set|image|cross-fade|element)\s*\(/gi, '$1-blocked(')
    .replace(/@import/gi, '@blocked-import');
  return FETCHING_CSS.test(out) ? '' : out;
}

// Mermaid draws in the live page (it measures text there) before any sanitizer sees its output, so what a
// diagram would load is loaded while it is drawn: <img> / <video>… labels, `img:` shapes, url() / image-set()
// / @import in style, classDef, linkStyle, labels' style attributes, themeCSS. HTML entities (labels) and CSS
// escapes (styles) are decoded first, as the page will.
const MERMAID_FETCH = /<\s*\/?\s*(img|image|picture|source|video|audio|track|input|iframe|frame|object|embed|link|use|feimage|style|svg|meta|base)\b|\b(img|themeCSS)['"]?\s*:|\b(background|poster|srcset)\s*=/i;
function htmlUnescape(s: string): string {
  if (!s.includes('&') || typeof DOMParser === 'undefined') return s;
  // An inert document (nothing loads); a <textarea> holds text only, with its entities decoded.
  return new DOMParser().parseFromString(`<textarea>${s.replace(/<\/?textarea/gi, '')}</textarea>`, 'text/html').querySelector('textarea')?.value ?? s;
}
/** Would drawing this mermaid source load anything (remote or not)? Then it is drawn only when the note may load remote media. */
export function mermaidFetches(src: string): boolean {
  return [src, htmlUnescape(src)].some((t) => MERMAID_FETCH.test(t) || FETCHING_CSS.test(t) || FETCHING_CSS.test(cssUnescape(t)));
}
/** Elements whose href / xlink:href is fetched (not a link). */
const FETCHED_HREF = new Set(['image', 'feImage', 'use', 'IMAGE', 'FEIMAGE', 'USE']);

/** A URL as the browser reads it: leading / trailing controls and spaces go, tabs and line breaks inside go,
 *  a backslash is a slash ("\x01https://", "ht\ttps://", "\\\\host\\share" and "/\\host" all leave the folder). */
const asBrowserReads = (url: string) => url.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
/** Not a path inside the folder: a scheme, protocol-relative / UNC (`//host`), a fragment. */
const NOT_LOCAL = /^([a-z][a-z0-9+.-]*:|\/\/|#)/i;

/** An absolute or protocol-relative URL that is not inline data: loads from the network. */
export function isRemoteUrl(url: string): boolean {
  const u = asBrowserReads(url);
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(u) && !/^(data|blob):/i.test(u);
}

/** Raw HTML from a note: no data-* (app state), no class but USER_CLASSES. */
function scrubUserElement(el: Element): void {
  for (const a of Array.from(el.attributes)) if (a.name.startsWith('data-')) el.removeAttribute(a.name);
  if (!el.hasAttribute('class')) return;
  const keep = Array.from(el.classList).filter((c) => USER_CLASSES.has(c));
  if (keep.length) el.setAttribute('class', keep.join(' '));
  else el.removeAttribute('class');
}

/** <svg><image href="https://…"> and friends: never fetched from a note (`remoteImages`: an <image> of a
 *  diagram whose note may load remote media keeps a remote href). */
function dropForeignRefs(el: Element, remoteImages = false): void {
  if (!FETCHED_HREF.has(el.nodeName)) return;
  for (const name of ['href', 'xlink:href']) {
    const v = el.getAttribute(name);
    if (v === null || /^\s*(#|data:)/i.test(v)) continue;
    if (!(remoteImages && el.nodeName.toLowerCase() === 'image' && /^https?:\/\//i.test(asBrowserReads(v)))) el.removeAttribute(name);
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
  // Leading controls / spaces and tabs or line breaks inside: not a path the note can mean (the browser drops them).
  if (!url || /^[\u0000-\u0020]|[\t\n\r]/.test(url) || NOT_LOCAL.test(url) || NOT_LOCAL.test(asBrowserReads(url))) return null;
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

/** Relative URL from the directory of `from` to workspace path `to` (both POSIX, workspace-relative). */
export function relativeUrl(from: string | undefined, to: string): string {
  const a = from ? dirname(from).split('/').filter(Boolean) : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return encodeURI([...a.slice(i).map(() => '..'), ...b.slice(i)].join('/'));
}

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
    // Inline styles are handy (colours, widths) but must not load resources, overlay the app UI or redraw code.
    if (data.attrName === 'style') {
      data.attrValue = allowedStyle(data.attrValue, node.nodeName);
      if (!data.attrValue) data.keepAttr = false;
    }
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
    // Never the note's own spelling: without a backend URL (export) the path is written out relative to the note.
    node.setAttribute('src', current.resolveUrl ? current.resolveUrl(path) : relativeUrl(current.path, path).replace(/[?#]/g, encodeURIComponent));
    if (name === 'IMG' && !node.hasAttribute('loading')) node.setAttribute('loading', 'lazy');
  });
  // Library output: diagram labels are note text too — no app classes, no remote media, no top layer.
  lib.addHook('uponSanitizeAttribute', (node, data) => {
    foreignUrlAttr(node, data);
    if (data.attrName === 'style' && FETCHING_CSS.test(cssUnescape(data.attrValue))) data.keepAttr = false;
  });
  // A diagram's own stylesheet (classDef, themeCSS): url() / @import fetch whatever the note names.
  lib.addHook('uponSanitizeElement', (node) => {
    if (node.nodeName.toLowerCase() === 'style' && node.textContent) node.textContent = inertCss(node.textContent);
  });
  lib.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute('class')) {
      const keep = Array.from(node.classList).filter((c) => !APP_CLASS.test(c));
      if (keep.length !== node.classList.length) node.setAttribute('class', keep.join(' '));
    }
    dropForeignRefs(node, libRemote);
    const src = node.getAttribute('src');
    if (src !== null && isRemoteUrl(src) && !(libRemote && node.nodeName === 'IMG')) node.removeAttribute('src');
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

/** Mermaid output: SVG with an embedded <style> and (for HTML labels) foreignObject. `remote`: the note may
 *  load remote media, so its remote images (<img> labels, img: shapes) stay; CSS never fetches either way. */
export function sanitizeSvg(svg: string, o: { remote?: boolean } = {}): string {
  const p = ensure().lib;
  libRemote = !!o.remote;
  try {
    return p.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true, html: true },
      ADD_TAGS: ['foreignObject', 'style'],
      ADD_ATTR: ['dominant-baseline', 'transform-origin', 'marker-end', 'marker-start'],
      HTML_INTEGRATION_POINTS: { foreignobject: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'map', 'area'],
      FORBID_ATTR: NOT_IN_NOTES,
    }) as string;
  } finally {
    libRemote = false;
  }
}
