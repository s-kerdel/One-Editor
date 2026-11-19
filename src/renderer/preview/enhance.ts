// Lazy upgrades of rendered blocks: Shiki highlighting, KaTeX math, Mermaid diagrams.
// Nothing here is in the startup bundle — every library arrives through import() on first use, and
// blocks are upgraded in place (plain text first) when they come near the viewport.
import type { HighlighterCore } from 'shiki/core';
import { sanitizeLib, sanitizeSvg } from './sanitize';

// ---------------------------------------------------------------- Shiki

type LangModule = { default: unknown };
// Explicit map (not a computed import) so each grammar becomes its own small lazy chunk.
const LANGS: Record<string, () => Promise<LangModule>> = {
  markdown: () => import('shiki/langs/markdown.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  blade: () => import('shiki/langs/blade.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  bat: () => import('shiki/langs/bat.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  twig: () => import('shiki/langs/twig.mjs'),
  apache: () => import('shiki/langs/apache.mjs'),
};
const THEMES = { light: 'github-light', dark: 'github-dark' };
const MAX_HIGHLIGHT_CHARS = 200_000;

let highlighter: HighlighterCore | null = null;
let highlighterP: Promise<HighlighterCore> | null = null;
const langReady = new Set<string>();
const langLoading = new Map<string, Promise<boolean>>();
const codeCache = new Map<string, string>();

function loadHighlighter(): Promise<HighlighterCore> {
  return (highlighterP ??= (async () => {
    const [core, engine, dark, light] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes/github-dark.mjs'),
      import('shiki/themes/github-light.mjs'),
    ]);
    // JS regex engine: no 600KB Oniguruma WASM download/compile.
    highlighter = await core.createHighlighterCore({ themes: [dark.default, light.default], langs: [], engine: engine.createJavaScriptRegexEngine({ forgiving: true }) });
    return highlighter;
  })());
}

function ensureLang(id: string): Promise<boolean> {
  if (langReady.has(id)) return Promise.resolve(true);
  const loader = LANGS[id];
  if (!loader) return Promise.resolve(false);
  let p = langLoading.get(id);
  if (!p) {
    p = (async () => {
      try {
        const [h, mod] = await Promise.all([loadHighlighter(), loader()]);
        await h.loadLanguage(mod.default as Parameters<HighlighterCore['loadLanguage']>[0]);
        langReady.add(id);
        return true;
      } catch (err) {
        console.warn(`[preview] cannot load grammar "${id}"`, err);
        return false;
      }
    })();
    langLoading.set(id, p);
  }
  return p;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const plainLines = (code: string) => code.split('\n').map((l) => `<span class="line">${escapeHtml(l)}</span>`).join('\n');

/** Inner HTML for <code> (one .line span per line), or null if the grammar is not loaded yet. */
function highlightSync(code: string, lang: string): string | null {
  if (!highlighter || !langReady.has(lang)) return null;
  const key = `${lang}\u0000${code}`;
  const hit = codeCache.get(key);
  if (hit !== undefined) return hit;
  let inner: string;
  try {
    const html = highlighter.codeToHtml(code, { lang, themes: THEMES, defaultColor: false });
    const tpl = document.createElement('template');
    tpl.innerHTML = sanitizeLib(html);
    inner = tpl.content.querySelector('code')?.innerHTML ?? plainLines(code);
  } catch (err) {
    console.warn('[preview] highlight failed', err);
    inner = plainLines(code);
  }
  if (codeCache.size > 400) codeCache.clear();
  if (code.length < 50_000) codeCache.set(key, inner);
  return inner;
}

function applyCode(el: HTMLElement, inner: string | null): void {
  const codeEl = el.querySelector<HTMLElement>(':scope > pre > code');
  if (!codeEl) return;
  // Line spans are also needed without a grammar (line numbers, diff backgrounds).
  if (inner === null && (el.classList.contains('se-code-numbers') || el.dataset.fence === 'diff')) inner = plainLines(codeText(el));
  if (inner !== null) codeEl.innerHTML = inner;
  el.dataset.hl = inner === null ? 'plain' : '1';
  if (el.dataset.fence === 'diff' || el.dataset.fence === 'patch') {
    for (const line of codeEl.querySelectorAll<HTMLElement>(':scope > .line')) {
      const c = line.textContent?.[0];
      if (c === '+') line.classList.add('se-diff-add');
      else if (c === '-') line.classList.add('se-diff-del');
      else if (c === '@') line.classList.add('se-diff-hunk');
    }
  }
}

/** Source of a code block (without the trailing newline markdown-it adds). */
export function codeText(el: Element): string {
  return (el.querySelector(':scope > pre > code')?.textContent ?? '').replace(/\n$/, '');
}

// ---------------------------------------------------------------- KaTeX

type Katex = typeof import('katex').default;
let katex: Katex | null = null;
let katexP: Promise<Katex> | null = null;
const mathCache = new Map<string, string>();

function loadKatex(): Promise<Katex> {
  return (katexP ??= (async () => {
    const [mod] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')]);
    katex = mod.default;
    return katex;
  })());
}

function mathHtml(tex: string, display: boolean, output: 'html' | 'mathml'): string {
  const key = `${output}${display ? 'D' : 'I'}${tex}`;
  let html = mathCache.get(key);
  if (html === undefined) {
    const raw = katex!.renderToString(tex, { displayMode: display, throwOnError: false, output, strict: 'ignore', trust: false });
    html = sanitizeLib(raw);
    if (mathCache.size > 2000) mathCache.clear();
    mathCache.set(key, html);
  }
  return html;
}

function applyMath(el: HTMLElement, output: 'html' | 'mathml' = 'html'): void {
  const tex = el.dataset.tex ?? el.textContent ?? '';
  el.dataset.tex = tex;
  el.innerHTML = mathHtml(tex, el.classList.contains('se-math-display'), output);
  el.dataset.done = '1';
}

// ---------------------------------------------------------------- Mermaid

type Mermaid = typeof import('mermaid').default;
let mermaidP: Promise<Mermaid> | null = null;
let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidSeq = 0;
const mermaidCache = new Map<string, string>();

export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t === 'light') return false;
  if (t === 'system') return !window.matchMedia?.('(prefers-color-scheme: light)').matches;
  return true;
}

// Diagrams follow the app palette (same hues the callouts and links use) instead of mermaid's stock themes.
function mermaidTheme(dark: boolean) {
  const v = dark
    ? { bg: '#1b1d22', node: '#262a33', text: '#d7dae0', line: '#8b919c', border: '#7aa2f7', alt: '#2a2e36', note: '#3a3420' }
    : { bg: '#ffffff', node: '#eef2fd', text: '#1f2328', line: '#646b75', border: '#3b6ee8', alt: '#f2f2f0', note: '#fff8d6' };
  return {
    theme: 'base' as const,
    themeVariables: {
      darkMode: dark, background: v.bg, primaryColor: v.node, primaryTextColor: v.text, primaryBorderColor: v.border, lineColor: v.line,
      secondaryColor: v.alt, tertiaryColor: v.alt, textColor: v.text, mainBkg: v.node, nodeBorder: v.border, clusterBkg: v.alt, clusterBorder: v.line,
      edgeLabelBackground: v.bg, titleColor: v.text, noteBkgColor: v.note, noteTextColor: v.text, noteBorderColor: v.line, actorBkg: v.node, actorBorder: v.border,
      actorTextColor: v.text, signalColor: v.line, signalTextColor: v.text, labelBoxBkgColor: v.node, labelBoxBorderColor: v.border, labelTextColor: v.text, fontSize: '14px',
    },
  };
}

/** Sanitized SVG for a diagram. Renders are serialised because mermaid's configuration is global. */
function mermaidSvg(src: string, dark: boolean): Promise<string> {
  const key = `${dark ? 'd' : 'l'}${src}`;
  const hit = mermaidCache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const job = mermaidQueue.then(async () => {
    const mermaid = (await (mermaidP ??= import('mermaid').then((m) => m.default)));
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif', ...mermaidTheme(dark) });
    const id = `se-mmd-${++mermaidSeq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      const clean = sanitizeSvg(svg);
      if (mermaidCache.size > 100) mermaidCache.clear();
      mermaidCache.set(key, clean);
      return clean;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  mermaidQueue = job.catch(() => {});
  return job;
}

async function applyMermaid(el: HTMLElement, dark: boolean): Promise<void> {
  const src = el.dataset.src ?? el.querySelector('code')?.textContent ?? '';
  el.dataset.src = src;
  el.dataset.done = dark ? 'dark' : 'light';
  try {
    const svg = await mermaidSvg(src, dark);
    if (el.dataset.src !== src) return;
    el.innerHTML = svg;
    el.classList.remove('is-error');
  } catch (err) {
    el.classList.add('is-error');
    el.replaceChildren();
    const msg = document.createElement('div');
    msg.className = 'se-mermaid-error';
    msg.textContent = `Mermaid: ${(err as Error)?.message ?? err}`;
    const pre = document.createElement('pre');
    pre.textContent = src;
    el.append(msg, pre);
  }
}

// ---------------------------------------------------------------- orchestration

const PENDING = '.se-code:not([data-hl]), .se-math:not([data-done]), .se-mermaid:not([data-done])';

async function upgrade(el: HTMLElement, mathOutput: 'html' | 'mathml' = 'html', dark = isDark()): Promise<void> {
  if (el.classList.contains('se-code')) {
    if (el.dataset.hl) return;
    const lang = el.dataset.lang ?? '';
    const code = codeText(el);
    const ok = !!lang && code.length <= MAX_HIGHLIGHT_CHARS && (await ensureLang(lang));
    if (!el.dataset.hl) applyCode(el, ok ? highlightSync(code, lang) : null);
  } else if (el.classList.contains('se-math')) {
    await loadKatex();
    if (!el.dataset.done) applyMath(el, mathOutput);
  } else if (el.classList.contains('se-mermaid')) {
    await applyMermaid(el, dark);
  }
}

export interface Enhancer {
  /** Observes pending blocks so they upgrade near the viewport. With `sync`, blocks whose library is
   *  already loaded upgrade right now (no flash of plain text while typing). */
  scan(root: ParentNode, sync?: boolean): void;
  /** Re-render theme dependent output (mermaid). */
  retheme(): void;
  dispose(): void;
}

export function createEnhancer(scroller: HTMLElement): Enhancer {
  const io =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              io!.unobserve(e.target);
              void upgrade(e.target as HTMLElement);
            }
          },
          { root: scroller, rootMargin: '800px 0px' },
        );
  return {
    scan(root, sync = true) {
      const deadline = sync ? performance.now() + 10 : 0; // keep typing snappy: the rest is picked up by the observer
      for (const el of root.querySelectorAll<HTMLElement>(PENDING)) {
        if (el.classList.contains('se-code')) {
          const lang = el.dataset.lang ?? '';
          if (!lang || !LANGS[lang]) {
            applyCode(el, null);
            continue;
          }
          if (performance.now() < deadline) {
            const code = codeText(el);
            const inner = code.length <= 20_000 ? highlightSync(code, lang) : null;
            if (inner !== null) {
              applyCode(el, inner);
              continue;
            }
          }
        } else if (el.classList.contains('se-math')) {
          if (katex && performance.now() < deadline) {
            applyMath(el);
            continue;
          }
        } else {
          const src = el.querySelector('code')?.textContent ?? '';
          const hit = mermaidCache.get(`${isDark() ? 'd' : 'l'}${src}`);
          if (hit !== undefined) {
            el.dataset.src = src;
            el.dataset.done = isDark() ? 'dark' : 'light';
            el.innerHTML = hit;
            continue;
          }
        }
        if (io) io.observe(el);
        else void upgrade(el);
      }
    },
    retheme() {
      const mode = isDark() ? 'dark' : 'light';
      for (const el of scroller.querySelectorAll<HTMLElement>('.se-mermaid[data-done]')) if (el.dataset.done !== mode) void applyMermaid(el, mode === 'dark');
    },
    dispose() {
      io?.disconnect();
    },
  };
}

/** Upgrade everything under `root` now (export / copy / print). */
export async function enhanceAll(root: ParentNode, opts: { mathOutput?: 'html' | 'mathml'; dark?: boolean } = {}): Promise<void> {
  await Promise.all([...root.querySelectorAll<HTMLElement>(PENDING)].map((el) => upgrade(el, opts.mathOutput, opts.dark).catch((err) => console.warn('[preview] upgrade failed', err))));
}
