// In-memory link index over a plain folder of notes. No persisted metadata: it's rebuilt from file
// contents on open and patched incrementally. Derived structures (resolved links, backlink map,
// tag tree) are recomputed lazily on the first query after a change — cheap, because resolution is
// map-based — so bursts of updates (typing, bulk file events) stay O(changed notes).
import { createLinkResolver, type LinkResolver, type MutableLinkResolver } from '@shared/wikilinks';
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
  /** Follows file-set changes in place (applyFileChanges). */
  resolver: MutableLinkResolver;
  /** Parallel to note.links. */
  resolved: Map<string, Array<string | null>>;
  /** target path → notes linking to it. */
  incoming: Map<string, Set<string>>;
  /** lower-case unresolved target → notes containing it (lets a new alias re-resolve just those). */
  unresolvedBy: Map<string, Set<string>>;
  /** Unique notes each note links to (filled on demand, dropped whenever that note is re-linked). */
  outNotes: Map<string, readonly string[]>;
  /**
   * Unresolved links grouped by lower-case target: built on the first unresolved query (a derive does
   * not pay for it), then kept in step by link / unlink / patch (panels read them after every edit).
   */
  groups: Map<string, UGroup> | null;
  /** Unresolved keys per note (with `groups`): dropping a note's entries never sweeps every group. */
  keysOf: Map<string, Set<string>> | null;
  /**
   * Name key (lower-case last path segment, see linkKeys) → notes with a link looked up by it. A new
   * file can only change links the resolver finds by its name: exactly these are re-resolved.
   */
  nameRefs: Map<string, Set<string>>;
  namesOf: Map<string, readonly string[]>;
  /** Time-sliced derive: notes still to link (a snapshot) and the cursor; null when complete. */
  order: string[] | null;
  pos: number;
}

interface FileChanges {
  /** Files that joined since the last apply: links naming them re-resolve. */
  added: Set<string>;
  /** Notes to re-link (their links resolved to a file that left). */
  relink: Set<string>;
  /** Every add / remove in order, replayed on the resolver (twins: the first spelling owns the path). */
  ops: Array<[add: boolean, path: string]>;
}

/** File-set changes above this re-derive (time-sliced) instead of re-resolving link by link. */
const BULK_FILE_CHANGES = 1000;
/** Notes re-linked in place after file changes; more than this re-derives (time-sliced) instead. */
const RELINK_MAX = 300;
/** One time slice of a background derive. */
const DERIVE_SLICE_MS = 8;

/**
 * The name a link is looked up by: the lower-case last segment of its (normalized) target. Bare
 * names, path-like targets and exact / relative paths all end in that segment (normalize() drops
 * leading `..`, so a relative resolution ends in the same segment as the target itself). '' = none.
 */
function linkKey(target: string): string {
  let last = target.slice(target.lastIndexOf('/') + 1);
  if (last === '' || last === '.' || last === '..' || target.includes('\\')) {
    const t = normalize(target);
    last = t.slice(t.lastIndexOf('/') + 1);
  }
  return last.toLowerCase();
}

/**
 * Link keys that can find `path` by name. The resolver's byName holds basenames and note stems and is
 * read under `<name>` and (no extension) `<name>.md`; so a link keyed K can reach `path` iff K is its
 * basename or stem, or one of those minus a trailing `.md`.
 */
function fileKeys(path: string): string[] {
  const lower = path.toLowerCase();
  const b = lower.slice(lower.lastIndexOf('/') + 1);
  const keys = new Set([b]);
  if (isMarkdown(path)) keys.add(stem(lower));
  for (const k of [...keys]) if (k.endsWith('.md')) keys.add(k.slice(0, -3));
  return [...keys];
}

type USource = UnresolvedLink['sources'][number];
interface UGroup {
  /** Sources per note, each with the link text as written. */
  by: Map<string, Array<USource & { text: string }>>;
  n: number;
  /** Display text: as written in the first source (by path, line, col); cached until the group changes. */
  target: string | null;
}

// Same order as String#localeCompare without arguments, much cheaper per call.
const collator = new Intl.Collator();
const cmpSource = (a: USource, b: USource) => collator.compare(a.from, b.from) || a.line - b.line || a.col - b.col;

function addUnresolved(d: Derived, from: string, l: LinkRef, key: string) {
  let g = d.groups!.get(key);
  if (!g) d.groups!.set(key, (g = { by: new Map(), n: 0, target: null }));
  let list = g.by.get(from);
  if (!list) g.by.set(from, (list = []));
  list.push({ from, line: l.line, col: l.col, length: l.length, text: l.target });
  g.n++;
  g.target = null;
  let keys = d.keysOf!.get(from);
  if (!keys) d.keysOf!.set(from, (keys = new Set()));
  keys.add(key);
}

const NO_PATHS: readonly string[] = Object.freeze([]);
const NO_SET: ReadonlySet<string> = new Set();

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
   * Derive link data in time slices instead of all at once on the first query: called with a step
   * function to run (repeatedly, yielding in between) until it returns true. Queries meanwhile see the
   * links derived so far (`deriving` is true); the index notifies its listeners when complete.
   */
  scheduleDerive?: (step: () => boolean) => void;
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
  /** lower-case tag → notes, kept in step with `infos` (a note switch or an edit never rescans all notes). */
  private readonly tagIdx = new Map<string, { tag: string; notes: Set<string> }>();
  /** Bumped whenever tagIdx changes: tags() is cached by it (typing rarely changes a note's tags). */
  private tagVersion = 0;
  private tagsCache: { v: number; tree: TagNode[] } | null = null;
  private readonly listeners = new Set<() => void>();
  version = 0;

  private readonly scheduleDerive?: (step: () => boolean) => void;
  /** File-set changes not yet applied to the derived links (applied on the next query, batched). */
  private fileChanges: FileChanges | null = null;

  constructor(opts: KnowledgeIndexOptions = {}) {
    this.retainText = opts.retainText !== false;
    this.scheduleDerive = opts.scheduleDerive;
  }

  // ---------- mutation ----------

  /** All workspace files (any type) — attachments resolve too. Note contents are untouched. */
  setFiles(paths: Iterable<string>): void {
    const next = new Set(paths);
    // Indexed notes are files by definition, even if the tree hasn't caught up yet.
    for (const p of this.infos.keys()) next.add(p);
    if (next.size === this.fileSet.size && [...next].every((p) => this.fileSet.has(p))) return;
    const prev = this.fileSet;
    const added = this.derived ? [...next].filter((p) => !prev.has(p)) : [];
    const removed = this.derived ? [...prev].filter((p) => !next.has(p)) : []; // never notes (kept above)
    if (!this.derived || added.length + removed.length > BULK_FILE_CHANGES) {
      this.fileSet = next;
      this.rederive();
    } else {
      // In place: the set keeps the order the resolver saw files arrive in (case twins depend on it).
      for (const p of removed) prev.delete(p), this.fileRemoved(p);
      for (const p of added) prev.add(p), this.fileAdded(p);
    }
    this.touch();
  }

  /** Drops notes that no longer exist (after a tree refresh). */
  prune(existing: Iterable<string>): void {
    const keep = new Set(existing);
    let changed = false;
    for (const p of [...this.infos.keys()])
      if (!keep.has(p)) {
        const old = this.infos.get(p);
        this.dropInfo(p);
        this.texts.delete(p);
        this.snippets.delete(p);
        this.hashes.delete(p);
        this.fileSet.delete(p);
        this.fileRemoved(p, old);
        changed = true;
      }
    if (changed) this.touch();
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
      this.fileAdded(path);
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
    this.setInfo(path, info);
    this.fileSet.add(path);
    // A new file re-resolves only the links that name it (fileAdded). Content edits only affect this
    // note's links (plus alias users), so patch in place: typing stays O(note).
    if (isNew) this.fileAdded(path);
    else if (this.derived) {
      // Patch resolves with the current file set: apply pending file changes first (unless they re-derive).
      if (!this.fileChanges || this.applyFileChanges(this.derived)) this.patch(this.derived, path, old?.aliases ?? [], info.aliases);
    }
    this.touch();
    return true;
  }

  remove(path: string): void {
    const had = this.fileSet.delete(path);
    const old = this.infos.get(path);
    const hadNote = this.dropInfo(path);
    this.texts.delete(path);
    this.snippets.delete(path);
    this.hashes.delete(path);
    if (had || hadNote) {
      this.fileRemoved(path, old);
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
    const bulk = moved.size > BULK_FILE_CHANGES;
    for (const [a, b] of moved) {
      this.fileSet.delete(a);
      this.fileSet.add(b);
      const text = this.texts.get(a);
      const info = this.infos.get(a);
      if (!bulk) this.fileRemoved(a, info);
      const sn = this.snippets.get(a);
      const hash = this.hashes.get(a);
      this.texts.delete(a);
      this.dropInfo(a);
      this.snippets.delete(a);
      this.hashes.delete(a);
      if ((text !== undefined || info) && isMarkdown(b)) {
        if (text !== undefined) this.texts.set(b, text);
        if (hash !== undefined) this.hashes.set(b, hash);
        if (sn) this.snippets.set(b, sn);
        // Extraction depends on the text only (plus path/title): a folder move needn't re-parse every note.
        this.setInfo(b, info ? { ...info, path: b, title: stem(b) } : extractNote(b, text!));
      }
      if (!bulk) this.fileAdded(b);
    }
    if (bulk) this.rederive();
    if (moved.size) this.touch();
    return moved;
  }

  clear(): void {
    this.infos.clear();
    this.tagIdx.clear();
    this.tagVersion++;
    this.texts.clear();
    this.snippets.clear();
    this.hashes.clear();
    this.fileSet = new Set();
    this.fileChanges = null;
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

  /**
   * The derived link data. Without `scheduleDerive` it is complete on return; with it, a derive in
   * progress is returned as is (partial) — the scheduled steps finish it.
   */
  private d(): Derived {
    let d = this.derived ?? this.startDerive();
    if (this.fileChanges && !this.applyFileChanges(d)) d = this.startDerive();
    if (d.order && !this.scheduleDerive) this.deriveStep(Infinity);
    return d;
  }

  /**
   * Derived data with `path`'s own links resolved — exact even while a time-sliced derive is still
   * running (linking one note is O(its links); the derive skips it later). Incoming links fill in.
   */
  private own(path: string): Derived {
    const d = this.d();
    if (d.order && !d.resolved.has(path)) {
      const n = this.infos.get(path);
      if (n) this.link(d, n);
    }
    return d;
  }

  /** A derive is in progress (time-sliced): link queries see partial results until it completes. */
  get deriving(): boolean {
    return !!this.derived?.order;
  }

  /** Finish a time-sliced derive now (callers that need every link, e.g. before a bulk rewrite). */
  completeDerive(): void {
    this.d();
    this.deriveStep(Infinity);
  }

  /** Start deriving (time-sliced when scheduled) so the first panel open doesn't pay for it. */
  warm(): void {
    this.d();
  }

  /** Link notes for up to `budgetMs`; true when the derive is complete. */
  deriveStep(budgetMs = DERIVE_SLICE_MS): boolean {
    const d = this.derived;
    if (!d?.order) return true;
    if (this.fileChanges && !this.applyFileChanges(d)) {
      this.startDerive(); // too much changed: start over (it schedules its own steps)
      return true;
    }
    const t0 = performance.now();
    const order = d.order;
    while (d.pos < order.length) {
      const n = this.infos.get(order[d.pos++]);
      // Already linked: an edit / new file during the derive linked it with current data.
      if (n && !d.resolved.has(n.path)) this.link(d, n);
      if ((d.pos & 31) === 0 && performance.now() - t0 > budgetMs) return false;
    }
    d.order = null;
    if (this.scheduleDerive) this.touch(); // panels re-read the complete links
    return true;
  }

  private startDerive(): Derived {
    const aliases = new Map<string, string[]>();
    for (const n of this.infos.values())
      for (const a of n.aliases) {
        const k = a.toLowerCase();
        const l = aliases.get(k);
        if (l) l.push(n.path);
        else aliases.set(k, [n.path]);
      }
    const d: Derived = {
      aliases,
      resolver: createLinkResolver([...this.fileSet], aliases),
      resolved: new Map(),
      incoming: new Map(),
      unresolvedBy: new Map(),
      outNotes: new Map(),
      groups: null,
      keysOf: null,
      nameRefs: new Map(),
      namesOf: new Map(),
      order: [...this.infos.keys()],
      pos: 0,
    };
    this.derived = d;
    this.fileChanges = null; // a fresh derive starts from the current file set
    if (this.scheduleDerive) this.scheduleDerive(() => this.derived !== d || this.deriveStep());
    return d;
  }

  /** Drop the derived links: the next query derives again (time-sliced when scheduled). */
  private rederive() {
    this.derived = null;
    this.fileChanges = null;
  }

  /** A file joined the file set: links naming it (and its own, for a note) re-resolve on the next query. */
  private fileAdded(path: string) {
    if (!this.derived) return;
    const c = (this.fileChanges ??= { added: new Set(), relink: new Set(), ops: [] });
    c.added.add(path);
    c.ops.push([true, path]);
    if (c.added.size + c.relink.size > BULK_FILE_CHANGES) this.rederive();
  }

  /**
   * A file left the file set (`old`: its note info, when it was a note). Only links that resolved to
   * it can resolve differently now (removing a candidate the resolver did not pick never changes its
   * pick): they re-resolve on the next query; the note's own links are dropped now.
   */
  private fileRemoved(path: string, old?: NoteInfo) {
    const d = this.derived;
    if (!d) return;
    const c = (this.fileChanges ??= { added: new Set(), relink: new Set(), ops: [] });
    c.added.delete(path);
    c.relink.delete(path);
    c.ops.push([false, path]);
    if (d.resolved.has(path)) this.unlink(d, path, old?.links);
    for (const src of d.incoming.get(path) ?? []) if (src !== path) c.relink.add(src);
    d.incoming.delete(path);
    for (const a of old?.aliases ?? []) {
      const l = d.aliases.get(a.toLowerCase());
      const i = l ? l.indexOf(path) : -1;
      if (i !== -1) l!.splice(i, 1);
      if (l && !l.length) d.aliases.delete(a.toLowerCase());
    }
    if (c.added.size + c.relink.size > BULK_FILE_CHANGES) this.rederive();
  }

  /**
   * Apply batched file-set changes: one resolver rebuild, then re-resolve just the affected notes.
   * False when that is more than RELINK_MAX notes: the derived data was dropped (re-derive instead).
   */
  private applyFileChanges(d: Derived): boolean {
    const c = this.fileChanges!;
    this.fileChanges = null;
    for (const [add, f] of c.ops) (add ? d.resolver.addFile : d.resolver.removeFile)(f);
    const relink = c.relink;
    for (const f of c.added) {
      for (const k of fileKeys(f)) for (const src of d.nameRefs.get(k) ?? []) relink.add(src);
      const n = this.infos.get(f);
      if (n) {
        this.aliasDelta(d, f, [], n.aliases, relink);
        relink.add(f);
      }
    }
    if (relink.size > RELINK_MAX) {
      this.rederive();
      return false;
    }
    for (const p of relink) {
      const n = this.infos.get(p);
      if (!n) continue;
      if (d.resolved.has(p)) this.unlink(d, p, n.links);
      this.link(d, n);
    }
    return true;
  }

  private link(d: Derived, n: NoteInfo) {
    d.outNotes.delete(n.path);
    const out: Array<string | null> = new Array(n.links.length);
    for (let i = 0; i < n.links.length; i++) {
      const l = n.links[i];
      const r = (out[i] = this.resolveRef(d.resolver, l, n.path));
      const map = r ? d.incoming : d.unresolvedBy;
      const key = r ?? l.target.toLowerCase();
      const set = map.get(key);
      if (set) set.add(n.path);
      else map.set(key, new Set([n.path]));
      if (!r && l.target && d.groups) addUnresolved(d, n.path, l, key);
    }
    d.resolved.set(n.path, out);
    let names: string[] | null = null;
    for (const l of n.links) {
      const k = l.target ? linkKey(l.target) : '';
      if (!k) continue;
      let set = d.nameRefs.get(k);
      if (!set) d.nameRefs.set(k, (set = new Set()));
      if (set.has(n.path)) continue;
      set.add(n.path);
      (names ??= []).push(k);
    }
    if (names) d.namesOf.set(n.path, names);
  }

  private unindexNames(d: Derived, path: string) {
    const keys = d.namesOf.get(path);
    if (!keys) return;
    for (const k of keys) {
      const set = d.nameRefs.get(k);
      if (!set) continue;
      set.delete(path);
      if (!set.size) d.nameRefs.delete(k);
    }
    d.namesOf.delete(path);
  }

  /** The unresolved groups, built from the derived links on first use. */
  private groupsOf(d: Derived): Map<string, UGroup> {
    if (d.groups) return d.groups;
    d.groups = new Map();
    d.keysOf = new Map();
    for (const n of this.infos.values()) {
      const res = d.resolved.get(n.path);
      if (!res) continue;
      for (let i = 0; i < n.links.length; i++) {
        const l = n.links[i];
        if (!res[i] && l.target) addUnresolved(d, n.path, l, l.target.toLowerCase());
      }
    }
    return d.groups;
  }

  /** Forget a note's unresolved links (groups + unresolvedBy) via its own keys; false while no groups exist. */
  private dropUnresolved(d: Derived, path: string): boolean {
    if (!d.groups || !d.keysOf) return false;
    const keys = d.keysOf.get(path);
    if (!keys) return true;
    for (const key of keys) {
      d.unresolvedBy.get(key)?.delete(path);
      const g = d.groups.get(key);
      const list = g?.by.get(path);
      if (!g || !list) continue;
      g.n -= list.length;
      g.by.delete(path);
      g.target = null;
      if (!g.by.size) d.groups.delete(key);
    }
    d.keysOf.delete(path);
    return true;
  }

  private unlink(d: Derived, path: string, links: readonly LinkRef[] | undefined) {
    d.outNotes.delete(path);
    const res = d.resolved.get(path);
    if (!res) return;
    for (let i = 0; i < res.length; i++) {
      const r = res[i];
      if (r) d.incoming.get(r)?.delete(path);
      else if (links?.[i]) d.unresolvedBy.get(links[i].target.toLowerCase())?.delete(path);
    }
    this.dropUnresolved(d, path);
    this.unindexNames(d, path);
    d.resolved.delete(path);
  }

  private patch(d: Derived, path: string, oldAliases: readonly string[], newAliases: readonly string[]) {
    const affected = new Set<string>();
    this.aliasDelta(d, path, oldAliases, newAliases, affected);
    // The edited note's own old links must be unlinked by position, but its LinkRefs are already
    // replaced: drop them via the keys recorded at link time, or (no groups yet) sweep the unresolved sets.
    const res = d.resolved.get(path);
    d.outNotes.delete(path);
    if (res) {
      for (const r of res) if (r) d.incoming.get(r)?.delete(path);
      if (!this.dropUnresolved(d, path) && res.includes(null)) for (const set of d.unresolvedBy.values()) set.delete(path);
      this.unindexNames(d, path);
      d.resolved.delete(path);
    }
    affected.delete(path);
    for (const p of affected) {
      const n = this.infos.get(p);
      if (!n) continue;
      if (d.resolved.has(p)) this.unlink(d, p, n.links);
      this.link(d, n);
    }
    const self = this.infos.get(path);
    if (self) this.link(d, self);
  }

  /** Aliases of `path` changed: update the alias table; collect notes whose links may resolve differently. */
  private aliasDelta(d: Derived, path: string, oldAliases: readonly string[], newAliases: readonly string[], affected: Set<string>) {
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

  // ---------- link graph (Connections view, local graph, orphans: ./connections) ----------

  /** Notes `path` links to: resolved Markdown notes, unique, itself excluded. Don't mutate. */
  linksFrom(path: string): readonly string[] {
    const d = this.own(path);
    const hit = d.outNotes.get(path);
    if (hit) return hit;
    const res = d.resolved.get(path);
    if (!res) return NO_PATHS;
    const seen = new Set<string>();
    for (const r of res) if (r && r !== path && isMarkdown(r)) seen.add(r);
    const out = seen.size ? [...seen] : NO_PATHS;
    d.outNotes.set(path, out);
    return out;
  }

  /** Notes linking to `path` — the live set (may contain `path` itself). Don't mutate. */
  linksTo(path: string): ReadonlySet<string> {
    return this.d().incoming.get(path) ?? NO_SET;
  }

  tagsOf(path: string): readonly string[] {
    return this.infos.get(path)?.tags ?? NO_PATHS;
  }

  /** Notes carrying exactly `tag` (no nesting; case-insensitive). Don't mutate. */
  notesTagged(tag: string): ReadonlySet<string> {
    return this.tagNotes().get(tag.replace(/^#/, '').toLowerCase())?.notes ?? NO_SET;
  }

  /** Notes linking to `path` (cheap: no context snippets). */
  backlinkSources(path: string): string[] {
    return [...(this.d().incoming.get(path) ?? [])].filter((p) => p !== path);
  }

  outgoing(path: string): OutgoingLink[] {
    const n = this.infos.get(path);
    if (!n) return [];
    const res = this.own(path).resolved.get(path) ?? [];
    return n.links.map((link, i) => ({ link, path: res[i] ?? null }));
  }

  /**
   * How many distinct unresolved targets there are (a collapsed section header shows it after every
   * edit): the groups' size once built, else a scan of the per-target sets (~1 ms at 150k, no allocation).
   */
  unresolvedCount(): number {
    const d = this.d();
    if (d.groups) return d.groups.size;
    let n = 0;
    for (const [key, set] of d.unresolvedBy) if (key && set.size) n++;
    return n;
  }

  /**
   * Unresolved targets, most-linked first (then by name), sources by path / line / col.
   * `limit`: only the first `limit` of that order — cost ~O(targets) per call instead of a full sort
   * (a panel showing the top few hundred re-reads this after every edit).
   */
  unresolvedLinks(limit?: number): UnresolvedLink[] {
    if (limit === undefined && this.unresolvedCache?.version === this.version) return this.unresolvedCache.list;
    const d = this.d();
    const label = (g: UGroup) => {
      if (g.target !== null) return g.target;
      let best: (USource & { text: string }) | null = null;
      for (const list of g.by.values()) for (const s of list) if (!best || cmpSource(s, best) < 0) best = s;
      return (g.target = best!.text);
    };
    const cmpGroup = (a: UGroup, b: UGroup) => b.n - a.n || collator.compare(label(a), label(b));
    let picked: UGroup[];
    const groups = this.groupsOf(d);
    if (limit === undefined || limit >= groups.size) picked = [...groups.values()].sort(cmpGroup);
    else {
      // Buckets by link count (small integers), then only the bucket that crosses `limit` is ranked by name.
      const byN = new Map<number, UGroup[]>();
      for (const g of groups.values()) {
        const b = byN.get(g.n);
        if (b) b.push(g);
        else byN.set(g.n, [g]);
      }
      picked = [];
      for (const n of [...byN.keys()].sort((a, b) => b - a)) {
        const bucket = byN.get(n)!;
        const need = limit - picked.length;
        if (need <= 0) break;
        if (bucket.length <= need) {
          picked.push(...bucket.sort(cmpGroup));
          continue;
        }
        // The `need` first names of a big bucket: most candidates fail one compare with the current last.
        const top: UGroup[] = [];
        for (const g of bucket) {
          if (top.length === need && cmpGroup(g, top[need - 1]) >= 0) continue;
          let lo = 0;
          let hi = top.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (cmpGroup(top[mid], g) <= 0) lo = mid + 1;
            else hi = mid;
          }
          top.splice(lo, 0, g);
          if (top.length > need) top.pop();
        }
        picked.push(...top);
      }
    }
    const list: UnresolvedLink[] = picked.map((g) => ({
      target: label(g),
      sources: [...g.by.values()]
        .flat()
        .sort(cmpSource)
        .map(({ from, line, col, length }) => ({ from, line, col, length })),
    }));
    if (limit === undefined) this.unresolvedCache = { version: this.version, list };
    return list;
  }

  private setInfo(path: string, info: NoteInfo): void {
    const old = this.infos.get(path);
    this.infos.set(path, info);
    if (old && sameList(old.tags, info.tags)) return;
    if (old) this.untag(path, old.tags);
    this.tagVersion++;
    for (const t of info.tags) {
      const key = t.toLowerCase();
      let e = this.tagIdx.get(key);
      if (!e) this.tagIdx.set(key, (e = { tag: t, notes: new Set() }));
      e.notes.add(path);
    }
  }

  private dropInfo(path: string): boolean {
    const old = this.infos.get(path);
    if (!old) return false;
    this.infos.delete(path);
    this.untag(path, old.tags);
    return true;
  }

  private untag(path: string, tags: readonly string[]): void {
    if (tags.length) this.tagVersion++;
    for (const t of tags) {
      const key = t.toLowerCase();
      const e = this.tagIdx.get(key);
      if (!e) continue;
      e.notes.delete(path);
      if (!e.notes.size) this.tagIdx.delete(key);
    }
  }

  private tagNotes(): ReadonlyMap<string, { tag: string; notes: Set<string> }> {
    return this.tagIdx;
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

  /** The tag tree (shared between calls until a note's tags change: callers must not mutate it). */
  tags(): TagNode[] {
    if (this.tagsCache?.v === this.tagVersion) return this.tagsCache.tree;
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
    const tree = finish(roots);
    this.tagsCache = { v: this.tagVersion, tree };
    return tree;
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
