# 09 - Reference: security contracts

> **WHEN TO READ THIS:** you touch file access, opening folders, the vault, processes, outbound requests or packaging.
> **WHAT YOU GET:** the contracts to keep. **STOP AND ASK** before changing any of them.
> **NEXT FILE:** `09-reference-mcp.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Threat model

- Threat model: the user opens a folder made by someone else; a note in it may even take over the page (XSS).
- Neither may reach beyond that folder.

## Path containment is two rules

- **Path containment is two rules.**
- `Workspace.abs(rel)` is lexical only.
- Anything that touches the disk for ONE path goes through **`await ws.real(rel, leaf = 'follow' | 'entry')`** (`backend/workspace.ts`).
  - Same result as `abs()`, but `OUTSIDE_WORKSPACE` when a symlink / junction leads out of the folder.
  - `'entry'` = act on the entry itself (delete, rename, reveal): only its folder must be real.
- Used by every file RPC and by main's `app://sec-edit/__ws/<window key>/` route (each window's `wsKey` serves only that window's folder: `WindowBackend.real()`); a new file route (HTTP server included) must use it too.
- The tree walk and the watcher leave out links whose target is outside (`linkTarget`), so the index — all the indexer reads in bulk — holds no such path; on-request index reads (`readIndexedFiles*`) check paths the listing does not know.
- Links that stay inside the folder work as before (except in the MCP server's workspace, `links: 'skip'`).
- **Page writes, moves and deletes re-check the real parent folder** right before the disk changes and again after (`pageDirBefore` / `pageDirAfter`); what landed outside through a swapped-in link is taken back.
- A rename of a folder or link, or a removal of a link, runs alone (`withInflight(..., wide)`: exclusive slot `''`).
- `readFile` reads through the opened handle and checks its dev/ino against the realpath (`openedHere`).
- A failed `realpath(root)` fails closed (no link allowed on the way) and is not cached (`realRoot`).
- Index reads below a link are checked per file at read time (`ReadJob.v`, `readpool.ts`), never by a per-folder cache.
- **No page change under `.git`:** `BackendService` workspaces refuse any change under a `.git` segment (`protectGitDir`: case per folder, `GIT~N`, through links).
- `resolvePath`: a UNC or device path outside the folder is never looked up without `ServiceHooks.remotePathOk` (Windows would send the user's NTLM hash).
- Residuals: the tree listing of names (not contents) can still race a link move; hard links into `.git` inside a trusted folder.

## Files outside the open folder (external files)

- **Files outside the open folder ("external files")** (`shared/external.ts`, `backend/external-files.ts`; shell).
- A file the OS / the user hands to the app (Finder "Open With", argv, second instance, drop, `File: Open file…`) that is not inside the open folder opens as a normal tab and never changes the folder (`openAbsolutePathsNow`; with NO folder open the old rule stays: its folder opens).
- Its document key is `::ext:` + absolute path (`extIdOf`), accepted by `readFile` / `writeFile` like a relative path; the workspace-relative contract of in-folder files is untouched.
- **One entry point:** `BackendService.openExternalFile(abs)` puts the real path on the allow-list (`ExternalFiles`, ≤ 200, regular files only).
  - Read / write / watch go only through it.
  - The real path is re-checked on every call: a link swapped in later is `EACCES`.
  - A made-up id, `..` segments, the neighbour of an allowed file are `EACCES`.
- It exists only with `ServiceHooks.externalFiles` (desktop main); server mode / pinned web servers answer `ENOTSUP` and serve nothing.
- Main lets the RPC through only for a file it saw itself (`OpenGate.vouchedFile`: dialog `pickFile`, argv, `open-file`, drop; never a folder or a recent).
- Not a workspace file: not in the tree, index, search, knowledge, git, MCP, follow hooks or the session (restore drops the tab); create / rename / delete / writeBinary / reveal with such an id are `EINVAL`; search / knowledge guard on `isExtPath`.
- Changes on disk come from a 1.2 s stat poll of the allowed files (`FsEvent` with the id; the renderer ignores them unless the doc is open) and reach the normal conflict / reload flow.
- Tab label = file name, tooltip = the folder path.
- A new feature that walks `app.tabs` / `app.docs` and assumes a workspace-relative path must skip `isExtPath` ids.

## Opening a folder is main's decision

- **Opening a folder is main's decision** (`main/open-gate.ts`): `rpc:openWorkspace` only passes for a path main saw itself. Those are:
  - the folder dialog;
  - launch / second-instance / macOS `open-file` arguments;
  - a drop (the preload reports the `File`'s path on `app:vouchPath`);
  - a recent folder;
  - a folder inside the open one;
  - the folder of a vouched file.
- A new way to open a folder must `gate.vouch()` in main, never trust a path string from the page.
- **One gate per window** (`WindowCtx.gate`): a path is vouched in the window that saw it (its dialog, its drop, the launch step `planLaunch` sends there); `app:openFolderWindow` checks the asking window's gate, and the new window vouches the folder in its own.
- **Spelling first:** a path from the page is decided on its text. Only main's own paths (and a path spelled inside the open folder) touch the disk, so a UNC path main never saw is refused without an SMB connection. `ServiceHooks.remotePathOk` = `gate.seen()`.
- **In-place switch = a fresh page:** the renderer reloads after main opened the new folder (`pageReload`, `doc-save.ts`); main refuses the old page (`staleRealm`) and reloads it after `STALE_RELOAD_MS` (1.5 s) if it did not. Detail: `09-reference-app.md`.
- E2E: `app.evaluate(() => globalThis.__secEditVouch(path))` (vouches in every window).

## Vault scope

- **Vault scope** (`main/vault.ts`, `shared/vault.ts`):
  - folder-scoped keys (`<folder>::…`) are served only at or below the open folder (`vaultKeyInScope`);
  - a shared `vault:<key>` another folder saved needs the user's OK in a **native** dialog (`confirmSharedKey`, grant kept in vault.json `grants`, owner in `owners`).
- **One store, scoped per window:** every key call is scoped to the **calling window's** folder (`registerVaultIpc` `scopeOf` → `WindowCtx.vault`, resolved per call: the window may have opened another folder); an unknown window is `EACCES`; a window without a folder gets shared keys only. The shared-key dialog opens on the asking window.
- **Owner rule:** a new value for a shared key from another folder (allowed in the dialog) makes that folder the owner and drops every other grant of that key. The dialog shows the asking folder and the owner as full paths.
- Don't add a vault call that skips `check()` / `allowShared()`.

## Git trust

- **`git('trust')` only through `ServiceHooks.confirmTrust`** (main's native box on that window, `confirmTrust()` in `main.ts`). Without the hook: `EACCES` (`grantGitTrust`). `untrust` is always allowed.
- No HTTP server grants trust: the server answers `ENOTSUP` before the service sees it. The browser page tells the user to trust in the desktop app.
- After trust (tier 2) git runs the repository's hooks and filters and the user's login; `core.fsmonitor` is always off; commit-box writes (stage / unstage / blocks / discard) run no hook; push never takes a remote name starting with `-`. Detail: `09-reference-git.md`.

## Browser-mode servers are pinned

- **Every server `cli.ts` starts is pinned** (`pinRoot`, `roots` = its folder arguments). The page opens only those folders and folders inside them.
  - Checked by name first (`underRoots`: no disk access for an outside path), then on the real path (`whereIs`), then again after the open (a link renamed into place: back to the folder before).
  - One's data / cache folder is never opened.
- `shared` (desktop "Start web server", any bind beyond loopback): also no process list, no OS version (`SHARED` in `server.ts`).
- Settings writes go through the `WEB_SETTINGS` allowlist (64 KB per value, 256 KB per call). `preview.remoteImages` is left out on purpose.
- `revealInFolder` only from loopback.
- `--open` and the desktop "Open" hand the browser a 0600 redirect file (`launch-file.ts`), never a command line holding the launch code or the token.
- LAN starts need main's native confirm (`WebServerDeps.confirmLan`); local starts never ask.
- Residual: a link renamed into place at the exact moment of a switch (a check/use race, like audit H3).

## Terminal: residual risk, by decision

- **Terminal: residual risk, by decision.**
- `term:spawn` / `term:write` need no confirmation (UX).
- A page that is taken over can therefore run commands as the user; everything above limits what it reaches *without* a shell, and the renderer's own defences (sanitiser, CSP, no remote script) are what keep it from being taken over.
- Text from files typed into a terminal goes through `prepareRunText` / `claudePrompt` (control characters stripped, never Enter by default).

## Processes

- **Processes:** Windows system programs only by absolute path (`backend/winsys.ts` `winSystemExe`; a bare name is looked up in the current directory = the open folder, guarded by `tests/unit/backend/winsys.test.ts`).
- A path inside a cmd.exe command line goes through `cmdQuote` (`main/terminal-shells.ts`).
- POSIX system programs by absolute path too (`posixPs()`, `backend/processes.ts`): a bare name goes through PATH, where an empty entry = the current folder.
- Windows npm shims (`claude.cmd`, `opencode.cmd`, also `opencode serve` behind one) start with `NoDefaultCurrentDirectoryInExePath=1` (`SHIM_ENV`, `main/terminal-shells.ts`): the shim runs a bare `node`, and cmd.exe would look in the open folder first.
- Inside WSL the open folder reaches agent scripts only as env `ONE_CWD` (through `WSLENV`), never as script text or a script argument.
- Process explorer: `group` (from the page) is honoured only for a terminal's foreground job, never for One's own process group (`safeGroup`).
- Not yet by absolute path: `osascript` (`backend/trash.ts`), `open` / `xdg-open` (`backend/service.ts`, `server/cli.ts`).

## Outbound requests: one feature, two hosts

- **Outbound requests: one feature, two hosts** (`main/update-check.ts`, "Security updates").
- **Two triggers, one boolean from the page** (`check(manual)`, never a URL or host):
  - **"Check now"** (`manual: true`) always goes: the user clicked, no confirm dialog;
  - the **automatic** check (once after launch when visible, 7-day rule) needs the setting `updates.check` ("Check automatically every week", off by default). Main reads that setting itself and refuses without.
- Accepted residual: a hijacked page could trigger a manual check; it sends only names + versions to the same two hosts, like any check.
- `UPDATE_HOSTS` = `endoflife.date` + `api.osv.dev`. They are checked twice:
  - in the service before every fetch (`isAllowedUpdateUrl`: https, exact host, default port);
  - again by `webRequest` on its own in-memory session (`update-check` partition: no cookies, no cache, `User-Agent: update-check`, redirects are errors).
- Sent: a GET with nothing, and names + versions from `shipped-deps.json` — never an id, a path, a setting.
- **Don't add a host**, a header or a field: every extra host learns the user's IP and what they run; a new source needs the user's decision first (ask the lead).
- No timer: the renderer asks once after launch when visible (main applies the 7-day rule) and on "Check now"; failures stay quiet (`lastError` in Settings).
- Advisory text is untrusted: rendered as text, links rebuilt from the id (`vulnUrl`) or built from the version (`releases.electronjs.org`);
  - the summary (`UpdateStatus.summary`: Electron line, every package checked + its advisory count, timing, per-source error) is local only, cached in `update-check.json`, re-validated on read (`parseSummary`) and dropped when the build changes (`sameBuild`);
  - its only links are the two fixed source pages (`EOL_PAGE`, `OSV_PAGE`).
- Tests never use the real hosts: `SEC_EDIT_TEST_UPDATE_API=http://127.0.0.1:<port>` (test builds only; dropped when packaged) points both services at a local stub.

## One's own data folder is never served

- **One's own data folder is never served** (settings, mcp.json, the vault, git trust, the text cache, bookmarks).
  - `BackendService` opens every workspace with `deny: [configDir, cacheDir]`.
  - `Workspace.real()` refuses (`EACCES`) any path inside a denied folder, as written or where it really is.
  - The walk leaves it out.
- It matters when the open folder contains it (the home folder on Windows: `AppData` is no dot name): a page taken over cannot rewrite `mcp.json`.
- **Matched by identity too:** dev+ino of the root's ancestors (8.3 names, `\\localhost\c$`, firmlinks, bind mounts).
  - `openWorkspace` refuses a root inside a denied folder (`insideAnyFolder`), before the open folder is let go.
  - The walk lists nothing when the root is inside one.
- Residual: the data folder of the Windows install seen from a WSL build (and the other way round) is not denied.

## Untrusted patterns never become a backtracking regex

- Patterns from the folder (`.gitignore`, notes) and from MCP clients are matched by linear scanners only:
  - `globMatcher` (`backend/gitignore.ts`), `globSearch` (`path:`, `search/engine.ts`), `loosePhrase` (phrases across inline markers, step budget), `wildcard` (excludes, `backend/exclude.ts`).
- Never compile such a pattern into a RegExp. The indexer worker sends patterns, not regex sources, to main.
- MCP shares are refused in and around the data folder, the text cache (Windows: `%LOCALAPPDATA%\sec-edit\index-cache`) and One's program folders (`folderProblem`, `oneInstallDirs`, `mcp/grant.ts`).

## Per-folder renderer state

- **Never in localStorage / sessionStorage keyed by folder:** one origin serves every folder's page.
- Per-folder values (`{{variable}}` values, active environment / target, the remote-images choice, recent files) live in the folder's `SessionState`, through `folderValue` / `setFolderValue` (`app/documents.ts`). A legacy localStorage key is moved over once, then deleted.
- `theme-boot.js` only builds CSS from validated `#rrggbb` lists (`colorCache`, `app/accent.ts`). Never store CSS text.
- Copy: a code block's Copy hands out `copyableCode()` (no C0 / C1 controls); the terminal paste strips them too.
- Residuals: old localStorage keys of folders not reopened yet stay until opened once; nav history (sessionStorage per window) crosses folders after an in-place switch (paths only); search query history is global by design.

## Packaged builds

- **Packaged builds:**
  - `scripts/fuses.mjs` sets the Electron fuses: RunAsNode **off**, NODE_OPTIONS and `--inspect` **off**, OnlyLoadAppFromAsar **on**. Asar integrity stays off until it has run on Windows / macOS.
  - The servers need no Node mode: "Start web server" runs in a `utilityProcess`; MCP clients and the launchers use `One --mcp-stdio` / `One --serve`. Main only ever runs its two fixed programs (`launch-mode.ts`); old `cli.mjs` command lines map onto them.
  - `main/env-guard.ts` drops every `SEC_EDIT_*` variable but four harmless ones.
  - So a new test hook is automatically dead when packaged. Don't add one that must work there.
- Packaged builds refuse `--remote-debugging-port` / `-pipe` (`remoteDebuggingRefused`) except a test package (`package.mjs --out <dir> --test-package`).
- The packaged E2E drives such a test package over Chromium's DevTools port (`tests/e2e/electron/packaged.spec.ts`, `SEC_EDIT_PACKAGED_DIR` points at it).

## Other contracts (main)

- `__ws` serves a workspace file from one opened handle (dev/ino checked against the checked path; `workspaceFile()`, `main.ts`).
- `clipboard-read` is granted only to the app page's main frame.
- The update check caps the body while reading it (`readCapped`, `MAX_BODY`).
- Renderer crash reloads: at most 3 per 60 s (`crashReloads()`), then a start-screen window without session restore.

## Licences in packaged builds

- **Licences in packaged builds:** `package.mjs` writes `LICENSE.txt` (One, GPL-3.0-or-later), `LICENSE.electron.txt` and `THIRD-PARTY-NOTICES.txt` next to the executable (`scripts/notices.mjs`: every production package from the lockfile with its root licence files).
- When the build starts shipping a file a package bundles under **its own** licence (new pdf.js data in `vite.config.ts`, another native helper in `stage.mjs`), add that licence file to `BUNDLED_LICENCES`; a listed file that disappears fails the build.
