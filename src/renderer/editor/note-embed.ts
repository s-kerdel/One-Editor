// `![[Note]]` / `![[Note#Heading]]` / `![[Note#^block]]` on its own line → read-only embedded block in
// live preview. Rendering reuses the preview module (markdown-it + DOMPurify, nested embeds, code
// highlighting / math / mermaid), loaded lazily. Images stay inline widgets (live.ts).
import { EditorSelection } from '@codemirror/state';
import { WidgetType, type EditorView } from '@codemirror/view';
import { basename, isMarkdown, stem } from '@shared/paths';
import { getEditorHost } from './host';
import { icon } from './widgets';

const AUDIO_RE = /\.(mp3|wav|ogg|m4a|flac)$/i;
const VIDEO_RE = /\.(mp4|webm|ogv|mov)$/i;
const BINARY_RE = /\.(pdf|zip|gz|7z|exe|dll|docx?|xlsx?|pptx?|woff2?|ttf|otf|sqlite|db)$/i;

/** Last rendered HTML / height per embed, so a rebuilt widget paints at once without a jump. */
const htmlCache = new Map<string, string>();
const heightCache = new Map<string, number>();
const remember = <V>(m: Map<string, V>, k: string, v: V) => {
  if (m.size > 200) m.delete(m.keys().next().value!);
  m.set(k, v);
};

type PreviewMods = [typeof import('../preview/index'), typeof import('../preview/embeds'), typeof import('../preview/enhance')];
let mods: Promise<PreviewMods> | null = null;
const loadPreview = () => (mods ??= Promise.all([import('../preview/index'), import('../preview/embeds'), import('../preview/enhance')]));

export class NoteEmbedWidget extends WidgetType {
  constructor(
    /** Link text as written (`Note#Heading`). */
    readonly target: string,
    /** Resolved workspace path (null = unresolved). */
    readonly path: string | null,
    readonly fragment: string | null,
    /** Note containing the embed (cycle guard). */
    readonly host: string,
    /** Bumped when the embedded note changes. */
    readonly rev: number,
  ) {
    super();
  }
  eq(o: NoteEmbedWidget) {
    return o.target === this.target && o.path === this.path && o.host === this.host && o.rev === this.rev;
  }
  get key() {
    return `${this.host}\u0000${this.target}`;
  }
  get estimatedHeight() {
    return heightCache.get(this.key) ?? 140;
  }
  ignoreEvent() {
    return true;
  }

  toDOM(view: EditorView) {
    // Outer block carries the vertical spacing as padding (block widget margins aren't measured by CodeMirror).
    const block = document.createElement('div');
    block.className = 'se-note-embed-block';
    const wrap = document.createElement('div');
    wrap.className = 'se-note-embed';
    block.appendChild(wrap);
    if (this.path) wrap.dataset.path = this.path;
    const head = document.createElement('div');
    head.className = 'se-note-embed-head';
    const kind = !this.path ? 'file' : AUDIO_RE.test(this.path) ? 'music' : VIDEO_RE.test(this.path) ? 'film' : isMarkdown(this.path) ? 'file' : 'code';
    const title = document.createElement('a');
    title.className = 'se-note-embed-title';
    title.title = this.path ? `Open ${this.path}` : `Create “${this.target.split('#')[0]}”`;
    title.append(icon(kind), document.createTextNode(this.path ? (isMarkdown(this.path) ? stem(this.path) : basename(this.path)) : this.target.split('#')[0] || 'This note'));
    head.appendChild(title);
    if (this.fragment) {
      const frag = document.createElement('span');
      frag.className = 'se-note-embed-frag';
      frag.textContent = this.fragment.startsWith('^') ? this.fragment : `# ${this.fragment}`;
      head.appendChild(frag);
    }
    head.appendChild(Object.assign(document.createElement('span'), { className: 'se-note-embed-spacer' }));
    const editBtn = button('pencil', 'Edit embed link', () => {
      const pos = view.posAtDOM(block);
      view.focus();
      view.dispatch({ selection: EditorSelection.cursor(view.state.doc.lineAt(pos).to), userEvent: 'select' });
    });
    const openBtn = button('external', 'Open note', (e) => this.open(e));
    head.append(editBtn, openBtn);
    title.addEventListener('click', (e) => {
      e.preventDefault();
      this.open(e);
    });
    title.addEventListener('auxclick', (e) => e.button === 1 && (e.preventDefault(), this.open(e)));

    const body = document.createElement('div');
    body.className = 'se-note-embed-body se-preview markdown-body';
    wrap.append(head, body);
    // Links inside the embed open like in the preview (wikilinks via the app's resolver).
    body.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a');
      if (!a) return;
      e.preventDefault();
      const wiki = a.getAttribute('data-wikilink');
      const href = a.getAttribute('href') ?? '';
      const h = getEditorHost();
      if (wiki) h?.openLink({ kind: 'wiki', ...splitTarget(wiki) }, this.path ?? this.host, { newTab: e.ctrlKey || e.metaKey });
      else if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^app:/i.test(href)) h?.openLink({ kind: 'url', target: href }, this.host, {});
      else if (href.startsWith('#')) h?.openLink({ kind: 'anchor', target: '', heading: decodeURIComponent(href.slice(1)) }, this.host, {});
    });

    const cached = htmlCache.get(this.key);
    if (cached) body.innerHTML = cached; // sanitized when it was produced
    else {
      body.classList.add('is-loading');
      body.textContent = 'Loading…';
    }
    void this.fill(view, wrap, body);
    return block;
  }

  private open(e: MouseEvent) {
    getEditorHost()?.openLink({ kind: 'wiki', target: this.target.split('#')[0], heading: this.fragment ?? undefined }, this.host, { newTab: e.ctrlKey || e.metaKey || e.button === 1 });
  }

  private async fill(view: EditorView, wrap: HTMLElement, body: HTMLElement) {
    const done = (cls?: string, text?: string) => {
      body.classList.remove('is-loading');
      if (cls) {
        wrap.classList.add(cls);
        body.textContent = text ?? '';
      }
      remember(heightCache, this.key, (wrap.parentElement ?? wrap).offsetHeight || 140);
      view.requestMeasure();
    };
    const host = getEditorHost();
    if (!this.path) return done('is-unresolved', `“${this.target.split('#')[0]}” doesn’t exist yet — click the title to create it.`);
    if (this.path === this.host && !this.fragment) return done('is-cycle', 'A note can’t embed itself.');
    if (AUDIO_RE.test(this.path) || VIDEO_RE.test(this.path)) {
      const src = host?.imageUrl(this.path, this.host, true) ?? null;
      const media = document.createElement(AUDIO_RE.test(this.path) ? 'audio' : 'video');
      media.controls = true;
      media.preload = 'metadata';
      if (src) media.src = src;
      body.replaceChildren(media);
      return done();
    }
    if (BINARY_RE.test(this.path)) return done('is-binary', `${basename(this.path)} — open it to view`);
    try {
      const [pv, emb, enh] = await loadPreview();
      const src = this.path === this.host ? view.state.doc.toString() : await host?.readNote?.(this.path);
      if (src == null) return done('is-unresolved', `Cannot read ${this.path}`);
      let html: string;
      if (isMarkdown(this.path)) {
        const part = this.fragment ? emb.extractSection(src, this.fragment) : emb.stripFrontmatter(src);
        if (part === null) return done('is-missing', `“${this.fragment}” was not found in ${stem(this.path)}`);
        html = pv.embedContext.render(part.replace(/(^|\s)\^[\w-]+[ \t]*$/gm, ''), this.path);
      } else html = pv.embedContext.renderFile(this.path, src.length > 200_000 ? src.slice(0, 200_000) : src);
      body.innerHTML = html; // sanitized by the preview pipeline
      body.classList.remove('is-loading');
      if (!body.textContent?.trim() && !body.querySelector('img,svg,video,audio')) {
        body.textContent = 'Empty note';
        wrap.classList.add('is-empty');
      }
      await emb.expandEmbeds(body, pv.embedContext, [this.host, this.path]);
      await enh.enhanceAll(body, { dark: enh.isDark() });
      remember(htmlCache, this.key, body.innerHTML);
      done();
    } catch (err) {
      console.warn('[editor] embed failed', this.path, err);
      done('is-error', `Could not render ${this.path}`);
    }
  }
}

function splitTarget(t: string): { target: string; heading?: string } {
  const i = t.indexOf('#');
  return i < 0 ? { target: t } : { target: t.slice(0, i), heading: t.slice(i + 1) || undefined };
}

function button(name: string, label: string, run: (e: MouseEvent) => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'se-note-embed-btn';
  b.title = label;
  b.setAttribute('aria-label', label);
  b.appendChild(icon(name));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    run(e);
  });
  return b;
}
