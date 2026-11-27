// Contract between the renderer and a backend (Electron main via IPC, or the local HTTP server).
// All paths crossing this boundary are workspace-relative POSIX paths ("notes/todo.md"), never absolute,
// so the renderer never has to care about Windows separators or drive letters.

export type RelPath = string;
import type { PdfExportRequest, PdfExportResult } from './pdf';
import type { GitOp, GitOps } from './git';
export type { PdfExportRequest, PdfExportResult } from './pdf';
export type Eol = 'lf' | 'crlf';
/** On-disk text encoding. Preserved on save so we never silently re-encode a user's file. */
export type TextEncoding = 'utf8' | 'utf16le' | 'utf16be' | 'windows-1252';

export interface TreeNode {
  name: string;
  path: RelPath; // '' for the root
  kind: 'file' | 'dir';
  size?: number;
  mtime?: number;
  /** Entry is a symlink (target kind is reported in `kind`). */
  symlink?: boolean;
  children?: TreeNode[]; // dirs only, sorted: dirs first, then files, natural order
  /** Root only: listing stopped early because the folder is huge. */
  truncated?: boolean;
}

export interface WorkspaceInfo {
  root: string; // absolute, native (for display only)
  name: string;
  /** The folder tells "Note.md" from "note.md": probed per folder (a WSL root on Windows does, NTFS does not). */
  caseSensitive?: boolean;
}

export interface FileData {
  path: RelPath;
  content: string; // always LF-normalised; original EOL reported separately
  mtime: number;
  eol: Eol;
  /** File started with a byte-order mark (kept on save). */
  bom?: boolean;
  encoding?: TextEncoding;
  /** Looks binary (NUL bytes): content is empty and the file must not be saved from the editor. */
  binary?: boolean;
  size?: number;
}

export type FsEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
export interface FsEvent {
  type: FsEventType;
  path: RelPath;
  mtime?: number;
}

export interface WriteOptions {
  /** If set and the file on disk has a different mtime, the write fails with code EXTERNAL_CHANGE. */
  expectedMtime?: number;
  /** EOL to write with. Defaults to the file's existing EOL, else 'lf'. */
  eol?: Eol;
  /** Write a BOM. Defaults to whatever the file on disk has. */
  bom?: boolean;
  /** Defaults to the file's existing encoding, else utf8. */
  encoding?: TextEncoding;
}

/** Upper bound for `writeBinary` payloads (decoded bytes). Pasted screenshots are far below this. */
export const MAX_BINARY_BYTES = 50 * 1024 * 1024;

/** `readFile({ asText: true })`: a force-opened binary becomes at most this many bytes of text (the same
 *  bound the indexer uses). The UI must say so: the rest is only loaded when the user asks for it. */
export const MAX_AS_TEXT_BYTES = 2 * 1024 * 1024;
/** `readFile({ asText: 'full' })`: the most a user may force into the editor. A string this big is already
 *  slow to parse and hold, so "load all" stops here instead of at the 48 MB `readFile` open limit. */
export const MAX_AS_TEXT_FULL_BYTES = 16 * 1024 * 1024;

export interface TextPageOptions {
  /** Opaque cursor from the previous page's `nextCursor`; omit for the first page. */
  cursor?: string | null;
  /** Approximate page size (content length). The backend clamps it; a page always holds ≥ 1 file when any remain. */
  maxBytes?: number;
}

export interface TextPage {
  files: FileData[];
  /** null when this was the last page. */
  nextCursor: string | null;
  /** Progress: indexable files in this pass, and how many have been examined so far. */
  total?: number;
  done?: number;
}

export interface RemoveOptions {
  /** Skip the OS trash and delete for good. */
  permanent?: boolean;
}

export interface Settings {
  theme: 'dark' | 'light' | 'system';
  /** 'shelf' (default): workspace card + pill switcher + editor card. 'classic': IDE-style activity bar. */
  sidebarStyle?: 'shelf' | 'classic';
  // ---- appearance (Settings → Appearance) ----
  /** Accent colour as #rrggbb; '' = the theme's default blue. */
  accentColor?: string;
  /** 'rounded' (default) or 'square' corners everywhere (driven by --radius-* tokens). */
  cornerStyle?: 'rounded' | 'square';
  /** UI spacing: 'compact' | 'comfortable' (default) | 'spacious'. */
  uiDensity?: 'compact' | 'comfortable' | 'spacious';
  /** Markdown text column: 'readable' (default, ~860px) | 'wide' (~1200px) | 'full'. Sets --content-width. */
  contentWidth?: 'readable' | 'wide' | 'full';
  /** Editor/preview line height (unitless), default 1.65. Sets --editor-line-height. */
  editorLineHeight?: number;
  // ---- markdown editing ----
  /** Line numbers for Markdown in source + split mode (never in live / reading). Code files always show them. */
  markdownLineNumbers?: boolean;
  /** Formatting toolbar above the editor in live (pencil) mode. */
  formatToolbar?: boolean;
  viewMode: 'live' | 'source' | 'split' | 'preview';
  fontSize: number;
  editorFont: string;
  lineNumbers: boolean;
  wordWrap: boolean;
  formatOnSave: boolean;
  /** Formatter overrides (unset → per-language defaults; .editorconfig / .prettierrc win over these). */
  'format.printWidth'?: number;
  'format.tabWidth'?: number;
  'format.useTabs'?: boolean;
  'format.singleQuote'?: boolean;
  /** Minimum PHP version for formatted output, e.g. "8.3". */
  'format.phpVersion'?: string;
  'format.sqlKeywordCase'?: 'upper' | 'lower' | 'preserve';
  autosave: boolean;
  autosaveDelayMs: number;
  spellcheck: boolean;
  showHiddenFiles: boolean;
  excludeGlobs: string[];
  /** UI zoom factor (1 = 100%). */
  zoom?: number;
  /** Desktop: 'integrated' (default) = window controls in the tab strip (no OS title bar); 'native' = OS title bar.
   *  Read when the window is created, so a change applies after a restart. */
  windowFrame?: 'integrated' | 'native';
  /** Ask before moving files to the trash. */
  confirmDelete?: boolean;
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  sidebarStyle: 'shelf',
  accentColor: '',
  cornerStyle: 'rounded',
  uiDensity: 'comfortable',
  contentWidth: 'readable',
  editorLineHeight: 1.65,
  markdownLineNumbers: true,
  formatToolbar: true,
  viewMode: 'live',
  fontSize: 15,
  editorFont: '',
  lineNumbers: false,
  wordWrap: true,
  formatOnSave: false,
  autosave: true,
  autosaveDelayMs: 800,
  spellcheck: false,
  showHiddenFiles: false,
  excludeGlobs: ['node_modules', '.git', 'dist', 'build', 'vendor', '.next', '.cache', '__pycache__'],
  zoom: 1,
  windowFrame: 'integrated',
  confirmDelete: true,
};

/** Per-workspace UI session (open tabs etc.), persisted by the backend. */
export interface SessionState {
  openTabs: RelPath[];
  activeTab: RelPath | null;
  sidebarWidth?: number;
  sidebarVisible?: boolean;
  sidebarPanel?: string;
  /** File overview column (right sidebar). */
  overviewVisible?: boolean;
  overviewWidth?: number;
  /** Editor share of the split view (0..1). */
  splitRatio?: number;
  /** Expanded folders in the file tree. */
  expanded?: RelPath[];
  /** Zen mode is on: the layout to restore when leaving it (renderer app/zen.tsx). */
  zen?: { sidebarVisible: boolean; sidebarPanel: string; overviewVisible: boolean; processesOpen: boolean };
  [key: string]: unknown;
}

export interface BackendError {
  code: 'ENOENT' | 'EEXIST' | 'EXTERNAL_CHANGE' | 'OUTSIDE_WORKSPACE' | 'NO_WORKSPACE' | 'EIO' | 'ETRASH' | 'EINVAL' | 'EACCES' | string;
  message: string;
}

/** Result of resolving an absolute path handed to the app (CLI arg, drag-drop, second instance). */
export interface ResolvedPath {
  abs: string;
  kind: 'file' | 'dir';
  /** Workspace-relative path, or null when outside the open folder. */
  rel: RelPath | null;
}

/** Everything the renderer needs for first paint, in one round-trip. */
export interface BootstrapData {
  os: string;
  settings: Settings;
  workspace: WorkspaceInfo | null;
  session: SessionState | null;
  recent: string[];
  /** Absolute paths queued at launch (e.g. `sec-edit C:\notes\todo.md`). */
  openRequests: string[];
}

export interface BackendApi {
  readonly kind: 'electron' | 'web';
  readonly os: string; // process.platform of the backend: 'win32' | 'darwin' | 'linux'

  bootstrap(): Promise<BootstrapData>;
  getWorkspace(): Promise<WorkspaceInfo | null>;
  openWorkspace(absPath: string): Promise<WorkspaceInfo>;
  /** Native folder picker (Electron). Web backend may return null. */
  pickFolder(): Promise<string | null>;
  /** Native file picker (Electron); null = cancelled / web. The chosen file may be opened with openExternalFile. */
  pickFile(): Promise<string | null>;
  /** Desktop only: open a file that is outside the open folder. Returns its id (shared/external.ts), which every file call accepts like a path. Main refuses a path it did not see itself (dialog, OS open, argv, drop). */
  openExternalFile(absPath: string): Promise<string>;
  recentWorkspaces(): Promise<string[]>;
  forgetRecent(absPath: string): Promise<string[]>;
  resolvePath(absPath: string): Promise<ResolvedPath | null>;

  /** Whole tree, or just the subtree at `path` (used after a folder appears on disk). */
  listTree(path?: RelPath): Promise<TreeNode>;
  /**
   * `maxBytes`: fail with ETOOBIG instead of reading a bigger file (a cheap existence / size probe).
   * `asText`: the user asked to see a file `decode()` calls binary: its bytes come back as best-effort
   * text — `true` = the first MAX_AS_TEXT_BYTES, `'full'` = the whole file up to MAX_AS_TEXT_FULL_BYTES
   * (ETOOBIG above that). `binary` stays true either way, so the renderer still refuses to write it back.
   */
  readFile(path: RelPath, opts?: { maxBytes?: number; asText?: true | 'full' }): Promise<FileData>;
  writeFile(path: RelPath, content: string, opts?: WriteOptions): Promise<{ mtime: number }>;
  createFile(path: RelPath, content?: string): Promise<{ mtime: number }>;
  createDir(path: RelPath): Promise<void>;
  rename(from: RelPath, to: RelPath): Promise<void>;
  /** Moves to OS trash where possible; fails with ETRASH if that is impossible and !permanent. */
  remove(path: RelPath, opts?: RemoveOptions): Promise<void>;
  /** Every text file in the workspace (for the search index). Large/binary files skipped. */
  readAllText(): Promise<FileData[]>;
  /** Same files as readAllText (same order), a page at a time: no huge single response to parse. */
  readAllTextPage(opts?: TextPageOptions): Promise<TextPage>;
  /** Raw bytes (attachments, pasted images) as base64. Creates parent folders, overwrites, max MAX_BINARY_BYTES. */
  writeBinary(path: RelPath, base64: string): Promise<{ mtime: number }>;
  /** Show the file in Explorer/Finder (Electron); web backend opens the containing folder if it can. */
  revealInFolder(path: RelPath): Promise<void>;
  /** Desktop only (web: ENOTSUP). Renders the HTML to PDF in a locked-down hidden window, asks where to
   *  save it (native dialog) and writes it. null = the user cancelled the dialog. */
  exportPdf(req: PdfExportRequest): Promise<PdfExportResult | null>;
  /** Open (default PDF viewer) or reveal a file that exportPdf wrote in this session — nothing else. */
  showExportedFile(absPath: string, how: 'open' | 'reveal'): Promise<void>;

  getSettings(): Promise<Settings>;
  saveSettings(patch: Partial<Settings>): Promise<Settings>;
  getSession(): Promise<SessionState>;
  saveSession(s: SessionState): Promise<void>;
  /** Bookmarks of the open folder (One's app data, shared by desktop and browser mode): no argument reads, an op
   *  changes the list as it is on disk and returns the new one (shared/bookmarks.ts). */
  bookmarks(op?: import('./bookmarks').BookmarkOp): Promise<import('./bookmarks').Bookmark[]>;

  /** Batched filesystem change notifications (debounced by the backend). External changes only. */
  onFsEvents(cb: (events: FsEvent[]) => void): () => void;
  openExternal(url: string): Promise<void>;
  /** "Developer: Process explorer" (shared/processes.ts): a snapshot while open, 'close' when closed. */
  processes?(req: import('./processes').ProcRequest): Promise<import('./processes').ProcSnapshot | boolean>;
  /** OS version of the machine running One (shared/os-version.ts), for the Settings footer: the backend reads it,
   *  never navigator. Refused by a web server that serves one folder only (server.ts PINNED) → the footer shows the OS name only. */
  osVersion(): Promise<import('./os-version').OsVersionInfo | null>;
  /** Electron: mouse side buttons / keyboard browser keys that arrive as a window `app-command` (Windows). */
  onNavCommand?(cb: (dir: import('./nav').NavDir) => void): () => void;
  /** Electron: the window entered / left full screen. Chromium keeps env(titlebar-area-*) reporting the WCO
   *  area while fullscreen hides the buttons; main tells us so the CSS reservations collapse (html.fs-full). */
  onFullScreen?(cb: (on: boolean) => void): () => void;
  /** Paths the app was asked to open by a second instance (Electron). Launch-time paths come via bootstrap(). */
  onOpenRequest(cb: (absPaths: string[]) => void): () => void;

  // ---- optional, Electron-only niceties (feature-detect) ----
  /** Native path of a dropped File (Electron `webUtils.getPathForFile`). */
  getPathForFile?(file: File): string | null;
  setZoom?(factor: number): void;
  toggleDevTools?(): Promise<void>;
  /** Tell the host the UI is painted (Electron shows the window / logs launch timings). */
  notifyReady?(timings: Record<string, number>): void;
  /** Window close requested (Electron): flush/ask, then call approveClose(true) to really close. */
  onCloseRequest?(cb: () => void): () => void;
  approveClose?(ok: boolean): void;
  /** The frame this window was created with (may differ from settings.windowFrame until a restart). */
  readonly frame?: 'integrated' | 'native';
  /** Integrated frame: colour/height of the native window controls (Window Controls Overlay). */
  setTitleBarOverlay?(o: { color: string; symbolColor: string; height: number }): void;
  /** Zen mode: hold the window full screen (true) / give it back (false). Main restores the state from before
   *  and never leaves a full screen the user had already (main/zen-fullscreen.ts). */
  zenFullScreen?(on: boolean): void;
  /** Restart the app through the normal close flow (unsaved changes are flushed / asked about first). */
  relaunch?(): Promise<void>;
  /** Multiple windows (desktop): this window's key in app://sec-edit/__ws/<key>/… (platform fileUrl). */
  readonly wsKey?: string;
  /** Multiple windows (desktop): open a new window with the start screen. */
  newWindow?(): Promise<void>;
  /** Multiple windows (desktop): main decides where a folder opens — 'here' (this window is empty: open it in
   *  place), 'focused' (another window has it: brought to front) or 'new' (opened in a new window). */
  openFolderWindow?(abs: string): Promise<'here' | 'focused' | 'new'>;
  /** How Chromium uses the GPU in this window ("Developer: Show GPU status"); null if unavailable. */
  gpuStatus?(): Promise<GpuStatus | null>;
  /** Git status + source control: one entry point, every operation validated by the backend (shared/git.ts). */
  git?<K extends GitOp>(op: K, ...args: Parameters<GitOps[K]>): Promise<ReturnType<GitOps[K]>>;
}

/** Electron's app.getGPUFeatureStatus() (e.g. gpu_compositing: enabled | disabled_software), the GPUs and
 *  the GPU-related command-line switches in effect. */
export interface GpuStatus {
  features: Record<string, string>;
  devices: string[];
  switches: string[];
}

/** Links the app hands to the OS (default browser / mail client). Anything else — file:, javascript:,
 *  Windows protocol handlers like ms-msdt: or search-ms: — is never opened. */
export function isExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'mailto:') return true;
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname;
  } catch {
    return false;
  }
}

/** RPC method names that are plain request/response (shared by IPC + HTTP transports). */
export const RPC_METHODS = [
  'bootstrap',
  'getWorkspace',
  'openWorkspace',
  'pickFolder',
  'pickFile',
  'openExternalFile',
  'recentWorkspaces',
  'forgetRecent',
  'resolvePath',
  'listTree',
  'readFile',
  'writeFile',
  'createFile',
  'createDir',
  'rename',
  'remove',
  'readAllText',
  'readAllTextPage',
  'writeBinary',
  'revealInFolder',
  'getSettings',
  'saveSettings',
  'getSession',
  'saveSession',
  'bookmarks',
  'openExternal',
  'exportPdf',
  'showExportedFile',
  'git',
  'processes',
  'osVersion',
] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];
