// Electron main process. Kept deliberately tiny so the first window appears fast:
//  - settings/window-state/folder open start *before* app 'ready' and run in parallel with Chromium boot;
//  - the renderer is served from a privileged app:// scheme so V8 code cache works (file:// gets none);
//  - no default application menu (saves startup time and stray accelerators like Ctrl+R / Ctrl+W).
// Several windows, one per folder (windows.ts), in this one process. Main reaches a window's folder only through its
// WindowBackend (window-backend.ts: the seam a helper process can take over later); each window also has its own gate,
// zen state, close flow and URL keys. MCP, the web server, the vault, the update check and the terminals are shared;
// app-level reads (theme, frame, recent folders) go through `appState`, a backend without a folder.
import './env-boot'; // first: drops SEC_EDIT_* hooks in a packaged build before any module reads them
import { appMenuTemplate, dockMenuTemplate } from './app-menu';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, screen, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { RPC_METHODS, type Settings } from '../shared/api';
import { BackendService, readJson, writeJson, type ServiceHooks } from '../backend/service';
import { BackendFailure } from '../backend/errors';
import { isBridgeRoot } from '../backend/readpool';
import { registerProcessSource } from '../backend/processes';
import { electronProcessSource } from './process-rows';
import { APP_ORIGIN, SCHEME, isAppNavigation, isExternalUrl, pathsFromArgs, routeAppUrl } from './protocol';
import { renderPdf } from './pdf-window';
import { PDF_WORKER_CSP, isPdfWorkerAsset } from '../shared/pdf';
import { TerminalService, loadNodePty, registerTerminalIpc } from './terminal';
import { VaultService, registerVaultIpc, sharedKeyMessage, type VaultScope, type VaultSharedKeyRequest } from './vault';
import { OpenGate } from './open-gate';
import { registerGpuIpc } from './gpu';
import { WebServerService, childEnv, lanAddresses, registerWebServerIpc, spawnCli } from './web-server';
import { WEB_SERVER_CHANNELS } from '../shared/web-server';
import { UpdateCheckService, registerUpdateCheckIpc } from './update-check';
import { UPDATE_CHECK_CHANNELS, UPDATE_ENDPOINTS, isAllowedUpdateUrl } from '../shared/update-check';
import { NAV_CHANNEL, navFromAppCommand } from '../shared/nav';
import { McpService, folderChoice, foldersConfirm, mcpLaunch, registerMcpIpc } from './mcp';
import { platformTrash } from '../backend/trash';
import { MCP_CHANNELS } from '../shared/mcp';
import os from 'node:os';
import { ZenFullScreen } from './zen-fullscreen';
import { createRelaunch, frameOf, frameWindowOptions, initialOverlay, isDarkColor, parseOverlay, rememberOverlay, type TitleBarCache, type WindowFrame } from './frame';
import { createInProcessBackend, type WindowBackend } from './window-backend';
import { WindowRegistry, cascadeBounds, folderMatch, planLaunch, type LaunchPath, type LaunchStep } from './windows';

const tMainStart = performance.now(); // ms since process start (Node's timeOrigin)
const isTest = !!process.env.SEC_EDIT_TEST;
const logTimings = isTest || !!process.env.SEC_EDIT_TIMINGS;
if (process.env.SEC_EDIT_USER_DATA) app.setPath('userData', process.env.SEC_EDIT_USER_DATA);
// More libuv threads (default 4) only when this launch opens a slow folder (WSL / UNC / network):
// there every readdir or open blocks one for ms, and a tree walk must not starve file opens. On a
// local disk 16 threads only contend (the launch tree walk took ~2× as long). The pool size is fixed
// when it starts, so it is decided here, before any async I/O, from the folder this launch opens.
if (!process.env.UV_THREADPOOL_SIZE && (isBridgeRoot('') || launchFolders().some(isBridgeRoot))) process.env.UV_THREADPOOL_SIZE = '16';

/** What this launch opens (argv / SEC_EDIT_OPEN, else the most recent folder): a sync guess. */
function launchFolders(): string[] {
  const paths = pathsFromArgv(process.argv);
  if (process.env.SEC_EDIT_OPEN) paths.push(path.resolve(process.env.SEC_EDIT_OPEN));
  if (paths.length) return paths;
  try {
    const recent: unknown = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'recent.json'), 'utf8'));
    return Array.isArray(recent) && typeof recent[0] === 'string' ? [recent[0]] : [];
  } catch {
    return [];
  }
}

// A dev server only makes sense from a source checkout: in a packaged build this env var would point the
// privileged preload bridge (full file access) at an arbitrary URL.
const DEV_URL = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL || undefined : undefined;
// First-paint window colour = the page backdrop: --bg-shelf for the shelf style, --bg for classic.
const BG = { shelf: { dark: '#131519', light: '#f0f0ed' }, classic: { dark: '#1b1d22', light: '#ffffff' } };
const windowBg = (s: Settings) => BG[s.sidebarStyle === 'classic' ? 'classic' : 'shelf'][nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
const FOLDER_REFUSED = 'This folder was not chosen in the app: use “Open folder”, drop it on the window, or pick a recent one';
/** How long an empty window's 'here' counts its folder as taken when its own open (rpc:openWorkspace) never follows. */
const CLAIM_MS = 30_000;

// Single instance: a second launch hands its paths to the running app (feels instant).
// Tests run many instances in parallel; they opt back in with SEC_EDIT_SINGLE_INSTANCE=1.
const wantLock = !isTest || !!process.env.SEC_EDIT_SINGLE_INSTANCE;
const gotLock = !wantLock || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else main();

/** argv → existing absolute paths (skips exe, Chromium/Playwright flags and, unpackaged, the app dir). */
function pathsFromArgv(argv: string[], cwd = process.cwd()): string[] {
  return pathsFromArgs(argv, { cwd, appPath: app.isPackaged ? null : app.getAppPath(), exists: (p) => fs.existsSync(p), p: path, foldCase: process.platform !== 'linux' });
}

/** IPC must come from our own UI in the main frame — not a workspace file the window was tricked into showing. */
function trustedSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  const frame = e.senderFrame;
  if (!frame || frame !== e.sender.mainFrame) return false;
  return isAppNavigation(frame.url, DEV_URL);
}

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  /** Integrated frame: last overlay colours/height the renderer measured (first paint of the next launch). */
  titleBar?: TitleBarCache;
}

/** One window: its folder (through the backend only), and everything else that is per window. */
interface WindowCtx {
  /** webContents.id once the BrowserWindow exists: the registry key and the terminals' owner. */
  id: number;
  win: BrowserWindow | null;
  /** The launch's first window: timings, test hooks. */
  readonly first: boolean;
  readonly backend: WindowBackend;
  /** Folders this window may open (open-gate.ts): what main saw for this window. */
  readonly gate: OpenGate;
  readonly zen: ZenFullScreen;
  /** Vault calls of this window: its folder, the shared-key dialog on this window. */
  readonly vault: VaultScope;
  /** Per-window secrets for the preload (argv): app://sec-edit/__index/ (header) and app://sec-edit/__ws/<key>/. */
  readonly indexToken: string;
  readonly wsKey: string;
  /** What the window was created with (settings may change until a restart). */
  frame: WindowFrame;
  /** Main's own open of this window's folder: the renderer's first RPC waits for it (bootstrap sees the folder). */
  initialOpen: Promise<void>;
  /**
   * A folder being opened here (main's launch open; the renderer's own after 'here', and while its rpc open runs):
   * it counts as this window's until the open has settled, so a second request for it elsewhere finds this window.
   * `real` = its real path once known. Set and checked inside serial() (or before it runs: the first launch).
   */
  claim: { folder: string; real: string | null } | null;
  /** Real path of the open folder (a link's / mapped drive's target) and the backend root it belongs to (settleRoot()). */
  realRoot: string | null;
  realFor: string | null;
  /** The open folder (or the one being opened) and its case rule (undefined = the platform's). */
  readonly root: string | null;
  readonly foldsCase: boolean | undefined;
  closing: 'idle' | 'requested' | 'acked';
  closeApproved: boolean;
  queueSave: () => void;
  /** Settles once the window is shown (or closed). */
  shown: Promise<void>;
}
type Live = WindowCtx & { win: BrowserWindow };

function main() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true, corsEnabled: true, stream: true } },
  ]);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  else
    app.whenReady().then(() => {
      Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({ name: app.name, dev: !app.isPackaged, newWindow: (w) => void newWindow(registry.all().find((c) => c.win === w) ?? null) })));
      // Dock right-click: macOS lists the windows itself.
      app.dock?.setMenu(Menu.buildFromTemplate(dockMenuTemplate({ newWindow: () => void newWindow(null) })));
    });

  const userData = app.getPath('userData');
  const stateFile = path.join(userData, 'window-state.json');
  const rendererDir = path.resolve(process.env.SEC_EDIT_RENDERER_DIR || path.join(__dirname, '../renderer'));
  const timings: Record<string, number> = { mainStart: Math.round(tMainStart) };
  const mark = (k: string) => (timings[k] = Math.round(performance.now()));

  // App level, no folder: settings (theme, frame, MCP) and the recent folders (launch routing, every window's gate).
  // Settings saved in a window reach it (and the other windows' backends) through the settings.json watch.
  const appState = new BackendService(userData);
  const registry = new WindowRegistry<Live>({ p: path, foldCase: process.platform !== 'linux' });
  /** Integrated frame: the last overlay a renderer measured, for every window's first paint (window-state.json). */
  let titleBar: TitleBarCache | undefined;
  /** Quit asked (Cmd+Q, Playwright, the OS): every window closes the normal way first, then the app quits. */
  let quitRequested = false;
  const relaunch = createRelaunch({
    close: () => closeAll(),
    // SEC_EDIT_TEST_RELAUNCH: E2E checks the whole restart path without spawning a process it cannot drive.
    relaunch: () => (isTest && process.env.SEC_EDIT_TEST_RELAUNCH ? console.log('[sec-edit:relaunch]') : app.relaunch()),
    exit: (code) => app.exit(code),
  });

  /** The registered window of a trusted IPC sender; null = not ours (refused). */
  function trustedCtx(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): Live | null {
    if (!trustedSender(e)) return null;
    return registry.get(e.sender.id) ?? null;
  }
  const alive = (c: Live) => !c.win.isDestroyed();
  /** Shared services' events: every window shows the same status (also fires while quitting). */
  const broadcast = (channel: string, payload: unknown) => {
    for (const c of registry.all()) if (alive(c)) c.win.webContents.send(channel, payload);
  };
  /** An app-level dialog's window: the asking one when known, else the focused / last focused one. */
  const dialogParent = (asker?: Live | null): BrowserWindow | null => {
    if (asker && alive(asker) && registry.get(asker.id) === asker) return asker.win;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && registry.all().some((c) => c.win === focused)) return focused;
    const last = registry.lastFocused();
    return last && alive(last) ? last.win : null;
  };
  const openDialog = (w: BrowserWindow | null, o: Electron.OpenDialogOptions) => (w ? dialog.showOpenDialog(w, o) : dialog.showOpenDialog(o));
  function focusWindow(c: Live) {
    if (!alive(c)) return;
    if (c.win.isMinimized()) c.win.restore();
    c.win.show();
    c.win.focus();
    registry.noteFocus(c.id);
  }
  function closeAll() {
    for (const c of registry.all()) if (alive(c)) c.win.close();
  }
  const realOf = (abs: string) => fsp.realpath(abs).catch(() => null);
  /** Prepared windows not shown yet (their folder is already opening). */
  const pending = new Set<WindowCtx>();
  const contexts = (): WindowCtx[] => [...registry.all(), ...pending];
  const isLive = (c: WindowCtx): c is Live => !!c.win && registry.get(c.id) === c;
  /** Folder comparisons that see through links and mapped drives: every window's known real paths + `known`. */
  function matcher(known = new Map<string, string | null>()) {
    for (const c of contexts()) {
      if (c.claim && !known.has(c.claim.folder)) known.set(c.claim.folder, c.claim.real);
      const r = c.backend.root;
      if (r !== null && r === c.realFor && !known.has(r)) known.set(r, c.realRoot);
    }
    return folderMatch({ p: path, foldCase: process.platform !== 'linux', real: (x) => known.get(x) });
  }
  /** Another window that has this folder open, or is opening it (one window per folder). Inside serial(). */
  function windowWith(me: WindowCtx | null, abs: string, real: string | null): WindowCtx | undefined {
    const m = matcher(new Map([[abs, real]]));
    const has = (c: WindowCtx, folder: string | null | undefined, fold?: boolean) => !!folder && m.samePath(folder, abs, fold);
    return contexts().find((c) => c !== me && (has(c, c.claim?.folder) || has(c, c.backend.root, c.backend.foldsCase)));
  }
  /** `c` is opening `folder` (WindowCtx.claim). Returns the release: a no-op once a newer claim replaced this one. */
  function claim(c: WindowCtx, folder: string, real: string | null): () => void {
    const mine = { folder, real };
    c.claim = mine;
    return () => void (c.claim === mine && (c.claim = null));
  }
  /** After an open: the real path of what the window has open now (`hint`: a real path already known, no second lookup). */
  async function settleRoot(c: WindowCtx, hint?: { folder: string; real: string | null }) {
    const root = c.backend.root;
    if (root === c.realFor) return;
    const real = root === null ? null : hint && root === path.resolve(hint.folder) ? hint.real : await realOf(root);
    if (c.backend.root !== root) return; // opened again meanwhile: that open settles it
    c.realFor = root;
    c.realRoot = root === null ? null : (real ?? root); // no real path (gone, refused): its spelling
  }
  /** A prepared window that will not show (it failed, or the launch changed its plan): nothing of it stays behind. */
  function discard(c: WindowCtx) {
    pending.delete(c);
    c.claim = null;
    if (c.win && !c.win.isDestroyed()) c.win.destroy(); // already a window: 'closed' cleans up the rest
    else void c.backend.dispose();
  }

  if (isTest) (globalThis as any).__secEditVouch = (abs: string) => registry.all().forEach((c) => c.gate.vouch(abs)); // E2E stands in for the folder dialog

  // Integrated terminal: node-pty loads on the first spawn only (nothing at launch). Owner = the window's webContents id.
  const terminals = new TerminalService({
    loadPty: () => loadNodePty({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    getWorkspaceRoot: (owner) => registry.get(owner)?.backend.root ?? null,
    appVersion: app.getVersion(),
    // "Follow Claude's edits": per-terminal inbox folders in app data (terminal-follow.ts); paths are checked against the folder of the terminal's window.
    follow: {
      dir: path.join(userData, 'claude-follow'),
      foldCase: (owner) => !!registry.get(owner)?.backend.foldsCase,
      inside: (rel, owner) => registry.get(owner)?.backend.real(rel).then(() => true, () => false) ?? Promise.resolve(false),
      // Exact + / − for Claude's change list at the end of a turn: git's own numstat, only through the backend
      // (its trust gate and safety switches) — null for a folder that is not trusted or not a repository.
      numstat: (owner) => registry.get(owner)?.backend.gitNumstat() ?? Promise.resolve(null),
    },
  });
  // Process explorer rows (read only while it is open): Chromium processes + which children are shells.
  // Every window's renderer is a UI row; the focused one first (the explorer is open in the window the user looks at).
  registerProcessSource(
    electronProcessSource({
      shellPids: () => terminals.pids(),
      uiPids: () => [...new Set([registry.lastFocused(), ...registry.all()])].flatMap((c) => (c && alive(c) ? [c.win.webContents.getOSProcessId()] : [])),
    }),
  );

  // "Start web server": browser mode for a window's folder in a child process (only on request, never at launch).
  // One server for the app: it serves the folder of the window that started it; every window sees its status.
  const webServerCli = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'cli.mjs') : path.join(__dirname, '../server/cli.mjs');
  const webServer = new WebServerService({
    getRoot: () => null, // unused: every start names the calling window's folder (rootOf below)
    spawn: (args) => spawnCli(process.execPath, webServerCli, args, childEnv(process.env, userData)),
    lanAddresses: () => lanAddresses(os.networkInterfaces()),
    openExternal: (url) => shell.openExternal(url),
    onChange: (s) => broadcast(WEB_SERVER_CHANNELS.changed, s), // also fires while quitting
    log: (m) => console.log(m), // never the URL / token
  });
  if (isTest) (globalThis as any).__secEditWebServer = webServer; // E2E: child pid (no orphan after quit)

  // "Security updates" (Settings): nothing here runs until the renderer asks; the automatic check refuses
  // while the setting is off ("Check now" always goes). Requests go through a session of their own — in memory, no cookies, no cache,
  // a generic User-Agent — and only to the two allowlisted hosts (tests: one local stub, SEC_EDIT_TEST only).
  const updateStub = isTest && /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.SEC_EDIT_TEST_UPDATE_API ?? '') ? process.env.SEC_EDIT_TEST_UPDATE_API! : null;
  const updateUrlAllowed = (url: string) => (updateStub ? url.startsWith(`${updateStub}/`) : isAllowedUpdateUrl(url));
  let updateSession: Electron.Session | null = null;
  const updateFetch = (url: string, init: RequestInit) => {
    if (!updateSession) {
      updateSession = session.fromPartition('update-check', { cache: false });
      updateSession.setUserAgent('update-check', 'en');
      // Second lock on the same door: nothing but the allowlist leaves this session (redirects included).
      updateSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !updateUrlAllowed(d.url) }));
    }
    return updateSession.fetch(url, { ...init, credentials: 'omit', redirect: 'error', cache: 'no-store' });
  };
  const updateFile = path.join(userData, 'update-check.json');
  const updates = new UpdateCheckService({
    // settings.json itself, not appState's copy: a window saves the switch and asks at once, before appState's watch has
    // seen the change (the window's own save is on disk by then).
    isEnabled: async () => (await readJson<Partial<Settings> | null>(path.join(userData, 'settings.json'), null))?.['updates.check'] === true,
    electronVersion: process.versions.electron,
    shipped: () => readJson<unknown>(path.join(__dirname, 'shipped-deps.json'), null),
    endpoints: updateStub ? { eol: updateStub, osv: updateStub } : UPDATE_ENDPOINTS,
    allow: updateUrlAllowed,
    fetch: updateFetch,
    readState: () => readJson<unknown>(updateFile, null),
    writeState: (s) => writeJson(updateFile, s),
    onChange: (s) => broadcast(UPDATE_CHECK_CHANNELS.changed, s),
  });

  // Settings → MCP server: main owns mcp.json; nothing runs here (MCP clients start dist/mcp/cli.mjs
  // themselves). Turning it on, sharing a folder and allowing writes are native dialogs the page cannot answer.
  const mcpCli = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'mcp', 'cli.mjs') : path.join(__dirname, '../mcp/cli.mjs');
  /** The window whose MCP request came last: its dialogs go on it (else the focused one). */
  let mcpAsker: Live | null = null;
  // Tests: SEC_EDIT_TEST_MCP_CONFIRM = allow | deny (default deny; each box is logged as [sec-edit:mcp-confirm]),
  // SEC_EDIT_TEST_MCP_FOLDER = the folders the dialog "picks" (path.delimiter-separated) or cancel (SEC_EDIT_TEST only).
  const mcpConfirm = async (o: Electron.MessageBoxOptions) => {
    if (isTest) {
      console.log(`[sec-edit:mcp-confirm] ${JSON.stringify({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons })}`);
      return process.env.SEC_EDIT_TEST_MCP_CONFIRM === 'allow';
    }
    const w = dialogParent(mcpAsker);
    if (!w) return false;
    return (await dialog.showMessageBox(w, { type: 'question', defaultId: 1, cancelId: 1, noLink: true, ...o })).response === 0;
  };
  const mcp = new McpService({
    configDir: userData,
    homedir: os.homedir(),
    platform: process.platform,
    launch: () => mcpLaunch({ execPath: process.execPath, cli: mcpCli, exists: (p) => fs.existsSync(p) }),
    confirmEnable: () =>
      mcpConfirm({
        buttons: ['Turn on', 'Cancel'],
        title: 'Turn on the MCP server?',
        message: 'Let MCP clients read the folders you share?',
        detail: 'Apps you set up yourself (LM Studio, Codex CLI, Claude…) can then start One’s MCP server and read the folders you list in Settings: read-only unless you allow changes per folder. Nothing listens on the network. Your secrets and other folders stay out of reach.',
      }),
    confirmWrite: (f) =>
      mcpConfirm({
        buttons: ['Allow changes', 'Cancel'],
        title: 'Allow changes?',
        message: `Let MCP clients change files in “${f.alias}”?`,
        detail: `${f.path}\n\nAn AI model can then create, edit and move text files there, and delete them to the ${process.platform === 'win32' ? 'Recycle Bin' : 'trash'} (never permanently). Each change can be reverted in Settings → MCP server. Hidden files, key files and excluded folders stay off limits.`,
      }),
    pickFolders: async () => {
      const stub = isTest ? (process.env.SEC_EDIT_TEST_MCP_FOLDER ?? 'cancel') : null;
      if (stub !== null) return stub === 'cancel' ? [] : stub.split(path.delimiter).filter(Boolean);
      // Ctrl / Shift (macOS: Cmd / Shift) + click picks several; `message` is the macOS panel's only caption.
      const r = await openDialog(dialogParent(mcpAsker), { title: 'Share folders with MCP clients', message: 'Pick one or more folders to share read-only', properties: ['openDirectory', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    // The one dialog of "Add folders…": its buttons and checkbox are the choice (a one-button notice is never a yes).
    // Tests: SEC_EDIT_TEST_MCP_FOLDERS = read | write | write+code | cancel (default: read when
    // SEC_EDIT_TEST_MCP_CONFIRM = allow, else cancel).
    confirmFolders: async (q) => {
      const box = foldersConfirm(q);
      if (isTest) {
        console.log(`[sec-edit:mcp-confirm] ${JSON.stringify({ title: box.title, message: box.message, detail: box.detail, buttons: box.buttons, checkbox: box.checkboxLabel })}`);
        const want = process.env.SEC_EDIT_TEST_MCP_FOLDERS ?? (process.env.SEC_EDIT_TEST_MCP_CONFIRM === 'allow' ? 'read' : 'cancel');
        const response = want === 'read' ? 0 : want.startsWith('write') ? 1 : box.cancelId;
        return folderChoice(box, { response, checkboxChecked: want === 'write+code' });
      }
      const w = dialogParent(mcpAsker);
      if (!w) return null;
      const r = await dialog.showMessageBox(w, { noLink: true, ...box });
      return folderChoice(box, r);
    },
    realpath: (abs) => fsp.realpath(abs),
    isDirectory: (abs) => fsp.stat(abs).then((st) => st.isDirectory(), () => false),
    randomId: () => crypto.randomBytes(8).toString('hex'),
    onChange: (s) => broadcast(MCP_CHANNELS.changed, s),
    settings: () => appState.getSettings(),
    // Revert of a file MCP created: to the trash, like a delete from the tree (tests: SEC_EDIT_TRASH_DIR).
    trash: (abs) => (process.env.SEC_EDIT_TRASH_DIR ? platformTrash(abs) : shell.trashItem(abs)),
    confirmAllowCode: (f) =>
      mcpConfirm({
        buttons: ['Allow code files', 'Cancel'],
        title: 'Allow code and config files?',
        message: `Let MCP clients write code and config files in “${f.alias}”?`,
        detail: `${f.path}\n\nBesides notes (.md, .txt), an AI model could then change files such as .json, .yaml, .ts or .sh. Programs, scripts that run on a double-click (.js, .py, .bat, .ps1…) and shortcuts are never written.`,
      }),
    confirmUndoOff: () =>
      mcpConfirm({
        buttons: ['Turn off', 'Cancel'],
        title: 'Turn off undo copies?',
        message: 'Stop keeping undo copies of AI changes?',
        detail: 'Changes made from now on cannot be reverted in Settings → MCP server. Copies already kept stay until they expire. File deletes still keep a copy; deleted folders are restored from the Recycle Bin.',
      }),
    confirmToken: (q) =>
      mcpConfirm(
        q.kind === 'revoke'
          ? { buttons: ['Revoke', 'Cancel'], title: 'Revoke the token?', message: `Revoke the access token “${q.name}”?`, detail: 'The app using it stops working at once, until you copy a new setup into it.' }
          : { buttons: [q.kind === 'create' ? 'Create' : 'Regenerate', 'Cancel'], title: q.kind === 'create' ? 'New access token?' : 'Regenerate the token?', message: `${q.kind === 'create' ? 'Create' : 'Regenerate'} an access token for “${q.name}”?`, detail: `Its setup (with the token) is copied to the clipboard: paste it into that app's MCP configuration.${q.kind === 'regenerate' ? ' The old token stops working at once.' : ''}` },
      ),
    // Raw tokens for "Copy setup" again later: the OS keyring (safeStorage), never vault.json.
    tokenCrypto: { available: () => safeStorage.isEncryptionAvailable(), encrypt: (s) => safeStorage.encryptString(s), decrypt: (b) => safeStorage.decryptString(b) },
    writeClipboard: (text) => clipboard.writeText(text),
    readClipboard: () => clipboard.readText(),
    confirmCopy: (q) =>
      mcpConfirm({
        buttons: ['Copy', 'Cancel'],
        title: 'Copy setup with the access token?',
        message: `Copy the setup for “${q.name}” with its access token?`,
        detail: `Anyone who gets the token can use One's MCP server as that app. One clears the clipboard after 2 minutes.${process.platform === 'win32' ? ' Windows clipboard history (Win+V) and cloud clipboard sync keep their own copy: turn them off, or regenerate the token if it was synced.' : ''}`,
      }),
  });

  // ---- work that does not need Chromium: start immediately ----
  void appState.getSettings(); // the first window's theme / frame
  const windowStateP = readJson<WindowState | null>(stateFile, null);
  const launchPaths = pathsFromArgv(process.argv);
  if (process.env.SEC_EDIT_OPEN) launchPaths.push(path.resolve(process.env.SEC_EDIT_OPEN));
  // The first launch's windows: their folders start opening now, in parallel with Chromium's boot.
  const planFirst = async (extra: string[]) => {
    const [paths, recents] = await Promise.all([classify([...launchPaths, ...extra]), appState.recentWorkspaces()]);
    return prepareLaunch(plan(paths, recents, true));
  };
  const firstCtxs = planFirst([]);
  /** macOS: 'open-file' before the first windows exist (Finder / Dock started the app): this launch's paths. */
  const earlyOpen: string[] = [];
  let launchDone = false;
  let windowsReadyDone = () => {};
  /** The first launch's windows are registered: routing waits for them. */
  const windowsReady = new Promise<void>((r) => (windowsReadyDone = r));

  /** Launch paths → existing ones, folder or file (async: no blocking stat on the main thread). */
  async function classify(paths: string[]): Promise<LaunchPath[]> {
    const st = await Promise.all(paths.map((p) => fsp.stat(p).catch(() => null)));
    return paths.flatMap((abs, i): LaunchPath[] => (st[i] ? [{ abs, kind: st[i]!.isDirectory() ? 'dir' : 'file' }] : []));
  }

  /** `reals`: the launched paths' real paths (second launches; the first launch has no window to compare with). */
  function plan(paths: LaunchPath[], recents: string[], firstLaunch: boolean, reals = new Map<string, string | null>()): LaunchStep[] {
    const m = matcher(reals);
    return planLaunch({
      paths,
      // Each window with its own case rule; the match sees links and mapped drives (the same as windowWith).
      windows: registry.all().map((c) => ({ id: c.id, root: c.root, foldsCase: c.foldsCase })),
      lastFocusedId: registry.lastFocused()?.id ?? null,
      recents,
      firstLaunch,
      isInside: m.isInside,
      samePath: m.samePath,
      exists: (d) => fs.existsSync(d),
      dirname: (x) => path.dirname(x),
    });
  }

  /** The first launch: no window exists yet, so every step is a new window. */
  function prepareLaunch(steps: LaunchStep[]): WindowCtx[] {
    return steps.flatMap((s, i) => (s.kind === 'new-window' ? [prepareWindow({ folder: s.folder, files: s.files, first: i === 0 })] : []));
  }

  let routing: Promise<unknown> = Promise.resolve();
  /** Window routing one at a time: each sees the windows the one before made (a folder launched twice = one window). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = routing.then(() => windowsReady).then(fn);
    routing = run.catch(() => {});
    return run;
  }

  /** Second instance, macOS open-file: paths → windows (windows.ts planLaunch). */
  const routeLaunch = (raw: string[]) => serial(() => route(raw, false));

  /** Inside serial() only. Executes the steps in order: the last one ends up in front. */
  async function route(raw: string[], firstLaunch: boolean): Promise<void> {
    const [paths, recents, real] = await Promise.all([classify(raw), appState.recentWorkspaces(), Promise.all(raw.map(realOf))]);
    const reals = new Map(raw.map((x, i) => [x, real[i]] as const));
    const steps = plan(paths, recents, firstLaunch, reals);
    for (const [i, s] of steps.entries()) {
      if (s.kind === 'new-window') {
        const c = await createWindow({ folder: s.folder, files: s.files, real: s.folder === null ? null : reals.get(s.folder) }, registry.lastFocused() ?? null);
        // A new window takes the focus when it shows: wait for that before the next step.
        if (i < steps.length - 1) await shownOrLater(c);
        continue;
      }
      const c = registry.get(s.id);
      if (!c || !alive(c)) continue;
      if (s.kind === 'open-files') openFiles(c, s.files);
      focusWindow(c);
    }
  }
  /** A window that never shows (renderer stuck) must not hold up the windows after it. */
  const shownOrLater = (c: Live) => Promise.race([c.shown, new Promise((r) => setTimeout(r, 3000).unref())]);

  /** Files for a window: vouched in its gate, then to the renderer (before its bootstrap: the launch queue). */
  function openFiles(c: Live, files: string[]) {
    for (const f of files) c.gate.vouch(f);
    if (c.backend.booted) c.win.webContents.send('app:openRequest', files);
    else for (const f of files) c.backend.queueOpenRequest(f);
  }

  /** A start-screen window (Ctrl+Shift+N, macOS menus, a second launch without paths), next to `from`. */
  function newWindow(from: Live | null): Promise<Live> {
    return serial(() => createWindow({ folder: null, files: [] }, from ?? registry.lastFocused() ?? null));
  }

  async function createWindow(o: { folder: string | null; files: string[]; real?: string | null }, from: Live | null): Promise<Live> {
    const ctx = prepareWindow(o);
    try {
      await app.whenReady();
      return await showWindow(ctx, from);
    } catch (err) {
      discard(ctx);
      throw err;
    }
  }

  /** The dialogs and OS hooks of one window's backend: parented to that window. */
  function windowHooks(get: () => WindowCtx): ServiceHooks {
    const parent = () => {
      const w = get().win;
      return w && !w.isDestroyed() ? w : null;
    };
    const picked = (r: Electron.OpenDialogReturnValue) => {
      const p = r.canceled ? null : (r.filePaths[0] ?? null);
      if (p) get().gate.vouch(p);
      return p;
    };
    return {
      pickFolder: async () => picked(await openDialog(parent(), { properties: ['openDirectory', 'createDirectory'] })),
      pickFile: async () => picked(await openDialog(parent(), { properties: ['openFile'] })),
      externalFiles: true,
      // SEC_EDIT_TRASH_DIR (tests) → the service's platform trash moves files there instead.
      trash: process.env.SEC_EDIT_TRASH_DIR ? undefined : (abs) => shell.trashItem(abs),
      trashIsAuthoritative: process.platform === 'win32',
      openExternal: (url) => shell.openExternal(url),
      revealInFolder: (abs) => shell.showItemInFolder(abs),
      renderPdf,
      pickSavePath: async (defaultPath) => {
        // Tests: SEC_EDIT_TEST_SAVE_PATH = "default" (accept the suggestion) | "cancel" | an absolute path.
        const stub = isTest ? process.env.SEC_EDIT_TEST_SAVE_PATH : undefined;
        if (stub) return stub === 'cancel' ? null : stub === 'default' ? defaultPath : stub;
        const o: Electron.SaveDialogOptions = { title: 'Export to PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] };
        const w = parent();
        const r = await (w ? dialog.showSaveDialog(w, o) : dialog.showSaveDialog(o));
        return r.canceled || !r.filePath ? null : r.filePath;
      },
      openPath: async (abs) => {
        const err = await shell.openPath(abs);
        if (err) throw new BackendFailure('EIO', err);
      },
    };
  }

  /** Everything of a window that needs no Chromium: its backend starts opening the folder at once. `real`: the folder's
   *  real path when the caller knows it (else looked up next to the open, never in its way). */
  function prepareWindow(o: { folder: string | null; files: string[]; first?: boolean; real?: string | null }): WindowCtx {
    let ctx!: WindowCtx;
    const service = new BackendService(userData, windowHooks(() => ctx));
    // Test only, reaching past the seam: the startup guard reads the first window's workspace (fullWalks, host).
    if (isTest && o.first) (globalThis as any).__secEditService = service;
    const backend = createInProcessBackend(service);
    const send = (channel: string, payload: unknown) => {
      const w = ctx.win;
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    };
    ctx = {
      id: -1,
      win: null,
      first: !!o.first,
      backend,
      // Folders this window may open: only what main saw itself (see open-gate.ts).
      gate: new OpenGate({
        p: path,
        foldCase: process.platform !== 'linux',
        realpath: (abs) => fsp.realpath(abs).catch(() => null),
        isFile: (abs) => fsp.stat(abs).then((st) => st.isFile(), () => false),
        recent: () => appState.recentWorkspaces(),
        root: () => backend.root,
      }),
      zen: new ZenFullScreen(), // zen mode's full screen: what to give back when it ends
      vault: { root: () => backend.root, confirmSharedKey: (q) => confirmSharedKey(ctx, q) }, // folder-scoped keys: this window's folder only
      indexToken: crypto.randomBytes(16).toString('hex'),
      wsKey: crypto.randomBytes(16).toString('hex'),
      frame: 'native',
      initialOpen: Promise.resolve(),
      claim: null,
      realRoot: null,
      realFor: null,
      get root() {
        return ctx.claim?.folder ?? backend.root;
      },
      get foldsCase() {
        return ctx.claim === null && backend.root !== null ? backend.foldsCase : undefined;
      },
      closing: 'idle',
      closeApproved: false,
      queueSave: () => {},
      shown: Promise.resolve(),
    };
    pending.add(ctx);
    for (const p of [o.folder, ...o.files]) if (p) ctx.gate.vouch(p);
    // A file never changes an open folder (it becomes a tab; one outside the folder is the renderer's call).
    for (const f of o.files) backend.queueOpenRequest(f);
    const folder = o.folder;
    if (folder) {
      const release = claim(ctx, folder, o.real ?? null);
      const mine = ctx.claim!;
      // The real path next to the open (not in its way); the claim keeps the folder counted until it has settled.
      const realP = o.real !== undefined ? Promise.resolve(o.real) : realOf(folder).then((r) => (mine.real = r));
      ctx.initialOpen = (async () => {
        try {
          await backend.openWorkspace(folder);
        } catch (err) {
          console.error('[sec-edit] initial open failed', err); // the window shows the start screen
        }
        void realP.then((real) => settleRoot(ctx, { folder, real })).finally(release);
        if (o.first) mark('workspaceOpen');
      })();
    } else if (o.first) ctx.initialOpen = Promise.resolve().then(() => void mark('workspaceOpen'));
    backend.on('fs', (events) => send('fs:events', events));
    backend.on('git', (e) => send('git:changed', e));
    backend.on('settings', (s, patch) => {
      if ('theme' in patch || 'sidebarStyle' in patch) applyTheme(s);
    });
    // Another window, a browser-mode server or another process changed settings.json: this window applies it live.
    backend.on('externalSettings', (patch) => send('settings:changed', patch));
    return ctx;
  }

  // A shared `vault:<key>` another folder saved: the user decides, in a native dialog on the asking window the page cannot answer.
  async function confirmSharedKey(c: WindowCtx, q: VaultSharedKeyRequest): Promise<boolean> {
    // Tests: SEC_EDIT_TEST_VAULT_CONFIRM = allow | deny (default deny: a native dialog would hang the run).
    if (isTest) return process.env.SEC_EDIT_TEST_VAULT_CONFIRM === 'allow';
    const w = c.win;
    if (!w || w.isDestroyed()) return false;
    const m = sharedKeyMessage(q);
    const r = await dialog.showMessageBox(w, { type: 'question', buttons: ['Allow', 'Don’t allow'], defaultId: 1, cancelId: 1, noLink: true, title: 'Use a saved secret?', message: m.message, detail: m.detail });
    return r.response === 0;
  }

  for (const method of RPC_METHODS) {
    ipcMain.handle(`rpc:${method}`, async (e, ...args: unknown[]) => {
      const ctx = trustedCtx(e);
      if (!ctx) return { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
      await ctx.initialOpen; // the renderer's first getWorkspace/bootstrap must see the launch folder
      let opened: { folder: string; real: string | null; release: () => void } | null = null;
      try {
        if (method === 'openWorkspace') {
          // The page asks, main decides: a folder it has not seen itself is not opened (open-gate.ts).
          if (!(await ctx.gate.allows(args[0]))) throw new BackendFailure('EACCES', FOLDER_REFUSED);
          const folder = path.resolve(args[0] as string);
          const real = await realOf(folder);
          // One window per folder, decided in turn with launches and openFolderWindow: a folder another window has
          // open (or is opening) is shown there; else this window claims it until its open has settled.
          const release = await serial(async () => {
            const other = windowWith(ctx, folder, real);
            if (other) {
              if (isLive(other)) focusWindow(other);
              throw new BackendFailure('EBUSY', 'That folder is open in another window');
            }
            return claim(ctx, folder, real);
          });
          opened = { folder, real, release };
        }
        // An outside file is opened only if main saw that very file itself (dialog, OS open, argv, drop).
        if (method === 'openExternalFile' && !(await ctx.gate.vouchedFile(args[0]))) throw new BackendFailure('EACCES', 'This file was not chosen in the app: use “Open file”, drop it on the window or open it from the OS');
        const result = await ctx.backend.call(method, args);
        if (method === 'openWorkspace') {
          // Shells started in this window's previous folder go with it; a web server for a folder no window has open stops.
          terminals.setWorkspace(ctx.backend.root, ctx.id);
          webServer.rootsChanged(registry.roots(), 'Opening another folder stopped the web server.');
        }
        return { ok: true, result };
      } catch (err: any) {
        const code = err instanceof BackendFailure ? err.code : err?.code || 'EIO';
        return { ok: false, error: { code, message: String(err?.message || err) } };
      } finally {
        if (opened) {
          await settleRoot(ctx, opened);
          opened.release();
        }
      }
    });
  }
  // In-app "Open folder…", a recent folder, "Open as project", a folder drop: main decides where it opens.
  // 'here' = this window is empty (or has that folder): the renderer opens it in place (rpc:openWorkspace).
  ipcMain.handle('app:openFolderWindow', async (e, abs: unknown) => {
    const ctx = trustedCtx(e);
    if (!ctx) throw new BackendFailure('EACCES', 'Untrusted sender');
    await ctx.initialOpen;
    if (!(await ctx.gate.allows(abs))) throw new BackendFailure('EACCES', FOLDER_REFUSED);
    const folder = path.resolve(abs as string);
    const real = await realOf(folder);
    return serial(async () => {
      const other = windowWith(ctx, folder, real);
      if (other) {
        if (isLive(other)) focusWindow(other);
        return 'focused';
      }
      const own = ctx.backend.root;
      if (own === null) {
        // Empty: the renderer opens it here next (rpc:openWorkspace). Until then it counts as this window's, so the
        // same folder asked for in another window (or launched) comes here instead of opening twice.
        setTimeout(claim(ctx, folder, real), CLAIM_MS).unref();
        return 'here';
      }
      if (matcher(new Map([[folder, real]])).samePath(own, folder, ctx.backend.foldsCase)) return 'here';
      if (!(await fsp.stat(folder).then((st) => st.isDirectory(), () => false))) throw new BackendFailure('ENOENT', `Not a folder: ${folder}`);
      await createWindow({ folder, files: [], real }, ctx); // vouched in the new window's gate
      return 'new';
    });
  });
  ipcMain.handle('app:newWindow', async (e) => {
    const ctx = trustedCtx(e);
    if (!ctx) throw new BackendFailure('EACCES', 'Untrusted sender');
    await newWindow(ctx);
  });
  registerTerminalIpc(ipcMain, terminals, { isTrusted: (e) => !!trustedCtx(e as Electron.IpcMainEvent) });
  // Secrets of {{variables}}: safeStorage ciphertext in user data (read on first use, never at launch).
  // Without an OS keyring (Linux) safeStorage refuses and the renderer keeps secrets for the session only;
  // tests (no keyring under Xvfb) opt into the basic_text backend so the real code path still runs.
  if (isTest && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  // One store for every window; each call is scoped to the calling window's folder (scopeOf).
  const vault = new VaultService(
    path.join(userData, 'vault.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(b),
      backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'),
    },
    { root: () => null }, // unused (every call brings its window's scope); no folder, no shared-key dialog
  );
  registerVaultIpc(ipcMain, vault, { isTrusted: (e) => !!trustedCtx(e as Electron.IpcMainInvokeEvent), scopeOf: (e) => trustedCtx(e as Electron.IpcMainInvokeEvent)?.vault ?? null });
  registerGpuIpc(ipcMain, { isTrusted: (e) => !!trustedCtx(e as Electron.IpcMainInvokeEvent) });
  registerWebServerIpc(ipcMain, webServer, { isTrusted: (e) => !!trustedCtx(e as Electron.IpcMainInvokeEvent), rootOf: (e) => trustedCtx(e as Electron.IpcMainInvokeEvent)?.backend.root ?? null });
  registerUpdateCheckIpc(ipcMain, updates, { isTrusted: (e) => !!trustedCtx(e as Electron.IpcMainInvokeEvent) });
  registerMcpIpc(ipcMain, mcp, {
    isTrusted: (e) => {
      const c = trustedCtx(e as Electron.IpcMainInvokeEvent);
      if (c) mcpAsker = c; // runs right before the request: its dialogs go on this window
      return !!c;
    },
  });
  // "MCP active" (status bar): running stdio servers' live files. Off the startup path: a few seconds later;
  // the first scan also removes files that crashed servers left behind.
  setTimeout(() => mcp.watchSessions(), 3000).unref();
  // A file / folder dropped on the window: the preload read its path from the File object (page script
  // cannot fabricate one) and reports it here, so the open that follows passes that window's gate.
  ipcMain.on('app:vouchPath', (e, abs: unknown) => void trustedCtx(e)?.gate.vouch(abs));
  ipcMain.handle('app:toggleDevTools', (e) => {
    const c = trustedCtx(e);
    return c ? c.win.webContents.toggleDevTools() : false;
  });
  // Settings → Window frame → "Restart now": through every window's normal close flow (never loses edits).
  ipcMain.handle('app:relaunch', (e) => {
    if (!trustedCtx(e)) return false;
    relaunch.request();
    return true;
  });
  ipcMain.on('app:zenFullScreen', (e, on: unknown) => {
    const c = trustedCtx(e);
    if (c) c.zen.set(c.win, on === true);
  });
  // Integrated frame: the renderer reports the tab strip's real colours/height (theme, accent, density, zoom).
  ipcMain.on('app:titleBarOverlay', (e, raw: unknown) => {
    const o = parseOverlay(raw);
    const c = trustedCtx(e);
    if (!o || !c || c.frame !== 'integrated' || process.platform === 'darwin' || !alive(c)) return;
    c.win.setTitleBarOverlay(o);
    // Keyed by the colour's own brightness: main's theme may lag the renderer's by one settings round-trip.
    titleBar = rememberOverlay(titleBar, o, isDarkColor(o.color));
    if (isTest) (globalThis as any).__secEditTitleBar = o;
    c.queueSave();
  });
  ipcMain.on('app:ready', (e, r: { timeOrigin: number; marks: Record<string, number> }) => {
    if (!trustedCtx(e)?.first) return; // launch timings: the first window's
    mark('rendererReady');
    // Renderer clock → ms since main process start.
    for (const [k, v] of Object.entries(r.marks || {})) timings[`r.${k}`] = Math.round(r.timeOrigin + v - performance.timeOrigin);
    if (logTimings) console.log(`[sec-edit:timings] ${JSON.stringify(timings)}`);
  });
  // Close flow (see showWindow): per window, by sender.
  ipcMain.on('app:closeAck', (e) => {
    const c = trustedCtx(e);
    if (c && c.closing === 'requested') c.closing = 'acked';
  });
  ipcMain.on('app:closeApproved', (e, ok: boolean) => {
    const c = trustedCtx(e);
    if (!c || !alive(c)) return;
    if (!ok) {
      c.closing = 'idle'; // user chose Cancel: the next close asks again
      quitRequested = false; // …a quit that led here is off
      relaunch.cancelled(); // …and so is a "Restart now"
      return;
    }
    c.closeApproved = true;
    c.win.close();
  });

  function applyTheme(s: Settings) {
    // Drives prefers-color-scheme in the page *and* native chrome (Windows title bar, menus, scrollbars).
    nativeTheme.themeSource = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system';
    const bg = windowBg(s);
    for (const c of registry.all()) if (alive(c)) c.win.setBackgroundColor(bg);
  }

  function visibleBounds(st: WindowState | null): WindowState {
    const def = { width: 1280, height: 820 };
    if (!st || !st.width || !st.height) return def;
    if (st.x === undefined || st.y === undefined) return { width: st.width, height: st.height, maximized: st.maximized };
    // Monitor unplugged since last run → don't open off-screen.
    const onScreen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return st.x! + 80 < a.x + a.width && st.x! + st.width - 80 > a.x && st.y! >= a.y - 10 && st.y! + 40 < a.y + a.height;
    });
    return onScreen ? st : { width: st.width, height: st.height, maximized: st.maximized };
  }

  /** The BrowserWindow of a prepared window: geometry from the saved state, or cascaded from `from`. */
  async function showWindow(ctx: WindowCtx, from: Live | null): Promise<Live> {
    const cascadeFrom = from && alive(from) ? from.win : null;
    const [settings, savedState] = await Promise.all([appState.getSettings(), ctx.first ? windowStateP : cascadeFrom ? null : readJson<WindowState | null>(stateFile, null)]);
    applyTheme(settings);
    // New windows: next to the one they came from (its normal bounds), on its display; else where the last one was.
    const prev = cascadeFrom?.getNormalBounds();
    const st: WindowState = prev ? cascadeBounds(prev, screen.getDisplayMatching(prev).workArea) : visibleBounds(savedState);
    titleBar ??= savedState?.titleBar;
    const frame = (ctx.frame = frameOf(settings));
    const frameOpts = frameWindowOptions(frame, process.platform, initialOverlay(settings, nativeTheme.shouldUseDarkColors, titleBar));
    if (isTest && ctx.first) Object.assign(globalThis as any, { __secEditWindowOptions: { frame, ...frameOpts }, __secEditTitleBar: frameOpts.titleBarOverlay ?? null });
    if (ctx.first) mark('createWindow');
    const w = new BrowserWindow({
      x: st.x,
      y: st.y,
      width: st.width,
      height: st.height,
      minWidth: 480,
      minHeight: 320,
      show: false,
      backgroundColor: windowBg(settings), // matches first paint → no white flash
      autoHideMenuBar: true,
      title: 'sec-edit',
      ...frameOpts,
      icon: process.platform === 'linux' ? path.join(rendererDir, 'icon.png') : undefined,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: settings.spellcheck,
        backgroundThrottling: false,
        v8CacheOptions: 'bypassHeatCheck', // cache compiled JS on first run, not the third
        // Read by the preload (bridge.frame / bridge.indexToken / bridge.wsKey).
        additionalArguments: [`--sec-edit-frame=${frame}`, `--sec-edit-index-token=${ctx.indexToken}`, `--sec-edit-ws-key=${ctx.wsKey}`],
      },
    });
    const c = Object.assign(ctx, { win: w, id: w.webContents.id }) as Live;
    c.shown = new Promise<void>((r) => {
      w.once('show', () => r());
      w.once('closed', () => r());
    });
    registry.add(c);
    pending.delete(c);
    // A window opened while quitting or restarting (a second launch, the Dock): the user wants the app after all.
    if (quitRequested || relaunch.requested) {
      quitRequested = false;
      relaunch.cancelled();
    }
    c.zen.attach(w);
    w.on('focus', () => registry.noteFocus(c.id));
    w.on('show', () => registry.noteFocus(c.id));
    // Electron hides the WCO buttons in full screen but keeps env(titlebar-area-*) reporting their area (the
    // CSS assumption "hidden → 0" is wrong): tell the renderer, which drops the reservations (html.fs-full).
    w.on('enter-full-screen', () => w.webContents.send('app:fullScreen', true));
    w.on('leave-full-screen', () => w.webContents.send('app:fullScreen', false));
    w.once('ready-to-show', () => {
      if (c.first) mark('readyToShow');
      if (st.maximized) w.maximize();
      w.show();
      if (c.first) mark('shown');
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // Dropping a file on the window, or a link in a note, must never navigate away from the app
    // (that would discard unsaved edits); workspace files (/__ws/) are not the app either.
    w.webContents.on('will-navigate', (e, url) => {
      if (isAppNavigation(url, DEV_URL)) return;
      e.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    });
    w.webContents.on('will-redirect', (e, url) => {
      if (!isAppNavigation(url, DEV_URL)) e.preventDefault();
    });
    w.webContents.on('render-process-gone', (_e, d) => {
      console.error('[sec-edit] renderer gone', d.reason);
      // Crash / OOM: come back instead of leaving a dead window (autosave limits what is lost).
      if (d.reason !== 'clean-exit' && !w.isDestroyed()) setTimeout(() => !w.isDestroyed() && w.webContents.reload(), 300);
    });
    w.webContents.on('will-attach-webview', (e) => e.preventDefault());

    // Persist window geometry (debounced) and on close: the window saved last is where the next launch opens.
    let saveTimer: NodeJS.Timeout | null = null;
    const saveState = () => {
      if (w.isDestroyed() || w.isMinimized()) return;
      const maximized = c.zen.maximized(w);
      const normal = w.getNormalBounds(); // pre-maximize geometry, so un-maximizing next launch looks right
      void writeJson(stateFile, { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized, titleBar } satisfies WindowState).catch(() => {});
    };
    const queueSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveState, 400);
    };
    c.queueSave = queueSave;
    w.on('resize', queueSave);
    w.on('move', queueSave);
    w.on('maximize', queueSave);
    w.on('unmaximize', queueSave);

    // Mouse side buttons (and keyboard browser keys) on Windows: the renderer steps its navigation history.
    // The same press may also reach it as a DOM mouse event; it de-duplicates (shared/nav.ts).
    w.on('app-command', (e, cmd) => {
      const dir = navFromAppCommand(cmd);
      if (!dir || w.isDestroyed()) return;
      e.preventDefault();
      w.webContents.send(NAV_CHANNEL, dir);
    });

    // Minimised / hidden: let Chromium throttle the page (no frames for a blinking caret, timers
    // ≥ 1 s, document.hidden → the search feeder pauses) and hold the folder poller of WSL / network
    // roots. Off again when shown: terminals, autosave and indexing run at full speed in the foreground.
    const background = (on: boolean) => {
      if (w.isDestroyed()) return;
      w.webContents.setBackgroundThrottling(on);
      c.backend.setWatchPaused(on);
    };
    w.on('minimize', () => background(true));
    w.on('hide', () => background(true));
    w.on('restore', () => background(false));
    w.on('show', () => background(false));

    // Give the renderer a chance to flush autosaves / ask about unsaved changes before closing.
    // The 4 s fallback only covers a renderer that never picks the request up (crashed, still booting).
    // Once the preload acknowledges it, the user may take as long as they like on "Save changes?" —
    // closing anyway after 4 s threw their unsaved edits away. A renderer that hangs after acknowledging
    // is caught by 'unresponsive'. (app:closeAck / app:closeApproved: registered once, by sender.)
    const forceClose = () => {
      if (w.isDestroyed() || c.closeApproved) return;
      c.closeApproved = true;
      w.close();
    };
    w.on('close', (e) => {
      saveState();
      if (c.closeApproved || w.webContents.isCrashed()) return;
      e.preventDefault();
      if (c.closing === 'acked') {
        // Clicked close again while being asked: ask again (a handler that failed gets another chance).
        w.webContents.send('app:closeRequest');
        return;
      }
      c.closing = 'requested';
      w.webContents.send('app:closeRequest');
      setTimeout(() => c.closing === 'requested' && forceClose(), 4000);
    });
    w.on('unresponsive', () => c.closing !== 'idle' && forceClose());
    w.on('closed', () => {
      if (saveTimer) clearTimeout(saveTimer);
      registry.remove(c.id);
      terminals.killOwner(c.id);
      void c.backend.dispose();
      webServer.rootsChanged(registry.roots()); // its folder open nowhere else: the web server for it stops
    });

    void (DEV_URL ? w.loadURL(DEV_URL) : w.loadURL(`${APP_ORIGIN}/index.html`)).then(
      () => c.first && mark('loaded'),
      (err) => console.error('[sec-edit] window load failed', err),
    );
    return c;
  }

  function serveRenderer() {
    protocol.handle(SCHEME, async (req) => {
      const route = routeAppUrl(req.url, rendererDir, path);
      if (route.kind === 'error') return new Response(route.message, { status: route.status });
      // Text pages for the search workers: produced by the indexer thread as JSON bytes, only forwarded here.
      // The header's token names the window (each window's workers index its own folder).
      if (route.kind === 'index') {
        const token = req.headers.get('x-sec-edit-index');
        const c = token ? registry.all().find((x) => x.indexToken === token) : undefined;
        if (!c) return new Response('forbidden', { status: 403 });
        try {
          const body = route.op === 'page' ? await c.backend.indexPage(route.params.get('cursor'), Number(route.params.get('maxBytes')) || undefined) : await c.backend.indexFiles(await req.json());
          return new Response(body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': route.op === 'page' ? 'application/octet-stream' : 'application/json', 'cache-control': 'no-store' } });
        } catch (err) {
          return new Response(String((err as Error)?.message ?? err), { status: err instanceof BackendFailure && err.code === 'NO_WORKSPACE' ? 409 : 500 });
        }
      }
      // Workspace files for the preview (images, PDFs…): app://sec-edit/__ws/<window key>/<rel>, from that window's folder.
      if (route.kind === 'workspace') {
        const c = registry.all().find((x) => x.wsKey === route.key);
        if (!c) return new Response('not found', { status: 404 });
        try {
          const abs = await c.backend.real(route.rel); // also through links: a link out of the folder is not served
          // Regular files only: file:// on a folder renders a listing page, on a FIFO it blocks a thread.
          if (!(await fsp.stat(abs)).isFile()) return new Response('not found', { status: 404 });
          const res = await net.fetch(pathToFileURL(abs).toString());
          const headers = new Headers(res.headers);
          headers.set('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
          headers.set('x-content-type-options', 'nosniff');
          headers.set('cache-control', 'no-cache');
          return new Response(res.body, { status: res.status, headers });
        } catch {
          return new Response('not found', { status: 404 });
        }
      }
      const res = await net.fetch(pathToFileURL(route.file).toString());
      if (!isPdfWorkerAsset(route.file)) return res;
      const headers = new Headers(res.headers);
      headers.set('content-security-policy', PDF_WORKER_CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  }

  // A second launch (Explorer, CLI, Windows Shift+click on the taskbar): its paths go where planLaunch says — a folder
  // to the window that has it, else a new one; a file to the window whose folder holds it; no path = a new window.
  app.on('second-instance', (_e, argv, workingDirectory) => {
    void routeLaunch(pathsFromArgv(argv, workingDirectory)).catch((err) => console.error('[sec-edit] second launch failed', err));
  });

  // macOS never puts "Open With", a drop on the Dock icon or `open -a One <path>` in argv: it sends 'open-file' (also to a
  // running app, and on a cold start before 'ready'). Before the first windows exist the path is this launch's own (it
  // replaces "the most recent folder"); later it is routed like a second launch's.
  app.on('open-file', (e, p) => {
    e.preventDefault();
    if (!launchDone) earlyOpen.push(p);
    else void routeLaunch([p]).catch((err) => console.error('[sec-edit] open-file failed', err));
  });

  // macOS: a click on the Dock icon with no window open → a window like a fresh launch (the most recent folder).
  // Checked inside serial(): after the launch's own windows, and once for clicks in a row.
  app.on('activate', () => {
    void serial(async () => {
      if (!registry.all().length && !quitRequested) await route([], true);
    }).catch((err) => console.error('[sec-edit] activate failed', err));
  });

  if (process.platform === 'win32') app.setAppUserModelId('sec-edit'); // taskbar grouping + pinning

  app.whenReady().then(async () => {
    mark('appReady');
    // `npm run electron` runs the stock Electron.app, whose Dock icon is Electron's; a packaged One.app has its own .icns.
    if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(path.join(rendererDir, 'icon.png'));
    serveRenderer();
    // An editor needs no camera, mic, geolocation, notifications… deny everything but clipboard + fullscreen.
    const allowed = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    try {
      let ctxs = await firstCtxs;
      const extra = earlyOpen.splice(0);
      launchDone = true;
      if (extra.length) {
        // macOS cold start by Finder / the Dock: those paths are what this launch opens.
        for (const c of ctxs) discard(c);
        ctxs = await planFirst(extra);
      }
      let prev: Live | null = null;
      for (const ctx of ctxs) {
        try {
          if (prev) await shownOrLater(prev); // the last one ends up in front
          prev = await showWindow(ctx, prev);
        } catch (err) {
          console.error('[sec-edit] a launch window failed', err);
          discard(ctx); // the others still open
        }
      }
    } catch (err) {
      console.error('[sec-edit] launch failed', err);
    } finally {
      for (const c of [...pending]) discard(c); // nothing of a failed launch stays behind (routing has not started yet)
      windowsReadyDone();
      // Not one window came up: no window-all-closed will ever follow (Windows / Linux would keep a process without a window).
      if (!registry.all().length && process.platform !== 'darwin') app.quit();
    }
  });

  // Quit (Cmd+Q, the Dock, the OS, Playwright): every window goes through its own close flow first ("Save changes?");
  // a Cancel in any of them stops the quit. The last window closed then quits (window-all-closed).
  app.on('before-quit', (e) => {
    const open = registry.all().filter((c) => alive(c) && !c.closeApproved);
    if (open.length) {
      e.preventDefault();
      quitRequested = true;
      for (const c of open) c.win.close();
      return;
    }
    // No orphan shells: also on relaunch, which ends with app.exit() (no before-quit; see window-all-closed).
    terminals.dispose();
    webServer.dispose();
  });
  app.on('window-all-closed', () => {
    // macOS: the app stays in the Dock without a window (Mac convention), unless it is quitting or restarting.
    if (process.platform === 'darwin' && !quitRequested && !relaunch.requested) return;
    terminals.dispose();
    webServer.dispose(); // the child also exits by itself once this process is gone (IPC disconnect)
    appState.dispose();
    if (!relaunch.allClosed()) app.quit();
  });
}
