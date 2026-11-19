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
import { IgnoreStack, globalExcludesPath, isLockfile, isMinified } from './gitignore';
import { ReadPool, defaultReadThreads } from './readpool';
import { TextPass } from './textpass';
import { CacheWriter, TextCache, cacheFileFor } from './indexcache';

export { detectEol } from './textcodec';
export { BackendFailure } from './errors';

const TEXT_EXTS = new Set(
  (
    'md markdown mdx txt text rst adoc org log csv tsv json jsonc json5 yaml yml toml ini cfg conf env properties ' +
    'php phtml inc js mjs cjs jsx ts mts cts tsx vue svelte astro css scss sass less html htm xml svg xsl ' +
    'py rb go rs java kt kts scala c h cc cpp cxx hpp hh cs fs swift m mm dart lua pl pm r jl ex exs erl hrl ' +
    'clj cljs edn hs elm ml mli nim zig v sol sql graphql gql proto sh bash zsh fish ps1 psm1 bat cmd ' +
    'dockerfile makefile mk cmake gradle tf hcl nix lock gitignore gitattributes editorconfig htaccess twig blade'
  ).split(' '),
);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'readme', 'license', 'changelog', '.gitignore', '.env', '.htaccess', '.editorconfig']);
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_OPEN_BYTES = 48 * 1024 * 1024;
export const MAX_TREE_ENTRIES = 200_000;
const MAX_DEPTH = 40;
const isWin = process.platform === 'win32';
// readAllTextPage sizing (content length per page).
const PAGE_DEFAULT = 1 << 20;
const PAGE_MIN = 64 << 10;
const PAGE_MAX = 8 << 20;
// Sync reads are 10–20× faster than libuv round-trips (≈40 µs each on WSL / Windows + Defender), so
// indexing reads files synchronously in short bursts and yields in between.
const SYNC_BURST_MS = 12;
// One read slower than this → slow / network file system: switch to async so the process never stalls.
const SLOW_READ_MS = 25;
// O_NONBLOCK: opening a FIFO that replaced a file must not block (fstat then rejects it).
const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

export function isProbablyTextName(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot === -1) return false;
  return TEXT_EXTS.has(lower.slice(dot + 1));
}

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
}

export interface IndexOptions {
  /** Honour .gitignore files, .git/info/exclude and the global git excludes file. */
  respectGitignore?: boolean;
  /** package-lock.json, yarn.lock, composer.lock, Cargo.lock, … */
  skipLockfiles?: boolean;
  /** *.min.js / *.min.css bundles and *.map source maps. */
  skipMinified?: boolean;
  /** Bigger files are not indexed. */
  maxFileBytes?: number;
}

const DEFAULT_INDEX: Required<IndexOptions> = { respectGitignore: true, skipLockfiles: true, skipMinified: true, maxFileBytes: MAX_INDEX_BYTES };
/** An idle index pass (consumer gone) is dropped after this long. */
const PASS_IDLE_MS = 30_000;
const foldCaseFs = isWin || process.platform === 'darwin';

export class Workspace {
  readonly root: string;
  private matcher: ExcludeMatcher;
  private index = new Map<string, Entry>();
  private indexed = false;
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
  private textList: { version: string; list: string[] } | null = null;
  /** Set once a single sync read was slow (network share): later reads go async. */
  private slowFs = false;
  private indexOpts: Required<IndexOptions>;
  /** Folders holding a .gitignore / a .git (seen while walking; dotfiles are hidden from the index). */
  private ignoreDirs = new Set<string>();
  private repoDirs = new Set<string>();
  /** Bumped when ignore files may have changed. */
  private ignoreVersion = 0;
  private ignore: { version: number; stack: IgnoreStack } | null = null;
  private readonly cacheFile: string | null;
  private pool: ReadPool | null;
  private pass: TextPass | null = null;
  private passTimer: NodeJS.Timeout | null = null;

  constructor(root: string, opts: WorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.matcher = createExcludeMatcher(opts.exclude ?? ['node_modules', '.git'], !!opts.showHidden);
    this.watchMode = opts.watchMode ?? defaultWatchMode();
    this.debounceMs = opts.debounceMs ?? 80;
    this.pollMs = opts.pollMs ?? 4000;
    this.indexOpts = { ...DEFAULT_INDEX, ...definedOnly(opts.index ?? {}) };
    this.cacheFile = opts.cacheDir ? cacheFileFor(opts.cacheDir, this.root) : null;
    const threads = opts.readThreads ?? defaultReadThreads();
    this.pool = threads > 0 ? new ReadPool(threads) : null;
  }

  info(): WorkspaceInfo {
    return { root: this.root, name: path.basename(this.root) || this.root };
  }

  setOptions(opts: { exclude?: string[]; showHidden?: boolean }) {
    this.matcher = createExcludeMatcher(opts.exclude ?? [], !!opts.showHidden);
  }

  /** Changes what the indexers skip; takes effect on the next index pass. */
  setIndexOptions(opts: IndexOptions) {
    this.indexOpts = { ...DEFAULT_INDEX, ...definedOnly(opts) };
    this.textList = null;
    this.dropPass();
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
    const base = normalize(sub);
    const absBase = this.abs(base);
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
        entries = await fsp.readdir(absDir, { withFileTypes: true });
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
                const cmp = (p: string) => (isWin || process.platform === 'darwin' ? p.toLowerCase() : p);
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

    const children = await walk(absBase, base, depthOf(base), []);
    this.indexVersion++;
    this.ignoreVersion++;
    if (!base) {
      this.index = index;
      this.ignoreDirs = ignoreDirs;
      this.repoDirs = repoDirs;
      this.indexed = true;
      this.syncWatchedDirs();
    } else if (this.watch?.mode === 'perdir') {
      this.watch.addDir(base);
      for (const [k, v] of index) if (v.kind === 'dir' && isUnder(k, base)) this.watch.addDir(k);
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
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) throw new BackendFailure('EISDIR', `Is a folder: ${rel}`);
      // FIFOs / sockets / devices: reading would block a libuv thread forever (and stall indexing).
      if (!st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${rel}`);
      if (st.size > MAX_OPEN_BYTES) throw new BackendFailure('ETOOBIG', `File is too large to open (${Math.round(st.size / 1048576)} MB): ${rel}`);
      const buf = await fsp.readFile(abs);
      const d = decode(buf);
      this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
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
      const st = await this.statForWrite(abs, rel);
      if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${rel}`);
      return this.commit(key, abs, st, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    });
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
      const st = await fsp.stat(abs).catch(() => null);
      if (st) throw new BackendFailure('EEXIST', `Already exists: ${rel}`);
      await fsp.mkdir(abs, { recursive: true });
      this.noteEntry(key, { kind: 'dir' });
      if (this.watch?.mode === 'perdir') this.watch.addDir(key);
    });
  }

  async rename(from: string, to: string): Promise<void> {
    const src = normalize(from);
    const dst = normalize(to);
    if (!src || !dst) throw new BackendFailure('EINVAL', 'Cannot rename the workspace root');
    const a = this.abs(src);
    const b = this.abs(dst);
    if (a === b) return;
    const fold = (p: string) => (isWin || process.platform === 'darwin' ? p.toLowerCase() : p);
    if (fold(b).startsWith(fold(a) + path.sep)) throw new BackendFailure('EINVAL', 'Cannot move a folder into itself');
    await this.withInflight([src, dst], async () => {
      const sa = await fsp.lstat(a).catch(() => null);
      if (!sa) throw new BackendFailure('ENOENT', `Not found: ${from}`);
      const sb = await fsp.lstat(b).catch(() => null);
      if (sb) {
        // Same inode → case-only rename on a case-insensitive FS (Windows/macOS). Anything else is a real clash.
        const same = sa.dev === sb.dev && sa.ino === sb.ino && (sa.ino !== 0 || (sa.birthtimeMs === sb.birthtimeMs && sa.size === sb.size));
        if (!same) throw new BackendFailure('EEXIST', `Already exists: ${to}`);
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
      if (!st) throw new BackendFailure('ENOENT', `Not found: ${rel}`);
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
    if (!this.indexed) await this.listTree();
    const cursor = typeof opts.cursor === 'string' ? opts.cursor : null;
    const want = Number.isFinite(opts.maxBytes) ? Math.min(PAGE_MAX, Math.max(PAGE_MIN, Number(opts.maxBytes))) : PAGE_DEFAULT;
    if (this.pool?.available) {
      try {
        // Serialised: pages of one pass are cut in order, whoever asks.
        const run = this.passChain.then(() => this.passPage(cursor, want));
        this.passChain = run.catch(() => {});
        return await run;
      } catch {
        this.dropPass(); // threads unavailable here: read in-thread below
      }
    }
    const list = this.textPaths();
    let i = cursor === null ? 0 : upperBound(list, cursor);
    const files: FileData[] = [];
    let bytes = 0;
    const t0 = performance.now();
    while (i < list.length && bytes < want) {
      if (this.slowFs) {
        // Bounded concurrency keeps Windows (antivirus-scanned) / network reads from thrashing.
        const batch = list.slice(i, i + 16);
        i += batch.length;
        for (const f of await Promise.all(batch.map((p) => this.readIndexableAsync(p)))) {
          if (f) files.push(f), (bytes += f.content.length);
        }
        if (performance.now() - t0 > 200) break;
      } else {
        const f = this.readIndexableSync(list[i++]);
        if (f) files.push(f), (bytes += f.content.length);
        if (performance.now() - t0 > SYNC_BURST_MS) break;
      }
    }
    return { files, nextCursor: i < list.length ? list[i - 1] : null, total: list.length, done: i };
  }

  private passChain: Promise<unknown> = Promise.resolve();
  /** The last completed parallel pass: files read vs. served from the cache; `written` = its cache write. */
  lastPass: { read: number; cached: number; written: Promise<void> } | null = null;

  /** A page of the parallel pass (started, or restarted, when the cursor does not continue it). */
  private async passPage(cursor: string | null, want: number): Promise<TextPage> {
    let pass = this.pass;
    if (!pass || pass.cursor !== cursor) {
      this.dropPass();
      const list = this.textPaths();
      const start = cursor === null ? 0 : upperBound(list, cursor);
      let cache: TextCache | null = null;
      const file = this.cacheFile;
      if (file) cache = await TextCache.load(file);
      if (this.disposed) return { files: [], nextCursor: null, total: 0, done: 0 };
      // Only a pass over every file can write a complete cache.
      const makeWriter = file && start === 0 ? () => new CacheWriter(file) : null;
      pass = this.pass = new TextPass(list, start, this.passHost, this.pool!, this.indexOpts.maxFileBytes, cache, makeWriter, this.pool!.threadCount);
    } else pass.retarget(this.textPaths());
    this.armPassTimer();
    const files = await pass.page(want);
    const finished = pass.finished;
    if (finished && this.pass === pass) {
      this.pass = null;
      this.lastPass = { ...pass.stats, written: pass.written$ };
    }
    return { files, nextCursor: finished ? null : pass.cursor, total: pass.list.length, done: pass.head };
  }

  private readonly passHost = {
    abs: (rel: string) => this.abs(rel),
    decode: (rel: string, bytes: Uint8Array, mtime: number, size: number) => this.indexable(rel, bytes, { mtimeMs: mtime, size } as fs.Stats),
    fromCache: (rel: string, mtime: number, size: number, cache: TextCache): FileData | null => {
      this.noteEntry(rel, { kind: 'file', mtime, size });
      const c = cache.get(rel);
      if (!c || c.content === null) return null;
      const d: FileData = { path: rel, content: c.content, mtime, eol: c.eol, size };
      if (c.bom) d.bom = true;
      if (c.encoding) d.encoding = c.encoding;
      return d;
    },
  };

  private armPassTimer() {
    if (this.passTimer) clearTimeout(this.passTimer);
    // Consumer gone (renderer reloaded mid-pass): free the read-ahead buffers.
    this.passTimer = setTimeout(() => {
      this.passTimer = null;
      if (this.pass && Date.now() - this.pass.lastUsed >= PASS_IDLE_MS) this.dropPass();
    }, PASS_IDLE_MS);
    this.passTimer.unref?.();
  }

  private dropPass() {
    this.pass?.close();
    this.pass = null;
  }

  /** Text-looking, not ignored file paths in code-unit order (cached until paths or ignore rules change). */
  textPaths(): string[] {
    const version = `${this.indexVersion}:${this.ignoreVersion}`;
    if (this.textList?.version !== version) {
      const o = this.indexOpts;
      const ignore = o.respectGitignore ? this.ignoreStack() : null;
      const list = this.filePaths().filter((p) => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        if (!isProbablyTextName(name)) return false;
        if (o.skipLockfiles && isLockfile(name)) return false;
        if (o.skipMinified && isMinified(name)) return false;
        return !ignore?.ignored(p);
      });
      this.textList = { version, list: list.sort(byCodeUnit) };
    }
    return this.textList.list;
  }

  /** Is `rel` skipped by the indexers (ignored / generated)? The tree still shows it. */
  isIndexSkipped(rel: string): boolean {
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const o = this.indexOpts;
    if ((o.skipLockfiles && isLockfile(name)) || (o.skipMinified && isMinified(name))) return true;
    return o.respectGitignore && this.ignoreStack().ignored(rel);
  }

  private outer: { prefix: string; files: Array<{ text: string; prefix: string }> } | null | undefined;

  /** The repository the workspace sits inside (root is a subfolder of a checkout), if any. */
  private outerRepo() {
    if (this.outer !== undefined) return this.outer;
    this.outer = null;
    const gitignores: Array<{ dir: string }> = [];
    // Like git: never look for a repository in or above GIT_CEILING_DIRECTORIES.
    const fold = (p: string) => (foldCaseFs ? p.toLowerCase() : p);
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(Boolean).map((p) => fold(path.resolve(p))));
    let dir = path.dirname(this.root);
    for (let i = 0; i < 40 && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      if (ceilings.has(fold(dir))) break;
      gitignores.push({ dir });
      if (fs.existsSync(path.join(dir, '.git'))) {
        const rel = (from: string) => path.relative(from, this.root).split(path.sep).join('/') + '/';
        const files: Array<{ text: string; prefix: string }> = [];
        const info = readSmallText(path.join(dir, '.git', 'info', 'exclude'));
        if (info) files.push({ text: info, prefix: rel(dir) });
        // Outermost first: deeper .gitignore files win.
        for (const g of gitignores.reverse()) {
          const t = readSmallText(path.join(g.dir, '.gitignore'));
          if (t) files.push({ text: t, prefix: rel(g.dir) });
        }
        this.outer = { prefix: rel(dir), files };
        break;
      }
    }
    return this.outer;
  }

  private ignoreStack(): IgnoreStack {
    if (this.ignore?.version === this.ignoreVersion) return this.ignore.stack;
    const stack = new IgnoreStack(foldCaseFs);
    // Precedence (later wins): global excludes < .git/info/exclude < .gitignore files, shallow → deep.
    const outer = this.outerRepo();
    const repos = [...this.repoDirs].sort((a, b) => depthOf(a) - depthOf(b));
    const global = readSmallText(globalExcludesPath(readSmallText, process.env, os.homedir(), path.join));
    if (global) {
      stack.add('', global, outer?.prefix ?? '');
      for (const r of repos) if (r) stack.add(r, global);
    }
    for (const f of outer?.files ?? []) if (f.prefix && !f.prefix.startsWith('../')) stack.add('', f.text, f.prefix);
    for (const r of repos) {
      const t = readSmallText(path.join(this.abs(r), '.git', 'info', 'exclude'));
      if (t) stack.add(r, t);
    }
    for (const d of [...this.ignoreDirs].sort((a, b) => depthOf(a) - depthOf(b))) {
      const t = readSmallText(path.join(this.abs(d), '.gitignore'));
      if (t) stack.add(d, t);
    }
    this.ignore = { version: this.ignoreVersion, stack };
    return stack;
  }

  private readIndexableSync(p: string): FileData | null {
    const t = performance.now();
    let fd = -1;
    try {
      fd = fs.openSync(this.abs(p), O_READ);
      const st = fs.fstatSync(fd); // of the opened object: no stat→open race
      if (!st.isFile() || st.size > this.indexOpts.maxFileBytes) return null;
      const buf = Buffer.allocUnsafe(st.size);
      let n = 0;
      while (n < st.size) {
        const r = fs.readSync(fd, buf, n, st.size - n, n);
        if (!r) break;
        n += r;
      }
      return this.indexable(p, buf.subarray(0, n), st);
    } catch {
      return null;
    } finally {
      if (fd !== -1) fs.closeSync(fd);
      if (performance.now() - t > SLOW_READ_MS) this.slowFs = true;
    }
  }

  private async readIndexableAsync(p: string): Promise<FileData | null> {
    try {
      const abs = this.abs(p);
      const st = await fsp.stat(abs);
      if (!st.isFile() || st.size > this.indexOpts.maxFileBytes) return null;
      return this.indexable(p, await fsp.readFile(abs), st);
    } catch {
      return null;
    }
  }

  /** Decoded file for the indexers, or null for binary content. Remembers the mtime like readFile. */
  private indexable(key: string, buf: Uint8Array, st: fs.Stats): FileData | null {
    const d = decode(buf);
    this.noteEntry(key, { kind: 'file', mtime: st.mtimeMs, size: st.size });
    if (d.binary) return null;
    const content = toLf(d.text);
    if (content.includes('\u0000')) return null;
    const data: FileData = { path: key, content, mtime: st.mtimeMs, eol: detectEol(d.text), size: st.size };
    if (d.bom) data.bom = true;
    if (d.encoding !== 'utf8') data.encoding = d.encoding;
    return data;
  }

  // ---- index bookkeeping ----------------------------------------------------------------------

  /** Record the parent folders of `rel` (just created by our own mkdir -p) so the watcher does not
   *  report them back as external `addDir`s. Call right after mkdir, before the (slower) write. */
  private noteParents(rel: string) {
    for (let p = parentOf(rel); p; p = parentOf(p)) {
      if (this.index.get(p)?.kind === 'dir') break;
      this.index.set(p, { kind: 'dir' });
      this.indexVersion++;
      if (this.watch?.mode === 'perdir') this.watch.addDir(p);
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
      if (v.kind === 'dir' && this.watch?.mode === 'perdir') this.watch.addDir(k);
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
    const fold = (k: string) => (isWin || process.platform === 'darwin' ? k.toLowerCase() : k);
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
    this.watch = createWatchBackend(this.root, { hint: (rel) => this.queue(rel), rescan: () => this.requestRescan() }, this.watchMode, this.pollMs);
    if (this.indexed) this.syncWatchedDirs();
    else void this.listTree().catch(() => {});
  }

  private syncWatchedDirs() {
    if (this.watch?.mode !== 'perdir') return;
    this.watch.addDir('');
    for (const [k, v] of this.index) if (v.kind === 'dir') this.watch.addDir(k);
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
        for (const rel of hints) {
          if (this.isBusy(rel)) deferred.push(rel);
          else {
            // One bad hint (vanished mid-stat, name Win32 cannot open…) must not drop the rest of the batch
            // or surface as an unhandled rejection (Electron shows those as an error dialog).
            try {
              events.push(...(await this.reconcile(rel)));
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
  private async reconcile(rel: string): Promise<FsEvent[]> {
    if (this.matcher.path(rel)) return [];
    const parent = parentOf(rel);
    if (parent && this.index.get(parent)?.kind !== 'dir') {
      // Parent unknown: it probably just appeared (mkdir -p, folder moved in). Reconcile it instead; that walks it.
      const pst = await fsp.stat(this.abs(parent)).catch(() => null);
      return pst?.isDirectory() ? this.reconcile(parent) : [];
    }
    const abs = this.abs(rel);
    const st = await fsp.stat(abs).catch(() => null);
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
      if (this.watch?.mode === 'perdir') this.watch.addDir(rel);
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
    this.dropPass();
    this.pool?.close();
    if (this.passTimer) clearTimeout(this.passTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.closeWatcher();
    this.listeners.clear();
  }
}

function tooBigBinary(bytes: number) {
  return new BackendFailure('ETOOBIG', `File is too large (${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_BINARY_BYTES / 1048576} MB)`);
}

function readSmallText(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= 1 << 20 ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Index of the first entry > key in a sorted list. */
function upperBound(list: readonly string[], key: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
