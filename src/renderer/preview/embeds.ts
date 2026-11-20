// Note transclusion: `![[Other note]]`, `![[Other note#Section]]`, `![[Other note#^block]]`, `![[code.ts]]`.
// The renderer emits `span.se-embed` placeholders; this fills them asynchronously, recursively,
// with cycle detection and a depth limit.
import { isMarkdown } from '@shared/paths';
import { slugify } from './markdown';
import { isPdfPath, pageFromFragment } from '../pdf/model';

export interface EmbedContext {
  /** Text of a workspace file, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Sanitized HTML for a note (or note fragment) living at `path`; `host` = the note showing it. */
  render(src: string, path: string, host?: string): string;
  /** Sanitized HTML for a non-markdown text file. */
  renderFile(path: string, src: string): string;
  maxDepth?: number;
}

const TEXT_LIMIT = 400_000;

/** What each embed body was rendered from: Copy / Run of a code block in it read that text (fenceAt). */
export interface EmbedSource {
  path: string;
  text: string;
  /** A non-markdown file shown whole as one code block. */
  file: boolean;
}
const sources = new WeakMap<Element, EmbedSource>();
export const embedSourceOf = (body: Element): EmbedSource | null => sources.get(body) ?? null;
const BINARY_RE = /\.(pdf|zip|gz|7z|exe|dll|docx?|xlsx?|pptx?|woff2?|ttf|otf)$/i;

export function stripFrontmatter(src: string): string {
  return src.replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, '');
}

/** The part of a note addressed by `#Heading` or `#^block-id`; null when it does not exist. */
export function extractSection(src: string, frag: string): string | null {
  const lines = src.split('\n');
  if (frag.startsWith('^')) {
    const id = frag.slice(1).toLowerCase();
    const at = lines.findIndex((l) => new RegExp(`(?:^|\\s)\\^${id.replace(/[^\w-]/g, '')}\\s*$`, 'i').test(l));
    if (at === -1) return null;
    let from = at;
    let to = at;
    while (from > 0 && lines[from - 1].trim()) from--;
    while (to + 1 < lines.length && lines[to + 1].trim()) to++;
    return lines.slice(from, to + 1).join('\n');
  }
  const want = slugify(frag);
  let fence: string | null = null;
  let from = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const h = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i]);
    if (!h) continue;
    if (from === -1) {
      if (slugify(h[2].replace(/[*_`=~[\]]/g, '')) === want) {
        from = i;
        level = h[1].length;
      }
    } else if (h[1].length <= level) return lines.slice(from, i).join('\n');
  }
  return from === -1 ? null : lines.slice(from).join('\n');
}

/** Fills every not-yet-expanded embed under `root`. `stack` = chain of notes being rendered (cycle guard). */
export async function expandEmbeds(root: ParentNode, ctx: EmbedContext, stack: readonly string[]): Promise<void> {
  const max = ctx.maxDepth ?? 4;
  const jobs: Promise<void>[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('.se-embed[data-embed]:not([data-done])')) {
    el.dataset.done = '1';
    const path = el.dataset.path;
    if (!path) continue; // unresolved: stays a (differently styled) link
    if (stack.includes(path) || stack.length > max) {
      el.classList.add('is-cycle');
      el.title = stack.includes(path) ? 'Not embedded: this note is already being shown (cycle)' : 'Not embedded: too deeply nested';
      continue;
    }
    jobs.push(
      (async () => {
        const frag = el.dataset.embedFrag;
        let html: string;
        let text: string;
        if (isPdfPath(path)) return pdfCard(el, path, frag);
        if (BINARY_RE.test(path)) return;
        const src = await ctx.read(path);
        if (src === null) {
          el.classList.add('is-unresolved');
          return;
        }
        if (isMarkdown(path)) {
          const part = frag ? extractSection(src, frag) : stripFrontmatter(src);
          if (part === null) {
            el.classList.add('is-missing-section');
            el.title = `"${frag}" was not found in ${path}`;
            return;
          }
          text = part.replace(/(^|\s)\^[\w-]+[ \t]*$/gm, '');
          html = ctx.render(text, path, stack[0]);
        } else {
          text = src.length > TEXT_LIMIT ? src.slice(0, TEXT_LIMIT) : src;
          html = ctx.renderFile(path, text);
        }
        const link = el.querySelector(':scope > a') ?? el.querySelector('.se-embed-title > a');
        const title = document.createElement('span');
        title.className = 'se-embed-title';
        if (link) title.append(link);
        const body = document.createElement('span');
        body.className = 'se-embed-body';
        body.innerHTML = html; // already sanitized by ctx.render
        sources.set(body, { path, text, file: !isMarkdown(path) });
        el.replaceChildren(title, body);
        el.classList.add('is-loaded');
        await expandEmbeds(body, ctx, [...stack, path]);
      })().catch((err) => console.warn('[preview] embed failed', path, err)),
    );
  }
  await Promise.all(jobs);
}

/** `![[doc.pdf]]` / `![[doc.pdf#page=3]]`: a compact card; its link opens the PDF viewer (at that page). */
function pdfCard(el: HTMLElement, path: string, frag: string | undefined): void {
  const link = el.querySelector<HTMLAnchorElement>(':scope > a');
  if (!link) return;
  const page = pageFromFragment(frag);
  const name = document.createElement('span');
  name.className = 'se-embed-pdf-name';
  name.textContent = path.slice(path.lastIndexOf('/') + 1);
  const meta = document.createElement('span');
  meta.className = 'se-embed-pdf-meta';
  meta.textContent = page ? `PDF · page ${page}` : 'PDF';
  const badge = document.createElement('span');
  badge.className = 'se-embed-pdf-icon';
  badge.textContent = 'PDF';
  const text = document.createElement('span');
  text.className = 'se-embed-pdf-text';
  text.append(name, meta);
  link.replaceChildren(badge, text);
  link.classList.add('se-embed-pdf-card');
  link.title = `Open ${path}${page ? ` at page ${page}` : ''}`;
  el.classList.add('se-embed-pdf', 'is-loaded');
}

/** Puts loaded embeds of `path` back into placeholder state so the next expandEmbeds() refreshes them. */
export function invalidateEmbeds(root: ParentNode, path: string): boolean {
  let any = false;
  for (const el of root.querySelectorAll<HTMLElement>('.se-embed[data-done]')) {
    if (el.parentElement?.closest('.se-embed')) continue; // nested ones are rebuilt with their host
    if (el.dataset.path !== path && ![...el.querySelectorAll<HTMLElement>('.se-embed[data-path]')].some((n) => n.dataset.path === path)) continue;
    delete el.dataset.done;
    any = true;
  }
  return any;
}
