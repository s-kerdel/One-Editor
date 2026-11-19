// Markdown preview controller: incremental section rendering, lazy enhancements (Shiki/KaTeX/Mermaid),
// embeds, link + task interaction and editor ↔ preview scroll sync. The pure pipeline lives in ./markdown.
import './preview.css';
import { app, type PreviewController } from '../app/app';
import { runCommand } from '../app/commands';
import { noteEdited } from '../app/documents';
import { fileUrl } from '../platform';
import { isMarkdown } from '@shared/paths';
import { parseWikiLink, resolveWikiTarget } from '@shared/wikilinks';
import { renderCodeFile, renderFragment, renderMarkdown, resolveLocalPath, slugify, type RenderOptions } from './markdown';
import { sectionSource, splitSections, type Section } from './sections';
import { codeText, createEnhancer, enhanceAll } from './enhance';
import { expandEmbeds, invalidateEmbeds, type EmbedContext } from './embeds';
import { isRunnableFence } from '../terminal/run';

/** Desktop app: a "Run in terminal" button on shell code blocks (live preview only — exports render
 *  fresh markdown, so they never carry it). */
function addRunButtons(root: ParentNode): void {
  if (!app.runInTerminal) return;
  for (const tools of root.querySelectorAll<HTMLElement>('.se-code[data-fence] > .se-code-tools')) {
    const block = tools.parentElement!;
    if (tools.querySelector('.se-code-run') || !isRunnableFence(block.dataset.fence)) continue;
    const b = document.createElement('button');
    b.className = 'se-code-run';
    b.type = 'button';
    b.title = 'Run in terminal';
    b.setAttribute('aria-label', 'Run in terminal');
    tools.insertBefore(b, tools.querySelector('.se-code-copy'));
  }
}

export { renderMarkdown };
export type { RenderOptions };

export interface PreviewHandle extends PreviewController {
  /** Resolves once every section, embed and lazy upgrade (highlighting, math, diagrams) is rendered. */
  settle(): Promise<void>;
  /** The element holding the rendered document. */
  readonly content: HTMLElement;
}

interface Sec extends Section {
  first: boolean;
  epoch: number;
  defs: string;
  el: HTMLElement;
  /** Has real DOM (possibly stale while `dirty`). */
  rendered: boolean;
  dirty: boolean;
  diffable: boolean;
}
type Anchor = { line: number; top: number };

const SIG = Symbol('se-sig');
type Sigged = Element & { [SIG]?: string };
// Blocks whose output depends on other blocks (footnotes, reference links) are never reused individually.
const NO_DIFF_RE = /\[\^|^ {0,3}\[[^\]]+\]:/m;
const SYNC_BUDGET_MS = 45;
const PUMP_SLICE_MS = 20;
const HUGE_SECTIONS = 120;

export function renderOptionsFor(path: string): RenderOptions {
  return {
    path,
    files: app.files.value,
    resolveUrl: (p) => {
      const ws = app.workspace.value;
      return ws && app.backend ? fileUrl(app.backend, ws.root, p) : encodeURI(p);
    },
    breaks: app.settings.value['preview.lineBreaks'] === true,
  };
}

const embedSources = new Map<string, string>();
async function readNote(path: string): Promise<string | null> {
  const open = app.docs.get(path);
  if (open) return open.content;
  const hit = embedSources.get(path);
  if (hit !== undefined) return hit;
  try {
    const { content } = await app.backend.readFile(path);
    embedSources.set(path, content);
    return content;
  } catch {
    return null;
  }
}
export const embedContext: EmbedContext = {
  read: readNote,
  render: (src, path) => renderMarkdown(src, { ...renderOptionsFor(path), sourceLines: false, frontmatter: false }),
  renderFile: renderCodeFile,
};

/** Reuses unchanged top-level blocks of a section (keeps images, diagrams, highlighted code, open <details>). */
function patchChildren(host: HTMLElement, frag: DocumentFragment): void {
  const olds = Array.from(host.children) as Sigged[];
  const news = Array.from(frag.children) as Sigged[];
  const eq = (a: Sigged, b: Sigged) => a[SIG] !== undefined && a[SIG] === b[SIG];
  let p = 0;
  while (p < olds.length && p < news.length && eq(olds[p], news[p])) p++;
  let s = 0;
  while (s < olds.length - p && s < news.length - p && eq(olds[olds.length - 1 - s], news[news.length - 1 - s])) s++;
  const shift = (o: Element, n: Element) => {
    const delta = Number(n.getAttribute('data-line')) - Number(o.getAttribute('data-line'));
    if (!delta) return;
    for (const x of [o, ...o.querySelectorAll('[data-line]')]) {
      if (x.hasAttribute('data-line')) x.setAttribute('data-line', String(Number(x.getAttribute('data-line')) + delta));
    }
    o.setAttribute('data-end', String(Number(o.getAttribute('data-end')) + delta));
  };
  for (let i = 0; i < p; i++) shift(olds[i], news[i]);
  for (let i = 1; i <= s; i++) shift(olds[olds.length - i], news[news.length - i]);
  if (p === olds.length && p === news.length) return;
  const endOld = s ? olds[olds.length - s] : null;
  for (let n: ChildNode | null = p ? olds[p - 1].nextSibling : host.firstChild; n && n !== endOld; ) {
    const next: ChildNode | null = n.nextSibling;
    n.remove();
    n = next;
  }
  const endNew = s ? news[news.length - s] : null;
  for (let n: ChildNode | null = p ? news[p - 1].nextSibling : frag.firstChild; n && n !== endNew; ) {
    const next: ChildNode | null = n.nextSibling;
    host.insertBefore(n, endOld);
    n = next;
  }
}

export function createPreview(el: HTMLElement): PreviewController {
  el.classList.add('se-preview-scroller');
  const doc = document.createElement('div');
  doc.className = 'se-preview markdown-body';
  doc.tabIndex = -1; // focusable so keyboard scrolling targets the preview after a click
  el.replaceChildren(doc);

  const enhancer = createEnhancer(el);
  const scrollCbs = new Set<(l: number) => void>();
  const secOf = new WeakMap<Element, Sec>();
  let anchorCache = new WeakMap<Sec, Anchor[]>();
  let secs: Sec[] = [];
  let curPath: string | null = null;
  let epoch = 0;
  let lastMs = 0;
  let pumpTimer: ReturnType<typeof setTimeout> | undefined;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let renderRaf = 0;
  let stale = true; // content changed while the preview was hidden
  let disposed = false;
  let scrolledSincePump = false;

  // ------------------------------------------------------------ rendering

  function fill(sec: Sec, interactive = false): void {
    const src = sectionSource(sec, sec.defs);
    const frag = renderFragment(src, { ...renderOptionsFor(curPath ?? ''), frontmatter: sec.first });
    const lines = sec.text.split('\n');
    for (const child of Array.from(frag.children) as Sigged[]) {
      const l = child.getAttribute('data-line');
      const e = child.getAttribute('data-end');
      if (l !== null && e !== null) child[SIG] = `${child.tagName}\n${lines.slice(Number(l), Number(e)).join('\n')}`;
    }
    const diffable = !NO_DIFF_RE.test(src);
    if (sec.rendered && sec.diffable && diffable) patchChildren(sec.el, frag);
    else sec.el.replaceChildren(frag);
    sec.rendered = true;
    sec.dirty = false;
    sec.diffable = diffable;
    sec.el.style.minHeight = '';
    // Size estimate used while the section is off-screen and was never laid out (huge-document mode).
    sec.el.style.containIntrinsicBlockSize = `auto ${Math.max(1, sec.lines) * 24}px`;
    anchorCache.delete(sec);
    enhancer.scan(sec.el, interactive);
    addRunButtons(sec.el);
    if (sec.el.querySelector('.se-embed[data-embed]:not([data-done])')) void runEmbeds(sec.el);
  }

  async function runEmbeds(root: ParentNode): Promise<void> {
    const path = curPath;
    if (!path) return;
    await expandEmbeds(root, embedContext, [path]);
    if (curPath === path && !disposed) enhancer.scan(root);
  }

  /** Document-wide unique heading ids (sections are rendered independently). */
  function fixHeadingIds(): void {
    const seen = new Map<string, number>();
    for (const h of doc.querySelectorAll<HTMLElement>('.se-sec > [data-slug]')) {
      const base = h.dataset.slug!;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      const id = n ? `${base}-${n}` : base;
      if (h.id === id) continue;
      h.id = id;
      h.querySelector(':scope > a.se-anchor')?.setAttribute('href', `#${encodeURIComponent(id)}`);
    }
  }

  function pump(): void {
    pumpTimer = undefined;
    if (disposed) return;
    const t0 = performance.now();
    // Whatever the user is looking at first, then document order. Only looked up after a scroll:
    // measuring forces a layout of the half-built document, which would dominate the whole mount.
    if (scrolledSincePump) {
      scrolledSincePump = false;
      const at = secIndexAtY(el.scrollTop);
      for (let i = at; i < secs.length && i < at + 8 && performance.now() - t0 < PUMP_SLICE_MS; i++) if (secs[i].dirty) fill(secs[i]);
    }
    let more = false;
    for (const sec of secs) {
      if (!sec.dirty) continue;
      if (performance.now() - t0 > PUMP_SLICE_MS) {
        more = true;
        break;
      }
      fill(sec);
    }
    if (more) pumpTimer = setTimeout(pump, 0);
    else fixHeadingIds();
  }

  function fillAll(): void {
    clearTimeout(pumpTimer);
    pumpTimer = undefined;
    for (const sec of secs) if (sec.dirty) fill(sec);
    fixHeadingIds();
  }

  function clear(): void {
    clearTimeout(pumpTimer);
    secs = [];
    curPath = null;
    doc.replaceChildren();
  }

  function render(path: string, markdown: string): void {
    const t0 = performance.now();
    const switched = path !== curPath;
    if (switched) {
      clear();
      curPath = path;
      el.scrollTop = 0;
    }
    stale = false;
    const { sections, defs } = splitSections(markdown);
    const old = secs;
    const n = sections.length;
    const same = (o: Sec, s: Section, i: number) => o.text === s.text && o.first === (i === 0) && o.epoch === epoch && o.defs === defs && o.open === s.open;
    let a = 0;
    while (a < old.length && a < n && same(old[a], sections[a], a)) a++;
    let b = 0;
    while (b < old.length - a && b < n - a && same(old[old.length - 1 - b], sections[n - 1 - b], n - 1 - b)) b++;

    const next = old.slice(0, a);
    const oldMid = old.slice(a, old.length - b);
    const before = b ? old[old.length - b].el : null;
    const dirty: Sec[] = [];
    for (let i = a; i < n - b; i++) {
      const s = sections[i];
      let sec = oldMid.shift();
      if (sec) Object.assign(sec, s, { first: i === 0, epoch, defs, dirty: true });
      else {
        const host = document.createElement('div');
        host.className = 'se-sec';
        doc.insertBefore(host, before);
        sec = { ...s, first: i === 0, epoch, defs, el: host, rendered: false, dirty: true, diffable: false };
        secOf.set(host, sec);
      }
      dirty.push(sec);
      next.push(sec);
    }
    for (const gone of oldMid) gone.el.remove();
    for (let i = n - b; i < n; i++) {
      const sec = old[old.length - (n - i)];
      sec.start = sections[i].start;
      next.push(sec);
    }
    secs = next;
    // Huge documents: let the browser skip layout/paint of off-screen sections (see preview.css).
    doc.classList.toggle('is-huge', n > HUGE_SECTIONS);

    // The first changed section always renders now (that is where the user is typing); the rest
    // within a time budget, then progressively so huge documents never block the UI.
    let k = 0;
    for (; k < dirty.length; k++) {
      if (k > 0 && performance.now() - t0 > SYNC_BUDGET_MS) break;
      fill(dirty[k], true);
    }
    for (let j = k; j < dirty.length; j++) if (!dirty[j].rendered) dirty[j].el.style.minHeight = `${Math.max(1, dirty[j].lines) * 1.6}em`;
    if (k < dirty.length) pumpTimer ??= setTimeout(pump, 0);
    else if (dirty.length) fixHeadingIds();
    lastMs = performance.now() - t0;
    doc.dataset.renderMs = lastMs.toFixed(1);
    if (switched && isSplit()) requestAnimationFrame(syncFromEditor);
  }

  // ------------------------------------------------------------ line ↔ pixel mapping

  const topOf = (node: Element) => node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;

  /** Anchors of a section, tops relative to the section element (cached until layout changes). */
  function anchorsOf(sec: Sec): Anchor[] {
    let list = anchorCache.get(sec);
    if (list) return list;
    list = [{ line: sec.start, top: 0 }];
    if (sec.rendered) {
      const base = sec.el.getBoundingClientRect().top;
      for (const node of sec.el.querySelectorAll<HTMLElement>('[data-line]')) {
        if (node.tagName === 'INPUT') continue;
        const r = node.getBoundingClientRect();
        if (!r.height) continue; // inside a folded callout
        const line = sec.start + Number(node.dataset.line);
        const top = r.top - base;
        const last = list[list.length - 1];
        if (line > last.line && top >= last.top) list.push({ line, top });
      }
    }
    list.push({ line: sec.start + sec.lines, top: sec.el.offsetHeight });
    anchorCache.set(sec, list);
    return list;
  }

  function secIndexForLine(line: number): number {
    let lo = 0;
    let hi = secs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (secs[mid].start <= line) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function secIndexAtY(y: number): number {
    let lo = 0;
    let hi = secs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topOf(secs[mid].el) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  function lineToY(line: number): number {
    if (!secs.length) return 0;
    const sec = secs[secIndexForLine(line)];
    if (sec.dirty) fill(sec);
    const list = anchorsOf(sec);
    let k = 0;
    while (k + 2 < list.length && list[k + 1].line <= line) k++;
    const a = list[k];
    const b = list[k + 1];
    const f = b.line > a.line ? Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line))) : 0;
    return topOf(sec.el) + a.top + f * (b.top - a.top);
  }

  function yToLine(y: number): number {
    if (!secs.length) return 0;
    const sec = secs[secIndexAtY(y)];
    const rel = y - topOf(sec.el);
    const list = anchorsOf(sec);
    let k = 0;
    while (k + 2 < list.length && list[k + 1].top <= rel) k++;
    const a = list[k];
    const b = list[k + 1];
    const f = b.top > a.top ? Math.min(1, Math.max(0, (rel - a.top) / (b.top - a.top))) : 0;
    return a.line + f * (b.line - a.line);
  }

  // ------------------------------------------------------------ scroll sync

  const isSplit = () => app.settings.value.viewMode === 'split';
  const visible = () => el.offsetParent !== null && el.clientHeight > 0;
  // Loop safety: the preview only drives the editor while the user is physically scrolling the
  // preview, and never follows the editor during that time.
  let pointerDown = false;
  let userUntil = 0;
  const userActive = () => {
    userUntil = performance.now() + 450;
  };
  const driving = () => pointerDown || performance.now() < userUntil;
  const onPointerDown = () => {
    pointerDown = true;
  };
  const onPointerUp = () => {
    if (pointerDown) userActive();
    pointerDown = false;
  };
  el.addEventListener('wheel', userActive, { passive: true });
  el.addEventListener('touchmove', userActive, { passive: true });
  el.addEventListener('keydown', userActive);
  el.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);

  type CmView = {
    scrollDOM: HTMLElement;
    state: { doc: { lines: number; line(n: number): { from: number }; lineAt(pos: number): { number: number } } };
    lineBlockAtHeight(h: number): { from: number; top: number; height: number };
    lineBlockAt(pos: number): { top: number; height: number };
  };
  const cmView = (): CmView | null => {
    const v = app.editor?.getView?.() as CmView | undefined;
    return v && v.scrollDOM && typeof v.lineBlockAtHeight === 'function' ? v : null;
  };

  /** Editor's top line with a fraction (sub-line precision keeps long wrapped paragraphs smooth). */
  function editorTopLine(fallback: number): number {
    try {
      const v = cmView();
      if (v) {
        const st = v.scrollDOM.scrollTop;
        if (st <= 0) return 0;
        if (st + v.scrollDOM.clientHeight >= v.scrollDOM.scrollHeight - 1) return Infinity;
        const block = v.lineBlockAtHeight(st);
        return v.state.doc.lineAt(block.from).number - 1 + Math.min(1, Math.max(0, (st - block.top) / Math.max(1, block.height)));
      }
    } catch {}
    return fallback;
  }

  function scrollEditorTo(line: number): void {
    const ed = app.editor;
    if (!ed) return;
    try {
      const v = cmView();
      if (v) {
        const n = Math.min(Math.max(Math.floor(line) + 1, 1), v.state.doc.lines);
        const block = v.lineBlockAt(v.state.doc.line(n).from);
        v.scrollDOM.scrollTop = block.top + (line - Math.floor(line)) * block.height;
        return;
      }
    } catch {}
    ed.scrollToLine(Math.floor(line));
  }

  /** Scrolls so `target()` is at the top. In huge-document mode off-screen sections only have
   *  estimated heights, so the position is re-checked for a few frames once the real layout exists. */
  let settleRaf = 0;
  function scrollToY(target: () => number): void {
    cancelAnimationFrame(settleRaf);
    el.scrollTop = target();
    if (!doc.classList.contains('is-huge')) return;
    let tries = 4;
    const again = () => {
      const want = target();
      if (Math.abs(want - el.scrollTop) < 1 || driving() || --tries <= 0) return;
      el.scrollTop = want;
      settleRaf = requestAnimationFrame(again);
    };
    settleRaf = requestAnimationFrame(again);
  }

  function followEditor(line: number): void {
    if (!secs.length) return;
    if (line === Infinity) el.scrollTop = el.scrollHeight;
    else if (line <= 0) el.scrollTop = 0;
    else scrollToY(() => lineToY(line));
  }
  function syncFromEditor(): void {
    if (disposed || !isSplit() || !visible() || !app.editor) return;
    followEditor(editorTopLine(app.editor.getTopLine()));
  }

  let scrollRaf = 0;
  const onScroll = () => {
    scrolledSincePump = true;
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!secs.length) return;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const line = el.scrollTop <= 0 ? 0 : yToLine(el.scrollTop);
      scrollCbs.forEach((cb) => cb(Math.floor(line)));
      if (driving() && isSplit() && curPath === app.activePath.value) {
        const v = cmView();
        if (atEnd && v) v.scrollDOM.scrollTop = v.scrollDOM.scrollHeight;
        else scrollEditorTo(line);
      }
    });
  };
  el.addEventListener('scroll', onScroll, { passive: true });

  let offEditorScroll: (() => void) | null = null;
  let edRaf = 0;
  function attachEditor(): void {
    if (offEditorScroll || !app.editor || disposed) return;
    offEditorScroll = app.editor.onScroll((top) => {
      if (driving() || !isSplit() || curPath !== app.activePath.value) return;
      cancelAnimationFrame(edRaf);
      edRaf = requestAnimationFrame(() => {
        if (!driving() && visible()) followEditor(editorTopLine(top));
      });
    });
  }
  queueMicrotask(attachEditor);

  // ------------------------------------------------------------ interaction

  const absLine = (node: Element): number | null => {
    const holder = node.closest('[data-line]');
    const sec = secOf.get(node.closest('.se-sec') as Element);
    return holder && sec ? sec.start + Number(holder.getAttribute('data-line')) : null;
  };

  function toggleTask(input: HTMLInputElement): void {
    const path = curPath;
    const line = absLine(input);
    const content = path ? app.editor?.getContent(path) ?? app.docs.get(path)?.content : undefined;
    if (!path || line === null || content === undefined) return;
    let from = 0;
    for (let i = 0; i < line; i++) {
      from = content.indexOf('\n', from) + 1;
      if (from === 0) return;
    }
    const end = content.indexOf('\n', from);
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([^\]])\]/.exec(content.slice(from, end === -1 ? content.length : end));
    if (!m) return;
    const at = from + m[1].length;
    const insert = m[2] === ' ' ? 'x' : ' ';
    const next = content.slice(0, at) + insert + content.slice(at + 1);
    const ed = app.editor;
    if (ed?.applyChanges) ed.applyChanges(path, [{ from: at, to: at + 1, insert }]);
    else ed?.setContent(path, next);
    // Normal autosave path. Editors report programmatic edits themselves; this covers ones that do not.
    if (app.docs.get(path) && app.docs.get(path)!.content !== next && (ed?.getContent(path) ?? next) === next) noteEdited(path, next);
  }

  async function copyCode(btn: HTMLElement): Promise<void> {
    const block = btn.closest('.se-code');
    if (!block) return;
    const text = codeText(block);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    btn.classList.add('is-copied');
    btn.setAttribute('aria-label', 'Copied');
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.setAttribute('aria-label', 'Copy code');
    }, 1400);
  }

  function findAnchor(id: string): HTMLElement | null {
    const esc = (s: string) => CSS.escape(s);
    const slug = slugify(id);
    return (
      doc.querySelector<HTMLElement>(`[id="${esc(id)}"], a[name="${esc(id)}"]`) ??
      doc.querySelector<HTMLElement>(`[data-slug="${esc(slug)}"], [id="${esc(slug)}"]`) ??
      (id.startsWith('^') ? doc.querySelector<HTMLElement>(`[data-block="${esc(id.slice(1).toLowerCase())}"]`) : null)
    );
  }

  function scrollToAnchor(id: string): boolean {
    let target = findAnchor(id);
    if (!target && secs.some((s) => s.dirty)) {
      fillAll();
      target = findAnchor(id);
    }
    if (!target) return false;
    const node = target;
    scrollToY(() => topOf(node) - 12);
    target.classList.remove('se-flash');
    void target.offsetWidth; // restart the animation
    target.classList.add('se-flash');
    return true;
  }

  async function followWikilink(a: HTMLElement, from: string, newTab: boolean): Promise<void> {
    const raw = a.dataset.wikilink ?? '';
    const link = parseWikiLink(raw);
    if (!link.target && from === curPath) {
      // [[#Heading]] — same note
      const frag = link.heading ?? (link.block ? `^${link.block}` : '');
      if (scrollToAnchor(frag) && isSplit()) syncEditorToPreview();
      return;
    }
    if (app.openLink) return app.openLink(raw, from, { newTab });
    const path = resolveWikiTarget(link.target, app.files.value, from);
    if (!path) return void app.toast(`Note not found: ${link.target}`, 'error');
    await app.openFile(path, link.heading ? headingTarget(path, link.heading) : undefined);
  }

  function headingTarget(path: string, heading: string): { line: number } | undefined {
    const want = slugify(heading);
    const lines = (app.docs.get(path)?.content ?? '').split('\n');
    const line = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slugify(l.replace(/^#+\s+/, '')) === want);
    return line === -1 ? undefined : { line };
  }

  function syncEditorToPreview(): void {
    scrollEditorTo(yToLine(el.scrollTop));
  }

  async function followHref(href: string, from: string): Promise<void> {
    if (href.startsWith('#')) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      if (id && scrollToAnchor(id) && isSplit()) syncEditorToPreview();
      return;
    }
    if (/^(https?:|mailto:)/i.test(href)) return app.backend.openExternal(href);
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // file:, javascript: (already stripped), custom schemes: never followed
    const path = resolveLocalPath(href, from, app.files.value);
    if (path && app.files.value.includes(path)) {
      const frag = href.includes('#') ? decodeURIComponent(href.slice(href.indexOf('#') + 1)) : '';
      await app.openFile(path);
      const at = frag ? headingTarget(path, frag) : undefined; // content is only known once the file is open
      if (at) app.editor?.reveal(at);
    } else app.toast(`File not found: ${href}`, 'error');
  }

  async function jumpToSource(node: Element): Promise<void> {
    const line = absLine(node);
    if (line === null || !app.editor) return;
    if (app.settings.value.viewMode === 'preview') await runCommand('view.mode.live');
    app.editor.reveal({ line });
  }

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target?.closest) return;
    if (target.matches('input.se-task')) return toggleTask(target as HTMLInputElement);
    const copy = target.closest<HTMLElement>('.se-code-copy');
    if (copy) return void copyCode(copy);
    const run = target.closest<HTMLElement>('.se-code-run')?.closest<HTMLElement>('.se-code');
    if (run) return void app.runInTerminal?.(codeText(run), { lang: run.dataset.fence });
    const a = target.closest<HTMLAnchorElement>('a');
    if (a) {
      e.preventDefault(); // the app must never navigate away
      // Links inside an embedded note resolve relative to that note.
      const from = a.closest('.se-embed-body')?.closest<HTMLElement>('.se-embed')?.dataset.path ?? curPath ?? '';
      const job = a.classList.contains('se-wikilink') ? followWikilink(a, from, e.ctrlKey || e.metaKey) : followHref(a.getAttribute('href') ?? '', from);
      void Promise.resolve(job).catch((err) => app.toast(String((err as Error)?.message ?? err), 'error'));
      return;
    }
    const tag = target.closest<HTMLElement>('.se-tag[data-tag]');
    if (tag && app.openSearch) return app.openSearch(`tag:${tag.dataset.tag}`);
    if (target.closest('summary')) {
      anchorCache = new WeakMap(); // folding changes layout
      return;
    }
    if (e.ctrlKey || e.metaKey) void jumpToSource(target);
  };
  const onAuxClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement)?.closest?.('a')) e.preventDefault(); // middle click would open a browser window
  };
  doc.addEventListener('click', onClick);
  doc.addEventListener('auxclick', onAuxClick);

  // ------------------------------------------------------------ scheduling

  function run(): void {
    clearTimeout(renderTimer);
    cancelAnimationFrame(renderRaf);
    renderTimer = undefined;
    renderRaf = 0;
    if (disposed) return;
    const path = app.activePath.value;
    if (!path || !isMarkdown(path)) return clear();
    ctrl.render(path, app.editor?.getContent(path) ?? app.docs.get(path)?.content ?? '');
  }

  function schedule(immediate: boolean): void {
    if (!visible()) {
      stale = true; // rendered when it becomes visible (ResizeObserver below)
      return;
    }
    if (renderRaf || renderTimer !== undefined) {
      if (!immediate) return; // already queued
      clearTimeout(renderTimer);
      cancelAnimationFrame(renderRaf);
      renderTimer = undefined;
    }
    // Adaptive debounce: instant for normal notes, backs off when a render is expensive.
    const delay = immediate ? 0 : Math.min(300, lastMs * 2);
    if (delay < 16) renderRaf = requestAnimationFrame(run);
    else renderTimer = setTimeout(run, delay);
  }

  let embedTimer: ReturnType<typeof setTimeout> | undefined;
  function sourceChanged(path: string): void {
    embedSources.delete(path);
    if (path === curPath || !invalidateEmbeds(doc, path)) return;
    clearTimeout(embedTimer);
    embedTimer = setTimeout(() => void runEmbeds(doc), 200);
  }

  let filesSig = '';
  const offs = [
    app.events.on('doc:changed', (p) => {
      if (p === app.activePath.value) schedule(false);
      sourceChanged(p);
    }),
    app.events.on('active:changed', () => schedule(true)),
    app.events.on('file:updated', (p) => sourceChanged(p)),
    app.events.on('tree:changed', () => {
      const sig = app.files.value.join('\n');
      if (sig === filesSig) return;
      filesSig = sig;
      epoch++; // link resolution may have changed
      schedule(true);
    }),
    app.events.on('settings:changed', () => {
      epoch++;
      attachEditor();
      schedule(true);
      enhancer.retheme();
    }),
  ];

  const themeObserver = new MutationObserver(() => enhancer.retheme());
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const resizeObserver =
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
          anchorCache = new WeakMap();
          attachEditor();
          if (stale && visible()) schedule(true);
        });
  resizeObserver?.observe(el);
  resizeObserver?.observe(doc);

  const onBeforePrint = () => {
    if (stale) run();
    fillAll();
    // Print only the document, whatever the shell layout around it looks like.
    for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
      n.classList.add('se-print-path');
      for (const sib of Array.from(n.parentElement?.children ?? [])) if (sib !== n) sib.classList.add('se-print-hide');
    }
  };
  const onAfterPrint = () => {
    document.querySelectorAll('.se-print-path').forEach((n) => n.classList.remove('se-print-path'));
    document.querySelectorAll('.se-print-hide').forEach((n) => n.classList.remove('se-print-hide'));
  };
  window.addEventListener('beforeprint', onBeforePrint);
  window.addEventListener('afterprint', onAfterPrint);

  const ctrl: PreviewHandle = {
    content: doc,
    render,
    scrollToLine(line) {
      if (line <= 0) el.scrollTop = 0;
      else scrollToY(() => Math.max(0, lineToY(line) - 8));
    },
    onScroll(cb) {
      scrollCbs.add(cb);
      return () => scrollCbs.delete(cb);
    },
    async settle() {
      if (stale || renderRaf || renderTimer !== undefined) run();
      fillAll();
      await runEmbeds(doc);
      await enhanceAll(doc);
    },
    dispose() {
      disposed = true;
      offs.forEach((o) => o());
      offEditorScroll?.();
      clearTimeout(pumpTimer);
      clearTimeout(renderTimer);
      clearTimeout(embedTimer);
      cancelAnimationFrame(renderRaf);
      themeObserver.disconnect();
      resizeObserver?.disconnect();
      enhancer.dispose();
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', userActive);
      el.removeEventListener('touchmove', userActive);
      el.removeEventListener('keydown', userActive);
      el.removeEventListener('pointerdown', onPointerDown);
      el.replaceChildren();
      el.classList.remove('se-preview-scroller');
    },
  };
  return ctrl;
}

export { installPreview } from './install';
