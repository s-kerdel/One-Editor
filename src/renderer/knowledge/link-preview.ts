// Link hover preview. Ctrl/Cmd+hover (Settings → Links & notes: or plain hover, or off) over a
// [[wikilink]] or a Markdown link to a local note shows the target's start — or the linked
// #section — rendered by the preview pipeline (./hover-render, lazy). One popup for every surface:
// the editor reports the link under the pointer through its host (editor/hover.ts); links in the
// preview / reading view and in note embeds are picked up here by delegation. Cached per note
// until it changes; nothing is loaded but the note itself (remote media are dropped).
import { dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { parseWikiLink, resolveWikiTarget } from '@shared/wikilinks';
import { app } from '../app/app';
import { index } from './state';

export type HoverMode = 'mod' | 'hover' | 'off';

export interface HoverRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface HoverLink {
  /** 'wiki' = [[target#fragment]]; 'file' = a Markdown link's (relative) destination. */
  kind: 'wiki' | 'file';
  target: string;
  /** Heading, or `^block`. */
  fragment?: string;
  /** Viewport rect of the link text (the popup is placed against it). */
  rect: HoverRect;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const modOf = (e: MouseEvent | KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

export function hoverMode(): HoverMode {
  const v = app.settings.value['links.hoverPreview'];
  return v === 'hover' || v === 'off' ? v : 'mod';
}

const DELAY_MS: Record<HoverMode, number> = { mod: 300, hover: 500, off: 0 };
/** Leaving the link toward the popup: it stays this long. */
const GRACE_MS = 200;
const CACHE_MAX = 64;
const POPUP_W = 400;
const POPUP_MAX_H = 320;

interface Rendered {
  html: string;
  missing: boolean;
  truncated: boolean;
}

let hoverRender: Promise<typeof import('./hover-render')> | null = null;
const cache = new Map<string, Rendered>();

let current: { key: string; link: HoverLink; from: string; source: 'editor' | 'dom' } | null = null;
let popup: { key: string; el: HTMLElement; path: string } | null = null;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let token = 0;

const keyOf = (l: Omit<HoverLink, 'rect'>, from: string) => `${from}\u0000${l.kind}\u0000${l.target}\u0000${l.fragment ?? ''}`;

/** Workspace path of a hovered link (null: missing / not a note). */
export function resolveHover(link: Pick<HoverLink, 'kind' | 'target'>, from: string): string | null {
  const files = app.files.value;
  let path: string | null;
  if (link.kind === 'wiki') {
    if (!link.target) path = from;
    // The index knows aliases; without it (on demand, not built) the file list still resolves names.
    else path = (index.size ? index.resolve(link.target, from) : null) ?? resolveWikiTarget(link.target, files, from);
  } else {
    const p = link.target.startsWith('/') ? normalize(link.target) : normalize(`${dirname(from)}/${link.target}`);
    const set = fileSet(files);
    path = set.has(p) ? p : set.has(`${p}.md`) ? `${p}.md` : null;
  }
  return path && isMarkdown(path) ? path : null;
}

let setFor: readonly string[] | null = null;
let setCache = new Set<string>();
function fileSet(files: readonly string[]) {
  if (files !== setFor) {
    setFor = files;
    setCache = new Set(files);
  }
  return setCache;
}

async function textOf(path: string): Promise<string | null> {
  const doc = app.docs.get(path);
  if (doc && !doc.binary) return app.editor?.getContent(path) ?? doc.content;
  try {
    return (await app.backend.readFile(path)).content;
  } catch {
    return null;
  }
}

async function rendered(path: string, fragment: string | undefined): Promise<Rendered | null> {
  const key = `${path}\u0000${fragment ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const [text, mod] = await Promise.all([textOf(path), (hoverRender ??= import('./hover-render'))]);
  if (text === null) return null;
  const r = mod.renderPreview(path, text, fragment);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, r);
  return r;
}

function forget(path: string) {
  for (const k of cache.keys()) if (k.startsWith(`${path}\u0000`)) cache.delete(k);
}

// ---------------------------------------------------------------- popup

function hide() {
  clearTimeout(hideTimer);
  hideTimer = undefined;
  if (!popup) return;
  popup.el.remove();
  popup = null;
  window.removeEventListener('keydown', onKey, true);
  document.removeEventListener('scroll', onScroll, true);
  document.removeEventListener('wheel', onScroll, true);
  document.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('blur', hide);
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  current = null;
  hide();
}
const onScroll = (e: Event) => {
  if (popup && e.target instanceof Node && popup.el.contains(e.target)) return;
  current = null;
  hide();
};
const onDown = (e: MouseEvent) => {
  if (popup && e.target instanceof Node && popup.el.contains(e.target)) return;
  current = null;
  hide();
};

/** Remote media would load from the network and arrive late (the popup would grow): drop them. */
function stripRemote(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>('img, video, audio, source, picture')) {
    const src = el.getAttribute('src') ?? '';
    if (!/^(https?:)?\/\//i.test(src) && el.tagName !== 'PICTURE') continue;
    const alt = el.getAttribute('alt');
    if (alt && el.tagName === 'IMG') el.replaceWith(Object.assign(document.createElement('span'), { className: 'se-linkpv-media', textContent: alt }));
    else el.remove();
  }
}

function place(el: HTMLElement, r: HoverRect) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(8, Math.min(r.left, vw - w - 8));
  const below = r.bottom + 6;
  const above = r.top - 6 - h;
  const top = below + h <= vh - 8 || above < 8 ? Math.min(below, Math.max(8, vh - 8 - h)) : above;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

async function show(my: number, link: HoverLink, from: string, key: string) {
  const path = resolveHover(link, from);
  if (!path) return;
  const r = await rendered(path, link.fragment).catch((err) => (console.warn('[knowledge] link preview failed', err), null));
  if (my !== token || current?.key !== key || !r) return;
  hide();
  const el = document.createElement('div');
  el.className = 'se-linkpv se-hover-preview se-no-drag'; // may float over the integrated frame's drag strip
  el.setAttribute('role', 'tooltip');
  el.dataset.path = path;
  const head = el.appendChild(document.createElement('div'));
  head.className = 'se-linkpv-head';
  const title = head.appendChild(document.createElement('a'));
  title.className = 'se-linkpv-title';
  title.textContent = stem(path);
  title.title = `Open ${path}`;
  title.href = '#';
  if (link.fragment && !r.missing) {
    const frag = head.appendChild(document.createElement('span'));
    frag.className = 'se-linkpv-frag';
    frag.textContent = link.fragment.startsWith('^') ? link.fragment : `# ${link.fragment}`;
  }
  const where = head.appendChild(document.createElement('span'));
  where.className = 'se-linkpv-path';
  where.textContent = dirname(path);
  if (r.missing) {
    const note = el.appendChild(document.createElement('div'));
    note.className = 'se-linkpv-note';
    note.textContent = `“${link.fragment}” isn’t in this note — showing its start.`;
  }
  const body = el.appendChild(document.createElement('div'));
  body.className = `se-linkpv-body se-preview${r.truncated ? ' is-cut' : ''}`;
  if (r.html) {
    body.innerHTML = r.html; // sanitised by the preview pipeline
    stripRemote(body);
  } else body.append(Object.assign(document.createElement('div'), { className: 'se-linkpv-empty', textContent: 'Empty note' }));
  el.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  el.addEventListener('mouseleave', () => {
    current = null;
    hide();
  });
  el.addEventListener('click', (e) => {
    const a = (e.target as Element).closest('a');
    if (!a) return;
    e.preventDefault();
    current = null;
    hide();
    if (a === title) return void (app.openLink ? app.openLink(`${path}${link.fragment ? `#${link.fragment}` : ''}`, from) : app.openFile(path));
    const wiki = a.getAttribute('data-wikilink');
    if (wiki !== null) void app.openLink?.(wiki, path);
  });
  // Measured before it shows: it appears at its final place and size (no jump).
  el.style.visibility = 'hidden';
  el.style.width = `${Math.min(POPUP_W, window.innerWidth - 16)}px`;
  el.style.maxHeight = `${Math.min(POPUP_MAX_H, window.innerHeight - 16)}px`;
  document.body.appendChild(el);
  place(el, link.rect);
  el.style.visibility = '';
  popup = { key, el, path };
  window.addEventListener('keydown', onKey, true);
  document.addEventListener('scroll', onScroll, true);
  // A wheel over content that cannot scroll fires no scroll event: the gesture still dismisses.
  document.addEventListener('wheel', onScroll, { capture: true, passive: true });
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', hide);
}

/**
 * The pointer rests on `link` (null: it left it). Editor and preview call this; the popup follows
 * after a short delay, stays while the pointer is on the link or the popup, and goes on leave,
 * Escape, scroll or click.
 */
export function hoverLink(link: HoverLink | null, from: string, source: 'editor' | 'dom' = 'editor') {
  if (!link) {
    if (!current || current.source !== source) return;
    current = null;
    clearTimeout(showTimer);
    token++;
    if (popup) {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, GRACE_MS);
    }
    return;
  }
  const key = keyOf(link, from);
  if (current?.key === key) return;
  current = { key, link, from, source };
  clearTimeout(showTimer);
  if (popup?.key === key) return void clearTimeout(hideTimer);
  hide();
  const my = ++token;
  showTimer = setTimeout(() => void show(my, link, from, key), DELAY_MS[hoverMode()]);
}

// ---------------------------------------------------------------- preview pane (delegated)

/** A link in rendered Markdown (reading view, split preview, note embeds) as a hover target. */
function linkOfAnchor(a: HTMLAnchorElement): { link: Omit<HoverLink, 'rect'>; from: string } | null {
  const from = a.closest<HTMLElement>('.se-embed[data-path]')?.dataset.path ?? a.closest<HTMLElement>('.se-note-embed[data-path]')?.dataset.path ?? app.activePath.value;
  if (!from) return null;
  const raw = a.getAttribute('data-wikilink');
  if (raw !== null) {
    const w = parseWikiLink(raw);
    return { link: { kind: 'wiki', target: w.target, fragment: w.block ? `^${w.block}` : w.heading }, from };
  }
  const href = a.getAttribute('href') ?? '';
  if (!href || href.startsWith('#') || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) return null;
  const hash = href.indexOf('#');
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return { link: { kind: 'file', target: dec(hash < 0 ? href : href.slice(0, hash)), fragment: hash < 0 ? undefined : dec(href.slice(hash + 1)) || undefined }, from };
}

let lastAnchor: HTMLAnchorElement | null = null;

function probeAnchor(a: HTMLAnchorElement | null, mod: boolean) {
  const mode = hoverMode();
  if (mode === 'off' || !a) {
    lastAnchor = null;
    return hoverLink(null, '', 'dom');
  }
  if (mode === 'mod' && !mod && current?.source !== 'dom') return;
  const hit = linkOfAnchor(a);
  if (!hit) return hoverLink(null, '', 'dom');
  if (mode === 'mod' && !mod && current?.key !== keyOf(hit.link, hit.from)) return hoverLink(null, '', 'dom');
  const r = a.getBoundingClientRect();
  hoverLink({ ...hit.link, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }, hit.from, 'dom');
}

let installed = false;

export function installLinkPreview() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    'mousemove',
    (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (popup && popup.el.contains(t)) return void clearTimeout(hideTimer);
      // Cheap path: no modifier and nothing showing → nothing to do.
      if (!lastAnchor && !current && hoverMode() === 'mod' && !modOf(e)) return;
      const a = t.closest<HTMLAnchorElement>('.se-preview a');
      lastAnchor = a && !a.closest('.se-linkpv') ? a : null;
      probeAnchor(lastAnchor, modOf(e));
    },
    { passive: true },
  );
  // Pressing the modifier while resting on a link opens it too.
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Control' || e.key === 'Meta') && lastAnchor?.isConnected) probeAnchor(lastAnchor, true);
  });
  const drop = (path: string) => forget(path);
  app.events.on('doc:changed', drop);
  app.events.on('doc:saved', drop);
  app.events.on('file:updated', drop);
  app.events.on('files:changed', (paths) => paths.forEach(drop));
  app.events.on('variables:changed', () => cache.clear());
  app.events.on('tree:changed', () => cache.clear()); // resolved / unresolved links in the excerpt
  app.activePath.subscribe(() => {
    current = null;
    hide();
  });
}

/** Test/debug: what is showing. */
export const linkPreviewState = () => (popup ? { path: popup.path } : null);
