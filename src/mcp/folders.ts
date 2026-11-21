// The folders an MCP client may reach: mcp.json's allow-list → one lazy Workspace per folder.
//
// Every path a tool or resource takes goes through ONE resolver, Folder.resolve():
//   1. cleanPath()      string rules, decided without touching the disk (EINVAL): no "..", no absolute /
//                       drive / UNC / device-namespace paths, "/" only (no "\"), no control characters,
//                       no Unicode look-alikes of "/", "\", "." or ":", Windows name rules on Windows;
//   2. hidden()         the one visibility rule (dot segments, key files, the user's excludeGlobs, our temp
//                       files), on the path as asked → ENOENT, the same answer as a missing file;
//   3. Workspace.real() lexical containment (and One's own data folder is refused there);
//   4. no links         no part of the path may be a symlink / junction (the MCP workspace does not follow
//                       links at all: not in listings, not in the index), and the real location must be
//                       exactly the path as asked: no link, case or 8.3 alias of an excluded place;
//   5. at use           reads open the real path, then check the open file is the one that was checked
//                       and the path still resolves there (no check-then-use window to swap a link in);
//                       writes re-check rules 2 and 4 inside the Workspace's slot (Folder.guard).
// The built-in rules (dot paths, key files) never depend on settings.json; the user's excludes add to them.
// Messages carry the folder-relative path only, never a host path.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Workspace, compareNodes, type WriteGuard } from '../backend/workspace';
import { BackendFailure } from '../backend/errors';
import { createExcludeMatcher, type ExcludeMatcher } from '../backend/exclude';
import { isInsideDir, windowsNameProblem } from '../backend/pathsafe';
import { decode, detectEol, toLf } from '../backend/textcodec';
import { isProbablyTextName } from '../backend/textnames';
import os from 'node:os';
import { folderProblem } from './grant';
import { defaultCacheDir, indexOptionsFrom } from '../backend/appdata';
import type { Eol, FsEvent, Settings, TextEncoding, TreeNode } from '../shared/api';
import type { McpConfig, McpMode } from '../shared/mcp';
import { ToolError } from './protocol';
import type { FolderIndex } from './indexes';

/** Never visible, whatever the settings say (private keys, key stores, password databases). */
export const KEY_FILE_GLOBS = [
  '*.pem', '*.key', '*.pfx', '*.p12', '*.p8', '*.ppk', '*.jks', '*.keystore', '*.keytab', '*.kdbx', '*.kdb', '*.gpg',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'id_xmss*', 'secring*', 'wallet.dat', '*.tfstate', '*.tfstate.*',
];
export const MAX_PATH_CHARS = 1024;
/** Larger files are not read (paging still loads the whole file to count lines). */
export const MAX_READ_BYTES = 16 * 1024 * 1024;
/** list_files stops scanning after this many entries (a listing of a huge tree stays bounded). */
export const MAX_SCAN_ENTRIES = 20_000;

const invalid = (why: string) => new ToolError('EINVAL', `Invalid path: ${why}. Paths are relative to the shared folder and use "/" (e.g. notes/todo.md).`);

/**
 * Rule 1 of the resolver: the path as a string. Returns the clean folder-relative path ('' = the folder
 * itself). Nothing here looks at the disk, so a refusal tells nothing about what exists.
 */
export function cleanPath(input: unknown, o: { win: boolean }): string {
  if (typeof input !== 'string') throw invalid('not a string');
  if (input.length > MAX_PATH_CHARS) throw invalid('too long');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(input)) throw invalid('control characters');
  // Windows separators, UNC (\\server\share), device namespaces (\\?\, \\.\): one rule refuses them all.
  if (input.includes('\\')) throw invalid('use "/" between folders, not "\\"');
  if (/^[A-Za-z]:/.test(input)) throw invalid('a drive path (C:…) is not folder-relative');
  if (input.startsWith('/')) throw invalid('absolute paths (/… or //server/…) are not folder-relative');
  const out: string[] = [];
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') throw invalid('".." is not allowed');
    // Look-alikes: full-width "．．" / "／" / "＼", the two-dot leader "‥"… must not pass as plain names
    // that some layer (a later normalisation, a Windows "best fit") could turn into real separators.
    const k = seg.normalize('NFKC');
    if (k === '.' || k === '..' || /[/\\]/.test(k) || (o.win && k.includes(':'))) throw invalid(`"${seg}" contains characters that look like "/", "\\", ":" or ".."`);
    if (o.win) {
      // Device names (CON, NUL, COM1, aux.txt), ':' (NTFS streams "a.md:secret"), trailing dots / spaces.
      const why = windowsNameProblem(seg) ?? windowsNameProblem(k);
      if (why) throw invalid(`"${seg}" ${why}`);
      // 8.3 short names ("GIT~1", "PRIVAT~1.MD") are second names for other entries. Only the real shape
      // (a base of at most 8 characters with its ~N, an extension of at most 3): "notes~2026.md" is ordinary.
      const short = /^([^.~]{1,6})~(\d{1,6})(\.[^.]{0,3})?$/.exec(seg);
      if (short && short[1].length + 1 + short[2].length <= 8) throw invalid(`"${seg}" looks like a Windows short (8.3) name; use the full name`);
    }
    out.push(seg);
  }
  return out.join('/');
}

/** The one visibility rule. NFC and NFKC forms are checked too, so a differently normalised spelling
 *  of an excluded name (macOS folds them) cannot reach it. */
export class Visibility {
  private readonly m: ExcludeMatcher;
  constructor(excludeGlobs: readonly string[]) {
    this.m = createExcludeMatcher([...excludeGlobs.map((g) => g.normalize('NFC')), ...KEY_FILE_GLOBS], false);
  }
  /** Name of one entry (listing). */
  hiddenName(name: string): boolean {
    return this.m.name(name) || this.m.name(name.normalize('NFC')) || name.normalize('NFKC').startsWith('.');
  }
  hidden(rel: string): boolean {
    if (!rel) return false;
    if (this.m.path(rel) || this.m.path(rel.normalize('NFC'))) return true;
    return rel.split('/').some((s) => this.hiddenName(s));
  }
}

export interface FolderEnv {
  settings(): Settings;
  configDir: string;
  /** Free the workspace, watcher and indexes after this long without a call. */
  idleMs: number;
  /** Windows path rules (process.platform === 'win32'; tests pass either). */
  win: boolean;
  /** Tests: skip the case probe (true = names differ by case). */
  caseSensitive?: boolean;
  /** The user's home folder (grant rules); default os.homedir(). */
  homedir?: string;
  /** Builds the search + link indexes (server.ts). Injected, so main (Revert) never bundles the search engine. */
  makeIndex?: (ws: Workspace, visible: (path: string) => boolean, single: (path: string) => Promise<boolean>) => FolderIndex;
}

/** What a write may change, checked by resolveTarget (the write side of the one resolver). */
export interface Target {
  key: string;
  abs: string;
  /** Stats of what is there now (links followed), null when nothing is. */
  st: fs.Stats | null;
}

/** A mtime + size pair: what a file must still be when a write or a revert lands. */
export interface Stamp {
  mtime: number;
  size: number;
}

export interface Resolved {
  key: string;
  abs: string;
  real: string;
  st: fs.Stats;
}

export interface TextFile {
  path: string;
  content: string;
  eol: Eol;
  encoding: TextEncoding;
  bom: boolean;
  binary: boolean;
  mtime: number;
  size: number;
}

export interface ListEntry {
  path: string;
  dir: boolean;
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const sameFile = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

export class Folder {
  alias: string;
  mode: McpMode;
  /** mcp.json grant (main asks first): code and config files may be written too, not only notes. */
  allowCode = false;
  readonly root: string;
  private ws: Workspace | null = null;
  private realRoot: string | null = null;
  /** The folder's own case rule (probed), for containment checks of real paths. */
  private fold = false;
  private warm: Promise<Workspace> | null = null;
  private unwatch: (() => void) | null = null;
  private vis: Visibility;
  private index: FolderIndex | null = null;
  private busy = 0;
  private idle: NodeJS.Timeout | null = null;
  private disposed = false;
  /** The visibility changed during a call: the workspace starts over once the folder is idle. */
  private stale = false;

  constructor(
    entry: { alias: string; path: string; mode: McpMode },
    private readonly env: FolderEnv,
  ) {
    this.alias = entry.alias;
    this.mode = entry.mode;
    this.root = path.resolve(entry.path);
    this.vis = new Visibility(env.settings().excludeGlobs ?? []);
  }

  get isWarm() {
    return !!this.ws;
  }

  get indexState(): string {
    return this.index ? this.index.progress() : 'not built';
  }

  /** Throws once the folder is no longer shared: checked before every disk step of a call in flight. */
  private live() {
    if (this.disposed) throw new ToolError('ENOENT', `The folder "${this.alias}" is no longer shared`);
  }

  /** The one check that writes are allowed here: read-write mode (--read-only makes it read), still shared. */
  checkWritable() {
    this.live();
    if (this.mode !== 'write') throw new ToolError('EACCES', `The folder "${this.alias}" is read-only. The user can allow changes in One → Settings → MCP server.`);
  }

  /** Runs a tool's work with the folder kept awake (the idle timer never frees it mid-call). */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    this.live();
    this.busy++;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    try {
      return await fn();
    } finally {
      this.busy--;
      if (!this.busy && !this.disposed) {
        if (this.stale) this.sleep();
        else {
          this.idle = setTimeout(() => this.sleep(), this.env.idleMs);
          this.idle.unref?.();
        }
      }
    }
  }

  hidden(rel: string): boolean {
    return this.vis.hidden(rel);
  }

  /**
   * New exclusions apply at once, also to calls in flight: the visibility is swapped now, the indexes
   * (whose totals, tags and typo corrections were built under the old rule) are dropped now, and the
   * workspace starts over as soon as the folder is idle.
   */
  reconfigure() {
    const s = this.env.settings();
    this.vis = new Visibility(s.excludeGlobs ?? []);
    this.ws?.setOptions({ exclude: [...(s.excludeGlobs ?? []), ...KEY_FILE_GLOBS], showHidden: false });
    this.index?.dispose();
    this.index = null;
    if (this.busy) this.stale = true;
    else this.sleep();
  }

  async workspace(): Promise<Workspace> {
    this.live();
    if (this.ws) return this.ws;
    return (this.warm ??= this.wake().finally(() => (this.warm = null)));
  }

  private async wake(): Promise<Workspace> {
    const st = await fsp.stat(this.root).catch(() => null);
    this.live();
    if (!st?.isDirectory()) throw new ToolError('ENOENT', `The folder "${this.alias}" is not available right now (moved, renamed or offline)`);
    const s = this.env.settings();
    this.vis = new Visibility(s.excludeGlobs ?? []);
    this.stale = false;
    const ws = new Workspace(this.root, {
      exclude: [...(s.excludeGlobs ?? []), ...KEY_FILE_GLOBS],
      showHidden: false,
      index: indexOptionsFrom(s),
      // Nothing index-related until a search / link tool asks (indexes.ts).
      warmIndexer: false,
      cacheDir: defaultCacheDir(this.env.configDir),
      // Links are never followed: one name per file, so no link can alias an excluded or hidden place.
      links: 'skip',
      deny: [this.env.configDir],
      ...(this.env.caseSensitive === undefined ? {} : { caseSensitive: this.env.caseSensitive }),
    });
    try {
      this.realRoot = await fsp.realpath(this.root);
      // Checked again where the folder really is now (a link can be re-pointed after mcp.json was read).
      if (grantProblem(this.realRoot, this.env)) throw new ToolError('ENOENT', `The folder "${this.alias}" cannot be shared (check it in One → Settings → MCP server)`);
      await ws.detectCase();
      this.fold = ws.foldsCase;
      this.live();
      // The watcher keeps the file list (search mode files) and the indexes current while the folder is awake.
      this.unwatch = ws.onEvents((e) => this.index?.onEvents(e));
      await ws.listTree();
      this.live();
    } catch (err) {
      this.unwatch?.();
      this.unwatch = null;
      ws.dispose();
      throw err;
    }
    this.ws = ws;
    return ws;
  }

  private relOfReal(real: string): string | null {
    const root = this.realRoot;
    if (!root || !isInsideDir(real, root, path, this.fold)) return null;
    const r = path.relative(root, real);
    return r.split(path.sep).join('/');
  }

  /** The search + link indexes, built on first use and kept current from the watcher. */
  async indexes(): Promise<FolderIndex> {
    const ws = await this.workspace();
    if (!this.env.makeIndex) throw new ToolError('ENOTSUP', 'No index here');
    return (this.index ??= this.env.makeIndex(ws, (p) => !this.hidden(p), (p) => this.singleLink(p)));
  }

  /** A plain file (one name, not a link): what the index may take in. Hard links are left out. */
  private async singleLink(rel: string): Promise<boolean> {
    const st = await fsp.lstat(path.join(this.root, ...rel.split('/'))).catch(() => null);
    return !!st && st.isFile() && st.nlink === 1;
  }

  /** After our own writes (the workspace does not echo them): the indexes catch up. */
  changed(events: FsEvent[]) {
    this.index?.onEvents(events);
  }

  /**
   * Walks `key` from the folder root without following anything: how many leading parts exist, and
   * whether one of them is a link (a junction on Windows). MCP paths never go through a link.
   */
  private async walkParts(key: string): Promise<{ existing: number; link: boolean; parts: string[] }> {
    const parts = key ? key.split('/') : [];
    let cur = this.root;
    for (let i = 0; i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      const st = await fsp.lstat(cur).catch(() => null);
      if (!st) return { existing: i, link: false, parts };
      if (st.isSymbolicLink()) return { existing: i, link: true, parts };
    }
    return { existing: parts.length, link: false, parts };
  }

  /** The existing part of `key` is exactly where it says: inside, and spelled as asked (no 8.3 or case alias). */
  private async spelledExactly(existing: string): Promise<boolean> {
    if (!existing) return true;
    const real = await fsp.realpath(path.join(this.root, ...existing.split('/'))).catch(() => null);
    return real !== null && this.relOfReal(real) === existing;
  }

  // ---- writes: the same resolver, write side ----------------------------------------------------

  /**
   * A path a write may change: rule 1 (cleanPath), names decided without the disk (hidden / key /
   * excluded → EACCES; file types by writeTypeProblem), then no part of it may be a link, and its
   * existing part must be spelled exactly as asked. `sameAs`: a case-only rename (the target is the
   * source under another spelling, on a case-insensitive folder).
   */
  async resolveTarget(input: unknown, o: { kind: 'file' | 'dir' | 'any'; exists: 'must' | 'mustNot' | 'may'; sameAs?: fs.Stats }): Promise<Target> {
    this.live();
    const key = cleanPath(input, { win: this.env.win });
    if (!key) throw new ToolError('EINVAL', 'Invalid path: empty (the folder itself cannot be changed)');
    // One neutral answer for every refusal of where: hidden, excluded, key file, through a link, hard link
    // (the reason would let a client probe the user's exclusions name by name).
    const refuse = () => new ToolError('EACCES', `Cannot change ${key}`);
    if (this.vis.hidden(key)) throw refuse();
    const typeErr = () => {
      const why = writeTypeProblem(key, this.allowCode);
      return why ? new ToolError('EINVAL', `Cannot change ${key}: ${why}`) : null;
    };
    if (o.kind === 'file' && o.exists === 'mustNot') {
      const e = typeErr(); // a new file: decided by the name alone, before the disk is asked
      if (e) throw e;
    }
    const miss = () => new ToolError('ENOENT', `Not found: ${key}`);
    const ws = await this.workspace();
    let abs: string;
    try {
      abs = await ws.real(key);
    } catch (err) {
      if (err instanceof BackendFailure && err.code === 'EINVAL') throw invalid(String(err.message).replace(/^Invalid file name /, ''));
      // Through a link out of the folder or into One's data folder: the same answer as any other refusal.
      if (err instanceof BackendFailure && (err.code === 'OUTSIDE_WORKSPACE' || err.code === 'EACCES')) throw refuse();
      throw miss();
    }
    this.live();
    const w = await this.walkParts(key);
    if (w.link) throw refuse();
    const exists = w.existing === w.parts.length;
    const st = exists ? await fsp.stat(abs).catch(() => null) : null;
    const caseRename = !!(st && o.sameAs && st.dev === o.sameAs.dev && st.ino === o.sameAs.ino);
    if (o.exists === 'must' && !st) throw miss();
    if (o.exists === 'mustNot' && st && !caseRename) throw new ToolError('EEXIST', `Already exists: ${key}`);
    const known = caseRename ? w.parts.slice(0, -1).join('/') : w.parts.slice(0, w.existing).join('/');
    if (!(await this.spelledExactly(known))) throw refuse();
    this.live();
    if (st && st.isFile() && st.nlink > 1) throw refuse(); // a hard link: possibly an outside file under an inside name
    if (st && o.kind === 'file' && !st.isFile()) throw new ToolError(st.isDirectory() ? 'EISDIR' : 'EINVAL', `${st.isDirectory() ? 'Is a folder' : 'Not a file'}: ${key}`);
    if (st && o.kind === 'dir' && !st.isDirectory()) throw new ToolError('ENOTDIR', `Not a folder: ${key}`);
    if (o.kind === 'file' || (st && o.kind === 'any' && st.isFile())) {
      const e = typeErr();
      if (e) throw e;
    }
    return { key, abs, st };
  }

  /** Where `abs` really is, folder-relative: the nearest existing part resolved, the rest appended. null = outside. */
  async realRelOf(abs: string): Promise<string | null> {
    let cur = abs;
    const rest: string[] = [];
    for (;;) {
      let real: string | null = null;
      try {
        real = await fsp.realpath(cur);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      }
      if (real !== null) return this.relOfReal(rest.length ? path.join(real, ...rest) : real);
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }

  /**
   * The commit-time check of a write (Workspace runs it inside the path's slot, right before the disk
   * changes): the folder is still shared and read-write, no part of the path is a link (nothing is
   * written through one, and no swapped-in link can redirect the write), its existing part is spelled
   * as asked, it is visible, the file is still what the caller saw (`expect`), and `capture` gets the
   * bytes about to be replaced (the journal). `caseRenameOf`: the source of a case-only rename.
   */
  guard(o: { expect?: Stamp | 'absent' | 'emptyDir'; capture?: (prev: Buffer | null, role: 'target' | 'from' | 'to') => void | Promise<void>; caseRenameOf?: string } = {}): WriteGuard {
    // strict: the Workspace itself also refuses to follow a link at commit, never rewrites in place, and
    // re-checks where the parent folder really is after the write / rename (WriteGuard docs).
    return Object.assign(async (abs: string, role: 'target' | 'from' | 'to') => {
      if (this.disposed || this.mode !== 'write') throw new BackendFailure('EREADONLY', 'Not writable');
      const rel = path.relative(this.root, abs);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Outside');
      const key = rel.split(path.sep).join('/');
      if (this.vis.hidden(key)) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Hidden');
      const w = await this.walkParts(key);
      if (w.link) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Through a link');
      const exists = w.existing === w.parts.length;
      const known = w.parts.slice(0, w.existing).join('/');
      if (!(await this.spelledExactly(known))) {
        // A case-only rename's target is the source under its old spelling.
        const ok = role === 'to' && exists && !!o.caseRenameOf && (await this.realRelOf(abs)) === o.caseRenameOf && (await this.spelledExactly(w.parts.slice(0, -1).join('/')));
        if (!ok) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Not where it says');
      }
      const st = exists ? await fsp.stat(abs).catch(() => null) : null;
      if (st?.isFile() && st.nlink > 1) throw new BackendFailure('OUTSIDE_WORKSPACE', 'Hard link');
      const e = role === 'to' ? undefined : o.expect;
      if (e === 'absent' && st) throw new BackendFailure('EEXIST', 'Already exists');
      if (e === 'emptyDir' && (!st?.isDirectory() || (await fsp.readdir(abs)).length)) throw new BackendFailure('EXTERNAL_CHANGE', 'Folder changed');
      if (e && typeof e === 'object' && (!st || Math.abs(st.mtimeMs - e.mtime) > 1 || st.size !== e.size)) throw new BackendFailure('EXTERNAL_CHANGE', 'File changed on disk');
      if (o.capture) await o.capture(st?.isFile() ? await fsp.readFile(abs) : null, role); // may refuse (journal quota)
      if (this.disposed || this.mode !== 'write') throw new BackendFailure('EREADONLY', 'Not writable');
    }, { strict: true as const });
  }

  /** Visible file paths (search mode files, list_files), from the workspace's own listing (links are not in it). */
  async filePaths(): Promise<string[]> {
    const ws = await this.workspace();
    return ws.filePaths().filter((p) => !this.hidden(p));
  }

  /** Rules 1–4 of the resolver (see the top of this file). */
  async resolve(input: unknown, o: { allowRoot?: boolean } = {}): Promise<Resolved> {
    this.live();
    const key = cleanPath(input, { win: this.env.win });
    if (!key && !o.allowRoot) throw new ToolError('EINVAL', 'Invalid path: empty');
    const miss = () => new ToolError('ENOENT', `Not found: ${key || '(folder root)'}`);
    if (this.hidden(key)) throw miss();
    const ws = await this.workspace();
    let abs: string;
    try {
      abs = await ws.real(key);
    } catch (err) {
      // Name rules of resolveInside (Windows device names…) say only what was asked; anything else is a miss.
      if (err instanceof BackendFailure && err.code === 'EINVAL') throw invalid(String(err.message).replace(/^Invalid file name /, ''));
      throw miss();
    }
    this.live();
    // No part may be a link, and the real location must be exactly the path as asked: no link, case
    // or 8.3 alias of something else (an excluded folder reached under another name).
    const w = await this.walkParts(key);
    if (w.link || w.existing !== w.parts.length) throw miss();
    const real = await fsp.realpath(abs).catch(() => null);
    if (real === null || this.relOfReal(real) !== key) throw miss();
    const st = await fsp.stat(real).catch(() => null);
    this.live();
    // A hard link is a second name of a file that may live anywhere (outside the folder too): not served.
    if (!st || (st.isFile() && st.nlink > 1)) throw miss();
    return { key, abs, real, st };
  }

  /** read_file / get_outline: text through the resolver, verified at the moment of the read. */
  async readText(input: unknown): Promise<TextFile> {
    return this.readResolved(await this.resolve(input));
  }

  /** The read itself, for a path resolve() checked (split out so tests can swap the file in between). */
  async readResolved(r: Resolved): Promise<TextFile> {
    this.live();
    if (r.st.isDirectory()) throw new ToolError('EISDIR', `Is a folder: ${r.key} (use list_files)`);
    if (!r.st.isFile()) throw new ToolError('EINVAL', `Not a regular file: ${r.key}`);
    if (r.st.size > MAX_READ_BYTES) throw new ToolError('ETOOBIG', `Too large to read here (${Math.round(r.st.size / 1048576)} MB, the limit is ${MAX_READ_BYTES / 1048576} MB): ${r.key}`);
    const miss = () => new ToolError('ENOENT', `Not found: ${r.key}`);
    let fh: fsp.FileHandle;
    try {
      fh = await fsp.open(r.real, fs.constants.O_RDONLY | O_NOFOLLOW);
    } catch {
      throw miss();
    }
    let buf: Buffer;
    let st: fs.Stats;
    try {
      st = await fh.stat();
      // Rule 5: the open file is the one that was checked, and the asked path still leads there.
      const again = await fsp.realpath(r.abs).catch(() => null);
      if (!sameFile(st, r.st) || again !== r.real) throw miss();
      this.live();
      buf = await fh.readFile();
    } finally {
      await fh.close().catch(() => {});
    }
    this.live();
    const d = decode(buf);
    return { path: r.key, content: d.binary ? '' : toLf(d.text), eol: detectEol(d.text), encoding: d.encoding, bom: d.bom, binary: d.binary, mtime: st.mtimeMs, size: st.size };
  }

  /** list_files: entries under a folder, `depth` levels deep, folders first, natural order. Links are left out. */
  async list(input: unknown, depth: number): Promise<{ key: string; entries: ListEntry[]; truncated: boolean }> {
    const r = await this.resolve(input, { allowRoot: true });
    if (!r.st.isDirectory()) throw new ToolError('ENOTDIR', `Not a folder: ${r.key} (use read_file)`);
    const entries: ListEntry[] = [];
    let scanned = 0;
    let truncated = false;
    const walk = async (realDir: string, relDir: string, level: number): Promise<void> => {
      this.live();
      let list: fs.Dirent[];
      try {
        list = await fsp.readdir(realDir, { withFileTypes: true });
      } catch {
        return;
      }
      const nodes: Array<{ name: string; dir: boolean }> = [];
      for (const e of list) {
        if (++scanned > MAX_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (this.vis.hiddenName(e.name) || this.hidden(rel)) continue;
        if (e.isDirectory()) nodes.push({ name: e.name, dir: true });
        else if (e.isFile()) nodes.push({ name: e.name, dir: false });
      }
      nodes.sort((a, b) => compareNodes({ name: a.name, kind: a.dir ? 'dir' : 'file' } as TreeNode, { name: b.name, kind: b.dir ? 'dir' : 'file' } as TreeNode));
      for (const n of nodes) {
        const rel = relDir ? `${relDir}/${n.name}` : n.name;
        entries.push({ path: rel, dir: n.dir });
        if (n.dir && level < depth && !truncated) await walk(path.join(realDir, n.name), rel, level + 1);
      }
    };
    await walk(r.real, r.key, 1);
    return { key: r.key, entries, truncated };
  }

  /** Output paths from the indexes, re-checked through the resolver before they are shown. */
  async visibleOnly(paths: string[]): Promise<Set<string>> {
    const ok = await Promise.all(paths.map((p) => this.resolve(p).then(() => true, () => false)));
    return new Set(paths.filter((_, i) => ok[i]));
  }

  /** Frees the workspace, its watcher and the indexes (the next call builds them again). */
  sleep(force = false) {
    if (this.busy && !force) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.stale = false;
    this.index?.dispose();
    this.index = null;
    this.unwatch?.();
    this.unwatch = null;
    this.ws?.dispose();
    this.ws = null;
    this.warm = null;
  }

  /** No longer shared: every call in flight fails at its next step, nothing wakes it again. */
  dispose() {
    this.disposed = true;
    this.sleep(true);
  }
}

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The grant rules (grant.ts) for a folder: as written and resolved, against the data folder as written and resolved. */
export function grantProblem(folder: string, env: Pick<FolderEnv, 'configDir' | 'homedir' | 'win'>): string | null {
  const o = { homedir: env.homedir ?? os.homedir(), foldCase: env.win || process.platform !== 'linux' };
  const homes = [o.homedir, realOr(o.homedir)];
  for (const f of [folder, realOr(folder)])
    for (const configDir of [env.configDir, realOr(env.configDir)])
      for (const homedir of homes) {
        const why = folderProblem(f, { configDir, homedir, foldCase: o.foldCase });
        if (why) return why;
      }
  return null;
}

/** Notes everywhere; other text files only with Settings → MCP server → "Also allow code and config files". */
export const NOTE_EXTS: ReadonlySet<string> = new Set(['md', 'markdown', 'txt']);
/** Never written, whatever the grant: Windows shell / execution types (.js runs in Windows Script Host on a
 *  double-click, .py / .pyw in the py launcher) and their Linux / macOS cousins. */
const NEVER_EXTS = new Set(['lnk', 'url', 'scf', 'library-ms', 'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'exe', 'dll', 'msi', 'msc', 'cpl', 'scr', 'pif', 'com', 'reg', 'jar', 'appref-ms', 'application', 'desktop', 'command', 'py', 'pyw']);
const NEVER_NAMES = new Set(['desktop.ini', 'autorun.inf']);

/** Why a write to `key` is refused by its file type, or null. */
export function writeTypeProblem(key: string, allowCode: boolean): string | null {
  const name = key.slice(key.lastIndexOf('/') + 1).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  if (NEVER_NAMES.has(name) || NEVER_EXTS.has(ext)) return 'program, script and shortcut files are never written by AI apps';
  if (NOTE_EXTS.has(ext)) return null;
  if (allowCode) return isProbablyTextName(name) ? null : 'only text files can be written (no text file extension)';
  return 'only notes (.md, .markdown, .txt) can be written. Code and config files need "Also allow code and config files" in One → Settings → MCP server';
}

export interface Narrowing {
  /** --folder <alias>: only this folder. */
  folder?: string;
  /** --read-only: no folder may be written, whatever its mode. */
  readOnly?: boolean;
}

export class FolderPool {
  private folders = new Map<string, Folder>();

  constructor(
    private readonly env: FolderEnv,
    private readonly narrow: Narrowing = {},
  ) {}

  /** mcp.json is a plain file: every entry passes the same grant rules main applies when the user adds it,
   *  on the path as written AND where it really leads (a link entry to the home folder is refused). */
  private granted(f: { alias: string; path: string }): boolean {
    const why = grantProblem(f.path, this.env);
    if (why) console.error(`[mcp] not serving "${f.alias}": ${why}`);
    return !why;
  }

  /** Applies a (new) mcp.json. Returns true when the folder set or a mode changed (the tool list may differ). */
  apply(cfg: McpConfig): boolean {
    const want = cfg.folders.filter((f) => (!this.narrow.folder || f.alias === this.narrow.folder) && this.granted(f));
    let changed = false;
    const keep = new Set(want.map((f) => f.alias));
    for (const [alias, f] of this.folders)
      if (!keep.has(alias) || path.resolve(want.find((w) => w.alias === alias)!.path) !== f.root) {
        f.dispose();
        this.folders.delete(alias);
        changed = true;
      }
    const next = new Map<string, Folder>();
    for (const w of want) {
      const mode: McpMode = this.narrow.readOnly ? 'read' : w.mode;
      let f = this.folders.get(w.alias);
      if (!f) {
        f = new Folder({ alias: w.alias, path: w.path, mode }, this.env);
        changed = true;
      } else if (f.mode !== mode) {
        f.mode = mode;
        changed = true;
      }
      f.allowCode = w.allowCode === true;
      next.set(w.alias, f);
    }
    this.folders = next; // config order
    return changed;
  }

  list(): Folder[] {
    return [...this.folders.values()];
  }

  get canWrite(): boolean {
    return this.list().some((f) => f.mode === 'write');
  }

  /** The `folder` argument → a folder. Optional while exactly one folder is shared. */
  get(alias: unknown): Folder {
    const all = this.list();
    if (!all.length) throw new ToolError('ENOENT', 'No folders are shared. Add one in One → Settings → MCP server.');
    if (alias === undefined || alias === null || alias === '') {
      if (all.length === 1) return all[0];
      throw new ToolError('EINVAL', `Several folders are shared: pass "folder" (one of: ${all.map((f) => f.alias).join(', ')})`);
    }
    const f = typeof alias === 'string' ? this.folders.get(alias.trim().toLowerCase()) : undefined;
    if (!f) throw new ToolError('ENOENT', `Unknown folder "${String(alias).slice(0, 40)}". Shared folders: ${all.map((x) => x.alias).join(', ')}`);
    return f;
  }

  /** Settings that change what is visible or indexed: applied at once, also to calls in flight. */
  resetAll() {
    for (const f of this.folders.values()) f.reconfigure();
  }

  dispose() {
    for (const f of this.folders.values()) f.dispose();
    this.folders.clear();
  }
}
