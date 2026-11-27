// Node-side workspace service shared by the Electron main process and the HTTP server.
// A "workspace" is just a folder on disk: no vault metadata, nothing written inside it except user files.
//
// The workspace keeps an in-memory index (rel path → kind/mtime/size) built by listTree(). Watchers only
// deliver hints; `reconcile()` stats the hinted path and diffs it against the index. Our own operations
// update the index themselves, so they never echo back as "external" events.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { MAX_AS_TEXT_BYTES, MAX_AS_TEXT_FULL_BYTES, MAX_BINARY_BYTES, type Eol, type FileData, type FsEvent, type TextEncoding, type TextPage, type TextPageOptions, type TreeNode, type WorkspaceInfo, type WriteOptions } from '../shared/api';
import { normalize } from '../shared/paths';
import { decode, decodeBestEffort, detectEol, encode, toLf, withEol } from './textcodec';
import { createExcludeMatcher, type ExcludeMatcher } from './exclude';
import { createWatchBackend, defaultWatchMode, type WatchBackend, type WatchMode } from './watcher';
import { BackendFailure } from './errors';
import { isGitDirName, isInsideDir, relativeInside, resolveInside } from './pathsafe';
import { isProbablyTextName } from './textnames';
export { isProbablyTextName } from './textnames';
import { IgnoreStack, isLockfile, isMinified } from './gitignore';
import { defaultReadThreads } from './readpool';
import { cacheFileFor } from './indexcache';
import { DEFAULT_INDEX, MAX_INDEX_BYTES, type IndexOptions, type Stamp } from './indexer';
import { LocalIndexerHost, WorkerIndexerHost, indexerSource, type IndexerHost, type Raw } from './indexer-host';
import { fsDelayAsync } from './fsdelay';
import type { ProcRow } from '../shared/processes';

export { detectEol } from './textcodec';
export { MAX_INDEX_BYTES, type IndexOptions } from './indexer';
export { BackendFailure } from './errors';

const MAX_OPEN_BYTES = 48 * 1024 * 1024;

/** The first `bytes` of a file, without reading the rest (the bounded window of a force-opened binary). */
export async function readHead(abs: string, bytes: number): Promise<Buffer> {
  if (bytes <= 0) return Buffer.alloc(0);
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
export const MAX_TREE_ENTRIES = 200_000;
const MAX_DEPTH = 40;
const isWin = process.platform === 'win32';
// readAllTextPage sizing (content length per page).
const PAGE_MAX = 8 << 20;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));


const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareNodes = (a: TreeNode, b: TreeNode) => (a.kind !== b.kind ? (a.kind === 'dir' ? -1 : 1) : naturalCollator.compare(a.name, b.name));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parentOf = (rel: string) => {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
};
const depthOf = (rel: string) => (rel ? rel.split('/').length : 0);
const isUnder = (rel: string, dir: string) => dir === '' || rel === dir || rel.startsWith(dir + '/');

interface Entry {
  kind: 'file' | 'dir';
  mtime?: number;
  size?: number;
}

export interface WorkspaceOptions {
  exclude?: string[];
  showHidden?: boolean;
  watchMode?: WatchMode;
  /** Debounce window for batching watcher events. */
  debounceMs?: number;
  /** Rescan interval when falling back to polling. */
  pollMs?: number;
  /** What the indexers skip (the tree still lists everything). */
  index?: IndexOptions;
  /** Persistent text cache folder (the app's config dir — never the workspace). Unset = no cache. */
  cacheDir?: string;
  /** Reader threads for indexing (0 = read in-thread). */
  readThreads?: number;
  /** Start the indexer thread right after the first walk (default). false (search.indexing = onDemand):
   *  nothing index-related runs — no thread, no readers, no cache read — until text is first asked for. */
  warmIndexer?: boolean;
  /** Skip the probe (tests). true = names differ by case. */
  caseSensitive?: boolean;
  /** 'skip': symlinks / junctions are not listed, watched or read in bulk at all (the MCP server: a link
   *  must not become a second name for an excluded or hidden place). Default 'follow' (inside ones). */
  links?: 'follow' | 'skip';
  /** Folders whose content is never listed, read or written, whatever the open folder (One's own data
   *  folder: settings, mcp.json, the vault, git trust). A page taken over must not rewrite them. */
  deny?: string[];
  /** Refuse every change (write, create, rename, move, delete) of a path in a `.git` folder, as written or where it
   *  really is (BackendService: a page taken over must not plant hooks or `core.fsmonitor` in a trusted repository). */
  protectGitDir?: boolean;
}

/** Deny folders matched by identity (dev + ino), not by spelling: 8.3 roots, `\\localhost\c$`, macOS firmlinks and
 *  bind mounts name the same folder differently. `rels`: deny folders inside the root, as root-relative paths. */
interface DenyInfo {
  rels: string[];
  /** The root itself is (inside) a deny folder: nothing in it is served. */
  rootInside: boolean;
}

/** The existing-file read before a write (eol / BOM / encoding not given): never more than a file readFile serves. */
const MAX_PREWRITE_READ = 48 * 1024 * 1024;
const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
/** Thrown inside a slot when the entry turned out to need the workspace-wide one (see rename / remove). */
const WIDEN = Symbol('widen');

/** Only a guess, used when a folder gives nothing to probe with (no letters in any name). */
const foldCaseByDefault = isWin || process.platform === 'darwin';
const swapAsciiCase = (s: string) => s.replace(/[a-z]/gi, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
const hasCase = (s: string) => s.toLowerCase() !== s.toUpperCase();
const sameEntry = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && (a.ino !== 0n || (a.birthtimeNs === b.birthtimeNs && a.size === b.size));
const caseClashText = (name: string) => `“${name}” already exists (the name differs only in case, which this folder treats as the same file)`;

/**
 * Does `root` tell names apart by case? Decided per folder, never per OS: Windows opening
 * \\wsl.localhost\… talks to a case-sensitive ext4, Linux may mount a case-insensitive share. Never
 * writes: looks a child (or the root itself) up with its letters' case swapped. null = no letters to try.
 */
export async function probeCaseSensitive(root: string): Promise<boolean | null> {
  const seen: string[] = [];
  try {
    const d = await fsp.opendir(root, { bufferSize: 64 });
    try {
      for (let e = await d.read(); e && seen.length < 64; e = await d.read()) seen.push(e.name);
    } finally {
      await d.close().catch(() => {});
    }
  } catch {}
  const lower = new Set<string>();
  for (const n of seen) {
    if (lower.has(n.toLowerCase())) return true; // two names differing only in case: settled
    lower.add(n.toLowerCase());
  }
  const listed = new Set(seen);
  // A child says how lookups *inside* the root behave (NTFS can flag single folders case-sensitive).
  const child = seen.find((n) => swapAsciiCase(n) !== n && !listed.has(swapAsciiCase(n)));
  if (child) {
    const st = await fsp.lstat(path.join(root, swapAsciiCase(child))).catch((err) => (err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? false : null));
    if (st !== null) return st === false; // the swapped name is not listed, so finding it means folding
  }
  const base = path.basename(root);
  if (base && swapAsciiCase(base) !== base) {
    const [a, b] = await Promise.all([fsp.lstat(root, { bigint: true }).catch(() => null), fsp.lstat(path.join(path.dirname(root), swapAsciiCase(base)), { bigint: true }).catch((err) => (err?.code === 'ENOENT' ? false : null))]);
    if (a && b === false) return true;
    if (a && b) return !sameEntry(a, b);
  }
  return null;
}

/**
 * Optional last check of a mutation, run inside the path's exclusive slot right before the disk changes
 * (the MCP server re-checks where the path really leads, its precondition, and journals the old bytes).
 * Throwing cancels the operation. `abs` is the lexical path; `role` says which end of a rename it is.
 */
export type WriteGuard = ((abs: string, role: 'target' | 'from' | 'to') => Promise<void>) & {
  /** strict (the MCP server): never write through a link (refused at commit), never rewrite in place, no
   *  in-place fallback, the parent's real location checked again after the write / rename (what landed
   *  elsewhere through a link swapped in meanwhile is taken back), and a rename never overwrites. */
  strict?: boolean;
};

/** How long the first walk's tree may answer the next full listTree (the renderer asks within ~1 s). */
const BOOT_TREE_MS = 5_000;

export class Workspace {
  readonly root: string;
  private matcher: ExcludeMatcher;
  private index = new Map<string, Entry>();
  private indexed = false;
  /** The first full walk while it runs (shared by everyone who asks for the tree meanwhile). */
  private firstWalk: { p: Promise<TreeNode>; joined: boolean } | null = null;
  /** That walk's tree, for one caller right after it (nobody had joined it): exact while nothing changed. */
  private bootTree: { tree: TreeNode; version: number; at: number } | null = null;
  /** Full-tree walks so far (startup guard: one per workspace open). */
  fullWalks = 0;
  private watch: WatchBackend | null = null;
  private readonly watchMode: WatchMode;
  private readonly debounceMs: number;
  private readonly pollMs: number;
  private listeners = new Set<(e: FsEvent[]) => void>();
  private pending = new Set<string>();
  private rescanRequested = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private batchStart = 0;
  private flushing: Promise<void> | null = null;
  /** Paths with one of our own operations in progress: their hints wait until we are done. */
  private inflight = new Map<string, number>();
  /** Mutations in progress or queued (see exclusive()). */
  private ops = new Set<{ keys: string[]; done: Promise<void> }>();
  private disposed = false;
  /** Bumped whenever the set of indexed paths changes (keeps the sorted text-file list cache honest). */
  private indexVersion = 0;
  private indexOpts: Required<IndexOptions>;
  /** Folders holding a .gitignore / a .git (seen while walking; dotfiles are hidden from the index). */
  private ignoreDirs = new Set<string>();
  private repoDirs = new Set<string>();
  /** Bumped when ignore files may have changed. */
  private ignoreVersion = 0;
  /** Text cache folder; the file in it is named after the root with this folder's case rule (see indexer()). */
  private readonly cacheDir: string | null;
  private readonly readThreads: number;
  private readonly warmIndexer: boolean;
  private readonly skipLinks: boolean;
  private readonly protectGitDir: boolean;
  /** deny: as given and with links resolved. */
  private readonly denyDirs: string[];
  /** Index entries that are links (listed: they lead inside). The index pass checks where files below them
   *  really are before it reads them: a page can move a link (relative ones then lead elsewhere). */
  private links = new Set<string>();
  /** Indexing I/O (pass, cache, filters, decoding) lives here — a worker thread in the app. */
  private host: IndexerHost | null = null;
  private sentVersion = '';
  /** Ignore rules as last computed by the indexer: the watcher drops events inside ignored folders. */
  private hintIgnore: IgnoreStack | null = null;
  private passCbs = new Set<() => void>();
  /** Files opened / saved recently: the folder poller checks their mtimes (content edits keep folder mtimes). */
  private hot: string[] = [];
  private touchHot(rel: string) {
    this.hot = [rel, ...this.hot.filter((p) => p !== rel)].slice(0, 64);
  }
  private readonly pollSource = {
    children: (dir: string) => {
      const out = new Set<string>();
      const pre = dir ? dir + '/' : '';
      for (const k of this.index.keys()) if (k.startsWith(pre) && k.length > pre.length && k.indexOf('/', pre.length) === -1) out.add(k.slice(pre.length));
      return out;
    },
    hotFiles: () => this.hot,
  };

  /** Watch a folder (per-folder backends), unless it is git-ignored. */
  private watchDir(rel: string) {
    if (!this.watch?.wantsDirs) return;
    if (rel && this.indexOpts.respectGitignore && this.hintIgnore?.ignored(rel, true)) return;
    this.watch.addDir(rel);
  }

  /** Window hidden: the folder poller (WSL / network roots) holds still. */
  setWatchPaused(on: boolean) {
    this.watch?.pause?.(on);
  }

  /** Watcher hints dropped because they were inside ignored folders (tests, diagnostics). */
  droppedHints = 0;

  /** null until probed (see detectCase). */
  private caseSensitive: boolean | null = null;
  private caseProbe: Promise<boolean> | null = null;

  constructor(root: string, opts: WorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.matcher = createExcludeMatcher(opts.exclude ?? ['node_modules', '.git'], !!opts.showHidden);
    this.watchMode = opts.watchMode ?? defaultWatchMode(this.root);
    this.debounceMs = opts.debounceMs ?? 80;
    this.pollMs = opts.pollMs ?? 4000;
    this.indexOpts = { ...DEFAULT_INDEX, ...definedOnly(opts.index ?? {}) };
    this.cacheDir = opts.cacheDir || null;
    this.readThreads = opts.readThreads ?? defaultReadThreads(this.root);
    this.warmIndexer = opts.warmIndexer !== false;
    this.skipLinks = opts.links === 'skip';
    this.protectGitDir = !!opts.protectGitDir;
    const deny = (opts.deny ?? []).filter(Boolean).map((d) => path.resolve(d));
    this.denyDirs = [...new Set([...deny, ...deny.map((d) => {
      try {
        return fs.realpathSync(d);
      } catch {
        return d;
      }
    })])];
    if (opts.caseSensitive !== undefined) {
      this.caseSensitive = opts.caseSensitive;
      this.caseProbe = Promise.resolve(opts.caseSensitive);
    }
  }

  info(): WorkspaceInfo {
    return { root: this.root, name: path.basename(this.root) || this.root, caseSensitive: !this.foldsCase };
  }

  /** Probes (once) whether this folder tells names apart by case. */
  detectCase(): Promise<boolean> {
    return (this.caseProbe ??= probeCaseSensitive(this.root).then(
      (r) => (this.caseSensitive = r ?? !foldCaseByDefault),
      () => (this.caseSensitive = !foldCaseByDefault),
    ));
  }

  /** "Note.md" and "note.md" are the same entry here (before the probe: the platform's usual answer). */
  get foldsCase(): boolean {
    return !(this.caseSensitive ?? !foldCaseByDefault);
  }

  /**
   * Case-insensitive folders only: the existing entry `key` would silently reach under another spelling
   * ("notes/Todo.md" → "Notes/todo.md"), or null if every existing segment is spelled exactly so.
   * Names the index knows count as exact, except the last one when `listings` is given (stale spellings:
   * watcher hints, deletes); a watcher batch shares those folder reads.
   */
  private async caseClash(key: string, listings?: Map<string, Promise<Set<string> | null>>): Promise<string | null> {
    await this.detectCase();
    if (!this.foldsCase || !key) return null;
    const segs = key.split('/');
    let dir = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const rel = dir ? `${dir}/${seg}` : seg;
      if (hasCase(seg) && ((listings && i === segs.length - 1) || !this.index.has(rel))) {
        let names = listings?.get(dir);
        if (!names) {
          names = fsp.readdir(this.abs(dir)).then((l) => new Set(l), () => null);
          listings?.set(dir, names);
        }
        const list = await names;
        if (!list?.has(seg)) {
          const l = seg.toLowerCase();
          const other = list && [...list].find((n) => n.toLowerCase() === l);
          return other ? (dir ? `${dir}/${other}` : other) : null; // absent: the rest is new
        }
      }
      dir = rel;
    }
    return null;
  }

  setOptions(opts: { exclude?: string[]; showHidden?: boolean }) {
    this.matcher = createExcludeMatcher(opts.exclude ?? [], !!opts.showHidden);
  }

  /** Changes what the indexers skip; takes effect on the next index pass. */
  setIndexOptions(opts: IndexOptions) {
    this.indexOpts = { ...DEFAULT_INDEX, ...definedOnly(opts) };
    this.host?.setOptions(this.indexOpts);
    this.sentVersion = ''; // ignore rules may now apply or not: refresh the watcher's copy
  }

  get indexOptions(): Readonly<Required<IndexOptions>> {
    return this.indexOpts;
  }

  /** Resolves a workspace-relative path to an absolute native path, refusing traversal outside the root
   *  (and, on Windows, names Win32 would remap: devices like aux.md, ADS "a:b", trailing dots). */
  abs(rel: string): string {
    if (typeof rel !== 'string') throw new BackendFailure('EINVAL', 'Path must be a string');
    return resolveInside(this.root, rel, path, isWin);
  }

  // ---- containment through links ----------------------------------------------------------------
  // abs() is lexical: "docs/x.md" passes it even when `docs` is a symlink / junction to another place.
  // A folder someone else made (a clone, an unpacked archive) must not reach outside itself that way,
  // so every single-path operation also resolves links (real()); the tree walk and the watcher leave
  // links that point outside out of the index, which is all the indexer ever reads.

  private realRootP: Promise<string | null> | null = null;
  /** The root without links; null where the file system cannot say. Fails closed: callers then refuse every
   *  path with a link on the way (real()), and the failure is not kept (asked again on the next call). */
  private realRoot(): Promise<string | null> {
    return (this.realRootP ??= fsp.realpath(this.root).catch(() => {
      this.realRootP = null;
      return null;
    }));
  }

  /** Where the existing path `abs` really is: inside the root, outside it, or not there. */
  private async whereIs(abs: string): Promise<'in' | 'out' | 'missing'> {
    const root = await this.realRoot();
    if (!root) return 'out'; // real() checks this case without realpath (no link on the way at all)
    let real: string;
    try {
      real = await fsp.realpath(abs);
    } catch (err: any) {
      // A dangling link is "missing" too: writing there replaces the link itself, inside its folder.
      return err?.code === 'ENOENT' || err?.code === 'ENOTDIR' ? 'missing' : 'out';
    }
    await this.detectCase();
    return isInsideDir(real, root, path, this.foldsCase) ? 'in' : 'out';
  }

  /**
   * abs(rel), refused (OUTSIDE_WORKSPACE) when links lead outside the folder.
   *  - 'follow' (reads, writes, listings): the path itself is resolved too;
   *  - 'entry' (delete, rename, reveal): the entry is acted on as it is — a link is removed or moved,
   *    never its target —, so only the folder it sits in must be real.
   * A path that does not exist yet is judged by its nearest existing folder.
   */
  async real(rel: string, leaf: 'follow' | 'entry' = 'follow'): Promise<string> {
    const abs = this.abs(rel);
    if (this.denyDirs.length) await this.refuseDenied(abs, rel);
    if (abs === this.root) return abs;
    if (!(await this.realRoot())) {
      // realpath fails on this drive: links cannot be judged, so none is allowed on the way (fail closed).
      const key = normalize(rel);
      if (await this.throughLink(leaf === 'follow' ? key : parentOf(key))) throw new BackendFailure('OUTSIDE_WORKSPACE', `Path leads outside the folder (through a link): ${rel}`);
      return abs;
    }
    let at = leaf === 'follow' ? abs : path.dirname(abs);
    for (;;) {
      const w = at === this.root ? 'in' : await this.whereIs(at);
      if (w === 'in') return abs;
      if (w === 'out') throw new BackendFailure('OUTSIDE_WORKSPACE', `Path leads outside the folder (through a link): ${rel}`);
      at = path.dirname(at);
    }
  }

  /**
   * strict writes: the parent folder of `key` must really be where its path says (realpath = root + parent
   * key). After the write (`ino`: what was written), a mismatch means a link was swapped in meanwhile: what
   * landed there is taken back (moved back to `undoTo`, or removed) and the write fails.
   */
  /** Strict mkdir -p: one level at a time, each checked where it really is before and after (a parent
   *  swapped for a link mid-way never gets folders made outside). */
  private async mkdirStrict(key: string): Promise<void> {
    const parts = key.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const k = parts.slice(0, i).join('/');
      const p = this.abs(k);
      const have = await fsp.lstat(p).catch(() => null);
      if (have) {
        if (!have.isDirectory()) throw new BackendFailure('OUTSIDE_WORKSPACE', `Not a folder: ${k}`);
        continue;
      }
      await this.parentStillHere(k);
      await fsp.mkdir(p);
      await this.parentStillHere(k, { ino: (await fsp.lstat(p, { bigint: true })).ino });
    }
  }

  /**
   * Strict writes: is the folder of `key` still where it should be (its realpath)? If not, the entry we just
   * made (`ino`) is taken back where it landed: renamed back to `undoTo` (a move), or replaced by the pinned
   * victim `restore` (a hard link to the file our rename replaced, made in the same folder), or removed.
   */
  private async parentStillHere(key: string, o: { ino?: bigint; undoTo?: string; restore?: string | null } = {}): Promise<void> {
    const parentKey = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    const root = (await this.realRoot()) ?? this.root;
    const want = parentKey ? path.join(root, ...parentKey.split('/')) : root;
    const real = await fsp.realpath(path.dirname(this.abs(key))).catch(() => null);
    if (real === want || (real !== null && this.foldsCase && real.toLowerCase() === want.toLowerCase())) return;
    if (o.ino !== undefined && real !== null) {
      const landed = path.join(real, path.basename(this.abs(key)));
      const st = await fsp.lstat(landed, { bigint: true }).catch(() => null);
      if (st && st.ino === o.ino) {
        const back = o.restore ? path.join(real, path.basename(o.restore)) : null;
        if (o.undoTo) await fsp.rename(landed, o.undoTo).catch(() => {});
        // The pinned victim back over ours, when it sits next to it; otherwise ours goes.
        else if (!(back && (await fsp.rename(back, landed).then(() => true, () => false)))) await (st.isDirectory() ? fsp.rmdir(landed) : fsp.rm(landed, { force: true })).catch(() => {});
      }
    }
    throw new BackendFailure('OUTSIDE_WORKSPACE', `The folder of ${key} changed during the write`);
  }

  /** Inside a denied folder (as written, or where its nearest existing part really is)? */
  private isDenied(abs: string): boolean {
    return this.denyDirs.some((d) => isInsideDir(abs, d, path, this.foldsCase));
  }

  /** Is `rel` in a denied folder, as written or where its nearest existing part really is? */
  private async deniedPath(rel: string): Promise<boolean> {
    try {
      await this.refuseDenied(this.abs(rel), rel);
      return false;
    } catch (err) {
      return err instanceof BackendFailure && err.code === 'EACCES';
    }
  }

  private async refuseDenied(abs: string, rel: string) {
    const refuse = () => new BackendFailure('EACCES', `One's own data folder is off limits: ${rel}`);
    if (this.isDenied(abs)) throw refuse();
    const info = await this.denyInfo();
    if (info.rootInside || this.deniedRel(normalize(rel), info)) throw refuse();
    for (let cur = abs; ; cur = path.dirname(cur)) {
      const real = await fsp.realpath(cur).catch(() => null);
      if (real !== null) {
        if (this.deniedReal(real, info, await this.realRoot())) throw refuse();
        return;
      }
      if (path.dirname(cur) === cur) return;
    }
  }

  private denyInfoP: Promise<DenyInfo> | null = null;
  /** Once per workspace: which deny folders are inside the root, and is the root inside one (by identity). */
  private denyInfo(): Promise<DenyInfo> {
    return (this.denyInfoP ??= this.denyDirs.length ? denyIdentity(this.root, this.denyDirs) : Promise.resolve({ rels: [], rootInside: false }));
  }

  /** Root-relative `rel` is (inside) a deny folder found under the root by identity. */
  private deniedRel(rel: string, info: DenyInfo): boolean {
    if (!info.rels.length) return false;
    const f = (s: string) => (this.foldsCase ? s.toLowerCase() : s);
    return info.rels.some((d) => isUnder(f(rel), f(d)));
  }

  /** A real (link-free) path inside a deny folder: as spelled, or by its place below the real root. */
  private deniedReal(real: string, info: DenyInfo, root: string | null): boolean {
    if (info.rootInside || this.isDenied(real)) return true;
    if (!root || !info.rels.length || !isInsideDir(real, root, path, this.foldsCase)) return false;
    return this.deniedRel(path.relative(root, real).split(path.sep).join('/'), info);
  }

  /**
   * Where `abs` really is, as a root-relative POSIX path: its nearest existing part resolved, the rest as
   * written. null = outside the folder (or no real root to judge by: then the lexical path).
   */
  private async realRelOf(abs: string): Promise<string | null> {
    const root = await this.realRoot();
    if (!root) return this.rel(abs);
    const rest: string[] = [];
    for (let cur = abs; ; ) {
      const real = await fsp.realpath(cur).catch(() => null);
      if (real !== null) {
        if (!isInsideDir(real, root, path, this.foldsCase)) return null;
        let r = path.relative(root, real);
        if (r.startsWith('..')) r = path.relative(root.toLowerCase(), real.toLowerCase()); // case-folded match
        return [...r.split(path.sep).filter(Boolean), ...rest].join('/');
      }
      const up = path.dirname(cur);
      if (up === cur) return null;
      rest.unshift(path.basename(cur));
      cur = up;
    }
  }

  /**
   * protectGitDir: refuses `key` when it is in a `.git` folder, as written (8.3 `GIT~1` too) or where it really
   * is (a link in the folder that leads into `.git`). `entry`: only the folder the entry sits in is resolved.
   */
  private async refuseGitDir(key: string, leaf: 'follow' | 'entry' = 'follow') {
    if (!this.protectGitDir || !key) return;
    await this.detectCase();
    const refuse = () => new BackendFailure('EACCES', `Git's own folder (.git) cannot be changed from One: ${key}`);
    const hit = (rel: string) => rel.split('/').some((s) => isGitDirName(s, this.foldsCase));
    if (hit(key)) throw refuse();
    const abs = this.abs(key);
    const real = await this.realRelOf(leaf === 'follow' ? abs : path.dirname(abs));
    if (real && hit(real)) throw refuse();
  }

  /**
   * Page writes, moves and deletes (no strict guard): the folder `abs` sits in, where it really is, must be inside
   * the root and not denied. Checked right before the disk changes and again right after (pageDirAfter): the
   * check at the start of the call (real()) can be far behind by then. Returns that real folder.
   */
  private async pageDirBefore(abs: string, key: string): Promise<string> {
    const dir = path.dirname(abs);
    const root = await this.realRoot();
    if (!root) {
      if (await this.throughLink(parentOf(key))) throw new BackendFailure('OUTSIDE_WORKSPACE', `The folder of ${key} leads outside the folder (through a link)`);
      return dir;
    }
    const real = await fsp.realpath(dir).catch(() => null);
    if (real === null) throw new BackendFailure('ENOENT', `Folder not found: ${parentOf(key) || '.'}`);
    if (!isInsideDir(real, root, path, this.foldsCase)) throw new BackendFailure('OUTSIDE_WORKSPACE', `The folder of ${key} leads outside the folder (through a link)`);
    if (this.denyDirs.length && this.deniedReal(real, await this.denyInfo(), root)) throw new BackendFailure('EACCES', `One's own data folder is off limits: ${key}`);
    return real;
  }

  /**
   * After a page write / move: does the folder still lead where pageDirBefore found it? If it now leads outside the
   * root (or into a deny folder) — a link swapped in meanwhile — what landed there (`ino`) is taken back (moved back
   * to `undoTo`, or removed) and the call fails. Still inside (moved by someone else): the result stands.
   */
  private async pageDirAfter(abs: string, key: string, before: string, o: { ino?: bigint; undoTo?: string } = {}): Promise<void> {
    const root = await this.realRoot();
    if (!root) return; // nothing was resolved before either (no link on the way, checked by lstat)
    const real = await fsp.realpath(path.dirname(abs)).catch(() => null);
    if (real === null || real === before || (this.foldsCase && real.toLowerCase() === before.toLowerCase())) return;
    if (isInsideDir(real, root, path, this.foldsCase) && !(this.denyDirs.length && this.deniedReal(real, await this.denyInfo(), root))) return;
    if (o.ino !== undefined) {
      const landed = path.join(real, path.basename(abs));
      const st = await fsp.lstat(landed, { bigint: true }).catch(() => null);
      if (st && st.ino === o.ino) {
        if (o.undoTo) await fsp.rename(landed, o.undoTo).catch(() => {});
        else await (st.isDirectory() ? fsp.rmdir(landed) : fsp.rm(landed, { force: true })).catch(() => {});
      }
    }
    throw new BackendFailure('OUTSIDE_WORKSPACE', `The folder of ${key} changed during the operation`);
  }

  /** links: 'skip' — is `rel` or any folder above it a link? */
  private async throughLink(rel: string): Promise<boolean> {
    let cur = this.root;
    if (!normalize(rel)) return false;
    for (const seg of normalize(rel).split('/')) {
      cur = path.join(cur, seg);
      const st = await fsp.lstat(cur).catch(() => null);
      if (!st) return false;
      if (st.isSymbolicLink()) return true;
    }
    return false;
  }

  /** A link met while listing: its target, when that is inside the folder (else null: not listed). */
  private async linkTarget(abs: string): Promise<string | null> {
    const real = await fsp.realpath(abs).catch(() => null);
    if (!real) return null;
    const root = await this.realRoot();
    await this.detectCase();
    // No real root (realpath fails here): a link cannot be judged, so it counts as outside.
    if (!root || !isInsideDir(real, root, path, this.foldsCase)) return null;
    if (this.denyDirs.length && this.deniedReal(real, await this.denyInfo(), root)) return null; // One's data folder
    return real;
  }

  /** Absolute native path → workspace-relative POSIX path, or null if outside. */
  rel(absPath: string): string | null {
    return relativeInside(this.root, absPath, path);
  }

  isExcluded(rel: string) {
    return this.matcher.path(rel);
  }

  // ---- tree -----------------------------------------------------------------------------------

  /** Lists the whole tree (and rebuilds the index), or a subtree. Files are not stat'ed: readdir only, for speed. */
  async listTree(sub = ''): Promise<TreeNode> {
    if (!normalize(sub)) {
      // Until the first full walk is done nobody has a tree: whoever asks meanwhile (the watcher's
      // kick-off at open, the renderer's first listTree, the indexer) shares that walk instead of
      // walking every folder again. The watcher starts before it and reports later changes.
      if (!this.indexed) {
        if (this.firstWalk) {
          this.firstWalk.joined = true;
          return this.firstWalk.p;
        }
        const w: { p: Promise<TreeNode>; joined: boolean } = { p: null!, joined: false };
        const watched = !!this.watch; // only a watcher running since before the walk keeps its tree exact
        w.p = this.walkTree('').then(
          (tree) => {
            if (watched && !w.joined && !this.disposed) this.bootTree = { tree, version: this.indexVersion, at: Date.now() };
            return tree;
          },
        ).finally(() => this.firstWalk === w && (this.firstWalk = null));
        this.firstWalk = w;
        return w.p;
      }
      // The walk won the race (fast disk, browser mode): the renderer's boot listTree arrives just
      // after it. Its tree is still exact while nothing changed since — once, and only shortly after.
      const boot = this.bootTree;
      this.bootTree = null;
      if (boot && this.watch && boot.version === this.indexVersion && !this.pending.size && !this.flushing && !this.flushTimer && !this.rescanRequested && Date.now() - boot.at < BOOT_TREE_MS) return boot.tree;
    }
    return this.walkTree(sub);
  }

  /**
   * readdir for tree walks, at most (libuv threads − 1) at a time. An uncapped walk queues hundreds
   * of readdirs ahead of every other fs call: the launch session read and any file open waited for
   * the whole walk (~40 ms on 12k entries); capped they wait ~2 ms, for a few ms more walk.
   */
  private readdirInSlot(abs: string): Promise<fs.Dirent[]> {
    return this.inDirSlot(async () => {
      await fsDelayAsync(); // tests: latency injection (a slow bridge holds the thread too)
      return fsp.readdir(abs, { withFileTypes: true });
    });
  }
  private async inDirSlot<T>(run: () => Promise<T>): Promise<T> {
    const max = Math.max(1, (Number(process.env.UV_THREADPOOL_SIZE) || 4) - 1);
    if (this.dirSlots < max) this.dirSlots++;
    else await new Promise<void>((r) => this.dirWaiters.push(r)); // the slot is handed over
    try {
      return await run();
    } finally {
      const next = this.dirWaiters.shift();
      if (next) next();
      else this.dirSlots--;
    }
  }
  private dirSlots = 0;
  private dirWaiters: Array<() => void> = [];

  /**
   * Per-folder watching (Linux) starts once the first walk is done: an entry added or removed in a
   * folder between its readdir and its watch would be missed — by the index and by the tree the
   * renderer got. Folders changed since the walk began are listed again; differences go through the
   * normal watcher queue (events). In the background, after the tree has gone out.
   */
  private async catchUpAfterWalk(walkStart: number) {
    const dirs = [''];
    for (const [k, v] of this.index) if (v.kind === 'dir') dirs.push(k);
    const changed: string[] = [];
    await Promise.all(
      dirs.map(async (rel) => {
        const st = await this.inDirSlot(() => fsp.stat(this.abs(rel))).catch(() => null);
        if (st && st.mtimeMs >= walkStart - 1000) changed.push(rel);
      }),
    );
    if (this.disposed || !changed.length) return;
    const want = new Set(changed);
    const childrenOf = new Map<string, string[]>();
    for (const k of this.index.keys()) {
      const p = parentOf(k);
      if (!want.has(p)) continue;
      const list = childrenOf.get(p);
      if (list) list.push(k);
      else childrenOf.set(p, [k]);
    }
    for (const rel of changed) {
      const names = await this.inDirSlot(() => fsp.readdir(this.abs(rel))).catch(() => null);
      if (!names || this.disposed) continue;
      const now = new Set<string>();
      for (const n of names) {
        if (this.matcher.name(n)) continue; // what the walk skips (dotfiles, excluded names)
        now.add(rel ? `${rel}/${n}` : n);
      }
      for (const c of now) if (!this.index.has(c)) this.queue(c);
      for (const c of childrenOf.get(rel) ?? []) if (!now.has(c)) this.queue(c);
    }
  }

  private async walkTree(sub: string): Promise<TreeNode> {
    const walkStart = Date.now();
    const base = normalize(sub);
    const absBase = this.abs(base);
    await this.detectCase();
    const fold = this.foldsCase;
    if (base) {
      await this.real(base);
      const st = await fsp.stat(absBase).catch(() => null);
      if (!st?.isDirectory()) throw new BackendFailure('ENOENT', `Not a folder: ${sub}`);
    }
    const index = base ? this.index : new Map<string, Entry>();
    // Entries we knew before (with mtimes) so change detection stays precise after a relist.
    const known = base ? new Map<string, Entry>() : this.index;
    if (base) {
      for (const [k, v] of index) if (k !== base && isUnder(k, base)) known.set(k, v);
      for (const k of known.keys()) index.delete(k);
    }
    let count = 0;
    let truncated = false;
    const matcher = this.matcher;
    const ignoreDirs = base ? this.ignoreDirs : new Set<string>();
    const repoDirs = base ? this.repoDirs : new Set<string>();
    const links = base ? this.links : new Set<string>();
    if (base) {
      for (const d of [...ignoreDirs]) if (isUnder(d, base)) ignoreDirs.delete(d);
      for (const d of [...repoDirs]) if (isUnder(d, base)) repoDirs.delete(d);
      for (const d of [...links]) if (d !== base && isUnder(d, base)) links.delete(d);
    }
    // One's data folder by identity (DenyInfo); `realRel` below = where a folder really is, root-relative (it
    // differs from its listed path below a followed link). The root inside a deny folder: nothing is listed.
    const deny = this.denyDirs.length ? await this.denyInfo() : null;
    const realRootDir = deny ? await this.realRoot() : null;
    const baseReal = !deny ? base : base ? await this.realRelOf(absBase) : '';
    const deniedDir = (abs: string, realRel: string | null) => !!deny && (this.isDenied(abs) || (realRel !== null && this.deniedRel(realRel, deny)));
    const realRelOfTarget = (real: string) => (realRootDir && isInsideDir(real, realRootDir, path, fold) ? path.relative(realRootDir, real).split(path.sep).join('/') : null);

    const walk = async (absDir: string, relDir: string, depth: number, followed: string[], realDir: string | null): Promise<TreeNode[]> => {
      if (deny?.rootInside) return [];
      let entries: fs.Dirent[];
      try {
        entries = await this.readdirInSlot(absDir);
      } catch {
        return [];
      }
      const nodes: TreeNode[] = [];
      const pending: Promise<void>[] = [];
      for (const e of entries) {
        // Ignore files are hidden (dotfiles) but decide what the indexers skip.
        if (e.name === '.gitignore') ignoreDirs.add(relDir);
        else if (e.name === '.git') repoDirs.add(relDir);
        if (matcher.name(e.name)) continue;
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (matcher.rooted && matcher.path(rel)) continue;
        if (++count > MAX_TREE_ENTRIES) {
          truncated = true;
          break;
        }
        const abs = path.join(absDir, e.name);
        const realRel = realDir === null ? null : realDir ? `${realDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (deniedDir(abs, realRel)) continue; // One's own data folder: never listed
          const node: TreeNode = { name: e.name, path: rel, kind: 'dir', children: [] };
          index.set(rel, { kind: 'dir' });
          nodes.push(node);
          if (depth < MAX_DEPTH) pending.push(walk(abs, rel, depth + 1, followed, realRel).then((c) => void (node.children = c)));
        } else if (e.isFile()) {
          nodes.push({ name: e.name, path: rel, kind: 'file' });
          const old = known.get(rel);
          index.set(rel, old?.kind === 'file' ? old : { kind: 'file' });
        } else if (e.isSymbolicLink() && !this.skipLinks) {
          pending.push(
            (async () => {
              // Broken links are skipped — and so are links to somewhere outside the folder: neither
              // listed nor followed (the index only ever holds what is really in here).
              // A link into One's data folder is not listed (nor read in bulk) either.
              const target = await this.linkTarget(abs);
              const real = target && this.denyDirs.length && this.isDenied(target) ? null : target;
              const st = real ? await fsp.stat(abs).catch(() => null) : null;
              if (!st) return;
              if (st.isFile()) {
                nodes.push({ name: e.name, path: rel, kind: 'file', symlink: true });
                index.set(rel, { kind: 'file' });
                links.add(rel);
              } else if (st.isDirectory()) {
                const node: TreeNode = { name: e.name, path: rel, kind: 'dir', symlink: true, children: [] };
                nodes.push(node);
                index.set(rel, { kind: 'dir' });
                links.add(rel);
                // Symlink loops: never follow a link whose target contains the current dir or was already followed.
                const here = await fsp.realpath(absDir).catch(() => absDir);
                const cmp = (p: string) => (fold ? p.toLowerCase() : p);
                if (!real || followed.includes(cmp(real)) || cmp(here + path.sep).startsWith(cmp(real + path.sep)) || cmp(here) === cmp(real)) return;
                if (depth < MAX_DEPTH) node.children = await walk(abs, rel, depth + 1, [...followed, cmp(real)], deny ? realRelOfTarget(real) : rel);
              }
            })(),
          );
        }
      }
      await Promise.all(pending);
      return nodes.sort(compareNodes);
    };

    if (!base) this.fullWalks++;
    const children = await walk(absBase, base, depthOf(base), [], baseReal);
    this.indexVersion++;
    this.ignoreVersion++;
    if (!base) {
      this.index = index;
      this.ignoreDirs = ignoreDirs;
      this.repoDirs = repoDirs;
      this.links = links;
      const first = !this.indexed;
      this.indexed = true;
      this.syncWatchedDirs();
      if (first && this.watch?.mode === 'perdir') setImmediate(() => void this.catchUpAfterWalk(walkStart).catch(() => {}));
      // The indexers ask for text right after boot: start the indexer thread and its readers now —
      // just after this tree has gone out (starting a thread and posting 10k paths costs the main
      // thread ms the waiting window should not pay).
      if (first && this.warmIndexer && !this.disposed) setImmediate(() => !this.disposed && void this.indexer().then((h) => h.warm(), () => {}));
    } else if (this.watch?.wantsDirs) {
      this.watchDir(base);
      for (const [k, v] of index) if (v.kind === 'dir' && isUnder(k, base)) this.watchDir(k);
    }
    const node: TreeNode = { name: base ? path.basename(absBase) : path.basename(this.root) || this.root, path: base, kind: 'dir', children };
    if (truncated) node.truncated = true;
    return node;
  }

  private pathsMemo: { version: number; matcher: ExcludeMatcher; list: string[] } | null = null;

  /** Every indexed file path (after the first listTree); never an excluded or hidden one. */
  filePaths(): string[] {
    const m = this.pathsMemo;
    if (m && m.version === this.indexVersion && m.matcher === this.matcher) return m.list.slice();
    const out: string[] = [];
    for (const [k, v] of this.index) if (v.kind === 'file' && !this.matcher.path(k)) out.push(k);
    this.pathsMemo = { version: this.indexVersion, matcher: this.matcher, list: out };
    return out.slice();
  }

  // ---- reading / writing ----------------------------------------------------------------------

  /**
   * `maxBytes`: refuse (ETOOBIG) before reading anything bigger — a cheap existence / size probe.
   * `asText`: see BackendApi.readFile — a window (default) or the whole file ('full') of a binary file.
   */
  async readFile(rel: string, opts: { maxBytes?: number; asText?: true | 'full' } = {}): Promise<FileData> {
    const key = normalize(rel);
    const abs = await this.real(key);
    await fsDelayAsync(); // tests: latency injection (slow bridge / antivirus)
    let fh: fsp.FileHandle | null = null;
    try {
      const st = await fsp.stat(abs);
      // Never open "Note.md" as a twin "note.md" document (a later save would rename it on disk).
      const clash = await this.caseClash(key);
      if (clash) throw new BackendFailure('ENOENT', `File not found: ${rel} (“${clash}” differs only in case)`);
      if (st.isDirectory()) throw new BackendFailure('EISDIR', `Is a folder: ${rel}`);
      // FIFOs / sockets / devices: reading would block a libuv thread forever (and stall indexing).
      if (!st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${rel}`);
      if (st.size > MAX_OPEN_BYTES) throw new BackendFailure('ETOOBIG', `File is too large to open (${Math.round(st.size / 1048576)} MB): ${rel}`);
      if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw new BackendFailure('ETOOBIG', `File is larger than ${opts.maxBytes} bytes: ${rel}`);
      // asText: the user overrode the "binary" verdict. It stays flagged binary, so every "never write
      // this back" guard in the renderer keeps working. Default = a bounded window; 'full' = the whole
      // file, but only up to MAX_AS_TEXT_FULL_BYTES: a bigger string is not safe to put in the editor.
      if (opts.asText === 'full' && st.size > MAX_AS_TEXT_FULL_BYTES)
        throw new BackendFailure('ETOOBIG', `File is too large to open as text (${Math.round(st.size / 1048576)} MB; the limit is ${MAX_AS_TEXT_FULL_BYTES / 1048576} MB): ${rel}`);
      // Read through the opened handle, checked after the open: what is read is the file the checks were about,
      // not a link or FIFO swapped in since real() (opening never waits: O_NONBLOCK).
      fh = await fsp.open(abs, O_READ);
      await this.openedHere(abs, fh, st, key);
      const window = opts.asText === 'full' ? st.size : MAX_AS_TEXT_BYTES;
      const buf = opts.asText ? await readHeadFh(fh, Math.min(st.size, window)) : await fh.readFile();
      const d = opts.asText ? decodeBestEffort(buf) : decode(buf);
      // An excluded / hidden place (vendor/, a dot folder) is not part of the listing: reading it — Go to
      // definition does — must not hand it to the indexers, nor push the user's files off the hot list.
      if (!this.matcher.path(key)) {
        this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
        this.touchHot(key);
      }
      const eol = detectEol(d.text);
      const data: FileData = { path: key, content: toLf(d.text), mtime: st.mtimeMs, eol, size: st.size };
      if (d.bom) data.bom = true;
      if (d.encoding !== 'utf8') data.encoding = d.encoding;
      if (d.binary) data.binary = true;
      return data;
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new BackendFailure('ENOENT', `File not found: ${rel}`);
      throw err;
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  /**
   * The handle opened for `abs` is the file that was checked: the object `st` described, and — where links can
   * be judged — the file at the real path of `abs`, which is inside the root and not denied. A link swapped in
   * between the check and the open (or swapped back after it) fails here instead of being read.
   */
  private async openedHere(abs: string, fh: fsp.FileHandle, st: fs.Stats, key: string): Promise<void> {
    const changed = () => new BackendFailure('EXTERNAL_CHANGE', `${key} changed while it was opened`);
    const got = await fh.stat({ bigint: true });
    if (!got.isFile() || Number(got.dev) !== st.dev || Number(got.ino) !== st.ino) throw changed();
    const root = await this.realRoot();
    if (!root) {
      if (await this.throughLink(key)) throw new BackendFailure('OUTSIDE_WORKSPACE', `Path leads outside the folder (through a link): ${key}`);
      return;
    }
    const real = await fsp.realpath(abs).catch(() => null);
    if (real === null || !isInsideDir(real, root, path, this.foldsCase)) throw new BackendFailure('OUTSIDE_WORKSPACE', `Path leads outside the folder (through a link): ${key}`);
    if (this.denyDirs.length && this.deniedReal(real, await this.denyInfo(), root)) throw new BackendFailure('EACCES', `One's own data folder is off limits: ${key}`);
    const there = await fsp.stat(real, { bigint: true }).catch(() => null);
    if (!there || !sameEntry(got, there)) throw changed();
  }

  /**
   * The existing file's bytes before a write without eol / BOM / encoding: bounded (a page cannot stretch the time
   * between the checks and the write with a huge file), through the opened handle (a FIFO swapped in never blocks).
   * Where it really is, is commit's question (pageDirBefore / strict): only its line endings and encoding come from here.
   */
  private async readExisting(abs: string, st: fs.Stats, rel: string): Promise<Buffer> {
    if (st.size > MAX_PREWRITE_READ) throw new BackendFailure('ETOOBIG', `File is too large to replace without its line endings and encoding (${Math.round(st.size / 1048576)} MB): ${rel}`);
    const fh = await fsp.open(abs, O_READ);
    try {
      const got = await fh.stat();
      if (!got.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${rel}`);
      return await readHeadFh(fh, Math.min(got.size, MAX_PREWRITE_READ));
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async writeFile(rel: string, content: string, opts: WriteOptions = {}, guard?: WriteGuard): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    return this.withInflight(key, async () => {
      await this.real(key);
      await this.refuseGitDir(key);
      await this.refuseCaseClash(key);
      const st = await this.statForWrite(abs, rel);
      if (st && opts.expectedMtime !== undefined && Math.abs(st.mtimeMs - opts.expectedMtime) > 1) {
        throw new BackendFailure('EXTERNAL_CHANGE', `File changed on disk: ${rel}`);
      }
      if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${rel}`);
      await guard?.(abs, 'target');
      let { eol, bom, encoding } = opts as { eol?: Eol; bom?: boolean; encoding?: TextEncoding };
      if (st && (eol === undefined || bom === undefined || encoding === undefined)) {
        const d = decode(await this.readExisting(abs, st, rel));
        eol ??= detectEol(d.text);
        bom ??= d.bom;
        encoding ??= d.encoding;
      }
      return this.commit(key, abs, st, encode(withEol(content, eol ?? 'lf'), encoding ?? 'utf8', bom ?? false), !!guard?.strict);
    });
  }

  /**
   * Raw bytes (pasted images, attachments): same guarantees as writeFile — contained path, serialised
   * with every other mutation of the path, atomic, no watcher echo. Creates parent folders, overwrites.
   */
  async writeBinary(rel: string, data: Uint8Array, guard?: WriteGuard): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    if (data.byteLength > MAX_BINARY_BYTES) throw tooBigBinary(data.byteLength);
    return this.withInflight(key, async () => {
      await this.real(key);
      await this.refuseGitDir(key);
      await this.refuseCaseClash(key);
      const st = await this.statForWrite(abs, rel);
      if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${rel}`);
      await guard?.(abs, 'target');
      return this.commit(key, abs, st, Buffer.from(data.buffer, data.byteOffset, data.byteLength), !!guard?.strict);
    });
  }

  /** Case-insensitive folders: writing "note.md" would overwrite (and rename) an existing "Note.md".
   *  Its own code: callers treating EEXIST as "fine, it is there" must not take the other file for it. */
  private async refuseCaseClash(key: string, except?: string) {
    const clash = await this.caseClash(key);
    if (clash && clash !== except) throw new BackendFailure('ECASE', caseClashText(clash));
  }

  /** Existing regular file's stats, null if absent; folders / devices are refused. */
  private async statForWrite(abs: string, rel: string): Promise<fs.Stats | null> {
    const st = await fsp.stat(abs).catch((err) => {
      if (err?.code === 'ENOENT') return null;
      throw err;
    });
    if (st?.isDirectory()) throw new BackendFailure('EISDIR', `Is a folder: ${rel}`);
    if (st && !st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${rel}`);
    return st;
  }

  /** Shared write tail (caller holds the path's exclusive slot). */
  private async commit(key: string, abs: string, st: fs.Stats | null, data: Buffer, strict = false): Promise<{ mtime: number }> {
    let target = abs;
    if (st && (await fsp.lstat(abs)).isSymbolicLink()) {
      if (strict) throw new BackendFailure('OUTSIDE_WORKSPACE', `A link appeared at ${key}`);
      target = await fsp.realpath(abs); // write through, keep the link (its target is checked below: pageDirBefore)
    }
    await fsp.mkdir(path.dirname(target), { recursive: true });
    this.noteParents(key); // before the write: a watcher flush in between must see these as ours
    // Hard links and files owned by someone else must be rewritten in place, or the rename would detach them.
    const inPlace = !!st && (st.nlink > 1 || (!isWin && typeof process.getuid === 'function' && st.uid !== process.getuid()));
    if (strict) {
      if (inPlace) throw new BackendFailure('EACCES', `Not rewritten in place: ${key}`);
      await this.parentStillHere(key);
      // The file the guard checked, in its folder as just verified: the rename may only replace this one.
      const pin = st ? await fsp.lstat(target, { bigint: true }).catch(() => null) : null;
      if (st && (!pin || !pin.isFile())) throw new BackendFailure('EXTERNAL_CHANGE', `${key} changed during the write`);
      const w = await atomicWrite(target, data, st?.mode, { noFallback: true, pin });
      try {
        await this.parentStillHere(key, { ino: w.ino, restore: w.bak });
      } finally {
        if (w.bak) await fsp.unlink(w.bak).catch(() => {});
      }
    } else {
      // Page writes: the real folder is checked before the temp file is made, again right before it replaces the
      // file, and once more after (a write that landed outside through a link swapped in is taken back).
      const dir = await this.pageDirBefore(target, key);
      if (inPlace) {
        await writeInPlace(target, data);
        await this.pageDirAfter(target, key, dir); // nothing to take back: an existing file was rewritten
      } else {
        const w = await atomicWrite(target, data, st?.mode, { beforeReplace: () => this.pageDirBefore(target, key).then(() => {}) });
        await this.pageDirAfter(target, key, dir, w.inPlace ? {} : { ino: w.ino });
      }
    }
    const after = await fsp.stat(target);
    this.noteEntry(key, { kind: 'file', mtime: after.mtimeMs, size: after.size });
    return { mtime: after.mtimeMs };
  }

  async createFile(rel: string, content = '', guard?: WriteGuard): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    return this.withInflight(key, async () => {
      await this.real(key);
      await this.refuseGitDir(key);
      await this.refuseCaseClash(key);
      await guard?.(abs, 'target');
      if (guard?.strict && key.includes('/')) await this.mkdirStrict(key.slice(0, key.lastIndexOf('/')));
      else await fsp.mkdir(path.dirname(abs), { recursive: true });
      this.noteParents(key);
      if (guard?.strict) await this.parentStillHere(key);
      const dir = guard?.strict ? null : await this.pageDirBefore(abs, key);
      let ino = 0n;
      try {
        // 'wx': never over anything that appeared meanwhile (a link included).
        const fh = await fsp.open(abs, 'wx');
        try {
          await fh.writeFile(content);
          ino = (await fh.stat({ bigint: true })).ino;
        } finally {
          await fh.close();
        }
      } catch (err: any) {
        if (err?.code === 'EEXIST') throw new BackendFailure('EEXIST', `Already exists: ${rel}`);
        throw err;
      }
      if (guard?.strict) await this.parentStillHere(key, { ino });
      else await this.pageDirAfter(abs, key, dir!, { ino });
      const st = await fsp.stat(abs);
      this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
      return { mtime: st.mtimeMs };
    });
  }

  async createDir(rel: string, guard?: WriteGuard): Promise<void> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    await this.withInflight(key, async () => {
      await this.real(key);
      await this.refuseGitDir(key);
      await this.refuseCaseClash(key);
      const st = await fsp.stat(abs).catch(() => null);
      if (st) throw new BackendFailure('EEXIST', `Already exists: ${rel}`);
      await guard?.(abs, 'target');
      if (guard?.strict) await this.mkdirStrict(key);
      else {
        await fsp.mkdir(abs, { recursive: true });
        // Where the new folder really is: made outside through a link swapped in on the way → taken back (it is new
        // and empty: EEXIST above otherwise).
        await this.pageDirBefore(path.join(abs, 'x'), `${key}/x`).catch(async (err) => {
          await fsp.rmdir(abs).catch(() => {});
          throw err;
        });
      }
      this.noteEntry(key, { kind: 'dir' });
      this.watchDir(key);
    });
  }

  async rename(from: string, to: string, guard?: WriteGuard): Promise<void> {
    const src = normalize(from);
    const dst = normalize(to);
    if (!src || !dst) throw new BackendFailure('EINVAL', 'Cannot rename the workspace root');
    const a = this.abs(src);
    const b = this.abs(dst);
    if (a === b) return;
    await this.detectCase();
    const fold = (p: string) => (this.foldsCase ? p.toLowerCase() : p);
    if (fold(b).startsWith(fold(a) + path.sep)) throw new BackendFailure('EINVAL', 'Cannot move a folder into itself');
    // A folder or a link that moves changes where other paths lead (a link below the folder, a relative link's
    // target): it runs alone, never next to another change of this folder (the slot of the root, ''), so no
    // write, move or delete can be redirected through it half-way. Decided again inside the slot (WIDEN).
    const pre = await fsp.lstat(a).catch(() => null);
    let wide = !!pre && (pre.isDirectory() || pre.isSymbolicLink());
    for (;;) {
      try {
        return await this.withInflight([src, dst], () => this.renameNow(src, dst, a, b, from, to, wide, guard), wide);
      } catch (err) {
        if (err !== WIDEN) throw err;
        wide = true;
      }
    }
  }

  private async renameNow(src: string, dst: string, a: string, b: string, from: string, to: string, wide: boolean, guard?: WriteGuard): Promise<void> {
    await this.real(src, 'entry');
    await this.real(dst, 'entry');
    await this.refuseGitDir(src, 'entry');
    await this.refuseGitDir(dst, 'entry');
    // bigint: NTFS file ids exceed 2^53, as numbers two neighbours can compare equal.
    const sa = await fsp.lstat(a, { bigint: true }).catch(() => null);
    if (!sa || (await this.caseClash(src, new Map()))) throw new BackendFailure('ENOENT', `Not found: ${from}`);
    if (!wide && (sa.isDirectory() || sa.isSymbolicLink())) throw WIDEN;
    await this.refuseCaseClash(dst, src); // the source itself is fine: a case-only rename
    const sb = await fsp.lstat(b, { bigint: true }).catch(() => null);
    if (guard) {
      await guard(a, 'from');
      await guard(b, 'to');
    }
    if (guard?.strict && !(sb && sameEntry(sa, sb))) {
      // Never over something created in the window: a file is linked in (EEXIST when the name is taken)
      // and its old name removed; a folder can only replace an empty folder. Missing parent folders are
      // made one level at a time, each checked where it really is (a batch move into new subfolders).
      if (dst.includes('/')) await this.mkdirStrict(dst.slice(0, dst.lastIndexOf('/')));
      await this.parentStillHere(dst);
      // The source too: only the entry the guard checked (sa), from its folder as verified, before and
      // after it is linked in (its old name is removed last).
      await this.parentStillHere(src);
      const moved = await renameNoClobber(a, b, sa, () => this.parentStillHere(src));
      await this.parentStillHere(dst, { ino: moved, undoTo: a });
      this.moveEntries(src, dst);
      return;
    }
    if (sb) {
      // Same inode → case-only rename on a case-insensitive FS (Windows/macOS). Anything else is a real clash.
      if (!sameEntry(sa, sb)) throw new BackendFailure('EEXIST', `Already exists: ${to}`);
      // Short temp name: `${a}.suffix` would overflow NAME_MAX (255) for long file names.
      const tmp = path.join(path.dirname(a), `.~${crypto.randomBytes(4).toString('hex')}.sec-edit-rename-${Date.now()}`);
      const dir = guard?.strict ? null : await this.pageDirBefore(a, src);
      await retryWin(() => fsp.rename(a, tmp));
      await retryWin(() => fsp.rename(tmp, b));
      if (dir !== null) await this.pageDirAfter(b, dst, dir, { ino: sa.ino, undoTo: a });
    } else {
      await fsp.mkdir(path.dirname(b), { recursive: true });
      // Page moves: both folders checked where they really are right before the move, the target's again after
      // (an entry that landed outside through a link swapped in is moved back).
      const dirs = guard?.strict ? null : [await this.pageDirBefore(a, src), await this.pageDirBefore(b, dst)];
      try {
        await retryWin(() => fsp.rename(a, b));
      } catch (err: any) {
        if (err?.code !== 'EXDEV') throw err;
        await fsp.cp(a, b, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        await fsp.rm(a, { recursive: true, force: true });
      }
      if (dirs) await this.pageDirAfter(b, dst, dirs[1], { ino: sa.ino, undoTo: a });
    }
    this.moveEntries(src, dst);
  }

  /** Removes via `trash` when given (OS recycle bin), else hard delete. */
  async remove(rel: string, trash?: (abs: string) => Promise<void>, guard?: WriteGuard): Promise<void> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Refusing to delete workspace root');
    const abs = this.abs(key);
    // A link removed: alone, like a moved one (see rename).
    let wide = !!(await fsp.lstat(abs).catch(() => null))?.isSymbolicLink();
    for (;;) {
      try {
        return await this.withInflight(key, () => this.removeNow(key, abs, rel, wide, trash, guard), wide);
      } catch (err) {
        if (err !== WIDEN) throw err;
        wide = true;
      }
    }
  }

  private async removeNow(key: string, abs: string, rel: string, wide: boolean, trash?: (abs: string) => Promise<void>, guard?: WriteGuard): Promise<void> {
    await this.real(key, 'entry');
    await this.refuseGitDir(key, 'entry');
    const st = await fsp.lstat(abs).catch(() => null);
    // A stale spelling must not delete the twin it resolves to on a case-insensitive folder.
    if (!st || (await this.caseClash(key, new Map()))) throw new BackendFailure('ENOENT', `Not found: ${rel}`);
    if (!wide && st.isSymbolicLink()) throw WIDEN;
    const pin = await fsp.lstat(abs, { bigint: true }).catch(() => null);
    await guard?.(abs, 'target');
    if (guard?.strict) await this.parentStillHere(key);
    else await this.pageDirBefore(abs, key); // page deletes: the folder where it really is, right before
    // Still the entry that was checked, in its folder: never trash what a racer put in its place.
    const now = await fsp.lstat(abs, { bigint: true }).catch(() => null);
    if (!pin || !now || !sameEntry(pin, now) || (guard?.strict && now.isSymbolicLink())) throw new BackendFailure('EXTERNAL_CHANGE', `${rel} changed during the delete`);
    if (trash) await trash(abs);
    else await retryWin(() => fsp.rm(abs, { recursive: true, force: true }));
    this.dropEntries(key);
  }

  /** @deprecated use remove(rel) */
  removeHard(rel: string) {
    return this.remove(rel);
  }

  /** Every index entry (text files plus name-only entries), sorted by path. Prefer readAllTextPage for big folders. */
  async readAllText(): Promise<FileData[]> {
    const out: FileData[] = [];
    let cursor: string | null = null;
    do {
      const page: TextPage = await this.readAllTextPage({ cursor, maxBytes: PAGE_MAX });
      for (const f of page.files) out.push(f);
      cursor = page.nextCursor;
      if (cursor) await yieldLoop();
    } while (cursor);
    return out;
  }

  /**
   * One page of readAllText. The cursor is the last path examined, so a page never repeats or skips a
   * file even if the tree changes in between (new files sorting before it arrive as watcher events).
   */
  async readAllTextPage(opts: TextPageOptions = {}): Promise<TextPage> {
    const ix = await this.indexer();
    const { stamps, ...page } = await ix.page(typeof opts.cursor === 'string' ? opts.cursor : null, opts.maxBytes);
    this.applyStamps(stamps);
    return page;
  }

  /** The same page as UTF-8 JSON bytes, untouched by this thread (the index channel forwards them). */
  async readAllTextPageRaw(opts: TextPageOptions = {}): Promise<Uint8Array> {
    const ix = await this.indexer();
    const r: Raw = await ix.pageRaw(typeof opts.cursor === 'string' ? opts.cursor : null, opts.maxBytes);
    this.applyStamps(r.stamps);
    return r.body;
  }

  /**
   * Paths the indexer may read on request. Listed files are inside the folder by construction (the
   * walk and the watcher leave out links that point outside); anything else — a file the watcher has
   * not reported yet, or a path the caller made up ("link/…") — is resolved first. Refused ones read as gone.
   */
  private async readable(paths: string[]): Promise<{ ok: string[]; refused: string[] }> {
    const ok: string[] = [];
    const refused: string[] = [];
    for (const p of paths.map(normalize).filter(Boolean)) {
      // Excluded / hidden places are never indexed, however a path to one arrives (an open vendor/ file closing).
      if (this.matcher.path(p)) {
        refused.push(p);
        continue;
      }
      // real() also refuses One's data folder (as written and where it really is): a listed path can lead
      // there through a link, so even listed paths take that check here.
      const known = (this.index.get(p)?.kind === 'file' && !this.denyDirs.length) || (await this.real(p).then(() => true, () => false));
      if (known && !(this.skipLinks && (await this.throughLink(p)))) ok.push(p);
      else refused.push(p);
    }
    return { ok, refused };
  }

  /** Incremental index update: current text of changed files, as UTF-8 JSON {files, skipped, gone}. */
  async readIndexedFilesRaw(paths: string[]): Promise<Uint8Array> {
    const ix = await this.indexer();
    const { ok, refused } = await this.readable(paths);
    const r = await ix.readFilesRaw(ok);
    this.applyStamps(r.stamps);
    if (!refused.length) return r.body;
    const res = JSON.parse(Buffer.from(r.body).toString('utf8')) as { gone: string[] };
    res.gone.push(...refused);
    return Buffer.from(JSON.stringify(res), 'utf8');
  }

  async readIndexedFiles(paths: string[]) {
    const ix = await this.indexer();
    const { ok, refused } = await this.readable(paths);
    const { stamps, ...r } = await ix.readFiles(ok);
    this.applyStamps(stamps);
    r.gone.push(...refused);
    return r;
  }

  /** The last completed full pass: files read vs. served from the cache (`written`: its cache write). */
  get lastPass() {
    return this.host?.lastPass ?? null;
  }

  /** Called when a full index pass starts (tests, activity log). */
  onPass(cb: () => void) {
    this.passCbs.add(cb);
    return () => this.passCbs.delete(cb);
  }

  private async indexer(): Promise<IndexerHost> {
    if (!this.indexed) await this.listTree();
    // deny: One's data folder, as spelled and by identity (root-relative): the pass checks where files below a
    // link really are against both.
    const deny = this.denyDirs.length ? await this.denyInfo() : null;
    if (!this.host) {
      await this.detectCase();
      // The cache file is named after the root with this folder's case rule: "Proj" and "proj" on a case-sensitive
      // disk are two folders with two caches (case-folding roots keep the name they always had).
      const cacheFile = this.cacheDir ? cacheFileFor(this.cacheDir, this.root, this.foldsCase) : null;
      const cfg = { root: this.root, cacheFile, readThreads: this.readThreads, index: this.indexOpts, foldCase: this.foldsCase, deny: this.denyDirs, denyRels: deny?.rels ?? [], denyAll: !!deny?.rootInside };
      const src = indexerSource();
      let host: IndexerHost | null = null;
      if (src) {
        try {
          host = new WorkerIndexerHost(src, cfg);
        } catch {
          host = null; // no worker threads here: index in this thread
        }
      }
      this.host = host ?? new LocalIndexerHost(cfg);
      this.host.onPassStart(() => this.passCbs.forEach((f) => f()));
    }
    this.syncIndexPaths();
    return this.host;
  }

  /** Process explorer: the indexer thread and its reader threads, with their state and why. */
  async processRows(): Promise<ProcRow[]> {
    const host = this.host;
    const row: ProcRow = { id: 'indexer', parent: 'main', kind: 'thread', name: 'Indexer', activity: ['index', 'index-update'], actions: ['restartIndexer'] };
    if (!host) {
      const why = !this.indexed ? 'folder not listed yet' : this.warmIndexer ? 'nothing asked for text yet' : 'index built on demand, not asked for yet';
      return [{ ...row, state: 'not started', detail: why }];
    }
    const st = await host.stats?.().catch(() => null);
    if (!st) return [{ ...row, state: 'running' }];
    const pass = st.lastPass ? `last pass: ${st.lastPass.read.toLocaleString()} read, ${st.lastPass.cached.toLocaleString()} from cache` : '';
    if (!st.running) {
      const since = st.stoppedIdleAt ? ` ${Math.round((Date.now() - st.stoppedIdleAt) / 1000)} s ago` : '';
      return [{ ...row, state: 'stopped', detail: [`idle${since}, restarts when text is needed`, pass].filter(Boolean).join(' · ') }];
    }
    const rows: ProcRow[] = [{ ...row, name: st.inWorker ? 'Indexer (thread)' : 'Indexer (in this process)', state: st.passOpen ? 'indexing' : 'idle', busy: st.busy == null ? null : st.busy * 100, mem: st.heapBytes == null ? null : Math.round((st.heapBytes / 1048576) * 10) / 10, memKind: 'JS heap', detail: pass || undefined }];
    if (st.pool && st.pool.max > 0)
      rows.push({ id: 'readers', parent: 'indexer', kind: 'thread', name: 'Reader threads', state: st.pool.running ? (st.pool.busy ? 'reading' : 'idle') : 'stopped', detail: `${st.pool.running} of up to ${st.pool.max} running, ${st.pool.busy} reading${st.pool.running ? '' : ' (start with the next pass)'}` });
    return rows;
  }

  /** Process explorer → "Restart indexer": a fresh thread on the next request (the UI rebuilds). */
  restartIndexer() {
    const host = this.host;
    this.host = null;
    this.sentVersion = '';
    host?.dispose();
  }

  /** Sends the file list to the indexer when it changed (one array; it does all filtering and I/O). */
  private syncIndexPaths() {
    const version = `${this.indexVersion}:${this.ignoreVersion}`;
    if (!this.host || version === this.sentVersion) return;
    this.sentVersion = version;
    this.host.setPaths({ version, files: this.filePaths(), ignoreDirs: [...this.ignoreDirs], repoDirs: [...this.repoDirs], links: [...this.links] });
    const apply = (sets: Parameters<typeof IgnoreStack.fromJSON>[0]) => {
      if (this.sentVersion !== version) return;
      this.hintIgnore = sets.length ? IgnoreStack.fromJSON(sets, this.foldsCase) : null;
      // Git-ignored folders (build output) need no watch at all: their events are dropped anyway.
      if (this.hintIgnore && this.watch?.wantsDirs) for (const [k, v] of this.index) if (v.kind === 'dir' && this.hintIgnore.ignored(k, true) && !this.hintIgnore.ignored(parentOf(k), true)) this.watch.removeDir(k);
    };
    const rules = this.host.ignoreRules();
    if (Array.isArray(rules)) apply(rules);
    else rules.then(apply, () => {});
  }

  /** mtime + size of files the indexer examined: change detection after a rescan stays precise. */
  private applyStamps(stamps: Stamp[]) {
    for (const [p, mtime, size] of stamps) {
      const e = this.index.get(p);
      if (e?.kind === 'file' && (e.mtime !== mtime || e.size !== size)) this.index.set(p, { kind: 'file', mtime, size });
    }
  }

  /** Is `rel` skipped by the indexers (ignored / generated)? The tree still shows it. */
  isIndexSkipped(rel: string): boolean {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const o = this.indexOpts;
    if ((o.skipLockfiles && isLockfile(name)) || (o.skipMinified && isMinified(name))) return true;
    return o.respectGitignore && !!this.hintIgnore?.ignored(rel);
  }

  // ---- index bookkeeping ----------------------------------------------------------------------

  /** Record the parent folders of `rel` (just created by our own mkdir -p) so the watcher does not
   *  report them back as external `addDir`s. Call right after mkdir, before the (slower) write. */
  private noteParents(rel: string) {
    for (let p = parentOf(rel); p; p = parentOf(p)) {
      if (this.index.get(p)?.kind === 'dir') break;
      if (this.matcher.path(p)) continue; // an excluded folder (a save into vendor/) is neither listed nor watched
      this.index.set(p, { kind: 'dir' });
      this.indexVersion++;
      this.watchDir(p);
    }
  }

  private noteEntry(rel: string, e: Entry) {
    if (this.matcher.path(rel)) return; // what the walk leaves out stays out (writes into vendor/, a move there)
    this.noteParents(rel); // mkdir -p via createFile/writeFile
    if (this.index.get(rel)?.kind !== e.kind) this.indexVersion++;
    this.index.set(rel, e);
  }

  private dropEntries(rel: string) {
    this.indexVersion++;
    for (const k of [...this.index.keys()]) if (isUnder(k, rel)) this.index.delete(k);
    for (const k of [...this.links]) if (isUnder(k, rel)) this.links.delete(k);
    this.watch?.removeDir(rel);
  }

  private moveEntries(from: string, to: string) {
    const moved: Array<[string, Entry]> = [];
    for (const [k, v] of this.index) if (isUnder(k, from)) moved.push([to + k.slice(from.length), v]);
    // Links move with their folder: what is below them is still checked by the index pass (a relative link can
    // lead outside from its new place).
    const links = [...this.links].filter((k) => isUnder(k, from)).map((k) => to + k.slice(from.length));
    this.dropEntries(from);
    for (const [k, v] of moved) {
      this.noteEntry(k, v);
      if (v.kind === 'dir') this.watchDir(k);
    }
    for (const k of links) if (this.index.has(k)) this.links.add(k);
  }

  /** `wide`: the slot of the root ('' overlaps every path): runs alone, after everything queued before it. */
  private async withInflight<T>(keys: string | string[], fn: () => Promise<T>, wide = false): Promise<T> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1);
    try {
      return await this.exclusive(wide ? [''] : list, fn);
    } finally {
      for (const k of list) {
        const n = (this.inflight.get(k) ?? 1) - 1;
        if (n <= 0) this.inflight.delete(k);
        else this.inflight.set(k, n);
      }
    }
  }

  /**
   * Runs mutations of overlapping paths (same file, or a folder and anything below it) one at a time,
   * in call order. Without this an autosave still syncing a big file could land *after* a newer
   * Ctrl+S (silently reverting it), or a pending write could recreate a file that was just renamed.
   */
  private async exclusive<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const fold = (k: string) => (this.foldsCase ? k.toLowerCase() : k);
    const mine = keys.map(fold);
    const overlaps = (a: string, b: string) => isUnder(a, b) || isUnder(b, a);
    // Registered synchronously, so later callers always queue behind earlier ones (no cycles possible).
    const before = [...this.ops].filter((o) => o.keys.some((k) => mine.some((m) => overlaps(k, m)))).map((o) => o.done);
    let release!: () => void;
    const op = { keys: mine, done: new Promise<void>((r) => (release = r)) };
    this.ops.add(op);
    try {
      await Promise.all(before);
      return await fn();
    } finally {
      this.ops.delete(op);
      release();
    }
  }

  private isBusy(rel: string) {
    for (const k of this.inflight.keys()) if (isUnder(rel, k)) return true;
    return false;
  }

  // ---- watching -------------------------------------------------------------------------------

  onEvents(cb: (e: FsEvent[]) => void): () => void {
    this.listeners.add(cb);
    this.ensureWatcher();
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.closeWatcher();
    };
  }

  get watching(): WatchMode | null {
    return this.watch?.mode ?? null;
  }

  private ensureWatcher() {
    if (this.watch || this.disposed) return;
    this.watch = createWatchBackend(this.root, { hint: (rel) => this.queue(rel), rescan: () => this.requestRescan() }, this.watchMode, this.pollMs, this.pollSource, this.matcher.names());
    if (this.indexed) this.syncWatchedDirs();
    else void this.listTree().catch(() => {});
  }

  private syncWatchedDirs() {
    if (!this.watch?.wantsDirs) return;
    this.watchDir('');
    for (const [k, v] of this.index) if (v.kind === 'dir') this.watchDir(k);
  }

  /** Resolves once queued hints have been processed (tests, and callers that want a settled state). */
  async settle(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
      await this.flush();
    }
    await this.flushing;
  }

  private queue(rel: string) {
    if (this.disposed) return;
    const clean = normalize(rel);
    // Ignore files are hidden but decide what gets indexed: the next pass re-reads them.
    if (clean === '.gitignore' || clean.endsWith('/.gitignore') || /(?:^|\/)\.git\/info\/exclude$/.test(clean)) {
      if (clean.endsWith('.gitignore')) this.ignoreDirs.add(parentOf(clean));
      this.ignoreVersion++;
      this.syncIndexPaths();
    }
    // Build output in a git-ignored folder (coverage/, target/ …): dropped before any stat or read.
    // The ignored folder itself still shows up / disappears in the tree.
    const parent = parentOf(clean);
    if (parent && this.indexOpts.respectGitignore && this.hintIgnore?.ignored(parent, true)) {
      this.droppedHints++;
      return;
    }
    if (!clean || this.matcher.path(clean)) {
      if (!clean) this.requestRescan(); // event on the root itself
      return;
    }
    this.pending.add(clean);
    this.schedule();
  }

  private requestRescan() {
    this.rescanRequested = true;
    this.schedule();
  }

  private schedule() {
    const now = Date.now();
    if (!this.flushTimer) this.batchStart = now;
    else clearTimeout(this.flushTimer);
    // Debounce bursts (git checkout, npm install), but never delay a batch by more than ~500ms.
    const wait = now - this.batchStart > 500 ? 0 : this.debounceMs;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      if (this.pending.size || this.rescanRequested) return this.flush();
      return;
    }
    this.flushing = (async () => {
      const events: FsEvent[] = [];
      if (this.rescanRequested) {
        this.rescanRequested = false;
        this.pending.clear();
        events.push(...(await this.rescan().catch(() => [] as FsEvent[])));
      } else {
        const hints = [...this.pending].sort((x, y) => depthOf(x) - depthOf(y));
        this.pending.clear();
        const deferred: string[] = [];
        const listings = new Map<string, Promise<Set<string> | null>>(); // one readdir per folder per batch
        for (const rel of hints) {
          if (this.isBusy(rel)) deferred.push(rel);
          else {
            // One bad hint (vanished mid-stat, name Win32 cannot open…) must not drop the rest of the batch
            // or surface as an unhandled rejection (Electron shows those as an error dialog).
            try {
              events.push(...(await this.reconcile(rel, listings)));
            } catch {}
          }
        }
        if (deferred.length) {
          for (const d of deferred) this.pending.add(d);
          setTimeout(() => this.schedule(), 50);
        }
      }
      if (events.length && !this.disposed) {
        for (const l of this.listeners) {
          try {
            l(events);
          } catch (err) {
            console.error('[sec-edit] fs event listener failed', err);
          }
        }
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

  /** Stat one hinted path and diff it against the index. */
  private async reconcile(rel: string, listings?: Map<string, Promise<Set<string> | null>>): Promise<FsEvent[]> {
    if (this.matcher.path(rel)) return [];
    // A recursive watcher reports everything below the root, One's data folder included: never indexed.
    if (this.denyDirs.length && (await this.deniedPath(rel))) return [];
    const parent = parentOf(rel);
    if (parent && this.index.get(parent)?.kind !== 'dir') {
      // Parent unknown: it probably just appeared (mkdir -p, folder moved in). Reconcile it instead; that walks it.
      const pst = await fsp.stat(this.abs(parent)).catch(() => null);
      return pst?.isDirectory() ? this.reconcile(parent, listings) : [];
    }
    const abs = this.abs(rel);
    // lstat first (one call for ordinary entries, as before): a link that appeared or was re-pointed is
    // an entry only while its target is inside the folder.
    const own = await fsp.lstat(abs).catch(() => null);
    let st = own?.isSymbolicLink() ? (!this.skipLinks && (await this.linkTarget(abs)) ? await fsp.stat(abs).catch(() => null) : null) : own;
    // Case-insensitive folder: after "Note.md" → "note.md" the old name still stats fine (it finds the
    // new one). Only the listing tells: else the old spelling comes back as a phantom twin.
    if (st && (await this.caseClash(rel, listings ?? new Map()))) st = null;
    const prev = this.index.get(rel);
    const events: FsEvent[] = [];
    const kind = st ? (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null) : null;
    // A link that appeared here (or a link replaced by a plain entry): the index pass must know (see `links`).
    const isLink = !!kind && !!own?.isSymbolicLink();
    if (isLink !== this.links.has(rel)) {
      if (isLink) this.links.add(rel);
      else this.links.delete(rel);
      this.indexVersion++;
    }
    if (prev && prev.kind !== kind) {
      events.push({ type: prev.kind === 'dir' ? 'unlinkDir' : 'unlink', path: rel });
      this.dropEntries(rel);
    }
    if (kind === 'dir' && prev?.kind !== 'dir') {
      events.push({ type: 'addDir', path: rel });
      this.noteEntry(rel, { kind: 'dir' });
      this.watchDir(rel);
      // A folder moved/copied in: report its contents too, so consumers never have to walk.
      const before = new Set(this.index.keys());
      await this.listTree(rel).catch(() => null);
      for (const [k, v] of this.index) {
        if (k !== rel && isUnder(k, rel) && !before.has(k)) events.push({ type: v.kind === 'dir' ? 'addDir' : 'add', path: k });
      }
    } else if (kind === 'file' && st) {
      if (prev?.kind !== 'file') {
        this.noteEntry(rel, { kind: 'file', mtime: st.mtimeMs, size: st.size });
        events.push({ type: 'add', path: rel, mtime: st.mtimeMs });
      } else if (prev.mtime !== st.mtimeMs || prev.size !== st.size) {
        this.index.set(rel, { kind: 'file', mtime: st.mtimeMs, size: st.size });
        events.push({ type: 'change', path: rel, mtime: st.mtimeMs });
      }
    }
    return events;
  }

  /** Full diff of disk vs index (watcher overflow, polling fallback). */
  private async rescan(): Promise<FsEvent[]> {
    const old = this.index;
    await this.listTree().catch(() => null);
    const now = this.index;
    const events: FsEvent[] = [];
    for (const [k, v] of old) {
      const n = now.get(k);
      if (n && n.kind === v.kind) continue;
      const p = parentOf(k);
      if (p && old.get(p)?.kind === 'dir' && now.get(p)?.kind !== 'dir') continue; // covered by parent's unlinkDir
      events.push({ type: v.kind === 'dir' ? 'unlinkDir' : 'unlink', path: k });
    }
    const added = [...now].filter(([k, v]) => old.get(k)?.kind !== v.kind).sort((x, y) => depthOf(x[0]) - depthOf(y[0]));
    for (const [k, v] of added) events.push({ type: v.kind === 'dir' ? 'addDir' : 'add', path: k });
    // Remember mtimes of new files so the next rescan can see them change (bounded: a big copy-in stays cheap).
    await Promise.all(
      added
        .filter(([, v]) => v.kind === 'file')
        .slice(0, 2000)
        .map(async ([k]) => {
          const st = await fsp.stat(this.abs(k)).catch(() => null);
          if (st) now.set(k, { kind: 'file', mtime: st.mtimeMs, size: st.size });
        }),
    );
    // Content changes: only for files we have seen (opened/saved) — that's what matters for open tabs.
    await Promise.all(
      [...now].map(async ([k, v]) => {
        const o = old.get(k);
        if (v.kind !== 'file' || o?.kind !== 'file' || o.mtime === undefined) return;
        const st = await fsp.stat(this.abs(k)).catch(() => null);
        if (st && (st.mtimeMs !== o.mtime || st.size !== o.size)) {
          now.set(k, { kind: 'file', mtime: st.mtimeMs, size: st.size });
          events.push({ type: 'change', path: k, mtime: st.mtimeMs });
        }
      }),
    );
    return events;
  }

  closeWatcher() {
    this.watch?.close();
    this.watch = null;
  }

  dispose() {
    this.disposed = true;
    this.bootTree = null;
    this.host?.dispose();
    this.host = null;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.closeWatcher();
    this.listeners.clear();
  }
}

function tooBigBinary(bytes: number) {
  return new BackendFailure('ETOOBIG', `File is too large (${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_BINARY_BYTES / 1048576} MB)`);
}

/** Same folder by identity (dev + ino). ino 0 = this file system gives no ids: never a match. */
const sameId = (a: fs.BigIntStats, b: fs.BigIntStats) => a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;

const ancestorsOf = (p: string): string[] => {
  const out: string[] = [];
  for (let c = p; ; c = path.dirname(c)) {
    out.push(c);
    if (path.dirname(c) === c) return out;
  }
};

/**
 * DenyInfo by identity: is an ancestor (or the root itself, as written or where it really is) a deny folder, and
 * which deny folders have the root as an ancestor (→ root-relative paths, checked by spelling from then on). A few
 * stats once per workspace, in parallel. A deny folder that does not exist yet is placed by its existing ancestors.
 */
async function denyIdentity(root: string, deny: string[], withRels = true): Promise<DenyInfo> {
  const big = (p: string) => fsp.stat(p, { bigint: true }).catch(() => null);
  const native = (p: string) => fsp.realpath(p).catch(() => null);
  const [realRoot, denyReal] = await Promise.all([native(root), Promise.all(deny.map(native))]);
  const rootAnc = [...new Set([...ancestorsOf(root), ...(realRoot ? ancestorsOf(realRoot) : [])])];
  const denyAll = [...new Set([...deny, ...denyReal.filter((p): p is string => !!p)])];
  const [rootAncSt, denySt] = await Promise.all([Promise.all(rootAnc.map(big)), Promise.all(denyAll.map(big))]);
  const denyIds = denySt.filter((s): s is fs.BigIntStats => !!s);
  const rootInside = rootAncSt.some((s) => !!s && denyIds.some((d) => sameId(s, d)));
  const rootSt = rootAncSt[0];
  const rels = new Set<string>();
  if (rootSt && withRels)
    await Promise.all(
      denyAll.map(async (d) => {
        const anc = ancestorsOf(d).slice(1);
        const sts = await Promise.all(anc.map(big));
        const i = sts.findIndex((s) => !!s && sameId(s, rootSt));
        if (i !== -1) rels.add(path.relative(anc[i], d).split(path.sep).join('/'));
      }),
    );
  return { rels: [...rels], rootInside };
}

/**
 * Is folder `dir` one of `folders` or inside one: as written, where it really is (links resolved), or by identity
 * (an ancestor IS one: 8.3 names, `\\localhost\c$`, firmlinks, bind mounts). Folds case except on Linux.
 */
export async function insideAnyFolder(dir: string, folders: string[]): Promise<boolean> {
  const fold = process.platform !== 'linux';
  const list = folders.filter(Boolean).map((d) => path.resolve(d));
  if (!list.length) return false;
  const [real, reals] = await Promise.all([fsp.realpath(dir).catch(() => null), Promise.all(list.map((d) => fsp.realpath(d).catch(() => null)))]);
  const all = [...list, ...reals.filter((d): d is string => !!d)];
  if ([dir, real].some((p) => !!p && all.some((d) => isInsideDir(p, d, path, fold)))) return true;
  return (await denyIdentity(dir, list, false)).rootInside;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}


export async function retryWin<T>(fn: () => Promise<T>): Promise<T> {
  // Windows: antivirus/indexer/Explorer briefly hold handles → EPERM/EBUSY/EACCES. Back off and retry.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isWin || attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      await sleep(10 * 2 ** attempt);
    }
  }
}

/** Rename without ever replacing an existing file: link + unlink (EEXIST if the name is taken), else an
 *  exclusive copy. Folders: a plain rename (it can only replace an empty folder). Returns the moved inode. */
/**
 * Strict move: never over an entry that appeared meanwhile, and only the entry `pin` (the one the guard
 * checked). A file is hard-linked in (EEXIST when the name is taken), checked, and its old name removed
 * last, after `beforeUnlink` (the source folder re-check); a failed removal takes the new link back so no
 * second name is left. A folder is renamed only when the target is absent. Returns the moved inode.
 */
async function renameNoClobber(a: string, b: string, pin: fs.BigIntStats, beforeUnlink: () => Promise<void>): Promise<bigint> {
  const same = (s: fs.BigIntStats | null) => !!s && sameEntry(pin, s) && !s.isSymbolicLink();
  const changed = () => new BackendFailure('EXTERNAL_CHANGE', 'Changed during the move');
  if (!same(await fsp.lstat(a, { bigint: true }).catch(() => null))) throw changed();
  if (pin.isDirectory()) {
    if (await fsp.lstat(b).then(() => true, () => false)) throw new BackendFailure('EEXIST', 'Already exists');
    await retryWin(() => fsp.rename(a, b));
    return pin.ino;
  }
  let linked = true;
  try {
    await fsp.link(a, b);
  } catch (err: any) {
    if (err?.code === 'EEXIST') throw new BackendFailure('EEXIST', 'Already exists');
    // No hard links here (FAT, some network shares): an exclusive copy, then the original goes.
    linked = false;
    await fsp.copyFile(a, b, fs.constants.COPYFILE_EXCL).catch((e) => {
      throw e?.code === 'EEXIST' ? new BackendFailure('EEXIST', 'Already exists') : e;
    });
  }
  const undo = () => fsp.unlink(b).catch(() => {});
  try {
    if (linked && !same(await fsp.lstat(b, { bigint: true }).catch(() => null))) throw changed();
    if (!same(await fsp.lstat(a, { bigint: true }).catch(() => null))) throw changed();
    await beforeUnlink();
    await retryWin(() => fsp.unlink(a));
  } catch (err) {
    await undo(); // e.g. Windows: the file is in use and keeps its old name: no nlink-2 lockout left behind
    throw err;
  }
  return linked ? pin.ino : (await fsp.lstat(b, { bigint: true })).ino;
}

/**
 * Rewrites an existing regular file in place (hard links, a file of another owner, a target locked against
 * replacement). Never through a link: the name must be a regular file (lstat), opened without following a link
 * where the OS can (O_NOFOLLOW), and still that file once opened. No O_TRUNC / O_CREAT: Windows refuses those on
 * hidden files, and nothing is created.
 */
export async function writeInPlace(target: string, data: Buffer): Promise<void> {
  const lst = await fsp.lstat(target, { bigint: true });
  if (!lst.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${path.basename(target)}`);
  const fh = await fsp.open(target, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile() || !sameEntry(lst, st)) throw new BackendFailure('EXTERNAL_CHANGE', `${path.basename(target)} changed during the write`);
    await fh.truncate(0);
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/** The first `bytes` of an opened file (from offset 0). */
async function readHeadFh(fh: fsp.FileHandle, bytes: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(Math.max(0, bytes));
  let n = 0;
  while (n < bytes) {
    const { bytesRead } = await fh.read(buf, n, bytes - n, n);
    if (!bytesRead) break;
    n += bytesRead;
  }
  return buf.subarray(0, n);
}

/** Write temp sibling → fsync → rename over the target, so a crash never truncates a note. Returns the
 *  written file's inode. `noFallback`: never rewrite the target in place when the rename fails.
 *  `beforeReplace`: a last check right before the target is replaced (rename or in-place fallback); throwing
 *  cancels the write (the temp file goes). `inPlace`: the fallback rewrote the target. */
export async function atomicWrite(target: string, data: Buffer, mode?: number, o: { noFallback?: boolean; pin?: fs.BigIntStats | null; beforeReplace?: () => Promise<void> } = {}): Promise<{ ino: bigint; bak: string | null; inPlace?: boolean }> {
  // At most 32 code points of the original name: long names (≥ ~230 bytes) would otherwise push the temp
  // name past NAME_MAX (255) and every save of that file would fail with ENAMETOOLONG.
  const short = Array.from(path.basename(target)).slice(0, 32).join('');
  const tmp = path.join(path.dirname(target), `.~${short}.${crypto.randomBytes(4).toString('hex')}.sec-edit.tmp`);
  const fh = await fsp.open(tmp, 'wx', mode !== undefined ? mode & 0o777 : 0o666);
  let ino = 0n;
  try {
    await fh.writeFile(data);
    await fh.datasync();
    ino = (await fh.stat({ bigint: true })).ino;
  } catch (err) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  if (mode !== undefined && !isWin) await fsp.chmod(tmp, mode & 0o7777).catch(() => {});
  // Strict: pin the file the rename will replace with a hard link next to it (same folder, whatever that
  // folder is by now) and check it is the one the guard saw; a caller that finds the folder moved under
  // it puts the pinned file back. No hard links (FAT, exFAT, some SMB): the same check on the name itself.
  let bak: string | null = null;
  if (o.pin) {
    const b = path.join(path.dirname(target), `.~${short}.${crypto.randomBytes(4).toString('hex')}.sec-edit.bak`);
    const linked = await fsp.link(target, b).then(() => true, () => false);
    if (linked) bak = b;
    const cur = await fsp.lstat(linked ? b : target, { bigint: true }).catch(() => null);
    if (!cur || cur.dev !== o.pin.dev || cur.ino !== o.pin.ino) {
      if (bak) await fsp.unlink(bak).catch(() => {});
      await fsp.rm(tmp, { force: true });
      throw new BackendFailure('EXTERNAL_CHANGE', 'The file changed during the write');
    }
  }
  try {
    await o.beforeReplace?.();
  } catch (err) {
    if (bak) await fsp.unlink(bak).catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  try {
    await retryWin(() => fsp.rename(tmp, target));
  } catch (err) {
    if (bak) await fsp.unlink(bak).catch(() => {});
    // Only a regular file is rewritten in place: never a link (it would write wherever the link leads), a
    // folder or a device that took the name meanwhile.
    const lst = o.noFallback ? null : await fsp.lstat(target).catch(() => null);
    if (!lst?.isFile()) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    // Target locked against replacement (some sync clients / editors): rewrite it in place instead.
    try {
      await o.beforeReplace?.();
      await writeInPlace(target, data);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return { ino: (await fsp.stat(target, { bigint: true })).ino, bak: null, inPlace: true };
  }
  return { ino, bak };
}
