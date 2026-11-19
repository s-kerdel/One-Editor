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
import { MAX_BINARY_BYTES, type Eol, type FileData, type FsEvent, type TextEncoding, type TextPage, type TextPageOptions, type TreeNode, type WorkspaceInfo, type WriteOptions } from '../shared/api';
import { normalize } from '../shared/paths';
import { decode, detectEol, encode, toLf, withEol } from './textcodec';
import { createExcludeMatcher, type ExcludeMatcher } from './exclude';
import { createWatchBackend, defaultWatchMode, type WatchBackend, type WatchMode } from './watcher';
import { BackendFailure } from './errors';
import { relativeInside, resolveInside } from './pathsafe';
import { isProbablyTextName } from './textnames';
export { isProbablyTextName } from './textnames';
import { IgnoreStack, isLockfile, isMinified } from './gitignore';
import { defaultReadThreads } from './readpool';
import { cacheFileFor } from './indexcache';
import { DEFAULT_INDEX, MAX_INDEX_BYTES, type IndexOptions, type Stamp } from './indexer';
import { LocalIndexerHost, WorkerIndexerHost, indexerSource, type IndexerHost, type Raw } from './indexer-host';
import { fsDelayAsync } from './fsdelay';

export { detectEol } from './textcodec';
export { MAX_INDEX_BYTES, type IndexOptions } from './indexer';
export { BackendFailure } from './errors';

const MAX_OPEN_BYTES = 48 * 1024 * 1024;
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
  /** Skip the probe (tests). true = names differ by case. */
  caseSensitive?: boolean;
}

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
  private readonly cacheFile: string | null;
  private readonly readThreads: number;
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
    this.cacheFile = opts.cacheDir ? cacheFileFor(opts.cacheDir, this.root) : null;
    this.readThreads = opts.readThreads ?? defaultReadThreads(this.root);
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
    if (base) {
      for (const d of [...ignoreDirs]) if (isUnder(d, base)) ignoreDirs.delete(d);
      for (const d of [...repoDirs]) if (isUnder(d, base)) repoDirs.delete(d);
    }

    const walk = async (absDir: string, relDir: string, depth: number, followed: string[]): Promise<TreeNode[]> => {
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
        if (e.isDirectory()) {
          const node: TreeNode = { name: e.name, path: rel, kind: 'dir', children: [] };
          index.set(rel, { kind: 'dir' });
          nodes.push(node);
          if (depth < MAX_DEPTH) pending.push(walk(abs, rel, depth + 1, followed).then((c) => void (node.children = c)));
        } else if (e.isFile()) {
          nodes.push({ name: e.name, path: rel, kind: 'file' });
          const old = known.get(rel);
          index.set(rel, old?.kind === 'file' ? old : { kind: 'file' });
        } else if (e.isSymbolicLink()) {
          pending.push(
            (async () => {
              const st = await fsp.stat(abs).catch(() => null); // broken links are skipped
              if (!st) return;
              if (st.isFile()) {
                nodes.push({ name: e.name, path: rel, kind: 'file', symlink: true });
                index.set(rel, { kind: 'file' });
              } else if (st.isDirectory()) {
                const node: TreeNode = { name: e.name, path: rel, kind: 'dir', symlink: true, children: [] };
                nodes.push(node);
                index.set(rel, { kind: 'dir' });
                // Symlink loops: never follow a link whose target contains the current dir or was already followed.
                const real = await fsp.realpath(abs).catch(() => null);
                const here = await fsp.realpath(absDir).catch(() => absDir);
                const cmp = (p: string) => (fold ? p.toLowerCase() : p);
                if (!real || followed.includes(cmp(real)) || cmp(here + path.sep).startsWith(cmp(real + path.sep)) || cmp(here) === cmp(real)) return;
                if (depth < MAX_DEPTH) node.children = await walk(abs, rel, depth + 1, [...followed, cmp(real)]);
              }
            })(),
          );
        }
      }
      await Promise.all(pending);
      return nodes.sort(compareNodes);
    };

    if (!base) this.fullWalks++;
    const children = await walk(absBase, base, depthOf(base), []);
    this.indexVersion++;
    this.ignoreVersion++;
    if (!base) {
      this.index = index;
      this.ignoreDirs = ignoreDirs;
      this.repoDirs = repoDirs;
      const first = !this.indexed;
      this.indexed = true;
      this.syncWatchedDirs();
      if (first && this.watch?.mode === 'perdir') setImmediate(() => void this.catchUpAfterWalk(walkStart).catch(() => {}));
      // The indexers ask for text right after boot: start the indexer thread and its readers now —
      // just after this tree has gone out (starting a thread and posting 10k paths costs the main
      // thread ms the waiting window should not pay).
      if (first && this.cacheFile !== undefined && !this.disposed) setImmediate(() => !this.disposed && void this.indexer().then((h) => h.warm(), () => {}));
    } else if (this.watch?.wantsDirs) {
      this.watchDir(base);
      for (const [k, v] of index) if (v.kind === 'dir' && isUnder(k, base)) this.watchDir(k);
    }
    const node: TreeNode = { name: base ? path.basename(absBase) : path.basename(this.root) || this.root, path: base, kind: 'dir', children };
    if (truncated) node.truncated = true;
    return node;
  }

  /** Every indexed file path (after the first listTree). */
  filePaths(): string[] {
    const out: string[] = [];
    for (const [k, v] of this.index) if (v.kind === 'file') out.push(k);
    return out;
  }

  // ---- reading / writing ----------------------------------------------------------------------

  async readFile(rel: string): Promise<FileData> {
    const key = normalize(rel);
    const abs = this.abs(key);
    await fsDelayAsync(); // tests: latency injection (slow bridge / antivirus)
    try {
      const st = await fsp.stat(abs);
      // Never open "Note.md" as a twin "note.md" document (a later save would rename it on disk).
      const clash = await this.caseClash(key);
      if (clash) throw new BackendFailure('ENOENT', `File not found: ${rel} (“${clash}” differs only in case)`);
      if (st.isDirectory()) throw new BackendFailure('EISDIR', `Is a folder: ${rel}`);
      // FIFOs / sockets / devices: reading would block a libuv thread forever (and stall indexing).
      if (!st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${rel}`);
      if (st.size > MAX_OPEN_BYTES) throw new BackendFailure('ETOOBIG', `File is too large to open (${Math.round(st.size / 1048576)} MB): ${rel}`);
      const buf = await fsp.readFile(abs);
      const d = decode(buf);
      this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
      this.touchHot(key);
      const eol = detectEol(d.text);
      const data: FileData = { path: key, content: toLf(d.text), mtime: st.mtimeMs, eol, size: st.size };
      if (d.bom) data.bom = true;
      if (d.encoding !== 'utf8') data.encoding = d.encoding;
      if (d.binary) data.binary = true;
      return data;
    } catch (err: any) {
      if (err?.code === 'ENOENT') throw new BackendFailure('ENOENT', `File not found: ${rel}`);
      throw err;
    }
  }

  async writeFile(rel: string, content: string, opts: WriteOptions = {}): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    return this.withInflight(key, async () => {
      await this.refuseCaseClash(key);
      const st = await this.statForWrite(abs, rel);
      if (st && opts.expectedMtime !== undefined && Math.abs(st.mtimeMs - opts.expectedMtime) > 1) {
        throw new BackendFailure('EXTERNAL_CHANGE', `File changed on disk: ${rel}`);
      }
      if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${rel}`);
      let { eol, bom, encoding } = opts as { eol?: Eol; bom?: boolean; encoding?: TextEncoding };
      if (st && (eol === undefined || bom === undefined || encoding === undefined)) {
        const d = decode(await fsp.readFile(abs));
        eol ??= detectEol(d.text);
        bom ??= d.bom;
        encoding ??= d.encoding;
      }
      return this.commit(key, abs, st, encode(withEol(content, eol ?? 'lf'), encoding ?? 'utf8', bom ?? false));
    });
  }

  /**
   * Raw bytes (pasted images, attachments): same guarantees as writeFile — contained path, serialised
   * with every other mutation of the path, atomic, no watcher echo. Creates parent folders, overwrites.
   */
  async writeBinary(rel: string, data: Uint8Array): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    if (data.byteLength > MAX_BINARY_BYTES) throw tooBigBinary(data.byteLength);
    return this.withInflight(key, async () => {
      await this.refuseCaseClash(key);
      const st = await this.statForWrite(abs, rel);
      if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${rel}`);
      return this.commit(key, abs, st, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
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
  private async commit(key: string, abs: string, st: fs.Stats | null, data: Buffer): Promise<{ mtime: number }> {
    let target = abs;
    if (st && (await fsp.lstat(abs)).isSymbolicLink()) target = await fsp.realpath(abs); // write through, keep the link
    await fsp.mkdir(path.dirname(target), { recursive: true });
    this.noteParents(key); // before the write: a watcher flush in between must see these as ours
    // Hard links and files owned by someone else must be rewritten in place, or the rename would detach them.
    const inPlace = !!st && (st.nlink > 1 || (!isWin && typeof process.getuid === 'function' && st.uid !== process.getuid()));
    if (inPlace) await fsp.writeFile(target, data);
    else await atomicWrite(target, data, st?.mode);
    const after = await fsp.stat(target);
    this.noteEntry(key, { kind: 'file', mtime: after.mtimeMs, size: after.size });
    return { mtime: after.mtimeMs };
  }

  async createFile(rel: string, content = ''): Promise<{ mtime: number }> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    return this.withInflight(key, async () => {
      await this.refuseCaseClash(key);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      this.noteParents(key);
      try {
        await fsp.writeFile(abs, content, { flag: 'wx' });
      } catch (err: any) {
        if (err?.code === 'EEXIST') throw new BackendFailure('EEXIST', `Already exists: ${rel}`);
        throw err;
      }
      const st = await fsp.stat(abs);
      this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
      return { mtime: st.mtimeMs };
    });
  }

  async createDir(rel: string): Promise<void> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('EINVAL', 'Empty path');
    const abs = this.abs(key);
    await this.withInflight(key, async () => {
      await this.refuseCaseClash(key);
      const st = await fsp.stat(abs).catch(() => null);
      if (st) throw new BackendFailure('EEXIST', `Already exists: ${rel}`);
      await fsp.mkdir(abs, { recursive: true });
      this.noteEntry(key, { kind: 'dir' });
      this.watchDir(key);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalize(from);
    const dst = normalize(to);
    if (!src || !dst) throw new BackendFailure('EINVAL', 'Cannot rename the workspace root');
    const a = this.abs(src);
    const b = this.abs(dst);
    if (a === b) return;
    await this.detectCase();
    const fold = (p: string) => (this.foldsCase ? p.toLowerCase() : p);
    if (fold(b).startsWith(fold(a) + path.sep)) throw new BackendFailure('EINVAL', 'Cannot move a folder into itself');
    await this.withInflight([src, dst], async () => {
      // bigint: NTFS file ids exceed 2^53, as numbers two neighbours can compare equal.
      const sa = await fsp.lstat(a, { bigint: true }).catch(() => null);
      if (!sa || (await this.caseClash(src, new Map()))) throw new BackendFailure('ENOENT', `Not found: ${from}`);
      await this.refuseCaseClash(dst, src); // the source itself is fine: a case-only rename
      const sb = await fsp.lstat(b, { bigint: true }).catch(() => null);
      if (sb) {
        // Same inode → case-only rename on a case-insensitive FS (Windows/macOS). Anything else is a real clash.
        if (!sameEntry(sa, sb)) throw new BackendFailure('EEXIST', `Already exists: ${to}`);
        // Short temp name: `${a}.suffix` would overflow NAME_MAX (255) for long file names.
        const tmp = path.join(path.dirname(a), `.~${crypto.randomBytes(4).toString('hex')}.sec-edit-rename-${Date.now()}`);
        await retryWin(() => fsp.rename(a, tmp));
        await retryWin(() => fsp.rename(tmp, b));
      } else {
        await fsp.mkdir(path.dirname(b), { recursive: true });
        try {
          await retryWin(() => fsp.rename(a, b));
        } catch (err: any) {
          if (err?.code !== 'EXDEV') throw err;
          await fsp.cp(a, b, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
          await fsp.rm(a, { recursive: true, force: true });
        }
      }
      this.moveEntries(src, dst);
    });
  }

  /** Removes via `trash` when given (OS recycle bin), else hard delete. */
  async remove(rel: string, trash?: (abs: string) => Promise<void>): Promise<void> {
    const key = normalize(rel);
    if (!key) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Refusing to delete workspace root');
    const abs = this.abs(key);
    await this.withInflight(key, async () => {
      const st = await fsp.lstat(abs).catch(() => null);
      // A stale spelling must not delete the twin it resolves to on a case-insensitive folder.
      if (!st || (await this.caseClash(key, new Map()))) throw new BackendFailure('ENOENT', `Not found: ${rel}`);
      if (trash) await trash(abs);
      else await retryWin(() => fsp.rm(abs, { recursive: true, force: true }));
      this.dropEntries(key);
    });
  }

  /** @deprecated use remove(rel) */
  removeHard(rel: string) {
    return this.remove(rel);
  }

  /** Every indexable text file, sorted by path. Prefer readAllTextPage for big folders. */
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

  /** Incremental index update: current text of changed files, as UTF-8 JSON {files, skipped, gone}. */
  async readIndexedFilesRaw(paths: string[]): Promise<Uint8Array> {
    const ix = await this.indexer();
    const r = await ix.readFilesRaw(paths.map(normalize).filter(Boolean));
    this.applyStamps(r.stamps);
    return r.body;
  }

  async readIndexedFiles(paths: string[]) {
    const ix = await this.indexer();
    const { stamps, ...r } = await ix.readFiles(paths.map(normalize).filter(Boolean));
    this.applyStamps(stamps);
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
    if (!this.host) {
      await this.detectCase();
      const cfg = { root: this.root, cacheFile: this.cacheFile, readThreads: this.readThreads, index: this.indexOpts, foldCase: this.foldsCase };
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

  /** Sends the file list to the indexer when it changed (one array; it does all filtering and I/O). */
  private syncIndexPaths() {
    const version = `${this.indexVersion}:${this.ignoreVersion}`;
    if (!this.host || version === this.sentVersion) return;
    this.sentVersion = version;
    this.host.setPaths({ version, files: this.filePaths(), ignoreDirs: [...this.ignoreDirs], repoDirs: [...this.repoDirs] });
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
      this.index.set(p, { kind: 'dir' });
      this.indexVersion++;
      this.watchDir(p);
    }
  }

  private noteEntry(rel: string, e: Entry) {
    this.noteParents(rel); // mkdir -p via createFile/writeFile
    if (this.index.get(rel)?.kind !== e.kind) this.indexVersion++;
    this.index.set(rel, e);
  }

  private dropEntries(rel: string) {
    this.indexVersion++;
    for (const k of [...this.index.keys()]) if (isUnder(k, rel)) this.index.delete(k);
    this.watch?.removeDir(rel);
  }

  private moveEntries(from: string, to: string) {
    const moved: Array<[string, Entry]> = [];
    for (const [k, v] of this.index) if (isUnder(k, from)) moved.push([to + k.slice(from.length), v]);
    this.dropEntries(from);
    for (const [k, v] of moved) {
      this.noteEntry(k, v);
      if (v.kind === 'dir') this.watchDir(k);
    }
  }

  private async withInflight<T>(keys: string | string[], fn: () => Promise<T>): Promise<T> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) this.inflight.set(k, (this.inflight.get(k) ?? 0) + 1);
    try {
      return await this.exclusive(list, fn);
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
    const parent = parentOf(rel);
    if (parent && this.index.get(parent)?.kind !== 'dir') {
      // Parent unknown: it probably just appeared (mkdir -p, folder moved in). Reconcile it instead; that walks it.
      const pst = await fsp.stat(this.abs(parent)).catch(() => null);
      return pst?.isDirectory() ? this.reconcile(parent, listings) : [];
    }
    const abs = this.abs(rel);
    let st = await fsp.stat(abs).catch(() => null);
    // Case-insensitive folder: after "Note.md" → "note.md" the old name still stats fine (it finds the
    // new one). Only the listing tells: else the old spelling comes back as a phantom twin.
    if (st && (await this.caseClash(rel, listings ?? new Map()))) st = null;
    const prev = this.index.get(rel);
    const events: FsEvent[] = [];
    const kind = st ? (st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null) : null;
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

/** Write temp sibling → fsync → rename over the target, so a crash never truncates a note. */
async function atomicWrite(target: string, data: Buffer, mode?: number) {
  // At most 32 code points of the original name: long names (≥ ~230 bytes) would otherwise push the temp
  // name past NAME_MAX (255) and every save of that file would fail with ENAMETOOLONG.
  const short = Array.from(path.basename(target)).slice(0, 32).join('');
  const tmp = path.join(path.dirname(target), `.~${short}.${crypto.randomBytes(4).toString('hex')}.sec-edit.tmp`);
  const fh = await fsp.open(tmp, 'wx', mode !== undefined ? mode & 0o777 : 0o666);
  try {
    await fh.writeFile(data);
    await fh.datasync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  if (mode !== undefined && !isWin) await fsp.chmod(tmp, mode & 0o7777).catch(() => {});
  try {
    await retryWin(() => fsp.rename(tmp, target));
  } catch {
    // Target locked against replacement (some sync clients / editors): rewrite it in place instead.
    try {
      await fsp.writeFile(target, data);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
}
