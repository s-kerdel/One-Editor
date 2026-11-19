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
import { BackendFailure, MAX_INDEX_BYTES, Workspace, retryWin, type IndexOptions, type WorkspaceOptions } from './workspace';
import { platformTrash } from './trash';
import { checkPdfRequest, looksLikePdf, withPdfExtension, writeFileAtomic } from './pdf-export';
import { GitService, gitEnv, locateGit, type GitServiceOptions } from './git';
import { diffTexts } from './git-compare';
import { GIT_OPS } from '../shared/git';

export function defaultConfigDir(): string {
  if (process.env.SEC_EDIT_CONFIG_DIR) return process.env.SEC_EDIT_CONFIG_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'sec-edit');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'sec-edit');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'sec-edit');
}

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
const rootId = (root: string) => crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);

/** Windows: %LOCALAPPDATA% (a cache must not travel with a roaming profile); elsewhere next to the settings. */
export function defaultCacheDir(configDir: string): string {
  const local = process.platform === 'win32' ? process.env.LOCALAPPDATA : undefined;
  if (local && samePathCI(configDir, defaultConfigDir())) return path.join(local, 'sec-edit', 'index-cache');
  return path.join(configDir, 'index-cache');
}
const samePathCI = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Settings → what the indexers skip (search.* in the settings registry). */
export function indexOptionsFrom(s: Settings): IndexOptions {
  const kb = Number(s['search.maxFileSizeKB']);
  return {
    respectGitignore: s['search.respectGitignore'] !== false,
    skipLockfiles: s['search.skipLockfiles'] !== false,
    skipMinified: s['search.skipMinified'] !== false,
    maxFileBytes: Number.isFinite(kb) && kb > 0 ? Math.min(16384, Math.max(16, kb)) * 1024 : MAX_INDEX_BYTES,
  };
}
const INDEX_KEYS = ['search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB'];

const samePath = (a: string, b: string) => (process.platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase());

export interface ServiceHooks {
  /** Native folder picker; absent in server mode. */
  pickFolder?: () => Promise<string | null>;
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
}

export class BackendService {
  workspace: Workspace | null = null;
  private settings: Settings | null = null;
  private settingsLoad: Promise<Settings> | null = null;
  private fsListeners = new Set<(e: FsEvent[]) => void>();
  private settingsListeners = new Set<(s: Settings, patch: Partial<Settings>) => void>();
  private unwatch: (() => void) | null = null;
  /** In-memory copy of recent.json (rapid opens must not read a stale file). */
  private recent: string[] | null = null;
  /** Absolute paths waiting for the renderer (launch args); drained by bootstrap(). */
  readonly openRequests: string[] = [];
  /** PDFs written by exportPdf in this process: the only files showExportedFile will open. */
  private exported = new Set<string>();
  /** In-memory copy of export-dirs.json (workspace id → last PDF folder). */
  private exportDirs: Record<string, unknown> | null = null;
  /** Git for the open folder: created on the first git call (no spawn at launch). */
  private gitSvc: GitService | null = null;
  private gitListeners = new Set<() => void>();
  private gitUnsub: (() => void) | null = null;

  constructor(
    readonly configDir: string = defaultConfigDir(),
    private hooks: ServiceHooks = {},
    private workspaceOptions: Pick<WorkspaceOptions, 'watchMode' | 'debounceMs' | 'pollMs' | 'readThreads' | 'cacheDir'> = {},
    private gitOptions: GitServiceOptions = {},
  ) {}

  private get settingsFile() {
    return path.join(this.configDir, 'settings.json');
  }
  private get recentFile() {
    return path.join(this.configDir, 'recent.json');
  }
  private sessionFile(root: string) {
    return path.join(this.configDir, 'sessions', `${rootId(root)}.json`);
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
  onSettingsChanged(cb: (s: Settings, patch: Partial<Settings>) => void): () => void {
    this.settingsListeners.add(cb);
    return () => this.settingsListeners.delete(cb);
  }

  async bootstrap(): Promise<BootstrapData> {
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
    const st = await fsp.stat(resolved).catch(() => null);
    if (!st?.isDirectory()) throw new BackendFailure('ENOENT', `Not a folder: ${absPath}`);
    if (this.workspace && samePath(this.workspace.root, resolved)) return this.workspace.info();
    this.unwatch?.();
    this.workspace?.dispose();
    this.disposeGit();
    const s = await this.getSettings();
    // The text cache lives with the app's data (never inside the folder); '' = off.
    const cacheDir = this.workspaceOptions.cacheDir === undefined ? defaultCacheDir(this.configDir) : this.workspaceOptions.cacheDir || undefined;
    this.workspace = new Workspace(resolved, { exclude: s.excludeGlobs, showHidden: s.showHiddenFiles, index: indexOptionsFrom(s), ...this.workspaceOptions, cacheDir });
    this.unwatch = this.workspace.onEvents((e) => this.fsListeners.forEach((l) => l(e)));
    const recent = (await this.recentWorkspaces()).filter((p) => !samePath(p, resolved));
    this.recent = [resolved, ...recent].slice(0, 20);
    void writeJson(this.recentFile, this.recent).catch(() => {});
    return this.workspace.info();
  }

  async pickFolder() {
    return this.hooks.pickFolder ? this.hooks.pickFolder() : null;
  }

  async recentWorkspaces(): Promise<string[]> {
    if (!this.recent) {
      const list = await readJson<string[]>(this.recentFile, []);
      this.recent ??= Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
    }
    return [...this.recent];
  }

  async forgetRecent(absPath: string) {
    this.recent = (await this.recentWorkspaces()).filter((p) => !samePath(p, absPath));
    await writeJson(this.recentFile, this.recent);
    return [...this.recent];
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
  readFile(p: string) {
    return this.ws().readFile(p);
  }
  writeFile(p: string, content: string, opts?: WriteOptions) {
    return this.ws().writeFile(p, content, opts);
  }
  createFile(p: string, content?: string) {
    return this.ws().createFile(p, content);
  }
  createDir(p: string) {
    return this.ws().createDir(p);
  }
  rename(a: string, b: string) {
    return this.ws().rename(a, b);
  }

  async remove(p: string, opts: RemoveOptions = {}) {
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
  readAllTextPage(opts?: TextPageOptions) {
    return this.ws().readAllTextPage(opts && typeof opts === 'object' ? opts : {});
  }

  /** `base64`: standard alphabet, padding optional. Decoded size is capped (MAX_BINARY_BYTES). */
  async writeBinary(p: string, base64: string) {
    const ws = this.ws();
    if (typeof base64 !== 'string') throw new BackendFailure('EINVAL', 'Content must be a base64 string');
    // Checked before decoding, so an oversized payload never allocates its buffer.
    const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
    if (bytes > MAX_BINARY_BYTES) {
      throw new BackendFailure('ETOOBIG', `File is too large (${(bytes / 1048576).toFixed(1)} MB; the limit is ${MAX_BINARY_BYTES / 1048576} MB)`);
    }
    // Buffer.from silently skips invalid characters: corrupt input must fail, not write garbage.
    if (base64.length % 4 === 1 || !BASE64_RE.test(base64)) throw new BackendFailure('EINVAL', 'Content is not valid base64');
    return ws.writeBinary(p, Buffer.from(base64, 'base64'));
  }

  async revealInFolder(p: string) {
    const abs = this.ws().abs(p);
    if (this.hooks.revealInFolder) return void (await this.hooks.revealInFolder(abs));
    // Server mode: best effort with the platform's file manager.
    const win = process.platform === 'win32';
    // explorer.exe has its own parser: it needs `/select,"C:\a b\x.md"` verbatim — Node's default quoting
    // ("/select,C:\a b\x.md") makes it open Documents instead. `"` cannot occur in a Windows path.
    const [cmd, args] = win ? ['explorer.exe', [`/select,"${abs}"`]] : process.platform === 'darwin' ? ['open', ['-R', abs]] : ['xdg-open', [path.dirname(abs)]];
    await new Promise<void>((resolve, reject) =>
      execFile(cmd, args as string[], { windowsHide: true, windowsVerbatimArguments: win }, (err) => (err && !win ? reject(new BackendFailure('EIO', 'No file manager available')) : resolve())),
    );
  }

  async exportPdf(req: unknown): Promise<PdfExportResult | null> {
    const ws = this.ws();
    const { path: rel, noteAbs, html, layout } = await checkPdfRequest(req, (p) => ws.abs(p));
    const { renderPdf, pickSavePath } = this.hooks;
    if (!renderPdf || !pickSavePath) throw new BackendFailure('ENOTSUP', 'PDF export needs the desktop app — in the browser use Print and pick "Save as PDF"');
    if (!this.exportDirs) {
      const saved = await readJson<unknown>(this.exportDirsFile, {});
      this.exportDirs = saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
    }
    const key = rootId(ws.root);
    const last = typeof this.exportDirs[key] === 'string' ? (this.exportDirs[key] as string) : null;
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
    this.exportDirs = { ...this.exportDirs, [key]: path.dirname(abs) };
    void writeJson(this.exportDirsFile, this.exportDirs).catch(() => {});
    return { abs, rel: inside, bytes: bytes.byteLength };
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
    this.settingsLoad ??= readJson<Partial<Settings>>(this.settingsFile, {}).then((s) => (this.settings = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) }));
    return this.settingsLoad;
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
    await this.getSettings();
    // Merge into the *current* object after the await, so concurrent saves never drop each other's patch.
    const next = { ...this.settings!, ...patch } as Settings;
    this.settings = next;
    if (this.workspace && ('excludeGlobs' in patch || 'showHiddenFiles' in patch)) {
      this.workspace.setOptions({ exclude: next.excludeGlobs, showHidden: next.showHiddenFiles });
    }
    if (this.workspace && INDEX_KEYS.some((k) => k in patch)) this.workspace.setIndexOptions(indexOptionsFrom(next));
    this.settingsListeners.forEach((l) => l(next, patch));
    await writeJson(this.settingsFile, next);
    return next;
  }

  /** Last session written per workspace root: a reload's first getSession() can arrive while the
   *  unload-time saveSession() is still writing, and must not read the older file. */
  private sessionCache = new Map<string, SessionState>();

  async getSession(): Promise<SessionState> {
    const ws = this.workspace;
    if (!ws) return { openTabs: [], activeTab: null };
    const s = this.sessionCache.get(ws.root) ?? (await readJson<SessionState>(this.sessionFile(ws.root), { openTabs: [], activeTab: null }));
    return { ...s, openTabs: Array.isArray(s.openTabs) ? s.openTabs : [], activeTab: s.activeTab ?? null };
  }

  async saveSession(s: SessionState) {
    const ws = this.workspace;
    if (!ws) return;
    this.sessionCache.set(ws.root, s); // synchronously, before the write: see sessionCache
    await writeJson(this.sessionFile(ws.root), s);
  }

  async openExternal(url: string) {
    if (typeof url !== 'string' || !isExternalUrl(url)) throw new BackendFailure('EIO', 'Refusing to open non-web URL');
    await this.hooks.openExternal?.(url);
  }

  // ---- git (read-only status + source control), one validated entry point -----------------------

  private gitService(): GitService {
    const ws = this.ws();
    if (this.gitSvc?.root === ws.root) return this.gitSvc;
    this.disposeGit();
    this.gitSvc = new GitService(ws.root, this.gitOptions);
    if (this.gitListeners.size) this.gitUnsub = this.gitSvc.onChange(() => this.gitListeners.forEach((l) => l()));
    return this.gitSvc;
  }

  private disposeGit() {
    this.gitUnsub?.();
    this.gitUnsub = null;
    this.gitSvc?.dispose();
    this.gitSvc = null;
  }

  /** HEAD / index / refs changed (commit or checkout elsewhere), or a repository appeared. */
  onGitChanged(cb: () => void): () => void {
    this.gitListeners.add(cb);
    if (this.gitSvc && !this.gitUnsub) this.gitUnsub = this.gitSvc.onChange(() => this.gitListeners.forEach((l) => l()));
    return () => {
      this.gitListeners.delete(cb);
      if (!this.gitListeners.size) {
        this.gitUnsub?.();
        this.gitUnsub = null;
      }
    };
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
      throw new BackendFailure('NO_WORKSPACE', 'No folder is open');
    }
    const g = this.gitService();
    const [a, b] = args;
    switch (op) {
      case 'status':
        return g.status();
      case 'headFile':
        return g.headFile(a as string, b ?? 'HEAD');
      case 'diff':
        return g.diff(a as string, b ?? 'HEAD');
      case 'stage':
        return g.stage(a);
      case 'unstage':
        return g.unstage(a);
      case 'discard':
        // Untracked files go to the OS trash (recoverable), like a delete from the tree.
        return g.discard(a, (rel) => this.remove(rel));
      case 'commit':
        return g.commit(a);
      case 'lastMessage':
        return g.lastMessage();
      case 'fetch':
        return g.fetch();
      case 'pull':
        return g.pull();
      case 'push':
        return g.push();
      case 'branches':
        return g.branches();
      case 'createBranch':
        return g.createBranch(a);
      case 'switchBranch':
        return g.switchBranch(a);
      case 'log':
        return g.log(a);
      case 'commitFiles':
        return g.commitFiles(a, b);
      case 'cancel':
        return g.cancel(a);
    }
  }

  dispose() {
    this.unwatch?.();
    this.workspace?.dispose();
    this.disposeGit();
  }
}
