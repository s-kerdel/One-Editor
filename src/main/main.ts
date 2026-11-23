// Electron main process. Kept deliberately tiny so the window appears fast:
//  - settings/window-state/workspace open start *before* app 'ready' and run in parallel with Chromium boot;
//  - the renderer is served from a privileged app:// scheme so V8 code cache works (file:// gets none);
//  - no default application menu (saves startup time and stray accelerators like Ctrl+R / Ctrl+W).
import './env-boot'; // first: drops SEC_EDIT_* hooks in a packaged build before any module reads them
import { appMenuTemplate } from './app-menu';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, safeStorage, screen, session, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { RPC_METHODS, type Settings } from '../shared/api';
import { BackendService, readJson, writeJson } from '../backend/service';
import { BackendFailure } from '../backend/workspace';
import { isInsideDir } from '../backend/pathsafe';
import { isBridgeRoot } from '../backend/readpool';
import { registerProcessSource } from '../backend/processes';
import { electronProcessSource } from './process-rows';
import { APP_ORIGIN, SCHEME, isAppNavigation, isExternalUrl, folderForOpenedFile, pathsFromArgs, routeAppUrl } from './protocol';
import { renderPdf } from './pdf-window';
import { PDF_WORKER_CSP, isPdfWorkerAsset } from '../shared/pdf';
import { TerminalService, loadNodePty, registerTerminalIpc } from './terminal';
import { VaultService, registerVaultIpc, sharedKeyMessage } from './vault';
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

const tMainStart = performance.now(); // ms since process start (Node's timeOrigin)
const isTest = !!process.env.SEC_EDIT_TEST;
/** Per-launch secret for app://sec-edit/__index/ (handed to the page through the preload). */
const indexToken = crypto.randomBytes(16).toString('hex');
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

// Single instance: a second launch hands its paths to the running window (feels instant).
// Tests run many instances in parallel; they opt back in with SEC_EDIT_SINGLE_INSTANCE=1.
const wantLock = !isTest || !!process.env.SEC_EDIT_SINGLE_INSTANCE;
const gotLock = !wantLock || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else main();

function isInside(child: string, parent: string) {
  return isInsideDir(child, parent, path, process.platform !== 'linux');
}

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

function main() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true, corsEnabled: true, stream: true } },
  ]);
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  else app.whenReady().then(() => Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate({ name: app.name, dev: !app.isPackaged }))));

  let win: BrowserWindow | null = null;
  let frame: WindowFrame = 'native'; // what the window was created with (settings may change until a restart)
  let titleBar: TitleBarCache | undefined;
  let queueStateSave = () => {};
  const zenFs = new ZenFullScreen(); // zen mode's full screen: what to give back when it ends
  const relaunch = createRelaunch({
    close: () => win?.close(),
    // SEC_EDIT_TEST_RELAUNCH: E2E checks the whole restart path without spawning a process it cannot drive.
    relaunch: () => (isTest && process.env.SEC_EDIT_TEST_RELAUNCH ? console.log('[sec-edit:relaunch]') : app.relaunch()),
    exit: (code) => app.exit(code),
  });
  const timings: Record<string, number> = { mainStart: Math.round(tMainStart) };
  const mark = (k: string) => (timings[k] = Math.round(performance.now()));

  const service = new BackendService(app.getPath('userData'), {
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      const picked = r.canceled ? null : (r.filePaths[0] ?? null);
      if (picked) gate.vouch(picked);
      return picked;
    },
    pickFile: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openFile'] });
      const picked = r.canceled ? null : (r.filePaths[0] ?? null);
      if (picked) gate.vouch(picked);
      return picked;
    },
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
      const r = await dialog.showSaveDialog(win!, { title: 'Export to PDF', defaultPath, filters: [{ name: 'PDF', extensions: ['pdf'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] });
      return r.canceled || !r.filePath ? null : r.filePath;
    },
    openPath: async (abs) => {
      const err = await shell.openPath(abs);
      if (err) throw new BackendFailure('EIO', err);
    },
  });
  if (isTest) (globalThis as any).__secEditService = service; // startup guard: tree walks at launch

  // Folders the window may open: only what main saw itself (see open-gate.ts).
  const gate = new OpenGate({
    p: path,
    foldCase: process.platform !== 'linux',
    realpath: (abs) => fsp.realpath(abs).catch(() => null),
    isFile: (abs) => fsp.stat(abs).then((st) => st.isFile(), () => false),
    recent: () => service.recentWorkspaces(),
    root: () => service.workspace?.root ?? null,
  });
  if (isTest) (globalThis as any).__secEditVouch = (abs: string) => gate.vouch(abs); // E2E stands in for the folder dialog

  // Integrated terminal: node-pty loads on the first spawn only (nothing at launch).
  const terminals = new TerminalService({
    loadPty: () => loadNodePty({ packaged: app.isPackaged, resourcesPath: process.resourcesPath }),
    getWorkspaceRoot: () => service.workspace?.root ?? null,
    appVersion: app.getVersion(),
    // "Follow Claude's edits": per-terminal inbox folders in app data (terminal-follow.ts); paths are checked against the open folder.
    follow: {
      dir: path.join(app.getPath('userData'), 'claude-follow'),
      foldCase: () => !!service.workspace?.foldsCase,
      inside: (rel) => (service.workspace ? service.workspace.real(rel).then(() => true, () => false) : Promise.resolve(false)),
      // Exact + / − for Claude's change list at the end of a turn: git's own numstat, only through the backend
      // (its trust gate and safety switches) — null for a folder that is not trusted or not a repository.
      numstat: () => service.git('numstat').catch(() => null),
    },
  });
  // Process explorer rows (read only while it is open): Chromium processes + which children are shells.
  registerProcessSource(electronProcessSource({ shellPids: () => terminals.pids(), uiPid: () => (win && !win.isDestroyed() ? win.webContents.getOSProcessId() : 0) }));

  // "Start web server": browser mode for the open folder in a child process (only on request, never at launch).
  const webServerCli = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'cli.mjs') : path.join(__dirname, '../server/cli.mjs');
  const webServer = new WebServerService({
    getRoot: () => service.workspace?.root ?? null,
    spawn: (args) => spawnCli(process.execPath, webServerCli, args, childEnv(process.env, app.getPath('userData'))),
    lanAddresses: () => lanAddresses(os.networkInterfaces()),
    openExternal: (url) => shell.openExternal(url),
    onChange: (s) => win && !win.isDestroyed() && win.webContents.send(WEB_SERVER_CHANNELS.changed, s), // also fires while quitting
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
  const updateFile = path.join(app.getPath('userData'), 'update-check.json');
  const updates = new UpdateCheckService({
    isEnabled: async () => (await service.getSettings())['updates.check'] === true,
    electronVersion: process.versions.electron,
    shipped: () => readJson<unknown>(path.join(__dirname, 'shipped-deps.json'), null),
    endpoints: updateStub ? { eol: updateStub, osv: updateStub } : UPDATE_ENDPOINTS,
    allow: updateUrlAllowed,
    fetch: updateFetch,
    readState: () => readJson<unknown>(updateFile, null),
    writeState: (s) => writeJson(updateFile, s),
    onChange: (s) => win && !win.isDestroyed() && win.webContents.send(UPDATE_CHECK_CHANNELS.changed, s),
  });

  // Settings → MCP server: main owns mcp.json; nothing runs here (MCP clients start dist/mcp/cli.mjs
  // themselves). Turning it on, sharing a folder and allowing writes are native dialogs the page cannot answer.
  const mcpCli = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'mcp', 'cli.mjs') : path.join(__dirname, '../mcp/cli.mjs');
  // Tests: SEC_EDIT_TEST_MCP_CONFIRM = allow | deny (default deny; each box is logged as [sec-edit:mcp-confirm]),
  // SEC_EDIT_TEST_MCP_FOLDER = the folders the dialog "picks" (path.delimiter-separated) or cancel (SEC_EDIT_TEST only).
  const mcpConfirm = async (o: Electron.MessageBoxOptions) => {
    if (isTest) {
      console.log(`[sec-edit:mcp-confirm] ${JSON.stringify({ title: o.title, message: o.message, detail: o.detail, buttons: o.buttons })}`);
      return process.env.SEC_EDIT_TEST_MCP_CONFIRM === 'allow';
    }
    if (!win || win.isDestroyed()) return false;
    return (await dialog.showMessageBox(win, { type: 'question', defaultId: 1, cancelId: 1, noLink: true, ...o })).response === 0;
  };
  const mcp = new McpService({
    configDir: app.getPath('userData'),
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
      const r = await dialog.showOpenDialog(win!, { title: 'Share folders with MCP clients', message: 'Pick one or more folders to share read-only', properties: ['openDirectory', 'multiSelections'] });
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
      if (!win || win.isDestroyed()) return null;
      const r = await dialog.showMessageBox(win, { noLink: true, ...box });
      return folderChoice(box, r);
    },
    realpath: (abs) => fsp.realpath(abs),
    isDirectory: (abs) => fsp.stat(abs).then((st) => st.isDirectory(), () => false),
    randomId: () => crypto.randomBytes(8).toString('hex'),
    onChange: (s) => win && !win.isDestroyed() && win.webContents.send(MCP_CHANNELS.changed, s),
    settings: () => service.getSettings(),
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

  const rendererDir = path.resolve(process.env.SEC_EDIT_RENDERER_DIR || path.join(__dirname, '../renderer'));
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');

  // ---- work that does not need Chromium: start immediately ----
  const settingsP = service.getSettings();
  const windowStateP = readJson<WindowState | null>(stateFile, null);
  const initialPaths = pathsFromArgv(process.argv);
  if (process.env.SEC_EDIT_OPEN) initialPaths.push(path.resolve(process.env.SEC_EDIT_OPEN));
  initialPaths.forEach((p) => gate.vouch(p));
  const initialOpen = (async () => {
    try {
      if (initialPaths.length) await openPathsAtLaunch(initialPaths);
      else {
        const recent = await service.recentWorkspaces();
        if (recent[0]) await service.openWorkspace(recent[0]).catch(() => {});
      }
    } catch (err) {
      console.error('[sec-edit] initial open failed', err);
    }
    mark('workspaceOpen');
  })();

  async function openPathsAtLaunch(paths: string[]) {
    for (const p of paths) {
      const st = await fsp.stat(p).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) {
        await service.openWorkspace(p);
        continue;
      }
      // A file never changes an open folder (it becomes a tab; one outside the folder is the renderer's call).
      // With no folder open: the most recent folder that contains it, else its own folder.
      const folder = folderForOpenedFile({ current: service.workspace?.root ?? null, file: p, recents: await service.recentWorkspaces(), isInside, exists: (r) => fs.existsSync(r), dirname: (x) => path.dirname(x) });
      if (folder) await service.openWorkspace(folder);
      service.openRequests.push(p);
    }
  }

  for (const method of RPC_METHODS) {
    ipcMain.handle(`rpc:${method}`, async (e, ...args: unknown[]) => {
      if (!trustedSender(e)) return { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
      await initialOpen; // the renderer's first getWorkspace/bootstrap must see the launch folder
      try {
        // The page asks, main decides: a folder it has not seen itself is not opened (open-gate.ts).
        if (method === 'openWorkspace' && !(await gate.allows(args[0]))) throw new BackendFailure('EACCES', 'This folder was not chosen in the app: use “Open folder”, drop it on the window, or pick a recent one');
        // An outside file is opened only if main saw that very file itself (dialog, OS open, argv, drop).
        if (method === 'openExternalFile' && !(await gate.vouchedFile(args[0]))) throw new BackendFailure('EACCES', 'This file was not chosen in the app: use “Open file”, drop it on the window or open it from the OS');
        const result = (await (service as any)[method](...args)) ?? null;
        // Shells started in the previous folder go with it.
        if (method === 'openWorkspace') terminals.setWorkspace(service.workspace?.root ?? null);
        if (method === 'openWorkspace') webServer.workspaceChanged();
        return { ok: true, result };
      } catch (err: any) {
        const code = err instanceof BackendFailure ? err.code : err?.code || 'EIO';
        return { ok: false, error: { code, message: String(err?.message || err) } };
      }
    });
  }
  registerTerminalIpc(ipcMain, terminals, { isTrusted: (e) => trustedSender(e as Electron.IpcMainEvent) });
  // Secrets of {{variables}}: safeStorage ciphertext in user data (read on first use, never at launch).
  // Without an OS keyring (Linux) safeStorage refuses and the renderer keeps secrets for the session only;
  // tests (no keyring under Xvfb) opt into the basic_text backend so the real code path still runs.
  if (isTest && process.platform === 'linux') safeStorage.setUsePlainTextEncryption(true);
  const vault = new VaultService(path.join(app.getPath('userData'), 'vault.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
    backend: () => (process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os'),
  }, {
    root: () => service.workspace?.root ?? null, // folder-scoped keys: the open folder's only
    // A shared `vault:<key>` another folder saved: the user decides, in a native dialog the page cannot answer.
    confirmSharedKey: async (q) => {
      // Tests: SEC_EDIT_TEST_VAULT_CONFIRM = allow | deny (default deny: a native dialog would hang the run).
      if (isTest) return process.env.SEC_EDIT_TEST_VAULT_CONFIRM === 'allow';
      if (!win || win.isDestroyed()) return false;
      const m = sharedKeyMessage(q);
      const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Allow', 'Don’t allow'], defaultId: 1, cancelId: 1, noLink: true, title: 'Use a saved secret?', message: m.message, detail: m.detail });
      return r.response === 0;
    },
  });
  registerVaultIpc(ipcMain, vault, { isTrusted: (e) => trustedSender(e as Electron.IpcMainInvokeEvent) });
  registerGpuIpc(ipcMain, { isTrusted: (e) => trustedSender(e as Electron.IpcMainInvokeEvent) });
  registerWebServerIpc(ipcMain, webServer, { isTrusted: (e) => trustedSender(e as Electron.IpcMainInvokeEvent) });
  registerUpdateCheckIpc(ipcMain, updates, { isTrusted: (e) => trustedSender(e as Electron.IpcMainInvokeEvent) });
  registerMcpIpc(ipcMain, mcp, { isTrusted: (e) => trustedSender(e as Electron.IpcMainInvokeEvent) });
  // "MCP active" (status bar): running stdio servers' live files. Off the startup path: a few seconds later;
  // the first scan also removes files that crashed servers left behind.
  setTimeout(() => mcp.watchSessions(), 3000).unref();
  // A file / folder dropped on the window: the preload read its path from the File object (page script
  // cannot fabricate one) and reports it here, so the open that follows passes the gate.
  ipcMain.on('app:vouchPath', (e, abs: unknown) => void (trustedSender(e) && gate.vouch(abs)));
  ipcMain.handle('app:toggleDevTools', (e) => trustedSender(e) && win?.webContents.toggleDevTools());
  // Settings → Window frame → "Restart now": through the normal close flow (never loses edits).
  ipcMain.handle('app:relaunch', (e) => {
    if (!trustedSender(e) || !win || win.isDestroyed()) return false;
    relaunch.request();
    return true;
  });
  // Integrated frame: the renderer reports the tab strip's real colours/height (theme, accent, density, zoom).
  ipcMain.on('app:zenFullScreen', (e, on: unknown) => void (trustedSender(e) && win && zenFs.set(win, on === true)));
  ipcMain.on('app:titleBarOverlay', (e, raw: unknown) => {
    const o = parseOverlay(raw);
    if (!o || !trustedSender(e) || frame !== 'integrated' || process.platform === 'darwin' || !win || win.isDestroyed()) return;
    win.setTitleBarOverlay(o);
    // Keyed by the colour's own brightness: main's theme may lag the renderer's by one settings round-trip.
    titleBar = rememberOverlay(titleBar, o, isDarkColor(o.color));
    if (isTest) (globalThis as any).__secEditTitleBar = o;
    queueStateSave();
  });
  ipcMain.on('app:ready', (_e, r: { timeOrigin: number; marks: Record<string, number> }) => {
    mark('rendererReady');
    // Renderer clock → ms since main process start.
    for (const [k, v] of Object.entries(r.marks || {})) timings[`r.${k}`] = Math.round(r.timeOrigin + v - performance.timeOrigin);
    if (logTimings) console.log(`[sec-edit:timings] ${JSON.stringify(timings)}`);
  });

  service.onFsEvents((events) => win?.webContents.send('fs:events', events));
  service.onGitChanged((e) => win?.webContents.send('git:changed', e));
  service.onSettingsChanged((s, patch) => {
    if ('theme' in patch || 'sidebarStyle' in patch) applyTheme(s);
  });
  // A browser-mode server (or another process) changed settings.json: the window applies it live.
  service.onExternalSettings((patch) => win && !win.isDestroyed() && win.webContents.send('settings:changed', patch));

  function applyTheme(s: Settings) {
    // Drives prefers-color-scheme in the page *and* native chrome (Windows title bar, menus, scrollbars).
    nativeTheme.themeSource = s.theme === 'light' || s.theme === 'dark' ? s.theme : 'system';
    win?.setBackgroundColor(windowBg(s));
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

  async function createWindow() {
    const [settings, savedState] = await Promise.all([settingsP, windowStateP]);
    applyTheme(settings);
    const st = visibleBounds(savedState);
    frame = frameOf(settings);
    titleBar = savedState?.titleBar;
    const frameOpts = frameWindowOptions(frame, process.platform, initialOverlay(settings, nativeTheme.shouldUseDarkColors, titleBar));
    if (isTest) Object.assign(globalThis as any, { __secEditWindowOptions: { frame, ...frameOpts }, __secEditTitleBar: frameOpts.titleBarOverlay ?? null });
    mark('createWindow');
    win = new BrowserWindow({
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
        additionalArguments: [`--sec-edit-frame=${frame}`, `--sec-edit-index-token=${indexToken}`], // read by the preload (bridge.frame / bridge.indexToken)
      },
    });
    const w = win;
    zenFs.attach(w);
    w.once('ready-to-show', () => {
      mark('readyToShow');
      if (st.maximized) w.maximize();
      w.show();
      mark('shown');
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

    // Persist window geometry (debounced) and on close.
    let saveTimer: NodeJS.Timeout | null = null;
    const saveState = () => {
      if (w.isDestroyed() || w.isMinimized()) return;
      const maximized = zenFs.maximized(w);
      const normal = w.getNormalBounds(); // pre-maximize geometry, so un-maximizing next launch looks right
      void writeJson(stateFile, { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized, titleBar } satisfies WindowState).catch(() => {});
    };
    const queueSave = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(saveState, 400);
    };
    queueStateSave = queueSave;
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
      service.workspace?.setWatchPaused(on);
    };
    w.on('minimize', () => background(true));
    w.on('hide', () => background(true));
    w.on('restore', () => background(false));
    w.on('show', () => background(false));

    // Give the renderer a chance to flush autosaves / ask about unsaved changes before closing.
    // The 4 s fallback only covers a renderer that never picks the request up (crashed, still booting).
    // Once the preload acknowledges it, the user may take as long as they like on "Save changes?" —
    // closing anyway after 4 s threw their unsaved edits away. A renderer that hangs after acknowledging
    // is caught by 'unresponsive'.
    let closeApproved = false;
    let closing: 'idle' | 'requested' | 'acked' = 'idle';
    const forceClose = () => {
      if (w.isDestroyed() || closeApproved) return;
      closeApproved = true;
      w.close();
    };
    w.on('close', (e) => {
      saveState();
      if (closeApproved || w.webContents.isCrashed()) return;
      e.preventDefault();
      if (closing === 'acked') {
        // Clicked close again while being asked: ask again (a handler that failed gets another chance).
        w.webContents.send('app:closeRequest');
        return;
      }
      closing = 'requested';
      w.webContents.send('app:closeRequest');
      setTimeout(() => closing === 'requested' && forceClose(), 4000);
    });
    w.on('unresponsive', () => closing !== 'idle' && forceClose());
    ipcMain.removeAllListeners('app:closeAck');
    ipcMain.on('app:closeAck', (e) => {
      if (trustedSender(e) && closing === 'requested') closing = 'acked';
    });
    ipcMain.removeAllListeners('app:closeApproved');
    ipcMain.on('app:closeApproved', (e, ok: boolean) => {
      if (w.isDestroyed() || !trustedSender(e)) return;
      if (!ok) {
        closing = 'idle'; // user chose Cancel: the next close asks again
        relaunch.cancelled(); // …and a "Restart now" that led here is off too
        return;
      }
      closeApproved = true;
      w.close();
    });

    if (DEV_URL) await w.loadURL(DEV_URL);
    else await w.loadURL(`${APP_ORIGIN}/index.html`);
    mark('loaded');
  }

  function serveRenderer() {
    protocol.handle(SCHEME, async (req) => {
      const route = routeAppUrl(req.url, rendererDir, path);
      if (route.kind === 'error') return new Response(route.message, { status: route.status });
      // Text pages for the search workers: produced by the indexer thread as JSON bytes, only forwarded here.
      if (route.kind === 'index') {
        if (req.headers.get('x-sec-edit-index') !== indexToken) return new Response('forbidden', { status: 403 });
        try {
          const body = route.op === 'page' ? await service.indexPageRaw(route.params.get('cursor'), Number(route.params.get('maxBytes')) || undefined) : await service.indexFilesRaw(await req.json());
          return new Response(body as Uint8Array<ArrayBuffer>, { headers: { 'content-type': route.op === 'page' ? 'application/octet-stream' : 'application/json', 'cache-control': 'no-store' } });
        } catch (err) {
          return new Response(String((err as Error)?.message ?? err), { status: err instanceof BackendFailure && err.code === 'NO_WORKSPACE' ? 409 : 500 });
        }
      }
      // Workspace files for the preview (images, PDFs…): app://sec-edit/__ws/<rel>
      if (route.kind === 'workspace') {
        try {
          const ws = service.workspace;
          if (!ws) return new Response('no folder', { status: 404 });
          const abs = await ws.real(route.rel); // also through links: a link out of the folder is not served
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

  app.on('second-instance', (_e, argv, workingDirectory) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    const paths = pathsFromArgv(argv, workingDirectory);
    paths.forEach((p) => gate.vouch(p));
    if (paths.length) win?.webContents.send('app:openRequest', paths);
  });

  // macOS never puts "Open With", a drop on the Dock icon or `open -a One <path>` in argv: it sends 'open-file' (also to a
  // running app, and on a cold start possibly before the window exists). A file of the folder already open just opens;
  // before the renderer has booted the path joins the launch queue (bootstrap() hands it over), like an argv path.
  app.on('open-file', (e, p) => {
    e.preventDefault();
    gate.vouch(p);
    void (async () => {
      if (!service.booted) await initialOpen;
      if (service.booted) {
        if (win?.isMinimized()) win.restore();
        win?.show();
        win?.focus();
        win?.webContents.send('app:openRequest', [p]);
      } else await openPathsAtLaunch([p]);
    })().catch((err) => console.error('[sec-edit] open-file failed', err));
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
    await createWindow();
  });

  // No orphan shells: also on relaunch, which ends with app.exit() (no before-quit).
  app.on('before-quit', () => {
    terminals.dispose();
    webServer.dispose();
  });
  app.on('window-all-closed', () => {
    terminals.dispose();
    webServer.dispose(); // the child also exits by itself once this process is gone (IPC disconnect)
    service.dispose();
    if (!relaunch.allClosed()) app.quit();
  });
}
