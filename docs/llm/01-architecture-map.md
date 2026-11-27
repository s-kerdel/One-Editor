# 01 - Architecture map

> **WHEN TO READ THIS:** you do not know which process, folder or file owns a piece of behaviour.
> **WHAT YOU GET:** the process diagram, the folder map, the data flow of one call, and where state lives.
> **NEXT FILE:** `02-find-existing-logic.md`

## The one-sentence model

**One renderer** (UI) talks to **one `BackendService`** through a transport. The transport is **Electron IPC** (desktop) or **HTTP + SSE** (browser mode). The MCP server is a **separate program**.

**Desktop: one renderer per window.** One main process, many windows; each window has its own `BackendService` for its own folder, reached from main only through `WindowBackend` (see [Windows (desktop)](#windows-desktop)).

## Process diagram

```
+--------------------------- RENDERER (src/renderer) ---------------------------+
|  app/      shell: Layout, FileTree, Tabs, StatusBar, Settings, commands        |
|  editor/   CodeMirror 6 (lazy chunk)      preview/  markdown-it + DOMPurify    |
|  search/ knowledge/ git/ terminal/ overview/ nav/ bookmarks/ variables/ pdf/   |
|  workers:  src/search/worker.ts   src/format/worker.ts                         |
|                                                                                |
|  app.backend.<method>(...)   <- built by src/renderer/platform/index.ts        |
+----------------+--------------------------------------------+------------------+
                 | desktop                                    | browser mode
                 | window.secEditBridge.invoke('rpc:<m>')     | POST /api/rpc/<m>
                 | (src/main/preload.ts)                      | (src/renderer/platform/web.ts)
                 v                                            v
+----------------------------------+        +-----------------------------------+
| ELECTRON MAIN  (src/main)        |        | HTTP SERVER  (src/server)         |
| main.ts: ipcMain.handle rpc:*    |        | server.ts: /api/rpc/*, /api/file  |
| terminal (node-pty), vault,      |        | /api/events (SSE), token header   |
| mcp settings, web-server child,  |        | no terminal, no PDF export        |
| update check, open-gate          |        | (answers ENOTSUP)                 |
+----------------+-----------------+        +-----------------+-----------------+
                 |                                            |
                 +---------------------+----------------------+
                                       v
                 +-------------------------------------------+
                 | BACKEND  (src/backend)                    |
                 | service.ts   BackendService = every RPC   |
                 | workspace.ts Workspace = files, tree,     |
                 |              watcher, path containment    |
                 | git*.ts      git (trust gate, monitor)    |
                 | indexer*.ts  text index (worker thread)   |
                 +---------------------+---------------------+
                                       v
                                 the open folder

+------------------------------------------------------------------------------+
| MCP SERVER (src/mcp) - dist/mcp/cli.mjs, run by `One --mcp-stdio`, stdio.    |
| Started by AI clients. Has its own Workspace per shared folder. No UI.       |
| Its settings/tokens are owned by main (src/main/mcp.ts, <app data>/mcp.json).|
+------------------------------------------------------------------------------+
```

## Windows (desktop)

```
ELECTRON MAIN (one process, src/main/main.ts)
 |- app level, one each: appState (BackendService without a folder: settings, recent folders),
 |      MCP settings, web server child, vault store, update check,
 |      WindowRegistry + launch routing (planLaunch, src/main/windows.ts)
 '- per window (WindowCtx): BrowserWindow, WindowBackend -> BackendService -> Workspace (its folder),
        OpenGate, ZenFullScreen, VaultScope, close flow, indexToken, wsKey
RENDERER: one Chromium process per window (same code; browser mode stays one window)
```

- **App level** = shared by every window: their status is broadcast to all windows (MCP on/off, web server, update check).
- **Per window** = never shared: folder, gate, vault scope, terminals (owner = `webContents.id`), zen, close flow.
- **The `WindowBackend` seam** (`src/main/window-backend.ts`, today `createInProcessBackend(service)`):
  - main never touches a window's `BackendService` / `Workspace` directly, only `ctx.backend`;
  - everything crossing it is JSON-serialisable or a `Uint8Array`; every call is async; sync members are cached values only (`root`, `foldsCase`, `booted`) plus two fire-and-forget notices (`setWatchPaused`, `queueOpenRequest`);
  - window backends share no in-memory state; shared files in `<app data>` are merged under a file lock;
  - goal: a window's backend can later move into its own `utilityProcess` without touching routing, IPC or the renderer.
- Contracts (routing, IPC, ws key, quit): `09-reference-app.md`, "Multiple windows".

## One RPC call, step by step

```
renderer:  app.backend.readFile('notes/a.md')
   |  platform/index.ts build(): one function per name in RPC_METHODS
   |-- desktop --> preload.ts invoke -> main.ts ipcMain.handle(`rpc:readFile`)
   |-- browser --> web.ts fetch POST /api/rpc/readFile -> server.ts
   v
BackendService.readFile()   (src/backend/service.ts)
   v
Workspace.readFile()        (src/backend/workspace.ts) -> ws.real(rel) -> disk
   v
{ ok: true, result }  or  { ok: false, error: { code, message } }  -> RpcError in the renderer
```

**Key fact:** `main.ts` and `server.ts` both loop over `RPC_METHODS` (`src/shared/api.ts`). Add a name there + a method on `BackendService` and **both modes work**. No edit in `main.ts`, `preload.ts`, `server.ts` or `platform/`.

## Events (backend -> renderer)

| Event | Desktop channel | Browser | Renderer entry |
|---|---|---|---|
| file changes | `fs:events` | SSE `/api/events` | `app.backend.onFsEvents` -> `src/renderer/app/disk-sync.ts` |
| git changed | `git:changed` | SSE `/api/events?git=1` | `src/renderer/git/index.ts` |
| settings changed outside | `settings:changed` | SSE `event: settings` | `src/renderer/app/settings-sync.ts` |
| open request | `app:openRequest` | - | `app.backend.onOpenRequest` |

Desktop channels must be listed in `CHANNELS` in `src/main/preload.ts`.

## Desktop-only channel families (not `RPC_METHODS`)

They need the sender's identity or native dialogs. Each has: channels in `src/shared/`, a bridge in `src/main/*-bridge.ts`, a service in `src/main/`, registered in `main.ts`.

| Family | Shared | Bridge | Service |
|---|---|---|---|
| `term:*` | `src/shared/terminal.ts` | `src/main/terminal-bridge.ts` | `src/main/terminal.ts` |
| `vault:*` | `src/shared/vault.ts` | `src/main/vault-bridge.ts` | `src/main/vault.ts` |
| `webserver:*` | `src/shared/web-server.ts` | `src/main/web-server-bridge.ts` | `src/main/web-server.ts` |
| `updates:*` | `src/shared/update-check.ts` | `src/main/update-check-bridge.ts` | `src/main/update-check.ts` |
| `mcp:*` | `src/shared/mcp.ts` | `src/main/mcp-bridge.ts` | `src/main/mcp.ts` |

**Do not add a new family without asking.**

## Folder map (who owns what)

| Folder | Runs in | What |
|---|---|---|
| `src/shared/` | everywhere | types + pure helpers. **No Node, no DOM.** |
| `src/backend/` | main + server + mcp | files, tree, watcher, git, index, processes |
| `src/main/` | Electron main | windows (`windows.ts` registry + routing, `window-backend.ts` seam), IPC, terminal, vault, mcp settings, update check |
| `src/server/` | Node (browser mode) | `cli.ts` (args), `server.ts` (HTTP), `ports.ts` |
| `src/renderer/` | Chromium | all UI |
| `src/search/` | renderer workers + mcp | search engine, symbols, go to definition (pure) |
| `src/format/` | renderer + worker | Prettier glue, format on save |
| `src/knowledge/` | renderer + worker + mcp | wikilinks, backlinks, tags, graph (pure) |
| `src/mcp/` | windowless `One --mcp-stdio` (no Node mode) | MCP protocol, tools, write guard, journal |
| `scripts/` | dev machine | build, stage, package, release |
| `tests/unit/<area>/` | vitest | unit tests |
| `tests/e2e/` | Playwright | browser-mode E2E (`harness.ts`) |
| `tests/e2e/electron/` | Playwright + Electron | desktop E2E (`fixture.ts`) |

Owner per folder: see the table in `09-reference-ownership.md` ("Layout and ownership").

## Where state lives

| State | Lives in | Access |
|---|---|---|
| Open folder, tree, tabs, active file, settings | signals on `app` (`src/renderer/app/app.ts`) | `app.workspace.value`, `app.tree.value`, `app.tabs.value`, `app.activePath.value`, `app.settings.value` |
| Open documents | `app.docs` (Map of `DocState`) | `app.docs.get(path)` |
| UI layout (sidebar width, overview, zen, tree selection, dialogs) | signals in `src/renderer/app/ui.ts` | `ui.overviewVisible.value`, `ui.zen.value`, ... |
| Settings on disk | `<app data>/settings.json` | `app.backend.saveSettings(patch)` via `updateSettings()` |
| Session (open tabs, layout) | `<app data>/sessions/<id>.json` (`@web` for browser mode) | `app.backend.saveSession()` |
| Bookmarks | `<app data>/bookmarks/<folder id>.json` | `app.backend.bookmarks(op?)` |
| Git trust | `<app data>/git-trust.json` | `git('trust')` |
| Recent folders, last PDF folder per folder | `<app data>/recent.json`, `export-dirs.json` (read-merge-write under `withFileLock`: several windows write them) | `recentWorkspaces()`; `exportPdf` |
| Open windows (desktop) | `WindowRegistry` in main (`src/main/windows.ts`) | `registry.all()`, `byRoot()`, `lastFocused()` |
| Window geometry | `<app data>/window-state.json` (main only; the window saved last) | `showWindow` in `src/main/main.ts` |
| MCP grants + tokens | `<app data>/mcp.json` (main only) | `mcp:*` channels |
| Secrets | `<app data>/vault.json` (main only, encrypted) | `vault:*` channels |
| Per-folder UI bits | renderer `localStorage` (`sec-edit-*` keys) | per origin, never shared across modes |

`<app data>` = `~/.config/sec-edit` (Linux), `%APPDATA%\sec-edit` (Windows), `~/Library/Application Support/sec-edit` (macOS). See `defaultConfigDir()` in `src/backend/appdata.ts`.

**Nothing but the user's notes (and pasted attachments) is written into the open folder.**

## Startup order (renderer)

`src/renderer/main.tsx` `boot()`:

1. `connectBackend()` -> `app.backend`
2. `app.backend.bootstrap()` -> settings, workspace, session (one round trip)
3. `installDocuments()`, `installGlobalKeymap()`, `installShell()`
4. feature stubs: `installSearch()`, `installKnowledge()`, `installFormatLazy()`, `installPreview()`, `installOverview()`, `installTerminal()`, `installGitLazy()`, `installNav()`
5. `render(<Layout />)`, then tree + session restore
6. `html[data-ready="true"]` is set (tests wait for it)

Each `installX()` is a **tiny stub**. The real code loads later with `import()`.

## Build outputs

| Source | Tool | Output |
|---|---|---|
| `src/renderer/` | Vite (`vite.config.ts`) | `dist/renderer/` |
| `src/main/main.ts`, `preload.ts` | esbuild (`scripts/build-node.mjs`) | `dist/main/main.cjs`, `dist/main/preload.cjs` |
| `src/server/cli.ts` | esbuild | `dist/server/cli.mjs` |
| `src/mcp/cli.ts` | esbuild | `dist/mcp/cli.mjs` |
