// Everything the indexers need from the disk — which files (ignore rules, filters), their text
// (parallel reads, persistent cache, decoding) — in one object that runs in a worker thread
// (indexer-worker.ts), so the Electron main process / the server's request loop only forward bytes
// and user actions (open a file, list a folder) never wait behind indexing work.
// Also usable in-process (unit tests, and when no worker bundle is available).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FileData, TextPage } from '../shared/api';
import { decode, detectEol, toLf } from './textcodec';
import { IgnoreStack, globalExcludesPath, isLockfile, isMinified, type IgnoreSet } from './gitignore';
import { ReadPool, type ReadCheck, type ReadResult } from './readpool';
import { TextPass, upperBound, nameOnlyFile } from './textpass';
import { CacheWriter, TextCache } from './indexcache';
import { isProbablyTextName } from './textnames';
import { fsDelay } from './fsdelay';
import type { FrameFile } from '../shared/textframe';
import { PatternTable } from '../shared/associations';

export interface IndexOptions {
  /** Honour .gitignore files, .git/info/exclude and the global git excludes file. */
  respectGitignore?: boolean;
  /** package-lock.json, yarn.lock, composer.lock, Cargo.lock, … */
  skipLockfiles?: boolean;
  /** *.min.js / *.min.css bundles and *.map source maps. */
  skipMinified?: boolean;
  /** Bigger files are not indexed. */
  maxFileBytes?: number;
  /** Names that are text because the user says so: the canonical patterns of the file type associations
   *  (shared/associations.ts; `*.ctp` opened as PHP is searched and symbol-indexed like a .php file). */
  textPatterns?: string[];
}

export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_INDEX: Required<IndexOptions> = { respectGitignore: true, skipLockfiles: true, skipMinified: true, maxFileBytes: MAX_INDEX_BYTES, textPatterns: [] };

export interface IndexerConfig {
  root: string;
  cacheFile: string | null;
  readThreads: number;
  index: Required<IndexOptions>;
  foldCase: boolean;
  /** One's data folder (absolute, as given and resolved) and, by identity, root-relative: never read. */
  deny?: string[];
  denyRels?: string[];
  /** The root itself is inside a deny folder: nothing below a link is read. */
  denyAll?: boolean;
}

/** What the workspace knows about its files (paths from the tree walk; folders with ignore files). */
export interface PathSnapshot {
  version: string;
  files: string[];
  ignoreDirs: string[];
  repoDirs: string[];
  /** Entries that are links (they led inside the folder when listed): files at or below one are read only after
   *  checking where they really are now — a page can move a link, and a relative one then leads elsewhere. */
  links?: string[];
}

/** mtime + size of every file a page examined (the workspace keeps them for change detection). */
export type Stamp = [path: string, mtime: number, size: number];
export type IndexPage = TextPage & { stamps: Stamp[] };
export interface ReadFilesResult {
  files: FileData[];
  /** Skipped by the index filters (ignored, lockfile, too big, binary): drop from the index. */
  skipped: string[];
  /** No longer on disk. */
  gone: string[];
  stamps: Stamp[];
}

const PAGE_MIN = 64 << 10;
const PAGE_MAX = 8 << 20;
const SYNC_BURST_MS = 12;
const PASS_IDLE_MS = 30_000;
const O_READ = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const depthOf = (rel: string) => (rel ? rel.split('/').length : 0);
const parentOf = (rel: string) => {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
};

const within = (child: string, parent: string, fold: boolean) => {
  const r = path.relative(fold ? parent.toLowerCase() : parent, fold ? child.toLowerCase() : child);
  return !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
};
/** The real path of `abs` when it is inside `c.root` and not denied (null: outside, denied, gone, or no `c`). */
function realInside(abs: string, c: ReadCheck | null): string | null {
  if (!c) return null;
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch {
    return null;
  }
  return within(real, c.root, c.fold) && !c.deny.some((d) => within(real, d, c.fold)) ? real : null;
}
/** After the open: `real` is the opened file (no link swapped in between the check and the open). */
function isOpened(fd: number, real: string): boolean {
  try {
    const a = fs.fstatSync(fd, { bigint: true });
    const b = fs.statSync(real, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino && (a.ino !== 0n || (a.birthtimeNs === b.birthtimeNs && a.size === b.size));
  } catch {
    return false;
  }
}

/** A small text file (ignore rules); `check`: below a link, read only where it really is inside (ReadJob.v). */
function readSmallText(abs: string, check?: ReadCheck | null): string | null {
  let fd = -1;
  try {
    fsDelay();
    if (check !== undefined && !realInside(abs, check)) return null;
    // Opened without waiting (a FIFO in its place never blocks this thread), then checked by the handle.
    fd = fs.openSync(abs, O_READ);
    if (check !== undefined) {
      const real = realInside(abs, check);
      if (!real || !isOpened(fd, real)) return null;
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > 1 << 20) return null;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = fs.readSync(fd, buf, n, st.size - n, n);
      if (!r) break;
      n += r;
    }
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== -1) fs.closeSync(fd);
  }
}

export interface PoolStats {
  max: number;
  running: number;
  busy: number;
}

export class Indexer {
  private opts: Required<IndexOptions>;
  private snap: PathSnapshot = { version: '', files: [], ignoreDirs: [], repoDirs: [] };
  private list: { key: string; paths: string[] } | null = null;
  private nameList: { key: string; paths: string[] } | null = null;
  private extra: { of: string[]; table: PatternTable<true> } | null = null;
  private ignore: { version: string; stack: IgnoreStack } | null = null;
  private outer: { prefix: string; files: Array<{ text: string; prefix: string }> } | null | undefined;
  private pool: ReadPool | null;
  private pass: TextPass | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private passTimer: NodeJS.Timeout | null = null;
  private passListeners = new Set<() => void>();
  /** The last completed pass: files read vs. served from the cache; `written` = its cache write. */
  lastPass: { read: number; cached: number; written: Promise<void> } | null = null;

  constructor(private readonly cfg: IndexerConfig) {
    this.opts = { ...cfg.index };
    this.pool = cfg.readThreads > 0 ? new ReadPool(cfg.readThreads) : null;
  }

  /** Boot the reader threads now (the renderer's first page request is moments away). */
  warm() {
    this.pool?.warm();
  }

  /** Reader threads: allowed / running / reading now (process explorer). */
  poolStats(): PoolStats {
    return { max: this.pool?.threadCount ?? 0, running: this.pool?.running ?? 0, busy: this.pool?.busy ?? 0 };
  }

  onPassStart(cb: () => void) {
    this.passListeners.add(cb);
    return () => this.passListeners.delete(cb);
  }

  setOptions(o: Required<IndexOptions>) {
    this.opts = { ...o };
    this.list = null;
    this.nameList = null;
    this.dropPass();
  }

  setPaths(s: PathSnapshot) {
    if (s.version === this.snap.version) return;
    this.snap = s;
    this.list = null;
    this.nameList = null;
    this.linkSet = new Set(s.links ?? []);
    this.underLink.clear();
  }

  private abs(rel: string) {
    return rel ? path.join(this.cfg.root, ...rel.split('/')) : this.cfg.root;
  }

  // ---- containment below links --------------------------------------------------------------------
  // The walk listed only links that led inside, but a page can move a link afterwards (a relative one then leads
  // elsewhere) or move a link that leads outside in place of a folder another link points to. Files at or below
  // a listed link are therefore read only after checking where they really are, right then (no folder cache:
  // the check must be newer than the move); everything else is read as before, at no extra cost.

  private linkSet = new Set<string>();
  /** Folder → at or below a listed link (per snapshot). */
  private underLink = new Map<string, boolean>();
  private checkInfo: ReadCheck | null = null;

  private dirUnderLink(dir: string): boolean {
    if (!dir) return false;
    let v = this.underLink.get(dir);
    if (v === undefined) {
      v = this.linkSet.has(dir) || this.dirUnderLink(parentOf(dir));
      this.underLink.set(dir, v);
    }
    return v;
  }

  /** `rel` is a listed link or below one. */
  needsCheck(rel: string): boolean {
    return this.linkSet.size > 0 && (this.linkSet.has(rel) || this.dirUnderLink(parentOf(rel)));
  }

  /** The root without links + the deny folders (null: realpath fails here, or the root is denied: fail closed).
   *  Only a success is kept. */
  check(): ReadCheck | null {
    if (this.checkInfo || this.cfg.denyAll) return this.checkInfo;
    let root: string;
    try {
      root = fs.realpathSync.native(this.cfg.root);
    } catch {
      return null;
    }
    const deny = [...(this.cfg.deny ?? []), ...(this.cfg.denyRels ?? []).map((r) => path.join(root, ...r.split('/')))];
    return (this.checkInfo = { root, deny, fold: this.cfg.foldCase });
  }

  /** In-thread check of an opened file (the reader threads do the same, readpool.ts). */
  private contained(rel: string, fd: number): boolean {
    const real = realInside(this.abs(rel), this.check());
    return !!real && isOpened(fd, real);
  }

  // ---- what gets indexed ----------------------------------------------------------------------

  /** Text-looking, not ignored files in code-unit order. */
  textPaths(): string[] {
    const key = `${this.snap.version}|${JSON.stringify(this.opts)}`;
    if (this.list?.key === key) return this.list.paths;
    const ignore = this.opts.respectGitignore ? this.ignoreStack() : null;
    const paths = this.snap.files.filter((p) => !this.skippedName(p) && !ignore?.ignored(p));
    paths.sort(byCodeUnit);
    this.list = { key, paths };
    return paths;
  }

  /**
   * Files that exist and are not git-ignored, but whose NAME cannot be content-indexed (binary /
   * unknown extension) — they still get a name-only entry (path metadata, content never read). In
   * code-unit order, so the page cursor (a text path) can select them by range. Lockfiles and
   * minified bundles are deliberately skipped entirely (not even by name), so they are excluded here.
   */
  nameOnlyPaths(): string[] {
    const key = `${this.snap.version}|${JSON.stringify(this.opts)}`;
    if (this.nameList?.key === key) return this.nameList.paths;
    const ignore = this.opts.respectGitignore ? this.ignoreStack() : null;
    const paths = this.snap.files.filter((p) => this.nameOnlyName(p) && !ignore?.ignored(p));
    paths.sort(byCodeUnit);
    this.nameList = { key, paths };
    return paths;
  }

  /**
   * `files` (one page of the text pass, in path order) plus the name-only docs in the page window
   * `(cursor, nextCursor]`, merged so the page stays in path order (readAllText promises sorted output).
   * The final page (`nextCursor` null) takes the tail. A loop, not `push(...)`: a window can hold up to
   * MAX_TREE_ENTRIES names, more than one call takes as arguments (RangeError past ~125k).
   */
  private withNameOnly(files: FileData[], cursor: string | null, nextCursor: string | null): FileData[] {
    const list = this.nameOnlyPaths();
    const lo = cursor === null ? 0 : upperBound(list, cursor);
    const hi = nextCursor === null ? list.length : upperBound(list, nextCursor);
    if (lo >= hi) return files;
    const out: FileData[] = [];
    let j = lo;
    // mtime 0: it comes from the watcher on the next change; a name-only file is never stat'ed here.
    for (const f of files) {
      while (j < hi && list[j] < f.path) out.push(nameOnlyFile(list[j++], 0));
      out.push(f);
    }
    while (j < hi) out.push(nameOnlyFile(list[j++], 0));
    return out;
  }

  /** The user's extra text names (opts.textPatterns) as a matcher, rebuilt when the options change. */
  private extraText(): PatternTable<true> | null {
    const patterns = this.opts.textPatterns;
    if (!patterns?.length) return null;
    if (this.extra?.of !== patterns) {
      const table = new PatternTable<true>();
      for (const p of patterns) if (typeof p === 'string') table.add(p, true);
      this.extra = { of: patterns, table };
    }
    return this.extra.table;
  }

  private skippedName(p: string): boolean {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!isProbablyTextName(name) && !this.extraText()?.match(name.toLowerCase())) return true;
    return (this.opts.skipLockfiles && isLockfile(name)) || (this.opts.skipMinified && isMinified(name));
  }

  /** A name that cannot be content-indexed (not text, not a user-mapped text name). Lockfiles and
   *  minified bundles return false: those are skipped entirely, never even as a name-only entry. */
  private nameOnlyName(p: string): boolean {
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (isProbablyTextName(name) || this.extraText()?.match(name.toLowerCase())) return false;
    return !isLockfile(name) && !isMinified(name);
  }

  isSkipped(rel: string): boolean {
    return this.skippedName(rel) || (this.opts.respectGitignore && this.ignoreStack().ignored(rel));
  }

  /** The ignore rules (for the watcher to drop events inside ignored folders without any I/O). */
  ignoreRules(): IgnoreSet[] {
    return this.opts.respectGitignore ? this.ignoreStack().toJSON() : [];
  }

  /** The repository the workspace sits inside (root is a subfolder of a checkout), if any. */
  private outerRepo() {
    if (this.outer !== undefined) return this.outer;
    this.outer = null;
    const root = this.cfg.root;
    const gitignores: Array<{ dir: string }> = [];
    // Like git: never look for a repository in or above GIT_CEILING_DIRECTORIES.
    const fold = (p: string) => (this.cfg.foldCase ? p.toLowerCase() : p);
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(Boolean).map((p) => fold(path.resolve(p))));
    let dir = path.dirname(root);
    for (let i = 0; i < 40 && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      if (ceilings.has(fold(dir))) break;
      gitignores.push({ dir });
      fsDelay();
      if (fs.existsSync(path.join(dir, '.git'))) {
        const rel = (from: string) => path.relative(from, root).split(path.sep).join('/') + '/';
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
    if (this.ignore?.version === this.snap.version) return this.ignore.stack;
    const stack = new IgnoreStack(this.cfg.foldCase);
    // Precedence (later wins): global excludes < .git/info/exclude < .gitignore files, shallow → deep.
    const outer = this.outerRepo();
    const repos = [...this.snap.repoDirs].sort((a, b) => depthOf(a) - depthOf(b));
    const global = readSmallText(globalExcludesPath(readSmallText, process.env, os.homedir(), path.join));
    if (global) {
      stack.add('', global, outer?.prefix ?? '');
      for (const r of repos) if (r) stack.add(r, global);
    }
    for (const f of outer?.files ?? []) if (f.prefix && !f.prefix.startsWith('../')) stack.add('', f.text, f.prefix);
    const checkFor = (dir: string) => (this.linkSet.size && this.dirUnderLink(dir) ? this.check() : undefined);
    for (const r of repos) {
      const t = readSmallText(path.join(this.abs(r), '.git', 'info', 'exclude'), checkFor(r));
      if (t) stack.add(r, t);
    }
    for (const d of [...this.snap.ignoreDirs].sort((a, b) => depthOf(a) - depthOf(b))) {
      const t = readSmallText(path.join(this.abs(d), '.gitignore'), checkFor(d));
      if (t) stack.add(d, t);
    }
    this.ignore = { version: this.snap.version, stack };
    return stack;
  }

  // ---- reading --------------------------------------------------------------------------------

  /** Bytes → indexable text, or null for binary / NUL-containing content. */
  private decodeFile(rel: string, bytes: Uint8Array, mtime: number, size: number): FileData | null {
    const d = decode(bytes);
    if (d.binary) return null;
    const content = toLf(d.text);
    if (content.includes('\u0000')) return null;
    const data: FrameFile = { path: rel, content, mtime, eol: detectEol(d.text), size };
    if (d.bom) data.bom = true;
    if (d.encoding !== 'utf8') data.encoding = d.encoding;
    // Valid UTF-8 without BOM / CR: the text's UTF-8 is exactly what was read — forward those bytes.
    else if (!d.bom && content === d.text) data.utf8 = bytes;
    return data;
  }

  private readSync(rel: string): ReadResult {
    let fd = -1;
    try {
      fsDelay();
      const check = this.needsCheck(rel);
      if (check && !realInside(this.abs(rel), this.check())) return { kind: 'error' };
      fd = fs.openSync(this.abs(rel), O_READ);
      if (check && !this.contained(rel, fd)) return { kind: 'error' };
      const st = fs.fstatSync(fd); // of the opened object: no stat→open race
      if (!st.isFile() || st.size > this.opts.maxFileBytes) return { kind: 'skip', mtime: st.mtimeMs, size: st.size };
      const buf = new Uint8Array(st.size);
      let n = 0;
      while (n < st.size) {
        const r = fs.readSync(fd, buf, n, st.size - n, n);
        if (!r) break;
        n += r;
      }
      return { kind: 'data', bytes: n === st.size ? buf : buf.subarray(0, n), mtime: st.mtimeMs, size: st.size };
    } catch {
      return { kind: 'error' };
    } finally {
      if (fd !== -1) fs.closeSync(fd);
    }
  }

  private async readMany(rels: string[]): Promise<ReadResult[]> {
    if (this.pool?.available) {
      try {
        const batches: Promise<ReadResult[]>[] = [];
        for (let i = 0; i < rels.length; i += 24) {
          const part = rels.slice(i, i + 24);
          const jobs = part.map((r) => (this.needsCheck(r) ? { abs: this.abs(r), v: 1 as const } : { abs: this.abs(r) }));
          batches.push(this.pool.read(jobs, this.opts.maxFileBytes, jobs.some((j) => 'v' in j) ? this.check() : null));
        }
        return (await Promise.all(batches)).flat();
      } catch {
        // threads unavailable: read in this thread below
      }
    }
    return rels.map((r) => this.readSync(r));
  }

  private readonly passHost = {
    abs: (rel: string) => this.abs(rel),
    needsCheck: (rel: string) => this.needsCheck(rel),
    check: () => this.check(),
    decode: (rel: string, bytes: Uint8Array, mtime: number, size: number) => this.decodeFile(rel, bytes, mtime, size),
    fromCache: (rel: string, mtime: number, size: number, cache: TextCache): FileData | null => {
      const c = cache.get(rel);
      if (!c || c.content === null) return null;
      const d: FrameFile = { path: rel, content: c.content, mtime, eol: c.eol, size, utf8: cache.getBytes(rel) };
      if (c.bom) d.bom = true;
      if (c.encoding) d.encoding = c.encoding;
      return d;
    },
  };

  /**
   * One page of the full pass. The cursor is the last path examined, so a page never repeats or skips
   * a file even if the tree changes in between (new files sorting before it arrive as watcher events).
   */
  page(cursor: string | null, maxBytes?: number): Promise<IndexPage> {
    const want = Number.isFinite(maxBytes) ? Math.min(PAGE_MAX, Math.max(PAGE_MIN, Number(maxBytes))) : 1 << 20;
    // Serialised: pages of one pass are cut in order, whoever asks.
    const run = this.chain.then(() => (this.pool?.available ? this.passPage(cursor, want) : this.syncPage(cursor, want)));
    this.chain = run.catch(() => {});
    return run.catch(() => {
      this.dropPass();
      return this.syncPage(cursor, want); // threads failed: read in this thread
    });
  }

  private async passPage(cursor: string | null, want: number): Promise<IndexPage> {
    let pass = this.pass;
    if (!pass || pass.cursor !== cursor) {
      this.dropPass();
      const list = this.textPaths();
      const start = cursor === null ? 0 : upperBound(list, cursor);
      if (start === 0) this.passListeners.forEach((l) => l());
      const file = this.cfg.cacheFile;
      const cache = file ? await TextCache.load(file) : null;
      // Only a pass over every file can write a complete cache.
      const makeWriter = file && start === 0 ? () => new CacheWriter(file) : null;
      pass = this.pass = new TextPass(list, start, this.passHost, this.pool!, this.opts.maxFileBytes, cache, makeWriter, this.pool!.threadCount);
    } else pass.retarget(this.textPaths());
    this.armPassTimer();
    const stamps: Stamp[] = [];
    const read = await pass.page(want, stamps);
    const finished = pass.finished;
    const next = finished ? null : pass.cursor;
    const files = this.withNameOnly(read, cursor, next); // name-only docs in this page's path range
    if (finished && this.pass === pass) {
      this.pass = null;
      this.lastPass = { ...pass.stats, written: pass.written$ };
    }
    return { files, nextCursor: next, total: pass.list.length, done: pass.head, stamps };
  }

  /** No threads: read in this thread in short bursts (this thread is the indexer's, not the UI's). */
  private async syncPage(cursor: string | null, want: number): Promise<IndexPage> {
    const list = this.textPaths();
    if (cursor === null) this.passListeners.forEach((l) => l());
    let i = cursor === null ? 0 : upperBound(list, cursor);
    const files: FileData[] = [];
    const stamps: Stamp[] = [];
    let bytes = 0;
    const t0 = performance.now();
    while (i < list.length && bytes < want) {
      const rel = list[i++];
      const r = this.readSync(rel);
      if (r.kind === 'error') continue;
      stamps.push([rel, r.mtime, r.size]);
      const f = r.kind === 'data' ? this.decodeFile(rel, r.bytes, r.mtime, r.size) : null;
      if (f) files.push(f), (bytes += f.content.length);
      else files.push(nameOnlyFile(rel, r.mtime, r.size)); // binary / NUL / oversized text-named file: a no-content hit
      if (performance.now() - t0 > SYNC_BURST_MS) await new Promise<void>((res) => setImmediate(res));
    }
    const next = i < list.length ? list[i - 1] : null;
    return { files: this.withNameOnly(files, cursor, next), nextCursor: next, total: list.length, done: i, stamps };
  }

  /** Incremental update: the current text of a few changed files (filters applied, no full pass). */
  async readFiles(rels: string[]): Promise<ReadFilesResult> {
    const out: ReadFilesResult = { files: [], skipped: [], gone: [], stamps: [] };
    const want: string[] = [];
    const nameOnly: string[] = [];
    const ignore = this.opts.respectGitignore ? this.ignoreStack() : null;
    for (const r of rels) {
      if (ignore?.ignored(r)) out.skipped.push(r); // git-ignored: never in the index
      else if (this.skippedName(r) && !this.nameOnlyName(r)) out.skipped.push(r); // lockfile / minified: skipped entirely
      else if (this.nameOnlyName(r)) nameOnly.push(r); // binary / unknown name: path metadata only
      else want.push(r); // text name: read + decode (a binary / oversized one becomes name-only below)
    }
    const res = await this.readMany(want);
    res.forEach((r, i) => {
      const rel = want[i];
      if (r.kind === 'error') return void out.gone.push(rel);
      out.stamps.push([rel, r.mtime, r.size]);
      const f = r.kind === 'data' ? this.decodeFile(rel, r.bytes, r.mtime, r.size) : null;
      if (f) out.files.push(f);
      else out.files.push(nameOnlyFile(rel, r.mtime, r.size)); // binary / NUL / oversized text-named file: a no-content hit
    });
    for (const rel of nameOnly) {
      const st = this.probe(rel); // stat only — the content of a name-only file is never read
      if (!st) out.gone.push(rel);
      else {
        out.stamps.push([rel, st.mtime, st.size]);
        out.files.push(nameOnlyFile(rel, st.mtime, st.size));
      }
    }
    return out;
  }

  /** Cheap existence + mtime/size probe for a name-only file (never reads its bytes). */
  private probe(rel: string): { mtime: number; size: number } | null {
    try {
      fsDelay();
      if (this.needsCheck(rel) && !realInside(this.abs(rel), this.check())) return null;
      const st = fs.statSync(this.abs(rel));
      return st.isFile() ? { mtime: st.mtimeMs, size: st.size } : null;
    } catch {
      return null;
    }
  }

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

  dispose() {
    this.dropPass();
    this.pool?.close();
    if (this.passTimer) clearTimeout(this.passTimer);
  }
}
