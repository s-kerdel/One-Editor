// In-memory link index over a plain folder of notes. No persisted metadata: it's rebuilt from file
// contents on open and patched incrementally. Derived structures (resolved links, backlink map,
// tag tree) are recomputed lazily on the first query after a change — cheap, because resolution is
// map-based — so bursts of updates (typing, bulk file events) stay O(changed notes).
import { createLinkResolver, type LinkResolver } from '@shared/wikilinks';
import { dirname, isMarkdown, normalize, stem } from '@shared/paths';
import { extractNote, findTagsInLine, maskUrls, scanLines, type Heading, type LinkRef, type NoteInfo } from './extract';

export * from './extract';
export { rewriteLinksForRename, rewriteLinksForRenames, computeRenameEdits, applyEdits, wikiLinkTextFor, type TextEdit } from './rename';

export interface Snippet {
  /** One line of context, trimmed + truncated. */
  text: string;
  /** Highlight range within `text`. */
  start: number;
  end: number;
}

export interface Backlink {
  from: string;
  line: number;
  col: number;
  length: number;
  link: LinkRef;
  context: Snippet;
}

export interface Mention {
  from: string;
  line: number;
  col: number;
  length: number;
  /** The matched text as written in the source note. */
  text: string;
  context: Snippet;
}

export interface OutgoingLink {
  link: LinkRef;
  /** Resolved workspace path, or null when the target doesn't exist. */
  path: string | null;
}

export interface UnresolvedLink {
  target: string;
  sources: Array<{ from: string; line: number; col: number; length: number }>;
}

export interface TagNode {
  /** Last segment ("project"). */
  name: string;
  /** Full tag without '#' ("tag/project"). */
  tag: string;
  /** Notes carrying this tag or any nested tag. */
  count: number;
  children: TagNode[];
}

export interface KnowledgeApi {
  readonly version: number;
  resolve(target: string, fromPath?: string): string | null;
  backlinks(path: string): Backlink[];
  unlinkedMentions(path: string): Mention[];
  outgoing(path: string): OutgoingLink[];
  unresolvedLinks(): UnresolvedLink[];
  tags(): TagNode[];
  headings(path: string): Heading[];
  notesWithTag(tag: string): string[];
  note(path: string): NoteInfo | undefined;
  notes(): NoteInfo[];
  onChange(cb: () => void): () => void;
}

const SNIPPET_MAX = 160;

export function makeSnippet(line: string, col: number, length: number): Snippet {
  const lead = line.length - line.trimStart().length;
  let text = line.trim();
  let start = Math.max(0, col - lead);
  let end = Math.min(text.length, start + length);
  if (text.length > SNIPPET_MAX) {
    const from = Math.max(0, Math.min(start - 50, text.length - SNIPPET_MAX));
    const to = Math.min(text.length, from + SNIPPET_MAX);
    const pre = from > 0 ? '…' : '';
    text = pre + text.slice(from, to) + (to < text.length ? '…' : '');
    start = start - from + pre.length;
    end = Math.min(text.length, end - from + pre.length);
  }
  return { text, start, end };
}

/** Context snippet of every link (its line, trimmed around the link): backlinks without keeping the text. */
export function linkSnippets(text: string, links: readonly LinkRef[]): Snippet[] {
  if (!links.length) return [];
  const starts: number[] = [0];
  const maxLine = links.reduce((m, l) => Math.max(m, l.line), 0);
  for (let i = text.indexOf('\n'); i !== -1 && starts.length <= maxLine + 1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineAt = (n: number) => {
    const a = starts[n];
    if (a === undefined) return '';
    const b = starts[n + 1];
    return text.slice(a, b === undefined ? text.length : b - 1).replace(/\r$/, '');
  };
  return links.map((l) => makeSnippet(lineAt(l.line), l.col, l.length));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WIKI_RE = /!?\[\[[^\[\]\n]+?\]\]/g;
const MD_LINK_RE = /!?\[(?:[^\[\]\\]|\\.)*\]\([^)\n]*\)/g;
const blank = (s: string) => ' '.repeat(s.length);

interface Derived {
  /** lower-case alias → notes; mutated in place (the resolver reads it live). */
  aliases: Map<string, string[]>;
  resolver: LinkResolver;
  /** Parallel to note.links. */
  resolved: Map<string, Array<string | null>>;
  /** target path → notes linking to it. */
  incoming: Map<string, Set<string>>;
  /** lower-case unresolved target → notes containing it (lets a new alias re-resolve just those). */
  unresolvedBy: Map<string, Set<string>>;
}

export function mentionNamesOf(n: Pick<NoteInfo, 'title' | 'aliases'>): string[] {
  return [...new Set([n.title, ...n.aliases].map((s) => s.trim()).filter((s) => s.length >= 2))].sort((a, b) => b.length - a.length);
}

export interface MentionMatcher {
  re: RegExp;
  lowerNames: string[];
}

export function mentionMatcher(names: string[]): MentionMatcher {
  return { re: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${names.map(escapeRe).join('|')})(?![\\p{L}\\p{N}_])`, 'giu'), lowerNames: names.map((s) => s.toLowerCase()) };
}

export const compareMentions = (a: Mention, b: Mention) => a.from.localeCompare(b.from) || a.line - b.line || a.col - b.col;

/** Unlinked mentions of `m`'s names in one note's text (appended to `out`, up to `limit`). */
export function findMentions(text: string, from: string, m: MentionMatcher, limit: number, out: Mention[]): void {
  const { re, lowerNames } = m;
  // Cheap prefilter: most notes don't mention the name at all.
  re.lastIndex = 0;
  if (!re.test(text)) return;
  scanLines(text, (line, lineNo, kind, masked) => {
    if (kind !== 'text') return;
    const ll = line.toLowerCase();
    if (!lowerNames.some((s) => ll.includes(s))) return;
    let clean = masked;
    if (clean.indexOf('[[') !== -1) clean = clean.replace(WIKI_RE, blank);
    if (clean.indexOf('](') !== -1) clean = clean.replace(MD_LINK_RE, blank);
    clean = maskUrls(clean);
    re.lastIndex = 0;
    let x: RegExpExecArray | null;
    while ((x = re.exec(clean))) {
      out.push({ from, line: lineNo, col: x.index, length: x[0].length, text: x[0], context: makeSnippet(line, x.index, x[0].length) });
      if (out.length >= limit) return false;
    }
  });
}

/** First line (0-based) where `tag` (or a nested tag) occurs in a note's text. */
export function findTagLine(text: string, tag: string): number | null {
  const t = tag.replace(/^#/, '').toLowerCase();
  let found: number | null = null;
  scanLines(text, (_line, lineNo, kind, masked) => {
    if (kind !== 'text') return;
    if (findTagsInLine(masked).some((x) => x.tag.toLowerCase() === t || x.tag.toLowerCase().startsWith(`${t}/`))) {
      found = lineNo;
      return false;
    }
  });
  return found;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** FNV-1a of a note's text: "unchanged?" without keeping the text. */
function textHash(t: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
  return (h ^ t.length) >>> 0;
}

export interface KnowledgeIndexOptions {
  /**
   * Keep every note's text (default). Without it the index holds only metadata + link context
   * snippets — the app's renderer, which gets note metadata from the search workers; full-text
   * features (unlinked mentions, tag lines) then come from those workers.
   */
  retainText?: boolean;
}

export class KnowledgeIndex implements KnowledgeApi {
  private readonly infos = new Map<string, NoteInfo>();
  private readonly texts = new Map<string, string>();
  private readonly snippets = new Map<string, Snippet[]>();
  private readonly hashes = new Map<string, number>();
  private readonly retainText: boolean;
  private fileSet = new Set<string>();
  private derived: Derived | null = null;
  private unresolvedCache: { version: number; list: UnresolvedLink[] } | null = null;
  private tagCache: { version: number; map: Map<string, { tag: string; notes: Set<string> }> } | null = null;
  private readonly listeners = new Set<() => void>();
  version = 0;

  constructor(opts: KnowledgeIndexOptions = {}) {
    this.retainText = opts.retainText !== false;
  }

  // ---------- mutation ----------

  /** All workspace files (any type) — attachments resolve too. Note contents are untouched. */
  setFiles(paths: Iterable<string>): void {
    const next = new Set(paths);
    // Indexed notes are files by definition, even if the tree hasn't caught up yet.
    for (const p of this.infos.keys()) next.add(p);
    if (next.size === this.fileSet.size && [...next].every((p) => this.fileSet.has(p))) return;
    this.fileSet = next;
    this.derived = null;
    this.touch();
  }

  /** Drops notes that no longer exist (after a tree refresh). */
  prune(existing: Iterable<string>): void {
    const keep = new Set(existing);
    let changed = false;
    for (const p of [...this.infos.keys()])
      if (!keep.has(p)) {
        this.infos.delete(p);
        this.texts.delete(p);
        this.snippets.delete(p);
        this.hashes.delete(p);
        this.fileSet.delete(p);
        changed = true;
      }
    if (changed) {
      this.derived = null;
      this.touch();
    }
  }

  /** Same text as last indexed (without keeping texts: by hash). */
  sameText(path: string, text: string): boolean {
    if (this.retainText) return this.texts.get(path) === text;
    return this.hashes.get(path) === textHash(text) && this.infos.has(path);
  }

  /**
   * Add or re-index a file. Non-markdown files only join the file list. Returns false if unchanged.
   * `info`: metadata already extracted from exactly this text (a worker). `text` may be null when
   * `info` and `snippets` come from a worker that had the text (the search shards).
   */
  update(path: string, text: string | null, info?: NoteInfo, snippets?: Snippet[]): boolean {
    const isNew = !this.fileSet.has(path);
    if (!isMarkdown(path)) {
      if (!isNew) return false;
      this.fileSet.add(path);
      this.derived = null;
      this.touch();
      return true;
    }
    if (text !== null && this.sameText(path, text)) return false;
    const old = this.infos.get(path);
    if (!info) {
      if (text === null) return false;
      info = extractNote(path, text);
    }
    if (text !== null) {
      if (this.retainText) this.texts.set(path, text);
      else this.hashes.set(path, textHash(text));
    } else this.hashes.delete(path);
    this.snippets.set(path, snippets ?? (text !== null ? linkSnippets(text, info.links) : []));
    this.infos.set(path, info);
    this.fileSet.add(path);
    // A new file can change how any link resolves → full re-derive (lazy). Content edits only
    // affect this note's links (plus alias users), so patch in place: typing stays O(note).
    if (isNew) this.derived = null;
    else if (this.derived) this.patch(this.derived, path, old?.aliases ?? [], info.aliases);
    this.touch();
    return true;
  }

  remove(path: string): void {
    const had = this.fileSet.delete(path);
    const hadNote = this.infos.delete(path);
    this.texts.delete(path);
    this.snippets.delete(path);
    this.hashes.delete(path);
    if (had || hadNote) {
      this.derived = null;
      this.touch();
    }
  }

  /** Move a file or a whole folder. Returns the old→new path of every affected file. */
  rename(from: string, to: string): Map<string, string> {
    const moved = new Map<string, string>();
    const prefix = `${from}/`;
    for (const p of this.fileSet) {
      if (p === from) moved.set(p, to);
      else if (p.startsWith(prefix)) moved.set(p, `${to}/${p.slice(prefix.length)}`);
    }
    for (const [a, b] of moved) {
      this.fileSet.delete(a);
      this.fileSet.add(b);
      const text = this.texts.get(a);
      const info = this.infos.get(a);
      const sn = this.snippets.get(a);
      const hash = this.hashes.get(a);
      this.texts.delete(a);
      this.infos.delete(a);
      this.snippets.delete(a);
      this.hashes.delete(a);
      if ((text !== undefined || info) && isMarkdown(b)) {
        if (text !== undefined) this.texts.set(b, text);
        if (hash !== undefined) this.hashes.set(b, hash);
        if (sn) this.snippets.set(b, sn);
        // Extraction depends on the text only (plus path/title): a folder move needn't re-parse every note.
        this.infos.set(b, info ? { ...info, path: b, title: stem(b) } : extractNote(b, text!));
      }
    }
    if (moved.size) {
      this.derived = null;
      this.touch();
    }
    return moved;
  }

  clear(): void {
    this.infos.clear();
    this.texts.clear();
    this.snippets.clear();
    this.hashes.clear();
    this.fileSet = new Set();
    this.derived = null;
    this.touch();
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private touch() {
    this.version++;
    for (const l of this.listeners) l();
  }

  // ---------- accessors ----------

  get size(): number {
    return this.infos.size;
  }
  files(): string[] {
    return [...this.fileSet];
  }
  has(path: string): boolean {
    return this.fileSet.has(path);
  }
  note(path: string): NoteInfo | undefined {
    return this.infos.get(path);
  }
  notes(): NoteInfo[] {
    return [...this.infos.values()];
  }
  text(path: string): string | undefined {
    return this.texts.get(path);
  }
  headings(path: string): Heading[] {
    return this.infos.get(path)?.headings ?? [];
  }

  // ---------- derived ----------

  private d(): Derived {
    if (this.derived) return this.derived;
    const aliases = new Map<string, string[]>();
    for (const n of this.infos.values())
      for (const a of n.aliases) {
        const k = a.toLowerCase();
        const l = aliases.get(k);
        if (l) l.push(n.path);
        else aliases.set(k, [n.path]);
      }
    const d: Derived = { aliases, resolver: createLinkResolver([...this.fileSet], aliases), resolved: new Map(), incoming: new Map(), unresolvedBy: new Map() };
    for (const n of this.infos.values()) this.link(d, n);
    return (this.derived = d);
  }

  private link(d: Derived, n: NoteInfo) {
    const out: Array<string | null> = new Array(n.links.length);
    for (let i = 0; i < n.links.length; i++) {
      const l = n.links[i];
      const r = (out[i] = this.resolveRef(d.resolver, l, n.path));
      const map = r ? d.incoming : d.unresolvedBy;
      const key = r ?? l.target.toLowerCase();
      const set = map.get(key);
      if (set) set.add(n.path);
      else map.set(key, new Set([n.path]));
    }
    d.resolved.set(n.path, out);
  }

  private unlink(d: Derived, path: string, links: readonly LinkRef[] | undefined) {
    const res = d.resolved.get(path);
    if (!res) return;
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r) d.incoming.get(r)?.delete(path);
      else if (links?.[i]) d.unresolvedBy.get(links[i].target.toLowerCase())?.delete(path);
    }
    d.resolved.delete(path);
  }

  private patch(d: Derived, path: string, oldAliases: readonly string[], newAliases: readonly string[]) {
    const affected = new Set<string>();
    if (!sameList(oldAliases, newAliases)) {
      const oldL = oldAliases.map((a) => a.toLowerCase());
      const newL = newAliases.map((a) => a.toLowerCase());
      // Anyone linking here may have done so through a removed alias.
      if (oldL.some((a) => !newL.includes(a))) for (const src of d.incoming.get(path) ?? []) affected.add(src);
      for (const a of oldL) {
        const l = d.aliases.get(a);
        if (!l) continue;
        const i = l.indexOf(path);
        if (i !== -1) l.splice(i, 1);
        if (!l.length) d.aliases.delete(a);
      }
      for (const a of newL) {
        const l = d.aliases.get(a);
        if (!oldL.includes(a)) {
          // A new alias can satisfy dangling links, or compete with another note's same alias.
          for (const src of d.unresolvedBy.get(a) ?? []) affected.add(src);
          for (const other of l ?? []) for (const src of d.incoming.get(other) ?? []) affected.add(src);
        }
        if (l) l.push(path);
        else d.aliases.set(a, [path]);
      }
    }
    // The edited note's own old links must be unlinked by position, but its LinkRefs are already
    // replaced — sweep the unresolved sets instead (rare + small).
    const res = d.resolved.get(path);
    if (res) {
      for (const r of res) if (r) d.incoming.get(r)?.delete(path);
      if (res.includes(null)) for (const set of d.unresolvedBy.values()) set.delete(path);
      d.resolved.delete(path);
    }
    affected.delete(path);
    for (const p of affected) {
      const n = this.infos.get(p);
      if (!n) continue;
      this.unlink(d, p, n.links);
      this.link(d, n);
    }
    const self = this.infos.get(path);
    if (self) this.link(d, self);
  }

  private resolveRef(resolver: LinkResolver, l: LinkRef, from: string): string | null {
    if (l.kind === 'wiki') return l.target ? resolver(l.target, from) : from;
    // Markdown links are plain relative paths (or /root-relative) — no fuzzy name matching.
    const p = l.target.startsWith('/') ? normalize(l.target) : normalize(`${dirname(from)}/${l.target}`);
    const hit = resolver(p);
    // The resolver falls back to basename matching for bare names; only accept exact path hits.
    if (!hit) return null;
    const hl = hit.toLowerCase();
    const pl = p.toLowerCase();
    return hl === pl || hl === `${pl}.md` ? hit : null;
  }

  resolve(target: string, fromPath?: string): string | null {
    const hash = target.indexOf('#');
    const t = (hash === -1 ? target : target.slice(0, hash)).trim();
    if (!t) return fromPath ?? null;
    return this.d().resolver(t, fromPath);
  }

  /** Line (0-based) of a heading or block in a note; headings match loosely like Obsidian. */
  findAnchor(path: string, anchor: { heading?: string; block?: string }): number | null {
    const n = this.infos.get(path);
    if (!n) return null;
    if (anchor.block) return n.blocks.find((b) => b.id.toLowerCase() === anchor.block!.toLowerCase())?.line ?? null;
    if (!anchor.heading) return null;
    return findHeadingLine(n.headings, anchor.heading);
  }

  backlinks(path: string): Backlink[] {
    const d = this.d();
    const sources = d.incoming.get(path);
    if (!sources) return [];
    const out: Backlink[] = [];
    for (const from of sources) {
      if (from === path) continue;
      const links = this.infos.get(from)?.links;
      const res = d.resolved.get(from);
      if (!links || !res) continue;
      const sn = this.snippets.get(from);
      for (let i = 0; i < links.length; i++) {
        if (res[i] !== path) continue;
        const link = links[i];
        out.push({ from, line: link.line, col: link.col, length: link.length, link, context: sn?.[i] ?? { text: '', start: 0, end: 0 } });
      }
    }
    return out.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.col - b.col);
  }

  /** Notes linking to `path` (cheap: no context snippets). */
  backlinkSources(path: string): string[] {
    return [...(this.d().incoming.get(path) ?? [])].filter((p) => p !== path);
  }

  outgoing(path: string): OutgoingLink[] {
    const n = this.infos.get(path);
    if (!n) return [];
    const res = this.d().resolved.get(path) ?? [];
    return n.links.map((link, i) => ({ link, path: res[i] ?? null }));
  }

  unresolvedLinks(): UnresolvedLink[] {
    if (this.unresolvedCache?.version === this.version) return this.unresolvedCache.list;
    const d = this.d();
    const map = new Map<string, UnresolvedLink>();
    const seen = new Set<string>();
    for (const sources of d.unresolvedBy.values())
      for (const from of sources) {
        if (seen.has(from)) continue;
        seen.add(from);
        const links = this.infos.get(from)?.links ?? [];
        const res = d.resolved.get(from) ?? [];
        for (let i = 0; i < links.length; i++) {
          const l = links[i];
          if (res[i] || !l.target) continue;
          const key = l.target.toLowerCase();
          let u = map.get(key);
          if (!u) map.set(key, (u = { target: l.target, sources: [] }));
          u.sources.push({ from, line: l.line, col: l.col, length: l.length });
        }
      }
    const list = [...map.values()].sort((a, b) => b.sources.length - a.sources.length || a.target.localeCompare(b.target));
    for (const u of list) u.sources.sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line || a.col - b.col);
    this.unresolvedCache = { version: this.version, list };
    return list;
  }

  private tagNotes(): Map<string, { tag: string; notes: Set<string> }> {
    if (this.tagCache?.version === this.version) return this.tagCache.map;
    const map = new Map<string, { tag: string; notes: Set<string> }>();
    for (const n of this.infos.values())
      for (const t of n.tags) {
        const key = t.toLowerCase();
        let e = map.get(key);
        if (!e) map.set(key, (e = { tag: t, notes: new Set() }));
        e.notes.add(n.path);
      }
    this.tagCache = { version: this.version, map };
    return map;
  }

  /** Names a note is mentioned by (title + aliases), longest first. */
  mentionNames(path: string): string[] {
    const n = this.infos.get(path);
    return n ? mentionNamesOf(n) : [];
  }

  /** Plain-text occurrences of the note's title/aliases in other notes that aren't already links. */
  unlinkedMentions(path: string, limit = 500): Mention[] {
    const names = this.mentionNames(path);
    if (!names.length) return [];
    const m = mentionMatcher(names);
    const out: Mention[] = [];
    for (const [from, text] of this.texts) {
      if (from === path) continue;
      findMentions(text, from, m, limit, out);
      if (out.length >= limit) break;
    }
    return out.sort(compareMentions);
  }

  tags(): TagNode[] {
    const roots: TagNode[] = [];
    const nodes = new Map<string, TagNode & { set: Set<string> }>();
    const ensure = (full: string): TagNode & { set: Set<string> } => {
      const key = full.toLowerCase();
      let node = nodes.get(key);
      if (node) return node;
      const slash = full.lastIndexOf('/');
      node = { name: slash === -1 ? full : full.slice(slash + 1), tag: full, count: 0, children: [], set: new Set() };
      nodes.set(key, node);
      if (slash === -1) roots.push(node);
      else ensure(full.slice(0, slash)).children.push(node);
      return node;
    };
    for (const { tag, notes } of this.tagNotes().values()) {
      const parts = tag.split('/');
      // A note tagged a/b also counts for a.
      for (let i = 1; i <= parts.length; i++) {
        const node = ensure(parts.slice(0, i).join('/'));
        for (const p of notes) node.set.add(p);
      }
    }
    const finish = (list: TagNode[]): TagNode[] =>
      list
        .map((n) => ({ name: n.name, tag: n.tag, count: (n as TagNode & { set: Set<string> }).set.size, children: finish(n.children) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    return finish(roots);
  }

  /** Notes tagged `tag` or a nested tag (`project` matches `project/x`). Leading '#' optional. */
  notesWithTag(tag: string): string[] {
    const t = tag.replace(/^#/, '').toLowerCase();
    const out = new Set<string>();
    for (const [key, { notes }] of this.tagNotes()) if (key === t || key.startsWith(`${t}/`)) for (const p of notes) out.add(p);
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  /** Lines where a tag occurs in a note (for jumping to it). Needs the retained text. */
  tagLine(path: string, tag: string): number | null {
    const text = this.texts.get(path);
    return text === undefined ? null : findTagLine(text, tag);
  }
}

const normHeading = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** `Note#A#B` addresses heading B under A; we match the last segment, preferring one after A. */
export function findHeadingLine(headings: readonly Heading[], heading: string): number | null {
  const parts = heading.split('#').map(normHeading).filter(Boolean);
  if (!parts.length) return null;
  let start = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const idx = headings.findIndex((h, j) => j >= start && normHeading(h.text) === parts[i]);
    if (idx !== -1) start = idx + 1;
  }
  const last = parts[parts.length - 1];
  const hit = headings.find((h, j) => j >= start && normHeading(h.text) === last) ?? headings.find((h) => normHeading(h.text) === last) ?? headings.find((h) => h.slug === heading.trim().toLowerCase());
  return hit ? hit.line : null;
}

export function titleOf(path: string): string {
  return stem(path);
}
