// Pure markdown → sanitized HTML pipeline (no app/DOM-controller dependencies, unit-testable).
// Obsidian flavour on top of GFM: callouts, wikilinks, embeds, tags, ==highlight==, %%comments%%,
// frontmatter properties, math placeholders (KaTeX upgrades them later), task lists with source lines.
import MarkdownIt, { type StateBlock, type StateCore, type StateInline, type Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import { languageForFence, languageForPath } from '@shared/languages';
import { dirname, extname } from '@shared/paths';
import { parseWikiLink, resolveWikiTarget } from '@shared/wikilinks';
import { useOneBlockRules } from '@shared/md-block-rules';
import { USER_MARK, mermaidFetches, relativeUrl, sanitizeHtml, sanitizeToFragment, type SanitizeContext } from './sanitize';

export interface RenderOptions {
  /** Workspace-relative path of the note being rendered (relative links/images resolve against it). */
  path?: string;
  /** All workspace files; enables resolved/unresolved wikilink styling. */
  files?: readonly string[];
  /** Maps a workspace path to a loadable URL (images). Without it, relative URLs are kept. */
  resolveUrl?: (wsPath: string) => string;
  /** Added to every data-line (used when rendering a slice of a document). */
  lineOffset?: number;
  /** false → no data-line attributes and task checkboxes are disabled (embeds, export). */
  sourceLines?: boolean;
  /** false → a leading `---` block is not treated as frontmatter. */
  frontmatter?: boolean;
  /** Obsidian-style: single newlines become <br>. */
  breaks?: boolean;
  /** {{variables}} (../variables): values for placeholders in prose, inline code and code blocks
   *  (`info` = the fence's info string, for `{target=…}` attributes). Secrets arrive masked. */
  vars?: ((text: string, info: string | null) => string) | null;
  /** Remote media (images from the internet) may load; default: placeholders (see ./remote). */
  remote?: boolean;
}

interface Env {
  opts: RenderOptions;
  slugs: Map<string, number>;
}

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.avif', '.ico']);
export const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogv', '.mov']);

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
// Fuzzy links would turn "README.md" into a link (.md is a TLD); GitHub only autolinks real URLs.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
md.use(footnote);
const esc = md.utils.escapeHtml;
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0xa0;

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

export { relativeUrl };

// ---------------------------------------------------------------- block rules

// frontmatter, %% comments, $$ math, \pagebreak: shared with the MCP server's {{placeholder}} check, so both
// see the same code blocks (src/shared/md-block-rules.ts).
useOneBlockRules(md);

// ---------------------------------------------------------------- inline rules

/** Pandoc/Obsidian rules so prices like "$5 and $10" are left alone. */
function mathInlineRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x24) return false;
  if (src.charCodeAt(start + 1) === 0x24) {
    const end = src.indexOf('$$', start + 2);
    if (end === -1 || end + 2 > state.posMax) return false;
    const content = src.slice(start + 2, end).trim();
    if (!content) return false;
    if (!silent) {
      const t = state.push('math_inline', 'span', 0);
      t.content = content;
      t.meta = { display: true };
    }
    state.pos = end + 2;
    return true;
  }
  const next = src.charCodeAt(start + 1);
  if (Number.isNaN(next) || isSpace(next)) return false;
  let pos = start + 1;
  for (;;) {
    pos = src.indexOf('$', pos);
    if (pos === -1 || pos >= state.posMax) return false;
    let bs = 0;
    while (src.charCodeAt(pos - 1 - bs) === 0x5c) bs++;
    if (bs % 2 === 0) break;
    pos++;
  }
  const before = src.charCodeAt(pos - 1);
  const after = src.charCodeAt(pos + 1);
  if (isSpace(before) || (after >= 0x30 && after <= 0x39)) return false;
  if (!silent) {
    const t = state.push('math_inline', 'span', 0);
    t.content = src.slice(start + 1, pos);
  }
  state.pos = pos + 1;
  return true;
}

function markRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  const max = state.posMax;
  if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d) return false;
  const c = src.charCodeAt(start + 2);
  if (Number.isNaN(c) || isSpace(c) || c === 0x3d) return false;
  let end = start + 2;
  for (;;) {
    end = src.indexOf('==', end + 1);
    if (end === -1 || end + 2 > max) return false;
    if (!isSpace(src.charCodeAt(end - 1))) break;
  }
  if (!silent) {
    state.push('mark_open', 'mark', 1);
    state.pos = start + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.posMax = max;
    state.push('mark_close', 'mark', -1);
  }
  state.pos = end + 2;
  return true;
}

function commentInlineRule(state: StateInline): boolean {
  const src = state.src;
  if (src.charCodeAt(state.pos) !== 0x25 || src.charCodeAt(state.pos + 1) !== 0x25) return false;
  const end = src.indexOf('%%', state.pos + 2);
  if (end === -1 || end + 2 > state.posMax) return false;
  state.pos = end + 2;
  return true;
}

// Resolution scans the whole file list; documents repeat the same few targets many times.
const resolveCache = new WeakMap<readonly string[], Map<string, string | null>>();
function resolveCached(target: string, files: readonly string[], from?: string): string | null {
  let map = resolveCache.get(files);
  if (!map) resolveCache.set(files, (map = new Map()));
  const key = `${from ?? ''}\u0000${target}`;
  let hit = map.get(key);
  if (hit === undefined) map.set(key, (hit = resolveWikiTarget(target, files, from)));
  return hit;
}

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21;
  if (embed) pos++;
  if (src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
  if (state.linkLevel > 0) return false;
  const end = src.indexOf(']]', pos + 2);
  if (end === -1 || end + 2 > state.posMax) return false;
  // Inside tables Obsidian requires the alias pipe to be escaped.
  const inner = src.slice(pos + 2, end).replace(/\\\|/g, '|');
  if (!inner.trim() || /[[\]\n]/.test(inner)) return false;
  if (!silent) {
    const env = state.env as unknown as Env;
    const link = parseWikiLink(inner, embed);
    const resolved = env.opts.files ? resolveCached(link.target, env.opts.files, env.opts.path) : undefined;
    const frag = link.heading ? `#${link.heading}` : link.block ? `#^${link.block}` : '';
    const display = link.alias || (link.target ? link.target + (link.heading ? ` > ${link.heading}` : '') : link.heading || inner);
    if (embed) {
      const t = state.push('embed', 'span', 0);
      t.meta = { link, resolved, frag, display };
    } else {
      const open = state.push('wikilink_open', 'a', 1);
      open.attrSet('class', resolved === null ? 'se-wikilink is-unresolved' : 'se-wikilink');
      open.attrSet('href', resolved ? relativeUrl(env.opts.path, resolved) + encodeURI(frag) : '#');
      open.attrSet('data-wikilink', link.target + frag);
      if (resolved) open.attrSet('data-path', resolved);
      if (resolved === null) open.attrSet('title', `${link.target} (not created yet)`);
      state.push('text', '', 0).content = display;
      state.push('wikilink_close', 'a', -1);
    }
  }
  state.pos = end + 2;
  return true;
}

const TAG_RE = /^#(?=[\p{L}\p{N}_/-]*[\p{L}_])[\p{L}\p{N}_/-]+/u;
/** `#tag` (not `# heading`, which the block parser already consumed; not inside links/URLs/words). */
function tagRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x23 || state.linkLevel > 0) return false;
  if (pos > 0 && !isSpace(src.charCodeAt(pos - 1)) && src.charCodeAt(pos - 1) !== 0x28) return false;
  const m = TAG_RE.exec(src.slice(pos, Math.min(state.posMax, pos + 160)));
  if (!m) return false;
  if (!silent) {
    const open = state.push('tag_open', 'span', 1);
    open.attrSet('class', 'se-tag');
    open.attrSet('data-tag', m[0].slice(1));
    state.push('text', '', 0).content = m[0];
    state.push('tag_close', 'span', -1);
  }
  state.pos = pos + m[0].length;
  return true;
}

md.inline.ruler.after('escape', 'math_inline', mathInlineRule);
md.inline.ruler.before('link', 'wikilink', wikilinkRule);
md.inline.ruler.before('link', 'tag', tagRule);
md.inline.ruler.before('emphasis', 'mark', markRule);
md.inline.ruler.before('emphasis', 'comment_inline', commentInlineRule);

// ---------------------------------------------------------------- core rules

export const CALLOUT_ALIASES: Record<string, string> = {
  summary: 'abstract', tldr: 'abstract', hint: 'tip', important: 'tip', check: 'success', done: 'success',
  help: 'question', faq: 'question', caution: 'warning', attention: 'warning', fail: 'failure', missing: 'failure',
  error: 'danger', cite: 'quote',
};
export const CALLOUT_TYPES = ['note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote'];

/** Turns `> [!type]± Title` blockquotes into callout containers. Runs before inline parsing so titles get inline markdown. */
function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'blockquote_open') continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (!para || para.type !== 'paragraph_open' || !inline || inline.type !== 'inline') continue;
    const m = /^\[!([^\]\n]+)\]([+-]?)[ \t]*([^\n]*)(?:\n|$)/.exec(inline.content);
    if (!m) continue;
    let close = i + 1;
    for (let depth = 1; close < tokens.length; close++) {
      if (tokens[close].type === 'blockquote_open') depth++;
      else if (tokens[close].type === 'blockquote_close' && --depth === 0) break;
    }
    const raw = m[1].trim().toLowerCase();
    const type = CALLOUT_ALIASES[raw] ?? raw;
    const fold = m[2];
    const known = CALLOUT_TYPES.includes(type);
    open.type = 'callout_open';
    open.tag = fold ? 'details' : 'div';
    open.attrSet('class', `se-callout${fold ? ' is-foldable' : ''}`);
    open.attrSet('data-callout', known ? type : 'note');
    if (!known) open.attrSet('data-callout-custom', raw.replace(/[^\w-]/g, ''));
    if (fold === '+') open.attrSet('open', '');
    tokens[close].type = 'callout_close';
    tokens[close].tag = open.tag;

    const mk = (type: string, tag: string, nesting: 1 | 0 | -1, cls?: string) => {
      const t = new state.Token(type, tag, nesting);
      t.block = true;
      t.level = open.level + 1;
      if (cls) t.attrSet('class', cls);
      return t;
    };
    const title = new state.Token('inline', '', 0);
    title.content = m[3].trim() || raw.charAt(0).toUpperCase() + raw.slice(1);
    title.children = [];
    title.level = open.level + 2;
    title.map = inline.map ? [inline.map[0], inline.map[0] + 1] : null;
    const head = [
      mk('callout_title_open', fold ? 'summary' : 'div', 1, 'se-callout-title'),
      mk('callout_icon', 'span', 0),
      mk('callout_title_inner_open', 'span', 1, 'se-callout-title-text'),
      title,
      mk('callout_title_inner_close', 'span', -1),
      ...(fold ? [mk('callout_fold', 'span', 0)] : []),
      mk('callout_title_close', fold ? 'summary' : 'div', -1),
      mk('callout_content_open', 'div', 1, 'se-callout-content'),
    ];
    const rest = inline.content.slice(m[0].length);
    tokens.splice(close, 0, mk('callout_content_close', 'div', -1));
    if (rest.trim()) {
      inline.content = rest;
      if (inline.map) inline.map = [inline.map[0] + 1, inline.map[1]];
      if (para.map) para.map = [para.map[0] + 1, para.map[1]];
      tokens.splice(i + 1, 0, ...head);
    } else {
      tokens.splice(i + 1, 3, ...head); // title-only first paragraph
    }
  }
}

function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  const opts = (state.env as unknown as Env).opts;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') continue;
    const first = inline.children?.[0];
    if (!first || first.type !== 'text') continue;
    const m = /^\[([^\]])\](?:[ \t ]+|$)/.exec(first.content);
    if (!m) continue;
    const checked = m[1] !== ' ';
    first.content = first.content.slice(m[0].length);
    const box = new state.Token('se_html', '', 0); // app markup: not raw HTML from the note (see R.html_inline)
    const line = opts.sourceLines === false || !inline.map ? null : inline.map[0] + (opts.lineOffset ?? 0);
    box.content = `<input class="se-task" type="checkbox"${line === null ? ' disabled' : ` data-line="${line}"`}${checked ? ' checked' : ''}${
      checked && !/x/i.test(m[1]) ? ` data-task="${esc(m[1])}"` : ''
    }>`;
    inline.children!.unshift(box);
    const li = tokens[i - 2];
    li.attrJoin('class', checked ? 'se-task-item is-checked' : 'se-task-item');
    for (let j = i - 3; j >= 0; j--) {
      if (tokens[j].level === li.level - 1 && (tokens[j].type === 'bullet_list_open' || tokens[j].type === 'ordered_list_open')) {
        if (!String(tokens[j].attrGet('class') ?? '').includes('contains-task-list')) tokens[j].attrJoin('class', 'contains-task-list');
        break;
      }
    }
  }
}

function headingRule(state: StateCore): void {
  const env = state.env as unknown as Env;
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = (inline.children ?? []).map((c: Token) => (c.type === 'text' || c.type === 'code_inline' ? c.content : '')).join('');
    const base = slugify(text) || 'section';
    const n = env.slugs.get(base) ?? 0;
    env.slugs.set(base, n + 1);
    const slug = n ? `${base}-${n}` : base;
    tokens[i].attrSet('id', slug);
    tokens[i].attrSet('data-slug', slug); // survives DOMPurify's clobbering guard (e.g. a heading named "Title")
    const a = new state.Token('se_html', '', 0);
    a.content = `<a class="se-anchor" href="#${esc(encodeURIComponent(slug))}" aria-label="Link to this heading"></a>`;
    (inline.children ??= []).push(a);
  }
}

/** Obsidian block ids (`text ^my-id`): hide the marker, expose it as data-block for `[[Note#^my-id]]`. */
function blockIdRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length; i++) {
    const kids = tokens[i].type === 'inline' ? tokens[i].children : null;
    const last = kids?.[kids.length - 1];
    if (!last || last.type !== 'text') continue;
    const m = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(last.content);
    if (!m) continue;
    last.content = last.content.slice(0, m.index);
    if (tokens[i - 1].nesting === 1) tokens[i - 1].attrSet('data-block', m[1].toLowerCase());
  }
}

const SELF_BLOCKS = new Set(['fence', 'code_block', 'hr', 'math_block', 'frontmatter', 'page_break']);
/** data-line (and data-end on top-level blocks) power scroll sync, task toggling and incremental DOM updates. */
function sourceLinesRule(state: StateCore): void {
  const opts = (state.env as unknown as Env).opts;
  if (opts.sourceLines === false) return;
  const off = opts.lineOffset ?? 0;
  for (const t of state.tokens) {
    if (!t.map) continue;
    const top = t.level === 0 && (t.nesting === 1 || SELF_BLOCKS.has(t.type));
    if (top || t.type === 'list_item_open' || t.type === 'tr_open' || (t.type === 'paragraph_open' && !t.hidden)) {
      t.attrSet('data-line', String(t.map[0] + off));
      if (top) t.attrSet('data-end', String(t.map[1] + off));
    }
  }
}

md.core.ruler.after('block', 'callouts', calloutRule);
md.core.ruler.push('task_lists', taskListRule);
md.core.ruler.push('block_ids', blockIdRule);
md.core.ruler.push('heading_ids', headingRule);
md.core.ruler.push('source_lines', sourceLinesRule);

/** {{variables}}: substitutes after parsing (values can never become markup) and after heading ids
 *  (anchors stay stable across environments). data-vars marks code blocks whose copy / run resolves
 *  placeholders; the raw text comes from the source (fenceAt), not from the page. */
function variablesRule(state: StateCore): void {
  const vars = (state.env as unknown as Env).opts.vars;
  if (!vars) return;
  for (const t of state.tokens) {
    if (t.type === 'fence' || t.type === 'code_block') {
      // Never in a diagram: mermaid draws in the live page, so values would go wherever its labels / styles load from.
      if (!t.content.includes('{{') || fenceWord(t.info ?? '') === 'mermaid') continue;
      t.attrSet('data-vars', '');
      t.content = vars(t.content, t.info ?? '');
    } else if (t.type === 'inline') {
      for (const c of t.children ?? []) if ((c.type === 'text' || c.type === 'code_inline') && c.content.includes('{{')) c.content = vars(c.content, null);
    }
  }
}
md.core.ruler.push('variables', variablesRule);

// ---------------------------------------------------------------- renderers

const R = md.renderer.rules;
const attrs = (t: Token) => md.renderer.renderAttrs(t);

R.softbreak = (_t, _i, _o, env) => ((env as unknown as Env).opts.breaks ? '<br>\n' : '\n');
// Raw HTML from the note: every element it creates is marked, so the sanitizer can strip app classes and
// data-* from it (they drive Copy / Run, embeds, overlays). Marking is textual on purpose: `<` + letter is
// exactly where the HTML tokenizer starts an element; a match inside an attribute value or comment only
// adds a harmless marker there. The app's own markup (se_html) is never marked.
const markUser = (html: string) => html.replace(/<([a-zA-Z][^\t\n\f\r />]*)/g, `<$1 ${USER_MARK}=""`);
R.html_block = (tokens, i) => markUser(tokens[i].content);
R.html_inline = (tokens, i) => markUser(tokens[i].content);
R.se_html = (tokens, i) => tokens[i].content;
R.callout_icon = () => '<span class="se-callout-icon" aria-hidden="true"></span>';
R.callout_fold = () => '<span class="se-callout-fold" aria-hidden="true"></span>';
R.math_inline = (tokens, i) => `<span class="se-math${tokens[i].meta?.display ? ' se-math-display' : ''}">${esc(tokens[i].content)}</span>`;
R.math_block = (tokens, i) => `<div class="se-math se-math-display"${attrs(tokens[i])}>${esc(tokens[i].content)}</div>\n`;
R.page_break = (tokens, i) => `<div class="se-page-break"${attrs(tokens[i])} aria-hidden="true"></div>\n`;

R.table_open = (tokens, i) => `<div class="se-table-wrap"${attrs(tokens[i])}><table>\n`;
R.table_close = () => '</table></div>\n';

const baseLinkOpen = R.link_open ?? ((tokens, i, o, _e, self) => self.renderToken(tokens, i, o));
R.link_open = (tokens, i, o, env, self) => {
  const href = String(tokens[i].attrGet('href') ?? '');
  if (/^(https?:|mailto:)/i.test(href)) {
    tokens[i].attrJoin('class', 'se-external');
    tokens[i].attrSet('rel', 'noopener noreferrer');
  }
  return baseLinkOpen(tokens, i, o, env, self);
};

/** Invisible and direction-changing characters: what is drawn differs from what Copy / Run hand out. */
const HIDDEN_CHARS = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

const fenceWord = (info: string) => (info.trim().split(/[\s{]/)[0] ?? '').toLowerCase();

function codeBlock(code: string, info: string, tokenAttrs: string, remote = false): string {
  const word = info.trim().split(/[\s{]/)[0] ?? '';
  const lang = languageForFence(info);
  if (word.toLowerCase() === 'mermaid') {
    // Mermaid draws in the live page: data-remote = the note may load remote media (./enhance draws with it).
    // Without it, a diagram that would load anything is not drawn and counts as blocked media (the "Load" bar).
    const blocked = !remote && mermaidFetches(code);
    return `<div class="se-mermaid${blocked ? ' se-remote-blocked' : ''}"${remote ? ' data-remote=""' : ''}${tokenAttrs}><pre class="se-mermaid-src"><code>${esc(code)}</code></pre></div>\n`;
  }
  if (word.toLowerCase() === 'math') return `<div class="se-math se-math-display"${tokenAttrs}>${esc(code.trim())}</div>\n`;
  const title = /\btitle=(?:"([^"]+)"|(\S+))/.exec(info);
  const numbers = /(?:^|[\s{,])(showLineNumbers|linenos|numbers)(?:[\s},]|$)/i.test(info);
  const label = [title?.[1] ?? title?.[2], lang?.name ?? word].filter(Boolean).join(' · ');
  return (
    `<div class="se-code${numbers ? ' se-code-numbers' : ''}" data-lang="${esc(lang?.shiki ?? '')}"${word ? ` data-fence="${esc(word.toLowerCase())}"` : ''}${tokenAttrs}>` +
    `<div class="se-code-tools">${label ? `<span class="se-code-lang">${esc(label)}</span>` : ''}` +
    (HIDDEN_CHARS.test(code) ? '<span class="se-code-warn" title="Contains invisible or text-direction characters: the copied text differs from what you see">hidden characters</span>' : '') +
    `<button class="se-code-copy" type="button" aria-label="Copy code" title="Copy code"></button></div>` +
    `<pre><code${word ? ` class="language-${esc(word.toLowerCase())}"` : ''}>${esc(code)}</code></pre></div>\n`
  );
}
// data-src-line: where the block starts in the rendered source — Copy / Run read the text from there (fenceAt).
const srcLine = (t: Token) => (t.map ? ` data-src-line="${t.map[0]}"` : '');
R.fence = (tokens, i, _o, env) => codeBlock(tokens[i].content, tokens[i].info, attrs(tokens[i]) + srcLine(tokens[i]), !!(env as unknown as Env).opts?.remote);
R.code_block = (tokens, i) => codeBlock(tokens[i].content, '', attrs(tokens[i]) + srcLine(tokens[i]));

R.embed = (tokens, i, _o, e) => {
  const env = e as unknown as Env;
  const { link, resolved, frag, display } = tokens[i].meta as { link: ReturnType<typeof parseWikiLink>; resolved: string | null | undefined; frag: string; display: string };
  const ext = extname(resolved ?? link.target);
  const url = resolved ? relativeUrl(env.opts.path, resolved) : encodeURI(link.target);
  const ws = resolved ? ` data-ws-src="${esc(resolved)}"` : '';
  if (IMAGE_EXT.has(ext)) {
    // Obsidian: ![[img.png|200]] or |200x100 sets the size; anything else is alt text.
    const size = /^(\d+)(?:x(\d+))?$/.exec(link.alias ?? '');
    const dims = size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ''}` : '';
    return `<img class="se-embed-img${resolved === null ? ' is-unresolved' : ''}" src="${esc(url)}"${ws} alt="${esc(size ? link.target : link.alias || link.target)}"${dims} loading="lazy">`;
  }
  if (resolved && AUDIO_EXT.has(ext)) return `<audio class="se-embed-media" controls preload="metadata" src="${esc(url)}"${ws}></audio>`;
  if (resolved && VIDEO_EXT.has(ext)) return `<video class="se-embed-media" controls preload="metadata" src="${esc(url)}"${ws}></video>`;
  // Note/file transclusion: the controller fills this placeholder asynchronously.
  return (
    `<span class="se-embed${resolved === null ? ' is-unresolved' : ''}" data-embed="${esc(link.target)}"${frag ? ` data-embed-frag="${esc(frag.slice(1))}"` : ''}${resolved ? ` data-path="${esc(resolved)}"` : ''}>` +
    `<a class="se-wikilink${resolved === null ? ' is-unresolved' : ''}" href="${resolved ? esc(url + encodeURI(frag)) : '#'}" data-wikilink="${esc(link.target + frag)}"${resolved ? ` data-path="${esc(resolved)}"` : ''}>${esc(display)}</a></span>`
  );
};

// ---- frontmatter → compact properties table

type FmValue = string | string[];
function unquote(v: string): string {
  const t = v.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}
/** Small YAML subset (scalars, inline + block lists, folded text). Returns null when the block is something else. */
export function parseFrontmatter(raw: string): Array<[string, FmValue]> | null {
  const out: Array<[string, FmValue]> = [];
  let cur: [string, FmValue] | null = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = /^([^\s:#-][^:]*?)\s*:(?:\s+(.*)|\s*)$/.exec(line);
    if (m) {
      const v = (m[2] ?? '').trim();
      if (/^\[.*\]$/.test(v)) cur = [m[1], v.slice(1, -1).split(',').map(unquote).filter(Boolean)];
      else if (v === '' || v === '|' || v === '>' || v === '|-' || v === '>-') cur = [m[1], ''];
      else cur = [m[1], unquote(v)];
      out.push(cur);
      continue;
    }
    if (!cur) return null;
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li) {
      if (!Array.isArray(cur[1])) cur[1] = cur[1] ? [cur[1]] : [];
      cur[1].push(unquote(li[1]));
    } else if (/^\s+\S/.test(line) && !Array.isArray(cur[1])) cur[1] = cur[1] ? `${cur[1]}\n${line.trim()}` : line.trim();
    else return null;
  }
  return out;
}

function fmValue(key: string, v: FmValue): string {
  const k = key.toLowerCase();
  const isTags = k === 'tags' || k === 'tag';
  const list = Array.isArray(v) ? v : isTags ? v.split(/[\s,]+/).filter(Boolean) : null;
  if (list) {
    return list.map((x) => (isTags ? `<span class="se-tag" data-tag="${esc(x.replace(/^#/, ''))}">#${esc(x.replace(/^#/, ''))}</span>` : `<span class="se-pill">${esc(x)}</span>`)).join(' ');
  }
  const s = v as string;
  if (/^https?:\/\/\S+$/.test(s)) return `<a class="se-external" href="${esc(s)}" rel="noopener noreferrer">${esc(s)}</a>`;
  if (s === 'true' || s === 'false') return `<input type="checkbox" disabled${s === 'true' ? ' checked' : ''}>`;
  return esc(s).replace(/\n/g, '<br>');
}

R.frontmatter = (tokens, i) => {
  const t = tokens[i];
  const props = parseFrontmatter(t.content);
  if (!props) return `<div class="se-frontmatter"${attrs(t)}><pre class="se-frontmatter-raw">${esc(t.content.trimEnd())}</pre></div>\n`;
  if (!props.length) return '';
  const rows = props.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${fmValue(k, v)}</td></tr>`).join('');
  return `<div class="se-frontmatter"${attrs(t)}><table><tbody>${rows}</tbody></table></div>\n`;
};

// ---------------------------------------------------------------- public API

function toHtml(src: string, opts: RenderOptions): string {
  const env: Env = { opts, slugs: new Map() };
  return md.render(src, env as unknown as Parameters<typeof md.render>[1]);
}
const ctx = (opts: RenderOptions): SanitizeContext => ({ path: opts.path, files: opts.files, resolveUrl: opts.resolveUrl, remote: opts.remote });

/** Pure render: markdown → sanitized HTML string. */
export function renderMarkdown(src: string, opts: RenderOptions = {}): string {
  return sanitizeHtml(toHtml(src, opts), ctx(opts));
}

/** Same pipeline, but returns live DOM nodes (skips a serialize + reparse round trip). */
export function renderFragment(src: string, opts: RenderOptions = {}): DocumentFragment {
  return sanitizeToFragment(toHtml(src, opts), ctx(opts));
}

/**
 * The code block starting on `line` of `src` (what render*() got), as the source says it: raw text
 * (placeholders unresolved) + fence info. Copy / Run use this, never the page — a note's raw HTML must not
 * be able to make a button copy or run something other than what is drawn.
 */
export function fenceAt(src: string, line: number, opts: Pick<RenderOptions, 'frontmatter'> = {}): { code: string; info: string } | null {
  const env: Env = { opts: { ...opts, sourceLines: false }, slugs: new Map() };
  for (const t of md.parse(src, env as unknown as Parameters<typeof md.parse>[1])) {
    if ((t.type === 'fence' || t.type === 'code_block') && t.map?.[0] === line) return { code: t.content.replace(/\n$/, ''), info: t.info ?? '' };
  }
  return null;
}

/** Renders a non-markdown file (e.g. `![[app.ts]]`) as a highlighted code block. */
export function renderCodeFile(path: string, content: string): string {
  const lang = languageForPath(path);
  return sanitizeHtml(codeBlock(content, lang?.aliases[0] ?? lang?.id ?? '', ''), {});
}

export { resolveLocalPath } from './sanitize';
