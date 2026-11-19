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
import { withFileLock } from './filelock';
import { checkPdfRequest, looksLikePdf, withPdfExtension, writeFileAtomic } from './pdf-export';
import { GitService, gitEnv, locateGit, type GitServiceOptions } from './git';
import { GitMonitor, type GitMonitorEvent } from './git-monitor';
import { diffTexts } from './git-compare';
import { GIT_OPS } from '../shared/git';
import { ProcessExplorer, registerProcessSource } from './processes';
import type { ProcRequest, ProcSnapshot } from '../shared/processes';

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
export const rootId = (root: string) => crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);

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
  /**
   * Whose open tabs / tree / layout this process keeps per folder. 'web' = browser mode (every HTTP server,
   * "Start web server" and the .cmd included): its own session file, so a browser tab and the desktop app on
   * the same folder never overwrite each other. Settings stay shared. Default 'desktop'.
   */
  sessionKind?: 'desktop' | 'web';
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
  /** In-memory copy of recent.json (rapid opens must not read a stale file). */
  private recent: string[] | null = null;
  /** Absolute paths waiting for the renderer (launch args); drained by bootstrap(). */
  readonly openRequests: string[] = [];
  /** PDFs written by exportPdf in this process: the only files showExportedFile will open. */
  private exported = new Set<string>();
  /** In-memory copy of export-dirs.json (workspace id → last PDF folder). */
  private exportDirs: Record<string, unknown> | null = null;
  /** Git for the open folder: created on the first git call (no spawn at launch). */
  private monitor: GitMonitor | null = null;
  private gitListeners = new Set<(e: GitMonitorEvent) => void>();
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
    this.workspace = new Workspace(resolved, { exclude: s.excludeGlobs, showHidden: s.showHiddenFiles, index: indexOptionsFrom(s), warmIndexer, ...this.workspaceOptions, cacheDir });
    this.unwatch = this.workspace.onEvents((e) => {
      this.fsListeners.forEach((l) => l(e));
      this.monitor?.trigger('fs', e.map((x) => x.path));
    });
    const recent = (await this.recentWorkspaces()).filter((p) => !samePath(p, resolved));
    this.recent = [resolved, ...recent].slice(0, 20);
    void writeJson(this.recentFile, this.recent).catch(() => {});
    const ws = this.workspace;
    await ws.detectCase(); // the renderer's create / rename checks need it (lookups only, no writes)
    return ws.info();
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
    return this.ws()
      .writeFile(p, content, opts)
      .then((r) => (this.gitTouched('save', [p]), r));
  }
  createFile(p: string, content?: string) {
    return this.ws()
      .createFile(p, content)
      .then((r) => (this.gitTouched('fs', [p]), r));
  }
  createDir(p: string) {
    return this.ws()
      .createDir(p)
      .then((r) => (this.gitTouched('fs', [p]), r));
  }
  rename(a: string, b: string) {
    return this.ws()
      .rename(a, b)
      .then((r) => (this.gitTouched('fs', [a, b]), r));
  }

  async remove(p: string, opts: RemoveOptions = {}) {
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
    this.settingsLoad ??= readJson<Partial<Settings>>(this.settingsFile, {}).then((s) => {
      this.settings = { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
      this.watchSettings();
      return this.settings;
    });
    return this.settingsLoad;
  }

  async saveSettings(patch: Partial<Settings>): Promise<Settings> {
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
    if (this.workspace && INDEX_KEYS.some((k) => k in patch)) this.workspace.setIndexOptions(indexOptionsFrom(next));
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
    const ws = this.workspace;
    if (!ws) return;
    this.sessionCache.set(ws.root, s); // synchronously, before the write: see sessionCache
    await writeJson(this.sessionFile(ws.root), s);
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
      if (!this.explorer) {
        this.explorer = new ProcessExplorer({ root: () => this.workspace?.root ?? null });
        registerProcessSource({ id: 'indexer', rows: () => this.workspace?.processRows() ?? [] });
      }
      return this.explorer.snapshot();
    }
    if (op === 'close') return void this.explorer?.close(), true;
    if (op === 'kill') return this.explorer?.kill(Number((req as { pid: unknown }).pid), !!(req as { group?: unknown }).group) ?? false;
    if (op === 'restartIndexer') return void this.workspace?.restartIndexer(), true;
    throw new BackendFailure('EINVAL', `Unknown process explorer request: ${String(op)}`);
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
    }
  }

  dispose() {
    this.settingsWatch?.close();
    this.settingsWatch = null;
    this.unwatch?.();
    this.workspace?.dispose();
    this.disposeGit();
  }
}
