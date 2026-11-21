# sec-edit — engineering guide for parallel agents

A fast, folder-based Markdown + code editor (Obsidian-like, **no vaults, no sync**).
Electron desktop app (Windows is the primary target, Linux/macOS must also work) **and** a
browser mode served by a local Node server. Both share one renderer.

## Stack
- TypeScript everywhere, **Preact + @preact/signals** for UI, **CodeMirror 6** editor,
  markdown-it + DOMPurify preview, Shiki (lazy) highlighting, Prettier standalone (+ @prettier/plugin-php, lazy, in a worker).
- Vite builds the renderer (`src/renderer` → `dist/renderer`), esbuild builds Node entry points (`scripts/build-node.mjs`).
- Tests: **Vitest** (`tests/unit/**`), **Playwright** (`tests/e2e/**`, browser mode, real server per worker).

## Layout & ownership (only edit what you own; see "Shared files")
| Path | Owner |
|---|---|
| `src/backend/`, `src/main/`, `src/server/`, `src/renderer/platform/`, `src/renderer/app/`, `src/renderer/styles/app.css`, `src/renderer/main.tsx`, `src/shared/api.ts`, packaging, `tests/e2e/electron/` | **shell** |
| `src/renderer/editor/` | **editor** |
| `src/renderer/preview/` | **preview** |
| `src/search/`, `src/renderer/search/` | **search** |
| `src/format/`, `src/shared/languages.ts` | **format** |
| `src/knowledge/`, `src/renderer/knowledge/`, `src/shared/wikilinks.ts` | **knowledge** |
| `src/renderer/overview/` (file overview, right column; shell's `Layout` hosts it, state in `ui.overviewVisible` / `ui.overviewWidth`) | **overview** |
| `src/renderer/terminal/`, `src/main/terminal*.ts`, `src/shared/terminal.ts` (integrated terminal + Claude glue; shell's `Layout` hosts the bottom panel while `panelOpen`) | **terminal** |
| `src/backend/git*.ts`, `src/shared/git.ts`, `src/renderer/git/` (status, tree marks, change bars, diff view, Source control pane; one `git(op, …)` RPC; the startup stub `git/install.ts` fills `gitUi` slots that FileTree / StatusBar / Popups / the editor read). **When** git runs is decided only by `backend/git-monitor.ts` (debounce, single-flight, adaptive interval, paused while hidden, multi-repo); `backend/git-wsl.ts` runs git inside WSL for `\\wsl.localhost` roots; every spawn is logged via `backend/git-activity.ts`. Read paths never write the repository; the one exception is the monitor's opt-out index stat-cache refresh (`GitService.refreshIndex`: hooks off, skipped while `index.lock` exists, never killed). Don't add renderer-side status polling: report triggers instead (`git('nudge')`, `git('visibility')`). Commit selection **is the index** (pane boxes = `stage` / `unstage`, batched in `git/selection.ts`; no app-side selection state); parts of a file = `git('hunks', path, from?)` (blocks composed from HEAD→index and index→worktree `-U0` diffs, `backend/git-hunks.ts`) and `git('stageHunks', path, picks, from?)` (`git apply --cached --unidiff-zero` with patches built from git's own diff bytes; never touches the working tree). **One way into a file's diff:** `openFileDiff(store, path, row?)` (`git/diff-open.tsx` → `openStaging` in the lazy `git/stage.ts`) serves "Diff with last commit" (menus, palette, status bar) **and** a click on a Source control row, so both show the same commit boxes; a new entry point calls it, never `openDiffWithHead` / `showDiff` directly (those are the plain view underneath). The box style is `git/check.css`, imported by the pane and the diff view (separate chunks). **Editing in the diff view** (`git/diff-edit.ts`, lazy diff chunk): git diffs only on the right side, and only when it IS the workspace file (`editableSide`: HEAD / index → working copy; never HEAD, History). **Compare** (`compareTargets`): either side that IS a workspace file (a whole file shown exactly as its document / the file on disk is now) takes typed text and blocks from the other side ("apply to the other side", both directions; `DiffViewProps.apply` + `basePath` for the left file); the clipboard, a selection and a remembered text are sources only — never render a control pointing at them; "Ignore whitespace" switches the controls off (`off` = the tooltip). The left side of a unified compare has no editor: its changes are `updateOriginalDoc` effects forwarded to the file, undone through `SideHistory` in turn with the editor's own history. It is not a second buffer: edits are forwarded to the file's open document (`app.editor.applyChanges`; no tab yet → `app.openFile` on the first edit), document changes flow back (`doc:changed`), so dirty state, `Ctrl+S`, autosave, EOL and disk conflicts are the editor's. Blocks of an edited diff are re-read from git after each `doc:saved`; a block ticked on unsaved edits saves first (`saveThenPick`). `StagingProps.toggleHunk(index, line?)` + `work` (the text the blocks refer to). **Trust gate** (`backend/git-trust.ts`, enforced in `BackendService.git` before a `GitMonitor` / `GitService` exists): a folder runs **no git at all** — no status, marks, diff, actions, WSL included — until the user says Trust in the Source control panel (`git('trust')` / `git('untrust')`; `status` answers `{ ok: false, reason: 'untrusted', repoLikely? }`, reads the UI makes by itself answer empty, everything else `EACCES`). Remembered per folder (real path, the folder's own case rule) in `<app data>/git-trust.json`, shared by desktop and browser-mode servers; recent folders migrate once. Never start git for the open folder outside `BackendService.git`. Read paths switch off **every** configured filter driver (all config scopes; only canonical Git LFS, and only when git-lfs exists). Tests trust their repos with `trustRepo()` (`tests/e2e/git-helpers.ts`) or `svc.git('trust')` | **git** |
| `src/renderer/variables/`, `src/main/vault*.ts`, `src/shared/vault.ts` ({{variables}}, environments / targets, secrets vault, smart paste; the editor chunk holds only `variables/cm.ts`, the rest is the lazy `variables` chunk; `variables/slot.ts` is the status-bar slot) | **variables** |
| `src/main/web-server*.ts`, `src/shared/web-server.ts`, `src/renderer/webserver/` ("Start web server": browser mode for the open folder as a child process, desktop only; `webserver/slot.ts` is the status-bar slot, the rest is the lazy `web-server-ui` chunk; Settings → Browser mode) | **shell** |
| `src/main/update-check*.ts`, `src/shared/update-check.ts`, `src/renderer/updates/`, `scripts/shipped-deps.mjs` ("Security updates": opt-in check for a newer Electron patch / end of support / known vulnerabilities in what the build ships, desktop only. Pure rules in `shared/update-check.ts`; requests, cache `<app data>/update-check.json` and the weekly rule in `main/update-check.ts`; `updates/slot.ts` is the status-bar slot, the rest is the lazy `updates-ui` chunk loaded after the idle Popups chunk; Settings → Security updates. `build-node.mjs` writes `dist/main/shipped-deps.json` from the lockfile: names + versions of every non-dev package) | **shell** |
| `src/renderer/whitespace/` (trailing whitespace: paste trim via CodeMirror's `clipboardInputFilter`, trim on save through format's `beforeSave` hook in `src/format/install.ts`, the `editor.trimWhitespace` command; editor chunk only) | **variables** |
| `src/renderer/pdf/` (PDF viewer: lazy chunk `PdfView` on pdf.js's `PDFViewer`; `engine.ts` is the only place documents are opened — security options live there; `model.ts` pure helpers; pdf.js data assets copied by `vite.config.ts` → `pdfjs/`; the worker gets `PDF_WORKER_CSP` from `src/shared/pdf.ts` in `main.ts` / `server.ts`) | **pdf** |
| `src/renderer/nav/`, `src/shared/nav.ts` (Go back / forward: `nav/install.ts` is the startup stub — two key bindings, mouse side buttons, ~0.4 kB gzip; `nav/impl.ts` = recorder + restore, lazy on idle; `nav/history.ts` = the pure stack) | **nav** |
| `tests/unit/<area>/`, `tests/e2e/<area>*.spec.ts` | the area's owner |

### Shared files (integration points)
`src/renderer/main.tsx`, `src/renderer/app/app.ts`, `src/renderer/app/commands.ts`, `src/shared/api.ts`, `src/shared/paths.ts`.
You MAY make **small additive edits** to them (e.g. one `installX()` call in `main.tsx`, a new optional field).
Always Read immediately before Edit (other agents edit concurrently), never rewrite/reformat these files, never remove others' code.

## Extension points (use these, don't invent parallel mechanisms)
- `app` singleton (`src/renderer/app/app.ts`): signals `workspace, tree, files, tabs, activePath, settings, overlay, sidebarPanel`,
  `app.docs` (open documents), `app.events` (`doc:changed`, `doc:saved`, `file:updated`, `workspace:opened`, …),
  `app.openFile(path, {line,col,length})`, `app.saveFile()`, `app.toast()`, `app.registerPanel()`, `app.editor`, `app.preview`.
- Contracts `EditorController` / `PreviewController` are in `app.ts`. Keep them backward compatible; add optional members if needed.
- Commands: `registerCommand({ id, title, keys?, displayKeys?, keywords?, when?, run })` in `src/renderer/app/commands.ts`.
  `keys` are **global** (capture phase, beat the editor). Editor-local shortcuts belong in CodeMirror keymaps — list them via `displayKeys`.
- Module bootstrap: each area exports an `installX()` called from `main.tsx`.
- Process explorer ("Developer: Process explorer", shell: `src/shared/processes.ts`, `src/backend/processes.ts`,
  `src/main/process-rows.ts`, `src/renderer/app/process-explorer/`): if your feature runs a process, thread or worker,
  give it a row. Backend / main: `registerProcessSource({ id, rows(), shellPids?(), ownPids?() })` (`backend/processes.ts`);
  renderer: `registerUiProcessSource({ id, rows() })` (`app/process-explorer/sources.ts`) **from your lazy chunk**.
  Rows (`ProcRow`) are read only while the explorer is open (every 2 s): keep `rows()` cheap, never spawn or wake a
  stopped thread for it. Child processes (git, terminals, watchers) are found automatically from the OS process tree.
- Indexing (search + knowledge read the same paged text stream, `app/workspace-text.ts`): the backend skips
  git-ignored files, lockfiles, `*.min.*` / `*.map` and files over `search.maxFileSizeKB` (`Workspace.textPaths()`;
  the tree still lists them), reads in worker threads and keeps a text cache in the app's data folder (never the workspace).
  Search is sharded over workers (`src/search/shards.ts`, exact two-phase merge — keep `tests/unit/search/shards.test.ts` green).
  Emit `app.events.emit('index:stale')` after a setting that changes what is indexed (both indexes rebuild).
  The index may be built **on demand** (`search.indexing`): a feature that reads it must ask for it —
  `searchClient.start()` / `(app as any).knowledge.ensure()` (search, mentions, headings already do) — and show
  "Indexing… x / y" (`searchClient.progress`) instead of an empty state; `indexDeferred` (`search/demand.ts`) = not built yet.
- Shared helpers: `src/shared/paths.ts` (POSIX rel paths), `src/shared/languages.ts` (ext/fence → CM/Shiki/Prettier ids),
  `src/shared/wikilinks.ts` (parse + resolve `[[links]]`).
- Link graph (knowledge): `KnowledgeIndex` keeps adjacency patched per edit — `linksFrom(path)` (unique resolved notes),
  `linksTo(path)` (live set), `tagsOf` / `notesTagged` (incremental tag index). Neighbourhood queries go through
  `src/knowledge/connections.ts` (`relatedNotes` = co-citation + coupling + shared tags with a work budget, `localGraph`
  capped, `orphanNotes`, `notesWithoutIncoming`): never scan all notes on a note switch (perf guard:
  `tests/e2e/knowledge-connections-perf.spec.ts`, < 16 ms at 10k notes). The overview's **Connections** section is the
  lazy chunk `knowledge/Connections.tsx` (reuses `overview/parts.tsx` + overview row classes); `knowledge/graph-canvas.ts`
  is the canvas renderer shared with the graph view. Keyless knowledge commands register from the chunk
  (`addCommandSource`, `registerKnowledgeCommands` in `knowledge/impl.tsx`): only key-bound ones live in the stub.
- Link hover preview (knowledge, `knowledge/link-preview.ts`, setting `links.hoverPreview`): one popup for every surface.
  The editor reports the link under the pointer via `EditorHost.hoverLink(link | null, from)` (`editor/hover.ts`,
  forwarded by `editor/integration.ts` to `app.knowledge.linkPreview`); rendered Markdown (`.se-preview a`, note embeds)
  is picked up by delegation. Content = `knowledge/excerpt.ts` (start of note / `#heading` / `#^block`, via preview's
  `extractSection`) through the preview pipeline (`renderOptionsFor`: sanitised, `{{variables}}` resolved), lazy chunk
  `knowledge/hover-render.ts`. A new link surface: report hovers the same way instead of drawing its own tooltip.
- Global `window.__secEdit` = `app` (for E2E introspection). `html[data-ready="true"]` once booted.
- Viewer docs (PDF, pdf area): a `.pdf` is never read as text — `loadDoc` makes a `binary` doc without a read,
  the shell's lazy `Viewer` mounts `pdf/PdfView` per path, unmount = `loadingTask.destroy()` (document + worker).
  `openFile(path, { line: 0, page })` → `doc.reveal` / event `viewer:reveal`; a disk change of an open PDF emits
  `binary:changed` (no read). Bytes come through the workspace file URL (`fileUrl`), never an RPC. Keys a focused
  widget must keep from the global keymap can also use `addGlobalKeyFilter()` (stackable; the viewer's `Ctrl+±/F/G/0`).
  PDF text is **not** indexed (no search / OCR) — by decision.
- Navigation history (nav, Go back / Go forward): recorded centrally — a file switch (`active:changed`, so every
  `app.openFile` caller is covered) and a cursor jump of more than 10 lines that is not an edit (the editor's
  `onCursor(edited)`) each make an entry; typing and small moves update the current one; jumps < 350 ms apart coalesce.
  **Don't patch callers.** Only if your feature makes a deliberate move those rules can't see (a short jump, a page of a
  viewer doc) call `app.markNavigation?.()` right before it (valid 1 s, feature-detect: set when the chunk is in).
  Viewer docs report their page with `app.events.emit('viewer:page', path, page)`; an unmarked page change is scrolling.
  Inputs all end in `go(dir, source)` (`nav/impl.ts`), de-duplicated in `shared/nav.ts`: on Windows one side-button press
  arrives as a DOM mouse event **and** a BrowserWindow `app-command` (main → `app:navigate` → `backend.onNavCommand`).
  The history is per window (sessionStorage `sec-edit-nav:<root>`, 50 entries), not in the session file.
  E2E handle: `window.__secEditNav` = `{ history, go }`.
- Terminal (desktop only): `app.runInTerminal?.(code, { lang })` pastes a shell code block into the terminal
  (never presses Enter by default) — feature-detect it, it is unset in the browser. `isRunnableFence(lang)` from
  `src/renderer/terminal/run.ts` (dependency-free) says which fences get a "Run in terminal" button.
  Keys a focused widget must keep from the global keymap: `setGlobalKeyFilter()` in `commands.ts` (the terminal uses it).
  Terminals use their own `term:*` IPC channels (`src/shared/terminal.ts`), not `RPC_METHODS`: they need the sender's identity.
- Variables: `app.variables` (`VariablesApi` in `src/renderer/variables/api.ts`) — `renderHook(path)` for markdown-it
  (`RenderOptions.vars`; export passes `{ export: true }`), `copyCode` / `runCode` / `forTargets` for code-block buttons
  (resolve placeholders, ask for missing values), `prepare(path)` before an export. Event `variables:changed` = re-render.
  Precedence lives in ONE function: `lookup()` in `variables/resolve.ts`. Secrets: `vault:*` IPC (`src/shared/vault.ts`,
  safeStorage in `src/main/vault.ts`; keys are scoped to the open folder there, see "Security contracts"); browser mode keeps them in memory only. Per-folder env / target / remembered
  values: localStorage `sec-edit-vars:<root>` (not settings: the registry test guards every dotted key that is read).
- Web server (desktop only, "Start web server"): main runs `dist/server/cli.mjs <root> --ipc` as a **child process**
  (`process.execPath` + `ELECTRON_RUN_AS_NODE`, allowlisted env, `SEC_EDIT_CONFIG_DIR` = userData; packaged:
  `app.asar.unpacked/dist/server/cli.mjs`). Handshake = Node IPC message `{ type: 'ready', port, token }` / `{ type: 'error' }`,
  never a parsed log line; `{ type: 'stop' }` or an IPC disconnect (app quit / crash) ends it. One at a time, never auto-started,
  stopped on quit and when another folder is opened. Bridge `secEditBridge.webServer` = `status / start / stop / open / onChange`
  over `webserver:*` channels (`src/shared/web-server.ts`), re-validated in `src/main/web-server.ts` like the vault; `open`
  only accepts a link of the running server. The token stays out of logs and the activity log (UI shows the address only;
  Copy uses the full link; Open asks the child for a one-time link, `{ type: 'launch' }` → `{ type: 'launch', url }`, so no
  browser command line holds the key). `--ipc` and any non-loopback `--host` start the server **pinned** (`pinRoot`): it
  refuses `openWorkspace` / `resolvePath` outside its folder, lists no recents, no process list, no `terminal.*` /
  `webserver.*` settings writes. The renderer chunk loads after the idle Popups chunk (zero startup bytes but the slot);
  browser mode has no bridge, so neither commands nor the Settings section (`SectionDef.desktopOnly`) exist there.
- Browser-only renderer code lives in **`src/renderer/platform/web.ts`** (token, launch code, RPC over fetch, SSE,
  media HMAC via `platform/hmac.ts`): its own chunk, which the desktop never fetches or evaluates (perf.spec checks the
  startup chunks for its markers). Never import it statically; `platform/index.ts` keeps only sync shims
  (`fileUrl` / `eventsUrl` / `webToken`), which `web.ts` fills through `installWeb()` as it evaluates. **Contract:**
  the server finds the chunk in Vite's build manifest (`build.manifest` → `.vite/manifest.json`, key
  `platform/web.ts`; the manifest is never served) and its index.html runs the chunk as a `<script type="module">`
  **right before the entry**, plus `modulepreload` for any chunk it imports that index.html doesn't list yet. So it
  downloads in parallel and is installed before `connectBackend()` runs, with no `import()` hop in front of the
  bootstrap round trip. Without it (Vite dev server, older build) `connectBackend()` imports the chunk itself.
  Renaming or moving `web.ts` means updating `BROWSER_CHUNK` in `server.ts`.
- Browser-mode access (`src/server/server.ts`, `src/renderer/platform/web.ts`): the token travels in the
  `x-sec-edit-token` header only and lives in the tab's sessionStorage — **never a cookie** (cookies ignore ports: every
  127.0.0.1 server would get it) and never in a URL the page shows; index.html is a static shell. Media GETs carry a
  **per-file capability** instead: `fileUrl()` → `/api/file?path=…&m=HMAC(mediaKey, root + path)` (key from `bootstrap()`,
  `platform/hmac.ts` = server's `mediaMac`), the event stream `eventsUrl()` → `ev=`. A new GET endpoint for `<img>` /
  EventSource uses the same scheme, never `?token=`. `/api/file` resolves links with `Workspace.real()` (no way out of
  the folder). `--open` / `launchUrl()` pass a one-time `?launch=` code. Script CSP: only the build's `assets/` +
  `theme-boot.js` (index.html for `app://`, rewritten per origin by the server, `'self'` under the Vite dev server).
- Note content (preview, embeds, hover, export) — **sanitizer contract** (`preview/sanitize.ts`, `preview/markdown.ts`):
  the app's classes and `data-*` drive behaviour (Copy / Run, embeds, tasks, media paths) and some are fixed overlays, so
  they come from the markdown renderer only. Every element raw HTML in a note creates is marked (`USER_MARK`) and loses
  all `data-*` and every class but `USER_CLASSES`; your own markup in a renderer rule is a `se_html` token (never
  `html_inline`). ids / names are prefixed `user-content-` (`SANITIZE_NAMED_PROPS`; headings get their slug back from
  `data-slug`). No popover / map / area / background / poster; `.se-preview` has `contain: paint`. **Copy / Run read the
  source**: `fenceAt(renderedSource, data-src-line)` (sections, `embedSourceOf(body)` for embeds) — never DOM text.
  **Remote media**: `preview/remote.ts` decides (Settings `preview.remoteImages` ask / always / never, per folder
  `sec-edit-remote:<root>`, "Load" per note); pass `remote` in `RenderOptions` (`renderOptionsFor` does), blocked media
  become `img.se-remote-blocked` placeholders; event `media:policy` = re-render. The static CSP still lists https:/http:
  for images (it cannot be per folder): the sanitizer is the gate.
- Sessions per client kind: every HTTP server (`startServer`, so also the .cmd / `start-web.sh`) runs its
  `BackendService` with `sessionKind: 'web'` → `sessions/<id>@web.json`; the desktop keeps `sessions/<id>.json`.
  A first browser visit reads the desktop file as a seed, never writes it. Settings are shared on purpose.
  Renderer localStorage is per origin (`app://sec-edit` vs `http://127.0.0.1:<port>`), so it never crosses over.
- Settings across processes: `saveSettings` merges only the patch into settings.json as it is on disk, under a
  cross-process lock (`backend/filelock.ts`, `settings.json.lock`, stale after 5 s). Each backend watches the file
  (debounced; own writes give no diff; keys still in flight are skipped) and reports *external* changes:
  `onExternalSettings` → Electron `settings:changed` (preload channel) / server SSE `event: settings`. The renderer
  re-syncs in `app/settings-sync.ts` (installed by the idle Popups chunk: no startup code).
- **Zen mode** (shell, "View: Toggle zen mode", `Mod-Alt-z`; stub `app/zen.tsx`, logic in the lazy `app/zen-impl.ts`):
  the flag is **`ui.zen`** (null = off, else the layout to restore). Entering saves sidebar visibility / panel, the
  overview, the process dock and the terminal panel, then closes them through **their own signals**; leaving
  restores exactly that. Tab strip, status bar (unless `zen.keepStatusBar`), classic activity bar and the shelf
  head / foot have no state: `Layout` leaves them out while `ui.zen` is set; the strip's place is `.se-zen-bar`
  (inside `.se-topline`, so the integrated frame's drag region and `--wco-right` still apply). **Contract:** a panel
  that opens *itself* (not on a user action: auto-open on an event, a restored flag) must not while `ui.zen.value`
  is set; a user action may open it (it shows on top of zen, and leaving zen still restores the pre-zen layout). Saved
  in the session (`SessionState.zen`) and in the skeleton cache (`sec-edit-layout` `z` → `<html data-zen="on[ status]">`
  by theme-boot.js), so the first paint is already zen.
- Calm file tree: setting `git.treeColors` (off = `gitUi.row()` / `Mark` draw nothing; drawing only, never a git run)
  and `tree.folderColors` (`hue` | `one` → `<html data-folders="one">`) + `tree.folderColor` (→ token
  **`--folder-color`**, derived per theme by `app/accent.ts` like the accent, cached as `sec-edit-folder` for
  theme-boot.js; unset = `--ft-folder`). Draw folder icons with `.se-ficon-folder` and they follow both.
- Browser state is per origin = per port: `cli.ts` remembers the last port per folder (`web-ports.json` in app data,
  `server/ports.ts`) and tries it first without `--port`; when it is busy, the ready handshake carries `busy` and the
  info panel says browser state starts empty.

### Global keybinding allocation (avoid conflicts)
| Owner | Keys |
|---|---|
| shell | `Mod-s` save, `Mod-w` close tab, `Mod-n` new note, `Mod-Shift-b` sidebar, `Mod-Alt-z` zen mode (also in `APP_KEYS_IN_TERMINAL`), `Mod-e` toggle edit/preview, `Mod-\` split, `Ctrl-Tab`/`Ctrl-Shift-Tab` tabs, `Mod-,` settings, `Mod-=`/`Mod--`/`Mod-0` zoom |
| search | `Mod-p`/`Mod-o` quick open, `Mod-Shift-p`/`F1` palette, `Mod-Shift-f` find in files, `Mod-Shift-h` replace in files, `Mod-Shift-o` go to heading, `Mod-t` workspace symbol/heading |
| format | `Shift-Alt-f` format document, `Mod-Alt-f` format selection/code block |
| editor (CM-local, not global) | `Mod-b` bold, `Mod-i` italic, `Mod-k` link, `Mod-f`/`Mod-h` in-file find/replace, `Mod-d`, `Mod-/`, `Mod-Enter` toggle checkbox, `Alt-Up/Down` move line, `Mod-Shift-v` paste exactly as copied (plain text, no trailing-whitespace trim, no smart paste), `/` slash menu, `Alt-F10` focus formatting toolbar, … |
| knowledge | `Mod-Alt-o` outline, `Mod-Alt-l` backlinks, `Mod-Alt-g` graph |
| git | `Mod-Shift-g` Source control panel, `Alt-F5` / `Shift-Alt-F5` next / previous change; pane-local `Mod-Enter` commit; diff view `F7` / `Shift-F7`, `Esc`, editable diff: `Mod-F7` revert the block at the cursor (compare: apply it to the right side), compare: `Mod-Shift-F7` apply the block at the cursor to the left side, `Mod-s` saves the diff's file(s) (key filter while it is open), `Mod-z` / `Mod-y` / `Mod-Shift-z` reach the diff's own undo when no editor in it has focus (window capture, only while a diff with an editable side is open) |
| overview | `Mod-Alt-b` toggle file overview (right sidebar) |
| nav | `Alt-ArrowLeft` / `Alt-ArrowRight` go back / forward (macOS: `Mod-[` / `Mod-]`); mouse side buttons (`button` 3 / 4, window capture, not a key). **Precedence:** global, so they beat CodeMirror's default `Alt-ArrowLeft/Right` (`cursorSyntaxLeft/Right`; on macOS `Mod-[` / `Mod-]` = indent less / more) as in VS Code — those stay in the palette ("Editor: Move cursor to syntax node start / end") and on `Tab` / `Shift-Tab`; `Shift-Alt-ArrowLeft/Right` (select syntax) is untouched. Not in `APP_KEYS_IN_TERMINAL`: in a focused terminal `Alt-←/→` stays readline's word move (the side buttons work there) |
| pdf (viewer-local, focus inside `.se-pdf` only; beats shell's UI zoom via `addGlobalKeyFilter`) | `Mod-f` find, `Mod-=`/`Mod--`/`Mod-0` + `Ctrl`-wheel zoom, `Mod-g` page box |
| terminal | ``Mod-` `` toggle / focus / hide panel, ``Mod-Shift-` `` (+ `Mod-Shift-~`) new terminal |
| terminal (xterm-local, focused terminal only) | `Mod-Shift-c`/`Mod-Shift-v` copy/paste, `Mod-f` find, `Shift-Insert`/`Ctrl-Insert`; Windows also `Ctrl-c` (with a selection) / `Ctrl-v`; macOS `Cmd-c/v/f/a/k` |

While a terminal has focus **only** `APP_KEYS_IN_TERMINAL` (`src/renderer/terminal/keys.ts`) reach global commands on
Windows/Linux — everything else goes to the shell (readline's `Ctrl-w/e/n/t/k/b/r`, F-keys for htop/mc). Add a key
there only if it must beat the shell.

## Rules
1. **Paths**: everything crossing the backend boundary is workspace-relative POSIX (`notes/a.md`). Never build paths with `\`.
   Windows matters: CRLF files (content is LF-normalised, EOL restored on save), case-insensitive FS, drive letters, `\\` in absolute paths.
   **Case sensitivity is per folder, never per OS**: read `WorkspaceInfo.caseSensitive` (renderer) / `Workspace.foldsCase` (backend). A `\\wsl.localhost` root on Windows is case-sensitive; never fold case because of `process.platform` or `backend.os`.
2. **Launch speed is a feature.** Nothing heavy at startup: Shiki, Prettier, KaTeX, Mermaid, language grammars → `import()` lazily on first use.
   Workers for CPU work (search index, formatting). Don't block first paint.
3. **Styling**: use CSS variables from `src/renderer/styles/app.css` (`--bg`, `--text`, `--accent`, `--code-bg`, …) so dark/light themes work.
   Corners: never hard-code `border-radius` — use `--radius-sm` / `--radius` / `--radius-lg` / `--radius-xl` (and `--radius-pill` for pills);
   "square" corner style flattens them. Text column: `--content-width`, `--editor-line-height`. Accent tokens are user-tunable: never hard-code the blue.
   Two sidebar styles exist (setting `sidebarStyle`: `shelf` default, `classic`): the root has `.ui-shelf` / `.ui-classic`;
   scope style-specific sidebar/tree CSS under those classes.
   **Integrated window frame** (desktop default, root class `.frame-integrated`): there is no OS title bar — the tab strip
   (`.se-topline`), the shelf head, the classic Files header and activity bar are `-webkit-app-region: drag`. Anything
   clickable you put there must be **no-drag**: `button`, `input`, `select`, `a`, `[role=tab|button]` and `[tabindex]`
   already are (app.css); otherwise add class `se-no-drag`. Floating UI over the strip (menus, dialogs) must be no-drag too.
   Don't place anything under the window controls: the strip reserves them via `--wco-right`.
   Put your CSS in your own folder (e.g. `src/renderer/editor/editor.css`) and import it from your module. Prefix classes `se-`.
   app.css holds only first-screen styles: classic-only rules are in `app/classic.css` (classic chunk); the palette,
   dialog, picker and stepper bases (`.se-palette*`, `.se-dialog*`, `.se-picker*`, `.se-stepper`) are in `app/overlays.css` —
   import it from any chunk that renders them (`.se-overlay` and `.se-menu*` stay in app.css).
   Icons: `app/icons.tsx` holds only first-screen glyphs; others are in the lazy `app/icon-pack.ts` or your chunk's
   `addIcons()`. An `<Icon>` whose name isn't registered yet draws an empty box and redraws when it arrives.
4. **Dependencies**: install ONLY via `flock /tmp/sec-edit-npm.lock npm install <pkg>` (serialises concurrent agents).
   Edit `package.json` scripts ONLY via `flock /tmp/sec-edit-npm.lock npm pkg set scripts.x="..."`.
5. **Testing is mandatory.** Unit tests in `tests/unit/<area>/`, E2E in `tests/e2e/<area>*.spec.ts` using `tests/e2e/harness.ts`
   (fresh server + temp workspace copy per worker). Run E2E with a **private build dir** so parallel agents don't clobber each other:
   `SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer npx playwright test tests/e2e/<area>`
   Unit: `npx vitest run tests/unit/<area>`. Typecheck: `npx tsc --noEmit -p .` (must stay clean — fix your own errors, don't touch others').
   DOM unit tests: add `// @vitest-environment happy-dom` at the top.
   Add fixture files under `tests/fixtures/workspace/` only if needed and **don't modify existing fixtures** (other tests depend on them).
6. **Electron E2E** (shell): Xvfb is available sudo-free: `~/.local/xvfb/start-xvfb.sh :99` then run Electron with `DISPLAY=:99` and `--disable-gpu`.
   Native save dialog (PDF export) in tests: `SEC_EDIT_TEST_SAVE_PATH=default|cancel|<abs path>` (only with `SEC_EDIT_TEST`).
   Desktop-only RPC methods (`exportPdf`, `showExportedFile`) are refused by the HTTP server with `ENOTSUP`, and so is
   every terminal name (`isTerminalMethod`): browser mode never exposes a shell.
   Terminal E2E (`tests/e2e/electron/terminal.spec.ts`) runs real bash; give it a private `HOME` (a developer's
   `~/.bashrc` may `cd ~`). `node-pty` is native: `build-node.mjs` keeps it external, `stage.mjs` copies only the target's
   binaries, `package.mjs` unpacks it to `app.asar.unpacked`.
7. Keep the renderer secure: `contextIsolation`, sandboxed preload, DOMPurify on all rendered HTML (the sanitizer
   contract above: no app classes / data-* from notes, no remote media unless allowed), no `eval`.
8. No new top-level frameworks (no React/Vue/Tailwind). Small focused libs are fine.
9. Code comments explain *why*, briefly.
10. **Stay inside the project.** Temp files, test workspaces and outputs go in `<project>/.tmp/<area>/` only. Never write outside the project (no `/tmp`, no Windows side via `/mnt/c` or `%TEMP%`, no user folders) and never run Windows executables via WSL interop. If a test truly needs that (e.g. real NTFS), stop and ask the lead, who asks the user first.
    vitest and both Playwright configs set `TMPDIR=<project>/.tmp/tmp`; for ad-hoc scripts (benchmarks, node -e) set `TMPDIR=$PWD/.tmp/tmp` yourself.
11. **This machine is the user's own PC.** Never run synthetic CPU load generators, repeated full-suite cycles or long benchmark sessions without the lead's approval (the lead asks the user first). Keep verification bounded: one full run per change set, one heavy job at a time, and kill your orphan processes when done.

## Security contracts (keep them when you touch these areas)
Threat model: the user opens a folder made by someone else; a note in it may even take over the page (XSS). Neither may reach beyond that folder.
- **Path containment is two rules.** `Workspace.abs(rel)` is lexical only. Anything that touches the disk for ONE path goes through **`await ws.real(rel, leaf = 'follow' | 'entry')`** (`backend/workspace.ts`): same result as `abs()`, but `OUTSIDE_WORKSPACE` when a symlink / junction leads out of the folder (`'entry'` = act on the entry itself: delete, rename, reveal — only its folder must be real). Used by every file RPC and by main's `app://sec-edit/__ws/` route; a new file route (HTTP server included) must use it too. The tree walk and the watcher leave out links whose target is outside (`linkTarget`), so the index — all the indexer reads in bulk — holds no such path; on-request index reads (`readIndexedFiles*`) check paths the listing does not know. Links that stay inside the folder work as before.
- **Opening a folder is main's decision** (`main/open-gate.ts`): `rpc:openWorkspace` only passes for a path main saw itself — the folder dialog, launch / second-instance arguments, a drop (the preload reports the `File`'s path on `app:vouchPath`), a recent folder, a folder inside the open one, the folder of a vouched file. A new way to open a folder must `gate.vouch()` in main, never trust a path string from the page. E2E: `app.evaluate(() => globalThis.__secEditVouch(path))`.
- **Vault scope** (`main/vault.ts`, `shared/vault.ts`): folder-scoped keys (`<folder>::…`) are served only at or below the open folder (`vaultKeyInScope`); a shared `vault:<key>` another folder saved needs the user's OK in a **native** dialog (`confirmSharedKey`, grant kept in vault.json `grants`, owner in `owners`). Don't add a vault call that skips `check()` / `allowShared()`.
- **Terminal: residual risk, by decision.** `term:spawn` / `term:write` need no confirmation (UX). A page that is taken over can therefore run commands as the user; everything above limits what it reaches *without* a shell, and the renderer's own defences (sanitiser, CSP, no remote script) are what keep it from being taken over. Text from files typed into a terminal goes through `prepareRunText` / `claudePrompt` (control characters stripped, never Enter by default).
- **Processes:** Windows system programs only by absolute path (`backend/winsys.ts` `winSystemExe`; a bare name is looked up in the current directory = the open folder, guarded by `tests/unit/backend/winsys.test.ts`). A path inside a cmd.exe command line goes through `cmdQuote` (`main/terminal-shells.ts`).
- **Outbound requests: one feature, two hosts** (`main/update-check.ts`, "Security updates"). Off by default; main reads the setting `updates.check` itself and `check()` refuses while it is off (the page cannot make it go out, and passes one boolean, never a URL). `UPDATE_HOSTS` = `endoflife.date` + `api.osv.dev`, checked in the service before every fetch (`isAllowedUpdateUrl`: https, exact host, default port) and again by `webRequest` on its own in-memory session (`update-check` partition: no cookies, no cache, `User-Agent: update-check`, redirects are errors). Sent: a GET with nothing, and names + versions from `shipped-deps.json` — never an id, a path, a setting. **Don't add a host**, a header or a field: every extra host learns the user's IP and what they run; a new source needs the user's decision first (ask the lead). No timer: the renderer asks once after launch when visible (main applies the 7-day rule) and on "Check now"; failures stay quiet (`lastError` in Settings). Advisory text is untrusted: rendered as text, links rebuilt from the id (`vulnUrl`) or built from the version (`releases.electronjs.org`). Tests never use the real hosts: `SEC_EDIT_TEST_UPDATE_API=http://127.0.0.1:<port>` (test builds only; dropped when packaged) points both services at a local stub.
- **Packaged builds:** `scripts/fuses.mjs` sets the Electron fuses (RunAsNode **on** for the web-server child; NODE_OPTIONS and `--inspect` **off**), and `main/env-guard.ts` drops every `SEC_EDIT_*` variable but four harmless ones — a new test hook is automatically dead when packaged; don't add one that must work there. The packaged E2E therefore drives the app over Chromium's DevTools port (`tests/e2e/electron/packaged.spec.ts`).
- **Licences in packaged builds:** `package.mjs` writes `LICENSE.txt` (One, GPL-3.0-or-later), `LICENSE.electron.txt` and `THIRD-PARTY-NOTICES.txt` next to the executable (`scripts/notices.mjs`: every production package from the lockfile with its root licence files). When the build starts shipping a file a package bundles under **its own** licence (new pdf.js data in `vite.config.ts`, another native helper in `stage.mjs`), add that licence file to `BUNDLED_LICENCES`; a listed file that disappears fails the build.

## Running Playwright in parallel
Also pass a private results dir, or parallel runs clobber `test-results/`:
`SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer npx playwright test tests/e2e/<area> --output $PWD/.tmp/<area>/test-results`

## Version control (lead only)
- **Agents never run `git commit`, `git tag`, `git push` or anything that changes history.** The lead commits only verified-green states.
- Commits: short subject titles (e.g. "Add multi-core search indexing"), no long bodies, **no co-author / tool trailers or links**. Author = the repo-local identity.
- Before each release: `npm run security` (npm audit, outdated packages, newest Electron patch + end of support, fuses of a built package; exit 1 = fix first). Electron patches carry Chromium security fixes: take them every release.
- Each iteration ends with `npm run iteration -- "summary"` (bumps the minor version, commits `Release vX.Y.0`, adds an annotated tag).
