// Transport-agnostic implementation of the RPC surface. Electron IPC and the HTTP server both wrap this.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  DEFAULT_SETTINGS,
  MAX_BINARY_BYTES,
  isExternalUrl,
  type BootstrapData,
  type FsEvent,
  type RemoveOptions,
  type ResolvedPath,
  type SessionState,
  type Settings,
  type TextPageOptions,
  type WriteOptions,
} from '../shared/api';
import type { PdfExportResult, PdfLayout } from '../shared/pdf';
import { stem } from '../shared/paths';
import { isExtPath } from '../shared/external';
import { ExternalFiles } from './external-files';
import { BackendFailure, MAX_INDEX_BYTES, Workspace, retryWin, type IndexOptions, type WorkspaceOptions } from './workspace';
import { platformTrash } from './trash';
import { withFileLock } from './filelock';
import { checkPdfRequest, looksLikePdf, withPdfExtension, writeFileAtomic } from './pdf-export';
import { GitService, gitEnv, hasDotGitAboveAsync, locateGit, type GitServiceOptions } from './git';
import { GitMonitor, findNestedRepos, type GitMonitorEvent } from './git-monitor';
import { GitTrust } from './git-trust';
import { diffTexts } from './git-compare';
import { GIT_OPS } from '../shared/git';
import { ProcessExplorer } from './processes';
import type { ProcRequest, ProcSnapshot } from '../shared/processes';
import { winSystemExe } from './winsys';
import { isMainOwnedKey } from '../shared/mcp';
import { applyOp, cleanList, cleanOp, type Bookmark } from '../shared/bookmarks';
import { cleanAssociations } from '../shared/languages';
import { linuxDistro, macSystemVersion, type OsVersionInfo } from '../shared/os-version';

// Moved to ./appdata (dependency-light, shared with the MCP server); re-exported for existing callers.
export { defaultConfigDir, defaultCacheDir, indexOptionsFrom } from './appdata';
import { defaultCacheDir, defaultConfigDir, indexOptionsFrom } from './appdata';

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

// Writes to the same file are serialised (and each uses a unique temp name) so overlapping saves
// can never interleave or rename a temp file that another write already moved.
const writeChains = new Map<string, Promise<void>>();
export function writeJson(file: string, data: unknown): Promise<void> {
  const prev = writeChains.get(file) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
      try {
        // Windows: antivirus / Defender briefly lock settings.json → EPERM; don't lose the user's setting.
        await retryWin(() => fsp.rename(tmp, file));
      } catch (err) {
        await fsp.rm(tmp, { force: true });
        throw err;
      }
    });
  writeChains.set(file, next);
  void next.finally(() => writeChains.get(file) === next && writeChains.delete(file)).catch(() => {});
  return next;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Stable per-folder id for config files (sessions, export folders). */
export const rootId = (root: string) => crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);

const INDEX_KEYS = ['search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB', 'files.associations'];
/** The app's index options: a name the user's file type associations cover is text too (search, symbols).
 *  The MCP server keeps the built-in names (it calls indexOptionsFrom itself). */
const appIndexOptions = (s: Settings): IndexOptions => ({ ...indexOptionsFrom(s), textPatterns: cleanAssociations(s['files.associations']).map((r) => r.pattern) });

const samePath = (a: string, b: string) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());
/** recent.json → its paths (anything else in a hand-edited file is dropped). */
const recentList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
/** export-dirs.json → its object (a corrupt file counts as empty). */
const exportDirsOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export interface ServiceHooks {
  /** Native folder picker; absent in server mode. */
  pickFolder?: () => Promise<string | null>;
  /** Native file picker; absent in server mode. */
  pickFile?: () => Promise<string | null>;
  /** Move to OS trash (Electron shell.trashItem). Falls back to the platform trash, then fails with ETRASH. */
  trash?: (absPath: string) => Promise<void>;
  /**
   * The hook's refusal is final: report ETRASH (the UI then offers "delete permanently") instead of trying
   * the platform trash. On Windows Electron refuses on purpose when an item cannot be recycled (USB stick,
   * network share, too big for the bin); the PowerShell fallback would silently delete it for good.
   */
  trashIsAuthoritative?: boolean;
  openExternal?: (url: string) => Promise<void>;
  /** Show a file in Explorer/Finder (Electron shell.showItemInFolder). */
  revealInFolder?: (absPath: string) => void | Promise<void>;
  /** Standalone HTML → PDF bytes (Electron: printToPDF in a locked-down hidden window). Absent in server mode. */
  renderPdf?: (html: string, layout: PdfLayout) => Promise<Uint8Array>;
  /** Native "Save as" dialog for a PDF; null = cancelled. */
  pickSavePath?: (defaultPath: string) => Promise<string | null>;
  /** Open a file with its default app (Electron shell.openPath). */
  openPath?: (absPath: string) => Promise<void>;
  /**
   * Whose open tabs / tree / layout this process keeps per folder. 'web' = browser mode (every HTTP server,
   * "Start web server" and the .cmd included): its own session file, so a browser tab and the desktop app on
   * the same folder never overwrite each other. Settings stay shared. Default 'desktop'.
   */
  sessionKind?: 'desktop' | 'web';
  /** Desktop main only: files the user opened outside the open folder may be served (backend/external-files.ts). Server mode never sets it. */
  externalFiles?: boolean;
}

export class BackendService {
  workspace: Workspace | null = null;
  private settings: Settings | null = null;
  private settingsLoad: Promise<Settings> | null = null;
  private fsListeners = new Set<(e: FsEvent[]) => void>();
  private settingsListeners = new Set<(s: Settings, patch: Partial<Settings>) => void>();
  /** Changes another process wrote to settings.json (desktop ↔ browser mode), see watchSettings(). */
  private externalSettingsListeners = new Set<(patch: Partial<Settings>) => void>();
  private settingsWatch: { close(): void } | null = null;
  /** Keys of our own patches not on disk yet: a file event in between must not revert them. */
  private settingsInFlight = new Map<string, number>();
  private settingsWrites: Promise<unknown> = Promise.resolve();
  private unwatch: (() => void) | null = null;
  /**
   * recent.json as this process last saw it (rapid opens must not read a stale file). Other windows /
   * processes write it too: `recentStamp` = the file's identity when read, a different one is read again.
   */
  private recent: string[] | null = null;
  private recentStamp: string | null = null;
  /** Bumped by every local change: a read that started before one must not replace it. */
  private recentGen = 0;
  /** Our writes not on disk yet: the in-memory list is the newest meanwhile. */
  private recentPending = 0;
  private recentWrites: Promise<unknown> = Promise.resolve();
  /** Absolute paths waiting for the renderer (launch args); drained by bootstrap(). */
  readonly openRequests: string[] = [];
  /** True once a renderer has called bootstrap(): later open requests are sent to it instead of queued. */
  booted = false;
  /** PDFs written by exportPdf in this process: the only files showExportedFile will open. */
  private exported = new Set<string>();
  /** export-dirs.json (workspace id → last PDF folder): our entries not on disk yet (the file is read per export). */
  private exportDirs = new Map<string, string>();
  private exportDirWrites: Promise<unknown> = Promise.resolve();
  /** Git for the open folder: created on the first git call (no spawn at launch). */
  private monitor: GitMonitor | null = null;
  private gitListeners = new Set<(e: GitMonitorEvent) => void>();
  private gitUnsub: (() => void) | null = null;
  /** Folders git may run in (app data, see git-trust.ts); the verdict for the open folder is kept until it changes. */
  private trustStore: GitTrust | null = null;
  private trustOf: { root: string; trusted: Promise<boolean> } | null = null;
  private repoLikely: { root: string; at: number; p: Promise<boolean> } | null = null;

  constructor(
    readonly configDir: string = defaultConfigDir(),
    private hooks: ServiceHooks = {},
    private workspaceOptions: Pick<WorkspaceOptions, 'watchMode' | 'debounceMs' | 'pollMs' | 'readThreads' | 'cacheDir'> = {},
    private gitOptions: GitServiceOptions = {},
  ) {
    this.ext.onEvents((e) => this.fsListeners.forEach((l) => l(e)));
  }

  /** Files outside the open folder that the user opened: the allow-list (empty, and unreachable, in server mode). */
  private readonly ext = new ExternalFiles();

  /**
   * Puts a file the user chose on the allow-list and returns its id (shared/external.ts). Callers vouch for the path
   * (main: open-gate); a page cannot reach this with a path of its own. Desktop only.
   */
  async openExternalFile(absPath: string): Promise<string> {
    if (!this.hooks.externalFiles) throw new BackendFailure('ENOTSUP', 'Opening files outside the folder works in the desktop app');
    return this.ext.allow(absPath);
  }

  private get settingsFile() {
    return path.join(this.configDir, 'settings.json');
  }
  private get recentFile() {
    return path.join(this.configDir, 'recent.json');
  }
  private sessionFile(root: string, kind = this.hooks.sessionKind ?? 'desktop') {
    return path.join(this.configDir, 'sessions', `${rootId(root)}${kind === 'web' ? '@web' : ''}.json`);
  }
  /** Last folder a PDF was saved to, per workspace. */
  private get exportDirsFile() {
    return path.join(this.configDir, 'export-dirs.json');
  }

  private ws(): Workspace {
    if (!this.workspace) throw new BackendFailure('NO_WORKSPACE', 'No folder is open');
    return this.workspace;
  }

  onFsEvents(cb: (e: FsEvent[]) => void): () => void {
    this.fsListeners.add(cb);
    return () => this.fsListeners.delete(cb);
  }

  /** Main process uses this to follow theme changes (native title bar, window background). */
  /** Only what another sec-edit process changed (never our own saves): forward it to the UI. */
  onExternalSettings(cb: (patch: Partial<Settings>) => void): () => void {
    this.externalSettingsListeners.add(cb);
    return () => this.externalSettingsListeners.delete(cb);
  }

  onSettingsChanged(cb: (s: Settings, patch: Partial<Settings>) => void): () => void {
    this.settingsListeners.add(cb);
    return () => this.settingsListeners.delete(cb);
  }

  async bootstrap(): Promise<BootstrapData> {
    this.booted = true;
    const [settings, recent, session] = await Promise.all([this.getSettings(), this.recentWorkspaces(), this.workspace ? this.getSession() : Promise.resolve(null)]);
    return {
      os: process.platform,
      settings,
      workspace: this.workspace?.info() ?? null,
      session,
      recent,
      openRequests: this.openRequests.splice(0),
    };
  }

  async getWorkspace() {
    return this.workspace?.info() ?? null;
  }

  async openWorkspace(absPath: string) {
    const resolved = path.resolve(absPath);
    // Git trust migrates from the recent list as it was BEFORE this open adds to it.
    const [st] = await Promise.all([fsp.stat(resolved).catch(() => null), this.gitTrust().ready()]);
    if (!st?.isDirectory()) throw new BackendFailure('ENOENT', `Not a folder: ${absPath}`);
    // A WSL root on Windows tells "Notes" from "notes": only fold where the open folder does.
    if (this.workspace && (this.workspace.foldsCase ? samePath(this.workspace.root, resolved) : this.workspace.root === resolved)) return this.workspace.info();
    this.unwatch?.();
    this.workspace?.dispose();
    this.disposeGit();
    const s = await this.getSettings();
    // The text cache lives with the app's data (never inside the folder); '' = off.
    const cacheDir = this.workspaceOptions.cacheDir === undefined ? defaultCacheDir(this.configDir) : this.workspaceOptions.cacheDir || undefined;
    // search.indexing = onDemand: no indexer thread at open; the renderer's first consumer starts it.
    const warmIndexer = s['search.indexing'] !== 'onDemand';
    // One's own data (settings, mcp.json, the vault, git trust, the text cache) is never served, even
    // when the open folder contains it (the home folder on Windows: AppData is no dot name).
    const deny = [this.configDir, ...(cacheDir ? [cacheDir] : [])];
    this.workspace = new Workspace(resolved, { exclude: s.excludeGlobs, showHidden: s.showHiddenFiles, index: appIndexOptions(s), warmIndexer, ...this.workspaceOptions, cacheDir, deny });
    this.unwatch = this.workspace.onEvents((e) => {
      this.fsListeners.forEach((l) => l(e));
      this.monitor?.trigger('fs', e.map((x) => x.path));
    });
    await this.recentWorkspaces(); // the list the change applies to (also picks up other writers)
    void this.changeRecent((list) => [resolved, ...list.filter((p) => !samePath(p, resolved))].slice(0, 20)).catch(() => {});
    const ws = this.workspace;
    await ws.detectCase(); // the renderer's create / rename checks need it (lookups only, no writes)
    return ws.info();
  }

  async pickFile() {
    return this.hooks.pickFile ? this.hooks.pickFile() : null;
  }
  async pickFolder() {
    return this.hooks.pickFolder ? this.hooks.pickFolder() : null;
  }

  async recentWorkspaces(): Promise<string[]> {
    if (this.recent && this.recentPending) return [...this.recent];
    const gen = this.recentGen;
    // Stat before read: a change in between is seen (and read) next time.
    const stamp = await this.recentFileStamp();
    if (this.recent && stamp === this.recentStamp) return [...this.recent];
    const list = recentList(await readJson<unknown>(this.recentFile, []));
    if (gen === this.recentGen && !this.recentPending) {
      this.recent = list;
      this.recentStamp = stamp;
    }
    return [...(this.recent ?? list)];
  }

  async forgetRecent(absPath: string) {
    await this.recentWorkspaces();
    await this.changeRecent((list) => list.filter((p) => !samePath(p, absPath)));
    return [...(this.recent ?? [])];
  }

  /** Identity of recent.json on disk (an atomic write is a new file: new inode / file id), null = missing. */
  private async recentFileStamp(): Promise<string | null> {
    const st = await fsp.stat(this.recentFile).catch(() => null);
    return st ? `${st.ino}:${st.mtimeMs}:${st.size}` : null;
  }

  /**
   * One change to the recent list: applied in memory now, then to the file as it is on disk, under the
   * file lock (other windows / processes write recent.json too: a whole stale copy dropped their entries).
   */
  private changeRecent(op: (list: string[]) => string[]): Promise<void> {
    this.recent = op(this.recent ?? []);
    this.recentGen++;
    this.recentPending++;
    const run = this.recentWrites.then(() =>
      withFileLock(this.recentFile, async () => {
        const next = op(recentList(await readJson<unknown>(this.recentFile, [])));
        await writeJson(this.recentFile, next);
        return { next, stamp: await this.recentFileStamp() }; // stamped inside the lock: no other writer yet
      }),
    );
    const done = run.then(
      ({ next, stamp }) => {
        // The last of our writes landed: the merged file is the list now.
        if (--this.recentPending) return;
        this.recent = next;
        this.recentStamp = stamp;
        this.recentGen++;
      },
      (err) => {
        this.recentPending--; // the file is unchanged (same stamp): memory keeps the change
        throw err;
      },
    );
    this.recentWrites = done.catch(() => {});
    return done;
  }

  async resolvePath(absPath: string): Promise<ResolvedPath | null> {
    let abs = path.resolve(absPath);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st || !(st.isFile() || st.isDirectory())) return null;
    if (process.platform !== 'linux') {
      // Case-insensitive FS: "c:\notes\TODO.md" must map to the tree's "todo.md", not open a twin doc.
      const real = await new Promise<string>((r) => fs.realpath.native(abs, (err, out) => r(err ? abs : out)));
      if (!this.workspace || this.workspace.rel(real) !== null || this.workspace.rel(abs) === null) abs = real;
    }
    const rel = this.workspace?.rel(abs) ?? null;
    return { abs, kind: st.isDirectory() ? 'dir' : 'file', rel: rel === '' && st.isDirectory() ? '' : rel };
  }

  listTree(p?: string) {
    return this.ws().listTree(p ?? '');
  }
  /** `opts` comes from the page: only a finite, non-negative `maxBytes` and `asText: true | 'full'` are passed on. */
  readFile(p: string, opts?: unknown) {
    const o = opts && typeof opts === 'object' ? (opts as { maxBytes?: unknown; asText?: unknown }) : {};
    const max = typeof o.maxBytes === 'number' && Number.isFinite(o.maxBytes) && o.maxBytes >= 0 ? { maxBytes: Math.floor(o.maxBytes) } : {};
    // Anything but the two known modes (a made-up string, a truthy number) is the normal refusal.
    const asText = o.asText === 'full' ? { asText: 'full' as const } : o.asText === true ? { asText: true as const } : {};
    if (isExtPath(p)) return this.ext.read(p, { ...max, ...asText });
    return this.ws().readFile(p, { ...max, ...asText });
  }
  writeFile(p: string, content: string, opts?: WriteOptions) {
    if (isExtPath(p)) return this.ext.write(p, content, opts);
    return this.ws()
      .writeFile(p, content, opts)
      .then((r) => (this.gitTouched('save', [p]), r));
  }
  createFile(p: string, content?: string) {
    if ([p].some(isExtPath)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    return this.ws()
      .createFile(p, content)
      .then((r) => (this.gitTouched('fs', [p]), r));
  }
  createDir(p: string) {
    if ([p].some(isExtPath)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    return this.ws()
      .createDir(p)
      .then((r) => (this.gitTouched('fs', [p]), r));
  }
  rename(a: string, b: string) {
    if ([a, b].some(isExtPath)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    return this.ws()
      .rename(a, b)
      .then((r) => (this.gitTouched('fs', [a, b]), r));
  }

  async remove(p: string, opts: RemoveOptions = {}) {
    if ([p].some(isExtPath)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    try {
      await this.removeNow(p, opts);
    } finally {
      this.gitTouched('fs', [p]);
    }
  }

  private async removeNow(p: string, opts: RemoveOptions) {
    const ws = this.ws();
    if (opts.permanent) return ws.remove(p);
    const hook = this.hooks.trash;
    await ws.remove(p, async (abs) => {
      if (hook) {
        try {
          return await hook(abs);
        } catch (err: any) {
          if (this.hooks.trashIsAuthoritative) throw new BackendFailure('ETRASH', `Could not move to trash: ${err?.message || err}`);
        }
      }
      try {
        await platformTrash(abs);
      } catch (err: any) {
        throw new BackendFailure('ETRASH', `Could not move to trash: ${err?.message || err}`);
      }
    });
  }

  readAllText() {
    return this.ws().readAllText();
  }

  // ---- index channel (not RPC: the search workers fetch these directly; see main.ts / server.ts) ----

  /** A page of the full index pass as UTF-8 JSON (a TextPage), produced off this thread. */
  indexPageRaw(cursor: string | null, maxBytes?: number): Promise<Uint8Array> {
    return this.ws().readAllTextPageRaw({ cursor, maxBytes });
  }

  /** Current text of changed files as UTF-8 JSON {files, skipped, gone} (incremental index updates). */
  indexFilesRaw(paths: unknown): Promise<Uint8Array> {
    if (!Array.isArray(paths) || paths.length > 20_000 || !paths.every((p) => typeof p === 'string')) throw new BackendFailure('EINVAL', 'paths must be an array of strings');
    return this.ws().readIndexedFilesRaw(paths as string[]);
  }
  readAllTextPage(opts?: TextPageOptions) {
    return this.ws().readAllTextPage(opts && typeof opts === 'object' ? opts : {});
  }

  /** `base64`: standard alphabet, padding optional. Decoded size is capped (MAX_BINARY_BYTES). */
  async writeBinary(p: string, base64: string) {
    if (isExtPath(p)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    const ws = this.ws();
    if (typeof base64 !== 'string') throw new BackendFailure('EINVAL', 'Content must be a base64 string');
    // Checked before decoding, so an oversized payload never allocates its buffer.
    const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (bytes > MAX_BINARY_BYTES) {
      throw new BackendFailure('ETOOBIG', `File is too large (${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_BINARY_BYTES / 1048576} MB)`);
    }
    // Buffer.from silently skips invalid characters: corrupt input must fail, not write garbage.
    if (base64.length % 4 === 1 || !BASE64_RE.test(base64)) throw new BackendFailure('EINVAL', 'Content is not valid base64');
    const r = await ws.writeBinary(p, Buffer.from(base64, 'base64'));
    this.gitTouched('save', [p]);
    return r;
  }

  async revealInFolder(p: string) {
    if ([p].some(isExtPath)) throw new BackendFailure('EINVAL', 'Not available for a file outside the folder');
    const abs = await this.ws().real(p, 'entry');
    if (this.hooks.revealInFolder) return void (await this.hooks.revealInFolder(abs));
    // Server mode: best effort with the platform's file manager.
    const win = process.platform === 'win32';
    // explorer.exe has its own parser: it needs `/select,"C:\a b\x.md"` verbatim — Node's default quoting
    // ("/select,C:\a b\x.md") makes it open Documents instead. `"` cannot occur in a Windows path.
    const [cmd, args] = win ? [winSystemExe('explorer.exe'), [`/select,"${abs}"`]] : process.platform === 'darwin' ? ['open', ['-R', abs]] : ['xdg-open', [path.dirname(abs)]];
    await new Promise<void>((resolve, reject) =>
      execFile(cmd, args as string[], { windowsHide: true, windowsVerbatimArguments: win }, (err) => (err && !win ? reject(new BackendFailure('EIO', 'No file manager available')) : resolve())),
    );
  }

  async exportPdf(req: unknown): Promise<PdfExportResult | null> {
    const ws = this.ws();
    const { path: rel, noteAbs, html, layout } = await checkPdfRequest(req, (p) => ws.abs(p));
    const { renderPdf, pickSavePath } = this.hooks;
    if (!renderPdf || !pickSavePath) throw new BackendFailure('ENOTSUP', 'PDF export needs the desktop app. In the browser use Print and pick "Save as PDF"');
    const key = rootId(ws.root);
    const saved = this.exportDirs.get(key) ?? exportDirsOf(await readJson<unknown>(this.exportDirsFile, {}))[key];
    const last = typeof saved === 'string' ? saved : null;
    const dir = last && (await fsp.stat(last).then((st) => st.isDirectory(), () => false)) ? last : path.dirname(noteAbs);
    // Render while the dialog is open: the PDF is usually ready by the time "Save" is clicked.
    const rendering = renderPdf(html, layout);
    rendering.catch(() => {}); // cancelled dialog → nobody awaits it
    const picked = await pickSavePath(path.join(dir, `${stem(rel)}.pdf`));
    if (!picked) return null;
    const abs = withPdfExtension(path.resolve(picked));
    const bytes = await rendering;
    if (!looksLikePdf(bytes)) throw new BackendFailure('EIO', 'The PDF renderer returned no document');
    const inside = ws.rel(abs);
    // Inside the folder: through the workspace (index + tree stay in sync, no watcher echo).
    if (inside && bytes.byteLength <= MAX_BINARY_BYTES) await ws.writeBinary(inside, bytes);
    else await writeFileAtomic(abs, bytes, retryWin);
    this.exported.add(abs);
    void this.saveExportDir(key, path.dirname(abs)).catch(() => {});
    return { abs, rel: inside, bytes: bytes.byteLength };
  }

  /** This folder's entry only, merged into the file as it is now under the file lock (other windows' folders stay). */
  private saveExportDir(key: string, dir: string): Promise<void> {
    this.exportDirs.set(key, dir);
    const run = this.exportDirWrites.then(() =>
      withFileLock(this.exportDirsFile, async () => {
        const disk = exportDirsOf(await readJson<unknown>(this.exportDirsFile, {}));
        await writeJson(this.exportDirsFile, { ...disk, [key]: dir });
      }),
    );
    // On disk now: the file is the answer again (a failed write keeps ours in memory).
    const done = run.then(() => void (this.exportDirs.get(key) === dir && this.exportDirs.delete(key)));
    this.exportDirWrites = done.catch(() => {});
    return done;
  }

  async showExportedFile(abs: unknown, how: unknown) {
    if (typeof abs !== 'string' || !this.exported.has(abs)) throw new BackendFailure('EACCES', 'Only PDFs exported in this session can be opened from here');
    const hook = how === 'open' ? this.hooks.openPath : how === 'reveal' ? this.hooks.revealInFolder : undefined;
    if (how !== 'open' && how !== 'reveal') throw new BackendFailure('EINVAL', `Unknown action: ${String(how)}`);
    if (!hook) throw new BackendFailure('ENOTSUP', 'Not available here');
    await hook(abs);
  }

  async getSettings(): Promise<Settings> {
    if (this.settings) return this.settings;
    this.settingsLoad ??= readJson<Partial<Settings>>(this.settingsFile, {}).then((s) => {
      this.settings = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
      this.watchSettings();
      return this.settings;
    });
    return this.settingsLoad;
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    // Grants of the MCP server are main's (mcp.json, behind native dialogs): never set from a page.
    if (patch && typeof patch === 'object') patch = Object.fromEntries(Object.entries(patch).filter(([k]) => !isMainOwnedKey(k))) as Partial<Settings>;
    await this.getSettings();
    // Merge into the *current* object after the await, so concurrent saves never drop each other's patch.
    const next = { ...this.settings!, ...patch } as Settings;
    this.settings = next;
    this.applySettingEffects(next, patch);
    this.settingsListeners.forEach((l) => l(next, patch));
    await this.writeSettingsPatch(patch);
    return this.settings!;
  }

  private applySettingEffects(next: Settings, patch: Partial<Settings>) {
    if (this.workspace && ('excludeGlobs' in patch || 'showHiddenFiles' in patch)) {
      this.workspace.setOptions({ exclude: next.excludeGlobs, showHidden: next.showHiddenFiles });
    }
    if (this.workspace && INDEX_KEYS.some((k) => k in patch)) this.workspace.setIndexOptions(appIndexOptions(next));
    if ('git.wslRouting' in patch) this.disposeGit(); // the next git call rebuilds the monitor with the new routing
    if ('git.refreshIndex' in patch) this.monitor?.setRefreshIndex(next['git.refreshIndex'] !== false);
  }

  /**
   * Only the changed keys, merged into the file as it is *now*: the desktop app and a browser-mode server
   * share settings.json, and writing a whole (stale) in-memory copy dropped the other one's changes.
   */
  private writeSettingsPatch(patch: Partial<Settings>): Promise<void> {
    const keys = Object.keys(patch);
    for (const k of keys) this.settingsInFlight.set(k, (this.settingsInFlight.get(k) ?? 0) + 1);
    const run = this.settingsWrites.then(() =>
      withFileLock(this.settingsFile, async () => {
        const disk = await readJson<Partial<Settings> | null>(this.settingsFile, null);
        await writeJson(this.settingsFile, { ...(disk && typeof disk === 'object' ? disk : {}), ...patch });
      }),
    );
    const done = run.finally(() => {
      for (const k of keys) {
        const n = (this.settingsInFlight.get(k) ?? 1) - 1;
        if (n > 0) this.settingsInFlight.set(k, n);
        else this.settingsInFlight.delete(k);
      }
    });
    this.settingsWrites = done.catch(() => {});
    return done;
  }

  /** Picks up settings.json written by another process (debounced). Our own writes produce no diff. */
  private watchSettings() {
    if (this.settingsWatch) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const kick = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.reloadSettings().catch(() => {}), 120);
      timer.unref?.();
    };
    const file = this.settingsFile;
    try {
      fs.mkdirSync(this.configDir, { recursive: true });
      // The folder, not the file: an atomic rename replaces the file (and a watch on it would go deaf).
      const w = fs.watch(this.configDir, { persistent: false }, (_e, name) => (!name || name === 'settings.json') && kick());
      w.on('error', () => {});
      this.settingsWatch = { close: () => (w.close(), timer && clearTimeout(timer)) };
    } catch {
      const poll = () => kick();
      fs.watchFile(file, { interval: 2000, persistent: false }, poll);
      this.settingsWatch = { close: () => fs.unwatchFile(file, poll) };
    }
  }

  private async reloadSettings() {
    const cur = this.settings;
    const disk = await readJson<Partial<Settings> | null>(this.settingsFile, null);
    if (!cur || !disk || typeof disk !== 'object') return;
    const fresh: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...disk };
    const patch: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(cur), ...Object.keys(fresh)])) {
      if (this.settingsInFlight.has(k)) continue;
      const a = (cur as Record<string, unknown>)[k] ?? null;
      const b = fresh[k] ?? null;
      if (JSON.stringify(a) !== JSON.stringify(b)) patch[k] = b;
    }
    if (!Object.keys(patch).length || this.settings !== cur) return;
    const next = { ...cur, ...patch } as Settings;
    this.settings = next;
    this.applySettingEffects(next, patch as Partial<Settings>);
    this.settingsListeners.forEach((l) => l(next, patch as Partial<Settings>));
    this.externalSettingsListeners.forEach((l) => l(patch as Partial<Settings>));
  }

  /** Last session written per workspace root: a reload's first getSession() can arrive while the
   *  unload-time saveSession() is still writing, and must not read the older file. */
  private sessionCache = new Map<string, SessionState>();

  async getSession(): Promise<SessionState> {
    const ws = this.workspace;
    if (!ws) return { openTabs: [], activeTab: null };
    const empty: SessionState = { openTabs: [], activeTab: null };
    let s = this.sessionCache.get(ws.root) ?? (await readJson<SessionState | null>(this.sessionFile(ws.root), null));
    // First browser visit: start from the desktop's tabs (a read-only seed; saves go to the web file only).
    if (!s && this.hooks.sessionKind === 'web') s = await readJson<SessionState | null>(this.sessionFile(ws.root, 'desktop'), null);
    s = s && typeof s === 'object' ? s : empty;
    return { ...s, openTabs: Array.isArray(s.openTabs) ? s.openTabs : [], activeTab: s.activeTab ?? null };
  }

  async saveSession(s: SessionState) {
    // Its tab list is the window's "which files are open": closed outside files stop being polled.
    if (Array.isArray(s?.openTabs)) this.ext.setOpen(s.openTabs);
    const ws = this.workspace;
    if (!ws) return;
    this.sessionCache.set(ws.root, s); // synchronously, before the write: see sessionCache
    await writeJson(this.sessionFile(ws.root), s);
  }

  /** In-process order of bookmark reads / changes (the file lock covers other processes). */
  private bookmarkChain: Promise<unknown> = Promise.resolve();

  /**
   * Bookmarks of the open folder (renderer/bookmarks): `<app data>/bookmarks/<folder id>.json`, never in the folder,
   * shared by desktop and browser mode. No argument reads; a change (shared/bookmarks.ts `BookmarkOp`, validated
   * by `cleanOp`) is applied to the list as it is on disk, under the file lock, and the new list is returned.
   * Bookmarks are data only: nothing here touches a bookmarked path.
   */
  async bookmarks(op?: unknown): Promise<Bookmark[]> {
    const file = path.join(this.configDir, 'bookmarks', `${rootId(this.ws().root)}.json`);
    const change = op === undefined || op === null ? null : cleanOp(op);
    if (op != null && !change) throw new BackendFailure('EINVAL', 'Invalid bookmark change');
    const read = async () => cleanList((await readJson<{ items?: unknown } | null>(file, null))?.items);
    const run = this.bookmarkChain.then(() =>
      change
        ? withFileLock(file, async () => {
            const list = applyOp(await read(), change);
            await writeJson(file, { version: 1, items: list });
            return list;
          })
        : read(),
    );
    this.bookmarkChain = run.catch(() => {});
    return run;
  }

  async openExternal(url: string) {
    if (typeof url !== 'string' || !isExternalUrl(url)) throw new BackendFailure('EIO', 'Refusing to open non-web URL');
    await this.hooks.openExternal?.(url);
  }

  // ---- git (status + source control), one validated entry point ---------------------------------

  /** The folder's git monitor: repositories, status cadence, deltas. Created on the first git call. */
  private gitMonitor(): GitMonitor {
    const ws = this.ws();
    if (this.monitor?.root === ws.root) return this.monitor;
    this.disposeGit();
    const routing = this.settings?.['git.wslRouting'] === 'off' ? 'off' : (this.gitOptions.wsl?.mode ?? 'auto');
    // foldCase per folder: on a WSL root "note.md" (new) must not show the change bars of "Note.md".
    const opts: GitServiceOptions = { foldCase: ws.foldsCase, ...this.gitOptions, wsl: { ...this.gitOptions.wsl, mode: routing } };
    this.monitor = new GitMonitor(ws.root, (root) => new GitService(root, opts), { refreshIndex: this.settings?.['git.refreshIndex'] !== false });
    this.gitUnsub = this.monitor.onEvent((e) => this.gitListeners.forEach((l) => l(e)));
    return this.monitor;
  }

  private gitTrust(): GitTrust {
    return (this.trustStore ??= new GitTrust(path.join(this.configDir, 'git-trust.json'), { recent: () => this.recentWorkspaces() }));
  }

  /** May git run in the open folder? (The user's "Trust" — see git-trust.ts.) */
  private gitTrusted(): Promise<boolean> {
    const ws = this.ws();
    if (this.trustOf?.root !== ws.root) {
      const trusted = ws.detectCase().then(() => this.gitTrust().isTrusted(ws.root, ws.foldsCase)).catch(() => false);
      const mine = (this.trustOf = { root: ws.root, trusted });
      // Only "trusted" is kept: "not yet" is asked again (another window of the app may have said Trust since).
      void trusted.then((ok) => !ok && this.trustOf === mine && (this.trustOf = null));
    }
    return this.trustOf.trusted;
  }

  /** Looks like a repository on disk (a `.git` here, above, or in a folder below)? Nothing is run to find out. */
  private looksLikeRepo(): Promise<boolean> {
    const root = this.ws().root;
    // Briefly cached (status is asked for in bursts); `git init` in a terminal shows up on the next look.
    if (this.repoLikely?.root !== root || Date.now() - this.repoLikely.at > 3000)
      this.repoLikely = { root, at: Date.now(), p: (async () => (await hasDotGitAboveAsync(root)) || (await findNestedRepos(root, { maxRepos: 1 })).length > 0)().catch(() => false) };
    return this.repoLikely.p;
  }

  /** What an untrusted folder answers: "no git here" for reads the UI makes by itself, a refusal for everything else. */
  private async untrustedReply(op: string): Promise<unknown> {
    switch (op) {
      case 'status':
        return { ok: false, reason: 'untrusted', ...((await this.looksLikeRepo()) ? { repoLikely: true } : {}) };
      case 'nudge':
      case 'visibility':
      case 'cancel':
        return null;
      case 'headFile':
        return { content: null, oid: null };
      case 'diff':
        return null;
      case 'hunks':
        return { mode: 'file', reason: 'unavailable' };
      case 'numstat':
        return null;
      default:
        throw new BackendFailure('EACCES', 'Git is off in this folder until you trust it (Source control panel)');
    }
  }

  private async setGitTrust(on: boolean): Promise<boolean> {
    const ws = this.ws();
    await ws.detectCase();
    await this.gitTrust().set(ws.root, ws.foldsCase, on);
    this.trustOf = null;
    if (!on) this.disposeGit(); // running git stops with it: no monitor, no watchers, nothing queued
    // Every client of this backend (other browser tabs) looks again.
    this.gitListeners.forEach((l) => l({} as GitMonitorEvent));
    return on;
  }

  private disposeGit() {
    this.gitUnsub?.();
    this.gitUnsub = null;
    this.monitor?.dispose();
    this.monitor = null;
  }

  /** New status version (fetch the delta), a run started / ended (spinner), a run finished (activity log). */
  onGitChanged(cb: (e: GitMonitorEvent) => void): () => void {
    this.gitListeners.add(cb);
    return () => this.gitListeners.delete(cb);
  }

  /** Our own edits count as git triggers (the watcher never echoes them). */
  private gitTouched(kind: 'save' | 'fs', paths: string[]) {
    this.monitor?.trigger(kind, paths);
  }

  private explorer: ProcessExplorer | null = null;

  /**
   * "Developer: Process explorer": a snapshot per request while it is open, `close` when it closes.
   * Created on the first request; nothing of it runs before (or after close).
   */
  async processes(req: ProcRequest): Promise<ProcSnapshot | boolean> {
    const op = (req as { op?: unknown } | null)?.op;
    if (op === 'snapshot') {
      // This backend's indexer rides on its own explorer (not a process-wide source): several windows' backends in
      // one process each list their own, Restart reaches that one, and a closed window's backend is not kept alive.
      this.explorer ??= new ProcessExplorer({ root: () => this.workspace?.root ?? null, rows: () => this.workspace?.processRows() ?? [] });
      return this.explorer.snapshot();
    }
    if (op === 'close') return void this.explorer?.close(), true;
    if (op === 'kill') return this.explorer?.kill(Number((req as { pid: unknown }).pid), !!(req as { group?: unknown }).group) ?? false;
    if (op === 'restartIndexer') return void this.workspace?.restartIndexer(), true;
    throw new BackendFailure('EINVAL', `Unknown process explorer request: ${String(op)}`);
  }

  /**
   * OS version of the machine running One, for the Settings build footer. No arguments, so nothing to validate;
   * the two system files are fixed paths, never a path from the page. Any read failure leaves os.release() alone.
   */
  async osVersion(): Promise<OsVersionInfo> {
    const info: OsVersionInfo = { platform: process.platform, release: os.release() };
    try {
      if (process.platform === 'darwin') Object.assign(info, macSystemVersion(await fsp.readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8')));
      else if (process.platform === 'linux') info.distro = linuxDistro(await fsp.readFile('/etc/os-release', 'utf8'));
    } catch {
      /* no SystemVersion.plist / no /etc/os-release (a minimal container): the release string still says enough */
    }
    return info;
  }

  /** Every git operation (see GitOps in shared/git.ts); arguments are validated by GitService. */
  async git(op: unknown, ...args: unknown[]): Promise<unknown> {
    if (typeof op !== 'string' || !(GIT_OPS as readonly string[]).includes(op)) throw new BackendFailure('EINVAL', `Unknown git operation: ${String(op)}`);
    if (op === 'diffTexts') {
      // Compare text: no repository needed; temp files live in the app's own config dir.
      const env = this.gitOptions.env ?? process.env;
      const exe = await locateGit({ gitPath: this.gitOptions.gitPath, env });
      return diffTexts(exe ? { git: exe.path, env: gitEnv(env), tmpRoot: path.join(this.configDir, 'tmp') } : null, args[0], args[1], args[2]);
    }
    if (!this.workspace) {
      if (op === 'status') return { ok: false, reason: 'no-repo' };
      if (op === 'nudge' || op === 'visibility' || op === 'cancel') return null;
      throw new BackendFailure('NO_WORKSPACE', 'No folder is open');
    }
    // The trust gate: before any GitService exists, so an untrusted folder never spawns git.
    if (op === 'trust' || op === 'untrust') return this.setGitTrust(op === 'trust');
    if (!(await this.gitTrusted())) return this.untrustedReply(op);
    const m = this.gitMonitor();
    await m.ready;
    const [a, b, c] = args;
    /** Repository-level operations: `repo` = its folder ('' / omitted: the only / first repository). */
    const repo = (rel: unknown) => {
      if (rel !== undefined && rel !== null && typeof rel !== 'string') throw new BackendFailure('EINVAL', 'Invalid repository');
      const svc = m.service(rel);
      if (!svc) throw new BackendFailure('EINVAL', `Not a repository in this folder: ${String(rel)}`);
      return svc;
    };
    const optRepo = (o: unknown) => (o && typeof o === 'object' ? (o as { repo?: unknown }).repo : undefined);
    const pathOf = (p: unknown) => {
      if (typeof p !== 'string') throw new BackendFailure('EINVAL', 'Path must be a string');
      return m.locate(p.replace(/\\/g, '/').replace(/^\/+/, ''));
    };
    /** Path lists → per repository (paths outside every repository are refused). */
    const grouped = (paths: unknown) => {
      if (!Array.isArray(paths)) throw new BackendFailure('EINVAL', 'Expected a list of paths');
      const by = new Map<GitService, { rel: string; subs: string[] }>();
      for (const p of paths) {
        const l = pathOf(p);
        if (!l) throw new BackendFailure('EINVAL', `Not inside a repository: ${String(p)}`);
        const g = by.get(l.svc) ?? { rel: l.rel, subs: [] };
        g.subs.push(l.sub);
        by.set(l.svc, g);
      }
      return [...by];
    };
    const each = async (paths: unknown, fn: (svc: GitService, subs: string[], rel: string) => Promise<import('../shared/git').GitActionResult>) => {
      let last: import('../shared/git').GitActionResult = { ok: true };
      for (const [svc, g] of grouped(paths)) {
        last = await fn(svc, g.subs, g.rel);
        if (!last.ok) return last;
      }
      return last;
    };
    const ws = (rel: string, p: string) => (rel ? `${rel}/${p}` : p);
    switch (op) {
      case 'status':
        return m.status((a ?? {}) as { since?: unknown; fresh?: unknown });
      case 'nudge':
        return void m.trigger(a === 'focus' ? 'focus' : 'open');
      case 'visibility':
        return void m.setVisible(String(a ?? ''), b !== false);
      case 'headFile': {
        const l = pathOf(a);
        return l ? l.svc.headFile(l.sub, b ?? 'HEAD') : { content: null, oid: null };
      }
      case 'diff': {
        const l = pathOf(a);
        return l ? l.svc.diff(l.sub, b ?? 'HEAD') : null;
      }
      case 'stage':
        return a === null ? repo(b).stage(null) : each(a, (svc, subs) => svc.stage(subs));
      case 'unstage':
        return a === null ? repo(b).unstage(null) : each(a, (svc, subs) => svc.unstage(subs));
      case 'discard':
        // Untracked files go to the OS trash (recoverable), like a delete from the tree.
        return each(a, (svc, subs, rel) => svc.discard(subs, (sub) => this.remove(ws(rel, sub))));
      case 'hunks':
      case 'stageHunks': {
        // Partial staging: one file; the rename source only when it is in the same repository.
        const l = pathOf(a);
        const from = op === 'hunks' ? b : c;
        const src = typeof from === 'string' && from ? pathOf(from) : null;
        const sub = src && src.svc === l?.svc ? src.sub : null;
        if (op === 'hunks') return l ? l.svc.hunks(l.sub, sub) : { mode: 'file', reason: 'unavailable' };
        if (!l) throw new BackendFailure('EINVAL', `Not inside a repository: ${String(a)}`);
        return l.svc.stageHunks(l.sub, b, sub);
      }
      case 'commit':
        return repo(optRepo(a)).commit(a);
      case 'lastMessage':
        return repo(a).lastMessage();
      case 'fetch':
        return repo(a).fetch();
      case 'pull':
        return repo(a).pull();
      case 'push':
        return repo(a).push();
      case 'branches':
        return repo(a).branches();
      case 'remoteBranches':
        return repo(optRepo(a)).remoteBranches(a);
      case 'branchDetails':
        return repo(c).branchDetails(a, b);
      case 'createBranch':
        return repo(b).createBranch(a);
      case 'switchBranch':
        return repo(b).switchBranch(a);
      case 'log':
        return repo(optRepo(a)).log(a);
      case 'commitFiles': {
        const r = typeof c === 'string' ? c : '';
        const res = await repo(c).commitFiles(a, b);
        return r ? { ...res, files: res.files.map((f) => ({ ...f, path: ws(r, f.path), ...(f.from ? { from: ws(r, f.from) } : {}) })) } : res;
      }
      case 'cancel':
        for (const rel of m.repoRels) m.service(rel)?.cancel(a);
        return null;
      case 'numstat': {
        // Every repository in the folder (a nested one's paths get its folder in front); null = none answered.
        let rows: import('../shared/git').GitNumstatRow[] | null = null;
        for (const rel of m.repoRels.length ? m.repoRels.slice(0, 8) : ['']) {
          const part = await m.service(rel)?.numstat();
          if (part) rows = [...(rows ?? []), ...part.map((f) => ({ ...f, path: ws(rel, f.path) }))];
        }
        return rows;
      }
    }
  }

  dispose() {
    this.settingsWatch?.close();
    this.settingsWatch = null;
    this.explorer?.close();
    this.explorer = null;
    this.unwatch?.();
    this.workspace?.dispose();
    this.ext.dispose();
    this.disposeGit();
  }
}
