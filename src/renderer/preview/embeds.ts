// Note transclusion: `![[Other note]]`, `![[Other note#Section]]`, `![[Other note#^block]]`, `![[code.ts]]`.
// The renderer emits `span.se-embed` placeholders; this fills them asynchronously, recursively,
// with cycle detection and a depth limit.
import { isMarkdown } from '@shared/paths';
import { slugify } from './markdown';

export interface EmbedContext {
  /** Text of a workspace file, or null when it cannot be read. */
  read(path: string): Promise<string | null>;
  /** Sanitized HTML for a note (or note fragment) living at `path`. */
  render(src: string, path: string): string;
  /** Sanitized HTML for a non-markdown text file. */
  renderFile(path: string, src: string): string;
  maxDepth?: number;
}

const TEXT_LIMIT = 400_000;
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
          html = ctx.render(part.replace(/(^|\s)\^[\w-]+[ \t]*$/gm, ''), path);
        } else {
          html = ctx.renderFile(path, src.length > TEXT_LIMIT ? src.slice(0, TEXT_LIMIT) : src);
        }
        const link = el.querySelector(':scope > a') ?? el.querySelector('.se-embed-title > a');
        const title = document.createElement('span');
        title.className = 'se-embed-title';
        if (link) title.append(link);
        const body = document.createElement('span');
        body.className = 'se-embed-body';
        body.innerHTML = html; // already sanitized by ctx.render
        el.replaceChildren(title, body);
        el.classList.add('is-loaded');
        await expandEmbeds(body, ctx, [...stack, path]);
      })().catch((err) => console.warn('[preview] embed failed', path, err)),
    );
  }
  await Promise.all(jobs);
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
