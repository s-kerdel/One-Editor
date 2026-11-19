// Link refactoring after a file/folder rename. Pure: text in → minimal edits out.
// Only the part of a link that names the file is touched; aliases, #fragments, titles and
// whitespace are preserved, and links that still resolve correctly as written are left alone.
import { createLinkResolver, wikiTargetSpan, type LinkResolver } from '@shared/wikilinks';
import { basename, dirname, extname, isMarkdown, normalize, stem } from '@shared/paths';
import { decodeTarget, scanLines } from './extract';

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[((?:[^\[\]\\]|\\.)*)\]\(\s*(?:<([^<>\n]*)>|((?:[^()\s\\]|\\.|\([^()\s]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/dg;
const REF_DEF_RE = /^( {0,3}\[[^\]\n]+\]:\s*)(?:<([^<>\n]*)>|(\S+))/d;
const SCHEME_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function relativePath(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split('/') : [];
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

function encodeDest(p: string): string {
  return encodeURI(p).replace(/[()#?]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

const stripMd = (p: string) => (isMarkdown(p) ? p.slice(0, p.length - extname(p).length) : p);

/**
 * Shortest wikilink text that resolves to `target` from `fromFile`: bare name when unambiguous,
 * else the full workspace path. Markdown extensions are omitted unless `keepExt`.
 */
export function wikiLinkTextFor(target: string, fromFile: string, resolve: LinkResolver, opts: { preferPath?: boolean; keepExt?: boolean } = {}): string {
  const ext = opts.keepExt && isMarkdown(target) ? target.slice(target.length - extname(target).length) : '';
  const full = stripMd(target) + ext;
  if (!opts.preferPath) {
    const bare = (isMarkdown(target) ? stem(target) : basename(target)) + ext;
    if (resolve(bare, fromFile) === target) return bare;
  }
  return full;
}

export interface RenameRewriter {
  /** Edits for one file. `filePath` is the file's path AFTER the rename. */
  edits(text: string, filePath: string): TextEdit[];
}

export function createRenameRewriter(renames: ReadonlyMap<string, string>, allFiles: Iterable<string>): RenameRewriter {
  // Accept the file list from before or after the rename: normalise to both views.
  const before = new Set(allFiles);
  const after = new Set(before);
  const inverse = new Map<string, string>();
  for (const [a, b] of renames) {
    before.delete(b);
    after.delete(a);
    inverse.set(b, a);
  }
  for (const [a, b] of renames) {
    before.add(a);
    after.add(b);
  }
  const resolveBefore = createLinkResolver([...before]);
  const resolveAfter = createLinkResolver([...after]);
  const beforeLower = new Map<string, string>();
  for (const f of before) beforeLower.set(f.toLowerCase(), f);

  /** New destination for a markdown link path, or null when it should stay as is. */
  const mdDest = (rawPath: string, angle: boolean, oldFile: string, filePath: string): { dest: string; oldTarget: string; newTarget: string } | null => {
    if (!rawPath || SCHEME_RE.test(rawPath)) return null;
    const decoded = angle ? rawPath : decodeTarget(rawPath);
    const absolute = decoded.startsWith('/');
    const p = absolute ? normalize(decoded) : normalize(`${dirname(oldFile)}/${decoded}`);
    let oldTarget = beforeLower.get(p.toLowerCase());
    let extless = false;
    if (!oldTarget) {
      oldTarget = beforeLower.get(`${p.toLowerCase()}.md`);
      extless = !!oldTarget;
    }
    if (!oldTarget) return null;
    const newTarget = renames.get(oldTarget) ?? oldTarget;
    if (newTarget === oldTarget && oldFile === filePath) return null;
    const want = extless ? stripMd(newTarget) : newTarget;
    // Still correct as written (e.g. both files moved together)?
    const asWritten = absolute ? normalize(decoded) : normalize(`${dirname(filePath)}/${decoded}`);
    if (asWritten === want) return null;
    let rel = absolute ? `/${want}` : relativePath(dirname(filePath), want);
    if (!absolute && decoded.startsWith('./') && !rel.startsWith('../')) rel = `./${rel}`;
    return { dest: angle ? rel : encodeDest(rel), oldTarget, newTarget };
  };

  const splitDest = (raw: string) => {
    const m = /[#?]/.exec(raw);
    return m ? { path: raw.slice(0, m.index), rest: raw.slice(m.index) } : { path: raw, rest: '' };
  };

  return {
    edits(text, filePath) {
      const out: TextEdit[] = [];
      const oldFile = inverse.get(filePath) ?? filePath;
      scanLines(text, (line, _n, kind, masked, offset) => {
        if (kind !== 'text' || line.indexOf('[') === -1) return;

        if (masked.indexOf('[[') !== -1) {
          WIKI_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = WIKI_RE.exec(masked))) {
            const inner = m[2];
            const span = wikiTargetSpan(inner);
            const target = inner.slice(span.from, span.to);
            if (!target) continue;
            const oldTarget = resolveBefore(target, oldFile);
            if (!oldTarget) continue;
            const newTarget = renames.get(oldTarget) ?? oldTarget;
            if (resolveAfter(target, filePath) === newTarget) continue;
            const keepExt = isMarkdown(oldTarget) && target.toLowerCase().endsWith(extname(oldTarget));
            const next = wikiLinkTextFor(newTarget, filePath, resolveAfter, { preferPath: /[\\/]/.test(target), keepExt });
            if (next === target) continue;
            const start = offset + m.index + m[1].length + 2 + span.from;
            out.push({ from: start, to: start + target.length, insert: next });
          }
        }

        if (masked.indexOf('](') !== -1) {
          MD_LINK_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = MD_LINK_RE.exec(masked))) {
            const angle = m[3] !== undefined;
            const idx = (m as any).indices as Array<[number, number] | undefined>;
            const destIdx = idx[angle ? 3 : 4]!;
            const { path, rest } = angle ? { path: m[3], rest: '' } : splitDest(m[4]);
            const r = mdDest(path, angle, oldFile, filePath);
            if (!r) continue;
            // Link text follows the file only when it literally is the file's name.
            const label = m[2];
            if (label && r.newTarget !== r.oldTarget) {
              const nl = label === stem(r.oldTarget) ? stem(r.newTarget) : label === basename(r.oldTarget) ? basename(r.newTarget) : label;
              if (nl !== label) out.push({ from: offset + idx[2]![0], to: offset + idx[2]![1], insert: nl });
            }
            out.push({ from: offset + destIdx[0], to: offset + destIdx[1], insert: r.dest + rest });
          }
        }

        if (masked.indexOf(']:') !== -1) {
          const m = REF_DEF_RE.exec(masked);
          if (m) {
            const angle = m[2] !== undefined;
            const idx = (m as any).indices as Array<[number, number] | undefined>;
            const destIdx = idx[angle ? 2 : 3]!;
            const { path, rest } = angle ? { path: m[2], rest: '' } : splitDest(m[3]);
            const r = mdDest(path, angle, oldFile, filePath);
            if (r) out.push({ from: offset + destIdx[0], to: offset + destIdx[1], insert: r.dest + rest });
          }
        }
      });
      return out.filter((e) => text.slice(e.from, e.to) !== e.insert).sort((a, b) => a.from - b.from);
    },
  };
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = '';
  let pos = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from)) {
    out += text.slice(pos, e.from) + e.insert;
    pos = e.to;
  }
  return out + text.slice(pos);
}

/** Edits for `filePath` (its path after the rename) given one or more old→new file renames. */
export function computeRenameEdits(text: string, renames: ReadonlyMap<string, string>, filePath: string, allFiles: Iterable<string>): TextEdit[] {
  return createRenameRewriter(renames, allFiles).edits(text, filePath);
}

export function rewriteLinksForRenames(text: string, renames: ReadonlyMap<string, string>, filePath: string, allFiles: Iterable<string>): string {
  const edits = computeRenameEdits(text, renames, filePath, allFiles);
  return edits.length ? applyEdits(text, edits) : text;
}

/**
 * Returns `text` (the content of `filePath`) with every link that pointed at `fromPath` now pointing
 * at `toPath`. `allFiles` may be the workspace file list from before or after the rename.
 */
export function rewriteLinksForRename(text: string, fromPath: string, toPath: string, filePath: string, allFiles: Iterable<string>): string {
  return rewriteLinksForRenames(text, new Map([[fromPath, toPath]]), filePath, allFiles);
}
