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
- E2E: `app.evaluate(() => globalThis.__secEditVouch(path))` (vouches in every window).

## Vault scope

- **Vault scope** (`main/vault.ts`, `shared/vault.ts`):
  - folder-scoped keys (`<folder>::…`) are served only at or below the open folder (`vaultKeyInScope`);
  - a shared `vault:<key>` another folder saved needs the user's OK in a **native** dialog (`confirmSharedKey`, grant kept in vault.json `grants`, owner in `owners`).
- **One store, scoped per window:** every key call is scoped to the **calling window's** folder (`registerVaultIpc` `scopeOf` → `WindowCtx.vault`, resolved per call: the window may have opened another folder); an unknown window is `EACCES`; a window without a folder gets shared keys only. The shared-key dialog opens on the asking window.
- Don't add a vault call that skips `check()` / `allowShared()`.

## Terminal: residual risk, by decision

- **Terminal: residual risk, by decision.**
- `term:spawn` / `term:write` need no confirmation (UX).
- A page that is taken over can therefore run commands as the user; everything above limits what it reaches *without* a shell, and the renderer's own defences (sanitiser, CSP, no remote script) are what keep it from being taken over.
- Text from files typed into a terminal goes through `prepareRunText` / `claudePrompt` (control characters stripped, never Enter by default).

## Processes

- **Processes:** Windows system programs only by absolute path (`backend/winsys.ts` `winSystemExe`; a bare name is looked up in the current directory = the open folder, guarded by `tests/unit/backend/winsys.test.ts`).
- A path inside a cmd.exe command line goes through `cmdQuote` (`main/terminal-shells.ts`).

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

## Packaged builds

- **Packaged builds:**
  - `scripts/fuses.mjs` sets the Electron fuses: RunAsNode **on** for the web-server child and the MCP server; NODE_OPTIONS and `--inspect` **off**.
  - `main/env-guard.ts` drops every `SEC_EDIT_*` variable but four harmless ones.
  - So a new test hook is automatically dead when packaged. Don't add one that must work there.
- The packaged E2E therefore drives the app over Chromium's DevTools port (`tests/e2e/electron/packaged.spec.ts`).

## Licences in packaged builds

- **Licences in packaged builds:** `package.mjs` writes `LICENSE.txt` (One, GPL-3.0-or-later), `LICENSE.electron.txt` and `THIRD-PARTY-NOTICES.txt` next to the executable (`scripts/notices.mjs`: every production package from the lockfile with its root licence files).
- When the build starts shipping a file a package bundles under **its own** licence (new pdf.js data in `vite.config.ts`, another native helper in `stage.mjs`), add that licence file to `BUNDLED_LICENCES`; a listed file that disappears fails the build.
