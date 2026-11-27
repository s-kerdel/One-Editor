# 04 - Rules and pitfalls (DO / DON'T)

> **WHEN TO READ THIS:** before editing anything about paths, files, security, keys, startup code, or platform behaviour.
> **WHAT YOU GET:** short imperatives distilled from the code and the full reference (`09-reference.md`), plus the **load-bearing list** (do not touch).
> **NEXT FILE:** `05-testing-and-verify.md`

The full reasoning is in `09-reference-rules.md` and `09-reference-security.md`.
Find a rule there with: `grep -n "keyword" docs/llm/09-reference*.md`.

## 1. Reuse and honesty

| DO | DON'T |
|---|---|
| Grep for an existing helper first (`02-find-existing-logic.md`). | Write a second helper that does the same thing. |
| Copy the nearest example in the same area folder. | Invent a new pattern, abstraction or config key. |
| `grep -rn "name" src/` before using a name. | Use a function, flag or file you have not seen in grep output. |
| Say "no precedent found" and stop. | Guess. |
| Report what you could not verify. | Claim a desktop-only change works when you only ran browser tests. |

## 2. Paths and files (security)

**Threat model:** the user opens a folder made by someone else. Nothing may reach outside that folder.

| DO | DON'T |
|---|---|
| Pass workspace-relative POSIX paths across the backend (`notes/a.md`). | Pass absolute paths from the page. Build paths with `\`. |
| `await ws.real(rel)` before any disk access for one path. | Use `ws.abs(rel)` + `fs` directly (it does not check symlinks). |
| Use `'entry'` as the leaf for delete / rename / reveal. | Follow a link out of the folder. |
| Send paths that come from **file contents** through `safeRel` / `safeJoin`. | Trust an import path, a link target or a hook payload. |
| Skip `isExtPath(id)` ids when you walk `app.tabs` / `app.docs`. | Assume every tab is a workspace-relative path. |
| Store app data under `this.configDir` (`BackendService`). | Write settings, caches or state into the open folder. |
| Read `WorkspaceInfo.caseSensitive` / `Workspace.foldsCase`. | Fold case because of `process.platform` or `backend.os`. |
| Open a folder only through main's `OpenGate` (`src/main/open-gate.ts`). | Open a folder from a path string the page sent. |
| Validate every RPC argument in `BackendService`. | Trust the type annotation: args are `unknown` at runtime. |

## 3. Renderer safety

- **DO** render note HTML only through `renderMarkdown` + the sanitizer (`src/renderer/preview/sanitize.ts`).
- **DON'T** set `innerHTML` with text from a file. Use `textContent`.
- **DON'T** use `eval`, `new Function`, remote scripts, or relax the CSP in `src/renderer/index.html`.
- **DON'T** turn off `contextIsolation` / `sandbox` in `src/main/main.ts`.
- **DO** read Copy / Run text from the **source** (`fenceAt`), never from DOM text.
- **DON'T** add a token to a URL or a cookie. Browser mode uses the `x-sec-edit-token` header only.

## 4. Processes, network, secrets

- **DON'T** start git yourself. All git goes through `BackendService.git` (trust gate). In the renderer: `git(op, ...)`.
- **DON'T** add renderer-side git polling. Use `git('nudge')`.
- **DON'T** add an outbound network request, host or header. Ask first.
- **DON'T** read `vault.json`, tokens or `mcp.json` from new code. Only `src/main/vault.ts` / `src/main/mcp.ts` do.
- **DON'T** log secrets, tokens, file contents or user prompts.
- **DO** run Windows system programs by absolute path (`winSystemExe`). Quote cmd.exe paths with `cmdQuote`.
- **DO** give a new worker / child process a Process-explorer row (`registerProcessSource`).
- **DON'T** expose a shell to browser mode. Terminal names answer `ENOTSUP` there by design.

## 5. Electron vs browser parity

| DO | DON'T |
|---|---|
| Add request/response calls via `RPC_METHODS` + `BackendService` (works in both). | Add `ipcMain.handle` for something the browser also needs. |
| Feature-detect optional desktop members: `app.backend.setZoom?.()`, `app.runInTerminal?.()`. | Assume `window.secEditBridge` exists. |
| Mark desktop-only settings `desktopOnly: true`. | Show a control that does nothing in the browser. |
| Put browser-only code in `src/renderer/platform/web.ts`. | Import `platform/web.ts` statically anywhere. |
| Test shared UI with the browser harness (fast). | Use the Electron suite for something the browser can show. |

## 6. Startup speed (it is a feature)

- **DO** load heavy code with `import()` on first use (Shiki, Prettier, KaTeX, Mermaid, your panel).
- **DO** keep `installX()` stubs tiny: a command, a key, a lazy component.
- **DON'T** add a static import of a big module to `src/renderer/main.tsx`, `app/Layout.tsx`, `app/shell.ts`, `app/Shelf.tsx`, `app/Tabs.tsx`.
- **DON'T** statically import `app/Shelf.tsx` or `app/zen.tsx` from a lazy chunk.
- **DON'T** call `import('./Popups')` from startup code. Use `popups()` (`src/renderer/app/fileops.ts`).
- **DO** put CPU work in a worker.
- **DO** show "Indexing... x / y" (`searchClient.progress`) instead of an empty state; call `searchClient.start()` when you need the index.

## 7. Keys

- **DO** check the allocation table in `09-reference-keys.md` before binding a key. Add your key to it.
- **DO** put editor-only keys in a CodeMirror keymap and show them with `displayKeys`.
- **DON'T** bind a global key the editor or the shell already uses (`Mod-b`, `Mod-f`, `Ctrl-r`, ...).
- **DON'T** bind `F12` to DevTools: it is Go to definition.
- **DON'T** add a macOS menu accelerator without Cmd (`src/main/app-menu.ts`).
- Terminal focused: only `APP_KEYS_IN_TERMINAL` reach the app. Add a key there only if it must beat the shell.

## 8. Styling

- **DO** use CSS variables (`--bg`, `--text`, `--accent`). **DON'T** hard-code colours or the accent blue.
- **DO** use `--radius-*`. **DON'T** write a literal `border-radius`.
- **DO** prefix classes `se-` and keep CSS in your area folder.
- **DO** add `se-no-drag` to clickable things in the tab strip / shelf head (integrated window frame).
- **DON'T** create two source files that differ only by case (`settings.ts` + `Settings.tsx`). It breaks macOS and Windows.

## 9. Platform quirks

| Platform | Remember |
|---|---|
| **Windows** (primary target) | CRLF files (content is LF in memory, EOL restored on save). Case-insensitive FS. Drive letters. `\\wsl.localhost` roots are case-sensitive. |
| **macOS** | Cmd + backtick is the OS's (the terminal also answers to Ctrl + backtick). Ctrl chords in the terminal belong to the shell. No Reload accelerator in the menu. The app keeps running with no window (Dock). |
| **WSL (this dev machine)** | No sudo. No Windows executables via interop. Never touch `/mnt/c`. Electron tests need Xvfb (`~/.local/xvfb/start-xvfb.sh :99`). |
| **Browser mode** | State is per origin (per port). No terminal, no PDF export, no vault on disk. |

## 10. Dependencies and tooling

- **DON'T** `npm install` anything without asking. If approved, use exactly `flock .tmp/sec-edit-npm.lock npm install <pkg>` (`09-reference-rules.md` rule 4; the lock lives in `.tmp/`, never `/tmp`).
- **DON'T** add a framework (React, Vue, Tailwind).
- **DON'T** edit `package.json` scripts by hand.
- **DON'T** modify existing files under `tests/fixtures/workspace/`. Add new fixture files only if needed.
- **DON'T** edit a test you did not write to make it pass.

## 11. Machine and repo

- **DON'T** run the full test suite, loops, benchmarks or CPU burners. This is the user's own PC.
- **DON'T** leave processes running. Kill what you started.
- **DON'T** write outside the project. Temp = `.tmp/<area>/`. Ad-hoc scripts: `TMPDIR=$PWD/.tmp/tmp`.
- **DON'T** commit, tag, push or rewrite history. No co-author trailers anywhere.
- **DON'T** drop unversioned builds into `release/`.

## 12. MCP server (`src/mcp/`)

- **DO** resolve every path with `folder.resolve()` / `folder.resolveTarget()`.
- **DO** answer in plain text via `src/mcp/tools/format.ts`. Keep descriptions short (`tests/unit/mcp/budget.test.ts`).
- **DON'T** write to stdout (it is the protocol channel).
- **DON'T** import `src/main/vault*`, run git, open the network, or run a regex from a query.
- **DON'T** put MCP grants in `settings.json`. Main owns `mcp.json`.

## Load-bearing - do not touch

**These look removable. They are not.** Each one is backed by a comment in the named file. Changing one = **STOP AND ASK**.
Decisions and their reasons: `10-decisions.md`. Check a row first: `grep -n "symbol" <file>`.

**Timeouts, sleeps, debounces**

| File: symbol | What it does | Removing / changing it breaks |
|---|---|---|
| `src/backend/git.ts`: `T_DISCOVER` | 15 s for the first look at git. | A slow cold start (security scan) shows "Git didn't answer in time". |
| `src/backend/git-wsl.ts`: `timeoutMs` 0 | Index refresh is never killed. | A killed git leaves `index.lock` behind. |
| `src/backend/git-monitor.ts`: `refreshOff` | After a refresh timeout: git is left alone, that repo is not refreshed again. | Kills or endless retries of a slow refresh. |
| `src/backend/filelock.ts`: `STALE_MS`, `WAIT_MS` | Stale lock is dropped after 5 s; a waiter goes ahead unlocked after 3 s. | A crashed writer blocks settings saves, or a change is lost. |
| `src/backend/workspace.ts`: `schedule` | Debounces file-event bursts, but never delays a batch more than ~500 ms. | Event storms on git checkout, or a tree that never updates. |
| `src/server/cli.ts`: `stop` | Exits after 3 s even when close hangs. | A hung close keeps the port. |
| `src/main/pdf-window.ts`: `LOAD_TIMEOUT_MS` | Prints what has arrived after the timeout. | A slow remote image blocks the PDF export. |
| `src/mcp/stdio.ts`: `DRAIN_MS` | Answers in progress get 15 s after stdin ends. | Lost answers, or a process that never exits. |
| `src/renderer/terminal/keys.ts`: `REMAP_GAP_MS` | Detects a remapper's Ctrl -> Cmd swap by key timing. | Ctrl+C / Ctrl+R stop reaching the shell on remapped Macs. |
| `src/shared/nav.ts`: `NAV_ECHO_MS` | Drops the echo of one back/forward press on the other channel. | One press navigates twice. |
| `src/renderer/search/client.ts`: `feedPageBytes` | 1 MB index pages in browser mode, 4 MB on desktop. | 4 MB pages delay every small RPC answer in browser mode. |

**Ordering**

| File: symbol | What it does | Removing / changing it breaks |
|---|---|---|
| `src/main/main.ts`: `import './env-boot'` | Must be the **first** import. | Other modules read `SEC_EDIT_*` test hooks in a packaged build. |
| `src/mcp/cli.ts`: `stdout-guard` | Must be the **first** import. | A stray log line on stdout: the MCP client drops the connection. |
| `src/main/main.ts`, `src/server/cli.ts`: `UV_THREADPOOL_SIZE` | Set before any async I/O, only for slow roots. | Set later = ignored. Set always = slower local launch. |
| `src/backend/service.ts`: `gitTrusted` | Checked before any `GitService` exists. | An untrusted folder spawns git. |
| `src/backend/service.ts`: `saveSettings` | Merges the patch **after** the await. | Concurrent saves drop each other's patch. |
| `src/backend/service.ts`: `writeBinary` | Size check before base64 decoding. | An oversized payload allocates its buffer first. |
| `src/main/terminal.ts`: `getWorkspaceRoot` | Root (of the terminal's window, `owner`) is compared again after the await. | A shell starts in the previous folder. |
| `src/backend/workspace.ts`: `sameEntry`, `parentStillHere` | Re-checks the entry right before trashing it. | A racer's replacement file gets trashed. |

**Security and path checks**

| File: symbol | What it does | Removing / changing it breaks |
|---|---|---|
| `src/backend/workspace.ts`: `real` | Symlink-safe containment for every disk access. | A link leads out of the open folder. |
| `src/backend/workspace.ts`: `isFile` check in the read path | Refuses FIFOs, sockets, devices. | A read blocks a libuv thread forever and stalls indexing. |
| `src/backend/service.ts`: `deny` | Never serves One's own data, even inside the open folder. | Settings, tokens, vault leak when the home folder is opened. |
| `src/backend/trash.ts`: `WIN_TRASH_SCRIPT` | Refuses a reparse point (junction / symlink) at delete time. | A swapped-in junction is followed. |
| `src/backend/winsys.ts`: `winSystemExe` | Absolute paths for Windows system programs. | A program planted in the open folder runs. |
| `src/main/protocol.ts`: `decodeURIComponent` in try/catch | A malformed %-escape answers 400. | An unhandled throw in main. |

**Workarounds**

| File: symbol | What it does | Removing / changing it breaks |
|---|---|---|
| `src/main/terminal-opencode.ts`: `child.stdout` / stderr handlers | Keep both pipes drained; never logged. | A full pipe blocks the Opencode server; logging leaks paths and the password. |
| `src/main/app-menu.ts`: `appMenuTemplate` | Own macOS menu without reload accelerators. | Ctrl+R reloads the window and kills every terminal's shell. |
| `src/backend/indexcache.ts`: `readFileSync` in `load` | Sync read on the indexer's own thread. | Async fs queues with the user's file opens in the shared libuv pool. |
| `vite.config.ts`: `codeSplitting` group `core` | Only `app` + `ui`. | A larger group made the warm launch ~12 ms slower. |
| `src/main/main.ts`: `confirmSharedKey` | Tests default to deny. | A native dialog hangs the test run. |

**Multiple windows (desktop main)** - contracts: `09-reference-app.md`, "Multiple windows"

| File: symbol | What it does | Removing / changing it breaks |
|---|---|---|
| `src/main/window-backend.ts`: `WindowBackend` | **The seam:** main reaches a window's folder only through it (JSON / `Uint8Array`, async, no shared in-memory state). Never touch a window's `BackendService` / `Workspace` from `main.ts`. | A window's backend can no longer move into its own `utilityProcess` without rewriting routing and IPC. |
| `src/main/window-backend.ts`: `run` | Disposes the service again when a call was still running as the window closed. | A closed window leaves a folder watch or git monitor running. |
| `src/main/main.ts`: `trustedCtx` | Every `ipcMain` handler finds its window by `e.sender.id`; not registered = refused. | A call acts on another window's folder, gate or vault scope. |
| `src/main/main.ts`: `prepareWindow` (`gate`, `vault`) | One `OpenGate` and one `VaultScope` per window: a path is vouched in the window that saw it; vault keys are scoped to the calling window's folder (`registerVaultIpc` `scopeOf`, resolved per call). | A path vouched in one window opens in another; a window reads another folder's secrets. |
| `src/main/main.ts`: `wsKey`, `indexToken` | Per-window secrets in the preload's argv; `__ws/<key>/` and the `x-sec-edit-index` header pick the window. | One window's preview or search workers read another window's folder. |
| `src/main/main.ts`: `serial` | Window routing one step at a time: each sees the windows the step before made. | A folder launched twice opens two windows. |
| `src/main/main.ts`: `shownOrLater` | Waits ≤ 3 s for a new window to show before the next launch step. | No wait: the wrong window ends in front. No cap: a stuck renderer holds up every window after it. |
| `src/main/app-menu.ts`: `registerAccelerator: false` | macOS File → New Window shows `CmdOrCtrl+Shift+N` but does not register it. | The menu takes the key from the renderer's `window.new` command (page and terminal alike). |
| `src/backend/service.ts`: `changeRecent`, `saveExportDir` | recent.json / export-dirs.json: read-merge-write under `withFileLock`. | Windows drop each other's recent folders / last PDF folders. |
| `src/backend/git.ts`: async `isFile`, `hunks`, `statSig`, `repoState`, `exists` (index.lock), `hasDotGitAboveAsync` | No blocking file calls on the main thread (no `*Sync(` left in `git*.ts`); every check one at a time, first hit wins. | A hung share freezes every window (one main process); parallel stats hold the whole libuv pool. |

## STOP AND ASK list

Stop and ask before you do any of these:

1. New dependency, new IPC channel family, new outbound host.
2. Any change to path containment, the sanitizer, CSP, tokens, vault, `OpenGate`, git trust.
3. An MCP tool that writes files.
4. A change touching more than ~6 files, or any shared file beyond a one-line addition.
5. Anything that needs the Windows side, `/tmp`, or real NTFS.
6. No precedent found after the grep recipes.
7. Removing, refactoring or "simplifying" anything in the **Load-bearing** list above or in `10-decisions.md`.
