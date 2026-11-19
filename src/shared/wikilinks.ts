// Obsidian-compatible wikilink parsing + resolution against a plain file list (no vault index needed).
// [[Note]], [[Note|Alias]], [[Note#Heading]], [[Note#^block]], [[folder/Note]], ![[image.png]]
import { basename, dirname, isMarkdown, normalize, stem } from './paths';

export interface WikiLink {
  target: string; // "folder/Note" (no #, no |)
  heading?: string;
  block?: string;
  alias?: string;
  embed: boolean;
}

/** Index of the alias separator: the first `|`, or the `\|` escape used inside table cells. */
function pipeIndex(s: string): { at: number; width: number } | null {
  const i = s.indexOf('|');
  if (i === -1) return null;
  return i > 0 && s[i - 1] === '\\' ? { at: i - 1, width: 2 } : { at: i, width: 1 };
}

export function parseWikiLink(inner: string, embed = false): WikiLink {
  let rest = inner;
  let alias: string | undefined;
  const pipe = pipeIndex(rest);
  if (pipe) {
    alias = rest.slice(pipe.at + pipe.width).trim();
    rest = rest.slice(0, pipe.at);
  }
  let heading: string | undefined;
  let block: string | undefined;
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    const frag = rest.slice(hash + 1).trim();
    rest = rest.slice(0, hash);
    if (frag.startsWith('^')) block = frag.slice(1);
    else heading = frag;
  }
  return { target: rest.trim(), heading, block, alias, embed };
}

/**
 * Offsets (relative to the start of `inner`) of the target part of a wikilink body, i.e. what
 * a rename has to replace — surrounding whitespace, `#fragment` and `|alias` are excluded.
 */
export function wikiTargetSpan(inner: string): { from: number; to: number } {
  let end = inner.length;
  const pipe = pipeIndex(inner);
  if (pipe) end = pipe.at;
  const hash = inner.indexOf('#');
  if (hash !== -1 && hash < end) end = hash;
  let from = 0;
  while (from < end && /\s/.test(inner[from])) from++;
  while (end > from && /\s/.test(inner[end - 1])) end--;
  return { from, to: end };
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

/** All wikilinks in a markdown string (ignores fenced code is the caller's job if needed). */
export function findWikiLinks(text: string): Array<WikiLink & { index: number; length: number }> {
  const out: Array<WikiLink & { index: number; length: number }> = [];
  for (const m of text.matchAll(WIKI_RE)) out.push({ ...parseWikiLink(m[2], m[1] === '!'), index: m.index!, length: m[0].length });
  return out;
}

export type LinkResolver = (target: string, fromPath?: string) => string | null;
/**
 * A resolver whose file list can change in place (O(1)-ish per file instead of rebuilding over every
 * file). Applying the same adds / removes in the same order gives exactly what a fresh resolver over
 * the resulting list (in that order) gives — case twins included (the first spelling owns the path).
 */
export type MutableLinkResolver = LinkResolver & { addFile(path: string): void; removeFile(path: string): void };

const depthThenLength = (a: string, b: string) => a.split('/').length - b.split('/').length || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * Pre-indexes a file list so each lookup is O(1)-ish instead of a scan (matters for 5k+ notes).
 * Order: exact workspace path → path relative to the linking note → same folder → shortest path whose
 * trailing segments / basename (with or without .md) match, case-insensitively → alias (if provided).
 */
export function createLinkResolver(files: readonly string[], aliases?: ReadonlyMap<string, readonly string[]>): MutableLinkResolver {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>(); // lower basename, and lower stem for markdown files
  const add = (key: string, f: string) => {
    const l = byName.get(key);
    if (l) l.push(f);
    else byName.set(key, [f]);
  };
  // "Note.md" and "note.md" can both exist (Linux, WSL): spellings byPath does not return, so the exact
  // one can still win over the case-folded hit.
  const twins = new Set<string>();
  for (const f of files) {
    const fl = f.toLowerCase();
    const had = byPath.get(fl);
    if (had === undefined) byPath.set(fl, f);
    else if (had !== f) twins.add(f);
    const b = basename(fl);
    add(b, f);
    if (isMarkdown(f)) add(stem(fl), f);
  }
  const anyCase = (p: string, l: string, md: boolean): string | undefined => {
    const hit = byPath.get(l);
    if (hit !== undefined) return hit === p || !twins.has(p) ? hit : p;
    const hitMd = md ? byPath.get(`${l}.md`) : undefined;
    if (hitMd === undefined) return undefined;
    return hitMd === `${p}.md` || !twins.has(`${p}.md`) ? hitMd : `${p}.md`;
  };
  const sameCase = (cands: readonly string[], t: string, bare: boolean) => {
    if (cands.length < 2) return cands;
    const hits = cands.filter((f) => (bare ? basename(f) === t || (isMarkdown(f) && stem(f) === t) : f.endsWith(`/${t}`) || f.endsWith(`/${t}.md`)));
    return hits.length ? hits : cands;
  };
  const pick = (cands: readonly string[], fromPath?: string): string | null => {
    if (!cands.length) return null;
    if (cands.length === 1) return cands[0];
    // Sorted first so ties never depend on file-list order.
    const sorted = [...cands].sort(depthThenLength);
    if (fromPath) {
      const dir = dirname(fromPath).toLowerCase();
      const same = sorted.find((c) => dirname(c).toLowerCase() === dir);
      if (same) return same;
    }
    return sorted[0];
  };
  // Hits that don't depend on the linking note (exact path / unique name) — most links in practice.
  const memo = new Map<string, string>();
  const resolve = ((target: string, fromPath?: string): string | null => {
    if (!target) return fromPath ?? null;
    const cached = memo.get(target);
    if (cached !== undefined) return cached;
    const t = normalize(target);
    if (!t) return null;
    const lower = t.toLowerCase();
    const withMd = /\.[a-z0-9]+$/i.test(t) ? null : `${lower}.md`;
    const dotRelative = /^\s*\.\.?[\\/]/.test(target);
    if (dotRelative && fromPath !== undefined) {
      // Explicit ./ or ../ means "relative to this note" — must win over a same-named root path.
      const rel = normalize(`${dirname(fromPath)}/${target.trim()}`);
      const hit = anyCase(rel, rel.toLowerCase(), !!withMd);
      if (hit) return hit;
    }
    const exact = anyCase(t, lower, !!withMd);
    if (exact) {
      if (dotRelative) return exact;
      memo.set(target, exact);
      return exact;
    }
    const slash = lower.lastIndexOf('/');
    if (slash !== -1 || dotRelative) {
      // Path-like: try relative to the linking note, then any file whose path ends with it.
      if (fromPath !== undefined) {
        const rel = normalize(`${dirname(fromPath)}/${target}`);
        const hit = anyCase(rel, rel.toLowerCase(), !!withMd);
        if (hit) return hit;
      }
      const last = lower.slice(slash + 1);
      const pool = [...(byName.get(last) ?? [])];
      if (withMd) for (const f of byName.get(`${last}.md`) ?? []) if (!pool.includes(f)) pool.push(f);
      const cands = pool.filter((f) => {
        const fl = f.toLowerCase();
        return fl.endsWith(`/${lower}`) || (!!withMd && fl.endsWith(`/${withMd}`));
      });
      const hit = pick(sameCase(cands, t, false), fromPath);
      if (hit) return hit;
    } else {
      const cands = byName.get(lower);
      if (cands?.length === 1) memo.set(target, cands[0]);
      const hit = pick(sameCase(cands ?? [], t, true), fromPath);
      if (hit) return hit;
    }
    const al = aliases?.get(target.trim().toLowerCase());
    return al ? pick(al, fromPath) : null;
  }) as MutableLinkResolver;
  const drop = (key: string, f: string) => {
    const l = byName.get(key);
    const i = l ? l.indexOf(f) : -1;
    if (i === -1) return;
    l!.splice(i, 1);
    if (!l!.length) byName.delete(key);
  };
  resolve.addFile = (f) => {
    memo.clear();
    const fl = f.toLowerCase();
    const had = byPath.get(fl);
    if (had === undefined) byPath.set(fl, f);
    else if (had !== f) twins.add(f);
    add(basename(fl), f);
    if (isMarkdown(f)) add(stem(fl), f);
  };
  resolve.removeFile = (f) => {
    memo.clear();
    const fl = f.toLowerCase();
    if (byPath.get(fl) === f) {
      // The next spelling in list order takes the path over (as a fresh build would pick it).
      let next: string | undefined;
      for (const t of twins)
        if (t.toLowerCase() === fl) {
          next = t;
          break;
        }
      if (next === undefined) byPath.delete(fl);
      else {
        byPath.set(fl, next);
        twins.delete(next);
      }
    } else twins.delete(f);
    drop(basename(fl), f);
    if (isMarkdown(f)) drop(stem(fl), f);
  };
  return resolve;
}

// resolveWikiTarget is called per link by the editor/preview; cache the lookup tables per file-list
// identity (length guards against in-place mutation) so callers don't pay an O(files) scan each time.
const resolverCache = new WeakMap<readonly string[], { size: number; resolve: LinkResolver }>();

/**
 * Resolve a link target to a workspace path. Order: exact relative path → same folder → shortest
 * path whose basename (without .md) matches, case-insensitively. Returns null if unresolved.
 */
export function resolveWikiTarget(target: string, files: readonly string[], fromPath?: string): string | null {
  let c = resolverCache.get(files);
  if (!c || c.size !== files.length) {
    c = { size: files.length, resolve: createLinkResolver(files) };
    resolverCache.set(files, c);
  }
  return c.resolve(target, fromPath);
}
