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
| `src/main/web-server*.ts`, `src/shared/web-server.ts`, `src/renderer/webserver/` ("Start web server": browser mode for the open folder as a child process, desktop only; `webserver/slot.ts` is the status-bar corner slot, the rest is the lazy `web-server-ui` chunk, which also carries the corner's MCP icon (`mcp/indicator.tsx`, re-exported: no extra chunk); Settings → Browser mode) | **shell** |
| `src/main/update-check*.ts`, `src/shared/update-check.ts`, `src/renderer/updates/`, `scripts/shipped-deps.mjs` ("Security updates": opt-in check for a newer Electron patch / end of support / known vulnerabilities in what the build ships, desktop only. Pure rules in `shared/update-check.ts`; requests, cache `<app data>/update-check.json` (findings + summary of what was checked) and the weekly rule in `main/update-check.ts`; `updates/slot.ts` is the status-bar corner slot, the rest (incl. `updates/summary.tsx`, the Settings summary) is the lazy `updates-ui` chunk loaded after the idle Popups chunk; Settings → Security updates. `build-node.mjs` writes `dist/main/shipped-deps.json` from the lockfile: names + versions of every non-dev package) | **shell** |
| `src/renderer/whitespace/` (trailing whitespace: paste trim via CodeMirror's `clipboardInputFilter`, trim on save through format's `beforeSave` hook in `src/format/install.ts`, the `editor.trimWhitespace` command; editor chunk only) | **variables** |
| `src/renderer/pdf/` (PDF viewer: lazy chunk `PdfView` on pdf.js's `PDFViewer`; `engine.ts` is the only place documents are opened — security options live there; `model.ts` pure helpers; pdf.js data assets copied by `vite.config.ts` → `pdfjs/`; the worker gets `PDF_WORKER_CSP` from `src/shared/pdf.ts` in `main.ts` / `server.ts`) | **pdf** |
| `src/mcp/`, `src/main/mcp*.ts`, `src/shared/mcp.ts`, `src/renderer/mcp/`, `build/windows/One MCP.cmd`, `build/linux/one-mcp.sh` (MCP server: a separate Node program, `dist/mcp/cli.mjs`, that MCP clients — LM Studio, Codex CLI, Claude — start over **stdio** with the app's executable in Node mode; one lazy `Workspace` + on-demand search / link indexes per shared folder; main owns `<app data>/mcp.json`; Settings → MCP server is the lazy `mcp-ui` chunk, zero startup bytes; the status-bar corner icon is `mcp/indicator.tsx` (slot `mcp/slot.ts`) in the idle web-server-ui chunk. `src/knowledge/sections.ts` (document map for `read_file` parts / `get_outline`) stays **knowledge**'s) | **mcp** |
| `src/renderer/nav/`, `src/shared/nav.ts` (Go back / forward: `nav/install.ts` is the startup stub — two key bindings, mouse side buttons, the buttons' state `navCan`, ~0.4 kB gzip; `nav/buttons.tsx` = the status bar's ← → (startup; with the stub's part ~0.4 kB gzip; shell's `StatusBar` renders them; → is the ← glyph mirrored in CSS); `nav/impl.ts` = recorder + restore + recent-places list, lazy on idle; `nav/places.ts` = list labels, lazy on first list; `nav/history.ts` = the pure stack) | **nav** |
| `src/renderer/bookmarks/`, `src/shared/bookmarks.ts` (Bookmarks panel: one lazy chunk `bookmarks/Panel.tsx` = UI + its store `store.ts` (re-exported) + `bookmarks.css`; startup = the panel registration and its `Mod-Alt-k` command in `app/shell.ts`, the glyph in `icons.tsx`. Storage = `BackendService.bookmarks(op?)` → `<app data>/bookmarks/<folder id>.json`, see Extension points) | **shell** |
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
  lazy chunk `knowledge/Connections.tsx` (reuses `overview/parts.tsx` + overview row classes); collapsed (its default)
  it computes only its header count — no lists, graph, related notes or mention scan. Section / sub-section open state
  is `overview/sections.ts`: the user's toggle wins (remembered), else the default (entries → open, 0 → closed; give a
  new list a `count`, `null` = "…" while unknown); `knowledge/graph-canvas.ts`
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
  **Buttons** (`nav/buttons.tsx`, setting `nav.buttons`, default on): `StatusBar` renders them **first in `.se-status`**
  (`← → │ folder · crumbs`; both sidebar styles), so they follow the status bar: zen hides them unless
  `zen.keepStatusBar` (keys + side buttons still work). The `│` is the group's `::after` (goes with the setting); the
  buttons share the `.se-status-item` / `.se-status-btn` rules (app.css). **The tab strip has no nav cell** (it had
  one in v0.5.1): `ShelfReveal` is its own ruled cell again — don't reserve strip space for them. Greyed out = `aria-disabled` (stays focusable),
  from the stub's `navCan` signals, which `impl.ts` `sync()`s only when the stack changes (never per keystroke).
  Right-click / long press / `Shift+F10` → `openPlaces` → `history.places(dir)` labelled by `describePlace`, in the
  shared context menu, **opened upwards** (`clientY: r.top - 4`: the menu host flips it to end over the button, like
  the status bar's folder menu); a pick is `jump(entry)` (`history.goTo`, the places in between stay).
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
- **Status bar layout** (shell, `app/StatusBar.tsx`): `← → │ folder · crumbs · save · git · vars ··· activity ·
  [Ln/Col · words · EOL · encoding · language · mode] │ MCP · :port · ⛨ n`. The far-right **corner** (`StatusCorner`,
  `.se-status-corner`, its `│` = `::before`) holds what is *on*: MCP server (`mcp/slot.ts`), web server
  (`webserver/slot.ts`), security findings (`updates/slot.ts`, always last). Normally it is empty and not rendered.
  **Corner slot pattern:** a startup `signal<ComponentType | null>` in `<area>/slot.ts` (just the signal); the lazy
  chunk sets it **only while its icon shows** and back to `null` otherwise (an `effect` on its status), so the corner
  and its `│` go when the last icon goes — never render `null` from a set slot. A new indicator = one slot + one
  fixed position in `StatusCorner` (startup cost ~40 B). Its component rides in an existing idle, desktop-only chunk
  (re-export it, like `installMcpIndicator` from `web-server-ui`; Popups calls it) rather than a new chunk, and
  imports only **types** from a shared module another lazy chunk uses (a value import splits that module out).
  Items after the spacer move left when the corner appears: keep corner icons rare (things that are on).
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
- **Zen mode** (shell, "View: Toggle zen mode", `Mod-Alt-z`; stub `app/zen.tsx`, the lazy chunk `app/zen-impl.ts` +
  `zen-strip.tsx` + `zen.css`; the toggle button is `ZenButton` in `app/Shelf.tsx`: shelf foot, classic icon bar, the
  left strip's foot, the tab strip's end): the flag is **`ui.zen`** (null = off, else the layout to restore). Entering
  saves sidebar visibility / panel, the overview, the process dock and the terminal panel, closes them through
  **their own signals** and goes full screen; leaving restores exactly that. Tabs stay; the sidebar and the overview
  (if it was open: `ui.zen.overviewVisible`) are **strips** (`.se-zen-strip`, lazy, resolved before the first zen
  frame: main.tsx awaits `preloadZenUi()` when restored). Showing a panel in zen (`sidebarVisible` /
  `overviewVisible`, by strip click or its shortcut) is a **peek**: `.se-zen-peek`, absolutely placed, rendered
  *after* `.se-content` and no-drag (Chromium: the last region box wins), closed by a press in `.se-main` outside
  peeks / strips, focus moving into `.se-content`, or `Esc`; never restored (`applySessionLayout`, skeleton cache).
  Status bar only with `zen.keepStatusBar`; `zen.fullScreen` (default on): desktop `zenFullScreen(on)` →
  `main/zen-fullscreen.ts` (remembers the pre-zen state, never leaves a full screen the user had, forgets its claim
  when the user leaves it; window-state.json keeps the pre-zen `maximized`), browser: Fullscreen API inside the
  toggle's gesture + `navigator.keyboard.lock(['Escape'])`. Leaving full screen from outside does **not** end zen.
  `zen.keepFileTree` is retired: a stored value is ignored. **Import `app/zen.tsx` only from startup modules no lazy
  chunk reaches** (Layout, shell, main.tsx), and add no new import to `Shelf.tsx` / `Tabs.tsx` for zen: either made
  rolldown split startup code into an extra chunk (a few hundred bytes more, measured). **Bundler, two more rules
  (measured with bookmarks):** a lazy chunk must not statically import `app/Shelf.tsx` (only classic.tsx does,
  grandfathered): the Bookmarks panel doing so split commands / fileops / settings into three extra startup chunks
  (+2.5 kB gzip). And every lazy chunk a startup module's `import()` reaches, **with its own static deps**, is a
  file name in the entry's preload table and an index on every such call site (see rule 2 for call sites): keep a
  feature in **one** chunk (the bookmarks store is re-exported by `bookmarks/Panel.tsx`, the sidebar-menu writes
  live in the Settings chunk) instead of a small shared one (~20–30 B gzip each). **Contract:** a panel that opens *itself* (not on a
  user action: auto-open on an event, a restored flag) must not while `ui.zen.value` is set; a user action may open
  it (a peek; leaving zen still restores the pre-zen layout). Saved in the session (`SessionState.zen`) and in the
  skeleton cache (`sec-edit-layout` `z` → `<html data-zen="on[ status][ ov]">` by theme-boot.js), so the first
  paint already has the strips.
- Calm file tree: setting `git.treeColors` (off = `gitUi.row()` / `Mark` draw nothing; drawing only, never a git run)
  and `tree.folderColors` (`hue` | `one` → `<html data-folders="one">`) + `tree.folderColor` (→ token
  **`--folder-color`**, derived per theme by `app/accent.ts` like the accent, cached as `sec-edit-folder` for
  theme-boot.js; unset = `--ft-folder`). Draw folder icons with `.se-ficon-folder` and they follow both.
- File tree selection (shell): **`ui.treeSelection` stays the focused row**; alone it is the selection, so callers
  that set it (reveal, new note, rename) keep working and simply drop a multi-selection. Several rows =
  **`ui.treeMulti`** `{ focus, anchor, paths }`, valid only while `focus === treeSelection` (a subscription in
  `ui.ts` clears it otherwise; the focus may be unselected after a Ctrl+click). Read with `ui.isTreeSelected(p)`,
  write with `ui.setTreeSel(sel | null, focus)`. The steps (toggle, range, prune of vanished rows, select all,
  open several, `topLevel()`) and the tree's keys (`treeKey(e, view)`) are the lazy `app/tree-select.ts`: FileTree
  `import()`s it on the tree's focus (the idle Popups chunk carries it too), so startup pays only for drawing
  (`.selected` / `.focused`, `.se-tree.multi`, the "N selected" foot). Keys pressed before it is in are claimed and
  replayed in order, a frame apart (rows re-render between): a new tree key goes into `treeKey`, not FileTree. Actions on several rows:
  `rowMenu(node, selection)` → `selectionMenu` in Popups (only multi-item actions; one-item ones are left out);
  `deletePaths` / `moveInto` take lists and reduce them with `topLevel()` themselves. A new multi-item tree action
  goes into `selectionMenu`; git adds its own through the optional `GitUi.menuMany(paths)`.
- **Sidebar panels and the sidebar menu** (shell): `app.registerPanel({ id, title, icon, order, component })` before the
  first render (an `installX()` in main.tsx; the glyph at startup: `icons.tsx` or the stub's `addIcons`, else the pill
  draws an empty box). Default places by `order`: Files 0 · Search 10 · Git 12 · **Bookmarks 20** │ Outline 30 ·
  Backlinks 31 · Tags 32. **Every bar is `ui.menuPanels(app.panels, settings['sidebar.panels'], open)`** (shelf pills,
  classic icon bar, zen strip; never map `app.panels` yourself). Setting `sidebar.panels` = `{ order, hidden }` (null =
  default), written only by `app/panel-menu.ts` (Settings → Appearance → Sidebar menu, `SidebarMenuSetting.tsx`; the
  pills' right-click "Hide …" reaches it through Settings' re-export, so it stays in the Settings chunk). **Merge rule**
  (pure, `tests/unit/app/panel-menu.test.ts`): stored order over the registered panels; a panel the order lacks (new
  in a later version) goes right after its default predecessor and is never hidden; stored ids nobody registers are
  skipped but kept in the setting (another build's panel keeps its place); the open panel shows while hidden; at
  least one entry stays; the default arrangement stores null. It runs in the first render (settings come with
  `bootstrap`; `applySessionLayout` restores `sidebarPanel` unchecked before the panels exist, so a hidden saved panel
  is in the first frame too): nothing jumps. A hidden panel must stay reachable: a key in `ui.PANEL_KEYS` (register
  that command yourself) or, without one, the generic palette command "View: Show <title>" (`shell-commands.ts`).
  Right-click menu: `Popups.panelMenu(id)` (Shelf's `panelMenu`, also used by classic).
- **Bookmarks** (shell, `src/renderer/bookmarks/`): workspace-relative POSIX paths + an optional label, **data only**
  (nothing in the backend touches a bookmarked path). One RPC, `bookmarks(op?)`: no argument reads; an op
  (`shared/bookmarks.ts` `BookmarkOp`: add / remove / move with `before`, label, rename) is validated by `cleanOp` /
  `cleanPath` (relative, `/` only, no `.` / `..` / empty segments, no drive / UNC / backslash / control characters;
  attack table in `tests/unit/bookmarks/model.test.ts`) and applied to the file **as it is on disk** under the file
  lock (desktop and browser mode share `<app data>/bookmarks/<folder id>.json`; never in the folder). The renderer
  applies the same op at once and takes the answer. Following renames: Popups' `movePath` reports every move made in
  One (`renamed(from, to, true)`: folders too, even empty ones), `file:renamed` per file, and outside renames are
  guessed from one watcher batch (`fsMoves`: same name elsewhere, or the only same-kind add in the same folder; never
  when ambiguous or re-added in place). A new way to rename / move in One calls `renamed(from, to, true)` from the
  bookmarks chunk. Missing targets (not in `app.tree`) are drawn greyed with Remove. Menu items: `bookmarkItem()` in
  Popups (tree row, selection via `topLevel()`, tab). Drops on the Bookmarks pill are delegated from the chunk
  (document listeners on `button[data-panel="bookmarks"]`): no startup code.
- MCP server (mcp, desktop: Settings → MCP server): `src/mcp/server.ts` puts the folder pool, the tools and the
  resources behind one `McpProtocol` (`protocol.ts`: JSON-RPC, dual-era — legacy `initialize` and the stateless
  2026-07-28 per-request `_meta`). The transport is separate: `stdio.ts` today; an HTTPS transport goes next to it as
  `http.ts` and drives the same `OneMcpServer`. **A new tool:** a flat-schema `ToolDef` in `src/mcp/tools/*`
  (`additionalProperties: false`, no top-level `oneOf`, a description on the tool and every parameter, name
  `^[a-zA-Z0-9_-]{1,64}$`, annotations set), every path through the folder's resolver (`folder.resolve` /
  `readText` / `list`), output paths from an index through `visibleOnly()`, answers sized by `env.limits()`
  (`mcp.maxReadKB` / `mcp.maxResults`, registry rows; a pinned web server cannot write `mcp.*`). A tool that changes
  files sets `write: true` (unlisted unless some folder is read-write) and refuses `folder.mode !== 'write'` itself
  (`inWritable` in `tools/write.ts`); its targets come from `folder.resolveTarget()` and it changes the disk only
  through `src/mcp/writes.ts` (Workspace write path + `folder.guard()` + a journal entry + `folder.changed()` for the
  indexes); its `ToolResult.journal` (never sent to the client) becomes the activity row's Revert.
  **Tokens are the budget** (main clients: small local models in LM Studio): tool definitions + `INSTRUCTIONS` ride along
  on every turn, so descriptions stay short, say each thing once (syntax in the tool, workflow in the instructions,
  per-call hints in the answer), and `tests/unit/mcp/budget.test.ts` pins their size — re-measure before raising it.
  Answers are **plain text** through `tools/format.ts` (`line()` = parts joined by " · ", `reply()`, `withBody()`, `P.*`
  shared params): one summary line (`path · etag … · lines 1-40 of 300 · more: offset_line=41`), then rows or the raw
  file text; a hint only when something was cut; errors one line `CODE: message`. Never JSON (keys repeated per row,
  escaped quotes). tools/list is a view (`describeTool`): `maxLength` is enforced by `checkArgs` but not advertised,
  `ServerHooks.hiddenParams` drops `folder` while one folder is shared (still accepted), annotations carry the title
  only for clients before 2025-06-18. Prefer a parameter or `mode` on an existing tool over a new tool; structured
  copies of query filters (`path`, `ext`…) are deliberately not parameters (`argHint` points the model at the query).
  stdout is the protocol channel: `cli.ts` imports `stdout-guard.ts` first; never write to stdout anywhere else.
- Browser state is per origin = per port: `cli.ts` remembers the last port per folder (`web-ports.json` in app data,
  `server/ports.ts`) and tries it first without `--port`; when it is busy, the ready handshake carries `busy` and the
  info panel says browser state starts empty.

### Global keybinding allocation (avoid conflicts)
| Owner | Keys |
|---|---|
| shell | `Mod-s` save, `Mod-w` close tab, `Mod-n` new note, `Mod-Shift-b` sidebar, `Mod-Alt-k` Bookmarks panel, `Mod-Alt-z` zen mode (also in `APP_KEYS_IN_TERMINAL`), `Mod-e` toggle edit/preview, `Mod-\` split, `Ctrl-Tab`/`Ctrl-Shift-Tab` tabs, `Mod-,` settings, `Mod-=`/`Mod--`/`Mod-0` zoom |
| search | `Mod-p`/`Mod-o` quick open, `Mod-Shift-p`/`F1` palette, `Mod-Shift-f` find in files, `Mod-Shift-h` replace in files, `Mod-Shift-o` go to heading, `Mod-t` workspace symbol/heading |
| format | `Shift-Alt-f` format document, `Mod-Alt-f` format selection/code block |
| editor (CM-local, not global) | `Mod-b` bold, `Mod-i` italic, `Mod-k` link, `Mod-f`/`Mod-h` in-file find/replace, `Mod-d`, `Mod-/`, `Mod-Enter` toggle checkbox, `Alt-Up/Down` move line, `Mod-Shift-v` paste exactly as copied (plain text, no trailing-whitespace trim, no smart paste), `/` slash menu, `Alt-F10` focus formatting toolbar, … |
| knowledge | `Mod-Alt-o` outline, `Mod-Alt-l` backlinks, `Mod-Alt-g` graph |
| git | `Mod-Shift-g` Source control panel, `Alt-F5` / `Shift-Alt-F5` next / previous change; pane-local `Mod-Enter` commit; diff view `F7` / `Shift-F7`, `Esc`, editable diff: `Mod-F7` revert the block at the cursor (compare: apply it to the right side), compare: `Mod-Shift-F7` apply the block at the cursor to the left side, `Mod-s` saves the diff's file(s) (key filter while it is open), `Mod-z` / `Mod-y` / `Mod-Shift-z` reach the diff's own undo when no editor in it has focus (window capture, only while a diff with an editable side is open) |
| overview | `Mod-Alt-b` toggle file overview (right sidebar) |
| nav | `Alt-ArrowLeft` / `Alt-ArrowRight` go back / forward (macOS: `Mod-[` / `Mod-]`); mouse side buttons (`button` 3 / 4, window capture, not a key). **Precedence:** global, so they beat CodeMirror's default `Alt-ArrowLeft/Right` (`cursorSyntaxLeft/Right`; on macOS `Mod-[` / `Mod-]` = indent less / more) as in VS Code — those stay in the palette ("Editor: Move cursor to syntax node start / end") and on `Tab` / `Shift-Tab`; `Shift-Alt-ArrowLeft/Right` (select syntax) is untouched. Not in `APP_KEYS_IN_TERMINAL`: in a focused terminal `Alt-←/→` stays readline's word move (the side buttons work there). On a focused ← → button (local, the browser's own context-menu keys): `Shift-F10` / `ContextMenu` open its recent-places list |
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
   **Startup bundle** (`node tests/perf/bundle-report.mjs <renderer dir>`; target < 100 kB, perf.spec): a module is
   never split by export, so a function only a lazy chunk calls still ships at startup when it lives in a startup
   module. Put it in that chunk, or in a module only that chunk imports (`app/file-rules.ts` → Popups; `setDocEol` /
   `cycleContentWidth` live in doc-chrome, `openFolderInteractive` in shell-commands). Every `import()` **call site**
   in a startup chunk repeats the target's preload list: startup modules load Popups only through `popups()`
   (`app/fileops.ts`; 11 sites were ~0.9 kB), do the same for any lazy chunk several startup modules import.
   `vite.config.ts` (`trackStartupChunks` + `modulePreload.resolveDependencies`) drops the startup chunks from every
   `import()` preload list: they are loaded before any import runs (~0.9 kB of no-op entries). index.html's own
   modulepreload links are untouched.
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
- **Path containment is two rules.** `Workspace.abs(rel)` is lexical only. Anything that touches the disk for ONE path goes through **`await ws.real(rel, leaf = 'follow' | 'entry')`** (`backend/workspace.ts`): same result as `abs()`, but `OUTSIDE_WORKSPACE` when a symlink / junction leads out of the folder (`'entry'` = act on the entry itself: delete, rename, reveal — only its folder must be real). Used by every file RPC and by main's `app://sec-edit/__ws/` route; a new file route (HTTP server included) must use it too. The tree walk and the watcher leave out links whose target is outside (`linkTarget`), so the index — all the indexer reads in bulk — holds no such path; on-request index reads (`readIndexedFiles*`) check paths the listing does not know. Links that stay inside the folder work as before (except in the MCP server's workspace, `links: 'skip'`).
- **Opening a folder is main's decision** (`main/open-gate.ts`): `rpc:openWorkspace` only passes for a path main saw itself — the folder dialog, launch / second-instance arguments, a drop (the preload reports the `File`'s path on `app:vouchPath`), a recent folder, a folder inside the open one, the folder of a vouched file. A new way to open a folder must `gate.vouch()` in main, never trust a path string from the page. E2E: `app.evaluate(() => globalThis.__secEditVouch(path))`.
- **Vault scope** (`main/vault.ts`, `shared/vault.ts`): folder-scoped keys (`<folder>::…`) are served only at or below the open folder (`vaultKeyInScope`); a shared `vault:<key>` another folder saved needs the user's OK in a **native** dialog (`confirmSharedKey`, grant kept in vault.json `grants`, owner in `owners`). Don't add a vault call that skips `check()` / `allowShared()`.
- **Terminal: residual risk, by decision.** `term:spawn` / `term:write` need no confirmation (UX). A page that is taken over can therefore run commands as the user; everything above limits what it reaches *without* a shell, and the renderer's own defences (sanitiser, CSP, no remote script) are what keep it from being taken over. Text from files typed into a terminal goes through `prepareRunText` / `claudePrompt` (control characters stripped, never Enter by default).
- **Processes:** Windows system programs only by absolute path (`backend/winsys.ts` `winSystemExe`; a bare name is looked up in the current directory = the open folder, guarded by `tests/unit/backend/winsys.test.ts`). A path inside a cmd.exe command line goes through `cmdQuote` (`main/terminal-shells.ts`).
- **Outbound requests: one feature, two hosts** (`main/update-check.ts`, "Security updates"). Two triggers, one boolean from the page (`check(manual)`, never a URL or host): **"Check now"** (`manual: true`) always goes — the user clicked, no confirm dialog; the **automatic** check (once after launch when visible, 7-day rule) needs the setting `updates.check` ("Check automatically every week", off by default), which main reads itself and refuses without. Accepted residual: a hijacked page could trigger a manual check; it sends only names + versions to the same two hosts, like any check. `UPDATE_HOSTS` = `endoflife.date` + `api.osv.dev`, checked in the service before every fetch (`isAllowedUpdateUrl`: https, exact host, default port) and again by `webRequest` on its own in-memory session (`update-check` partition: no cookies, no cache, `User-Agent: update-check`, redirects are errors). Sent: a GET with nothing, and names + versions from `shipped-deps.json` — never an id, a path, a setting. **Don't add a host**, a header or a field: every extra host learns the user's IP and what they run; a new source needs the user's decision first (ask the lead). No timer: the renderer asks once after launch when visible (main applies the 7-day rule) and on "Check now"; failures stay quiet (`lastError` in Settings). Advisory text is untrusted: rendered as text, links rebuilt from the id (`vulnUrl`) or built from the version (`releases.electronjs.org`); the summary (`UpdateStatus.summary`: Electron line, every package checked + its advisory count, timing, per-source error) is local only, cached in `update-check.json`, re-validated on read (`parseSummary`) and dropped when the build changes (`sameBuild`); its only links are the two fixed source pages (`EOL_PAGE`, `OSV_PAGE`). Tests never use the real hosts: `SEC_EDIT_TEST_UPDATE_API=http://127.0.0.1:<port>` (test builds only; dropped when packaged) points both services at a local stub.
- **Inbound access for AI clients: one feature** (`src/mcp`, Settings → MCP server). Off by default. Main owns
  `<app data>/mcp.json` (on/off, the folder allow-list, per-folder mode and `allowCode`, `undo`, token hashes; read-only
  by default); every widening step is a **native dialog** in main — turning on, sharing folders (only through main's
  folder dialog, `multiSelections`: the page never passes a path or a mode, `mcp:addFolder` takes no argument; every
  "Add folders…" step — one folder or several — gets exactly **one** native confirm (`foldersConfirm`) listing each
  alias + real path and, apart, every refused one with its reason — `folderProblem`, already shared, picked twice,
  over the limit; nothing to add = reasons + "OK" only; aliases in sorted path order. Its buttons **[Add read-only]
  [Add and allow changes] [Cancel]** (Cancel the default) and checkbox **"Also code and config files"** (counted only
  with allow changes; `folderChoice`) set mode and `allowCode` for every folder of that step, from the dialog's own
  response; nothing else asks for them), later per-folder widening — allowing writes, code files in a
  folder —, undo copies off, creating / regenerating / revoking a token; narrowing needs none. Grants never live in settings.json: `BackendService.saveSettings`
  drops every `mcp.*` key but the two result limits (`isMainOwnedKey`), and the server reads none from there.
  **Live files ("MCP active"):** a running stdio server keeps `<app data>/mcp-live/<pid>-<random>.json` (`src/mcp/live.ts`)
  holding only `{ v, pid, client (its token's name), started, lastCall }` — never a path, file name, query, text or
  token. Made after the token check, `lastCall` written at most every 5 s (a trailing write keeps the newest), temp +
  rename, removed on exit; an unwritable app data folder is skipped silently; nothing on stdout. Main
  (`McpService.watchSessions`, started 3 s after launch: `fs.watch` + a 15 s poll) lists them as
  `McpStatus.sessions` (`{ client, started, lastCall, idle }`, idle = no call for 2 min) and pushes changes over the
  existing `onChange`; files of processes that are gone (`process.kill(pid, 0)`, EPERM = alive) are removed, also at
  start; a file whose name and pid disagree is ignored. A reused pid is accepted (rare). Renderer: only the status-bar corner icon (`mcp/indicator.tsx`), which listens to `onChange` (no polling): shown while `enabled`, accent while `sessions` has entries, a 1 s pulse when the newest `lastCall` grows; click = Settings → MCP server at Recent activity (`revealActivity()` in mcp-ui).
  **Residual:** `excludeGlobs` is still a page setting, so a page can narrow the exclusions without a dialog
  (main-owned MCP excludes are a later item).
  **Access tokens** (`src/mcp/tokens.ts`, parsing in `shared/mcp.ts`; transport-neutral, a future HTTPS transport takes
  them as bearer tokens): `one_` + 43 base64url (256 random bits), one per client, named. At rest mcp.json keeps only
  `{ id, name, sha256, hint (4 chars), created, lastUsed }`; main also keeps the raw token encrypted with `safeStorage`
  (`mcp-tokens.json`, never `vault.json`, no `vault:*` key; no keyring → show-once). **The raw token never reaches the
  page:** `mcp:copySetup` / create / regenerate / turning on make main write the finished snippet to the clipboard and
  answer "copied" (copying again asks first, "Copy setup with the access token?"; any copy is cleared after 2 minutes if
  the clipboard still holds it); `McpStatus.tokens` carries names, dates, the hint. Clients pass it in `env` (`ONE_MCP_TOKEN`),
  **never argv** (every snippet; the CLI refuses any argument containing `one_` + 20 token characters, and no CLI message
  repeats an argument). `cli.ts` hashes it at
  startup, compares with `timingSafeEqual` against every stored hash, refuses (one stderr line, exit 1, no stdout) when
  missing / unknown / revoked, drops it from `process.env`, exits when it is revoked while running; audit rows carry the
  token's id and name, `lastUsed` is set by main from the activity log. Refused folders (`src/mcp/grant.ts` `folderProblem`): a drive root, the home
  folder itself, anything around the app data folder — checked by main when adding **and by the server for every
  mcp.json entry** (the file is not trusted). The server refuses to run while off or while settings.json exists but
  cannot be parsed (at run time it keeps the last good settings: exclusions never fail open), exits once switched off
  (it polls mcp.json); a removed folder fails every call in flight at its next disk step and never wakes again.
  **One resolver** for every path a tool or resource takes, `Folder.resolve()` (`src/mcp/folders.ts`): string rules
  first (`cleanPath`: no `..`, no absolute / drive / UNC / `\\?\` paths, `/` only, no control characters, no Unicode
  look-alikes, Windows name rules incl. 8.3 short names on Windows), then the one visibility rule (`Visibility`: dot
  segments and `KEY_FILE_GLOBS` built in — never from settings.json —, plus the user's excludeGlobs; case-, NFC- and
  NFKC-insensitive), then `Workspace.real()`, then **no links at all**: the MCP workspace runs with `links: 'skip'`
  (links are not listed, watched, indexed or followed), no part of a path may be a link, and the real path must equal
  the key exactly (no link, case or 8.3 alias of an excluded place). Reads re-check at the moment of the read
  (`readResolved`). Settings changes swap the visibility at once and drop the indexes (totals, tags, typo corrections
  never outlive an exclusion). Hidden answers `ENOENT` exactly like missing; messages carry the folder-relative path only
  — never a raw exception message (Node's carry host paths). Searches never run a regex (`noRegex`; `path:` globs use
  `globSearch`, a state-set matcher); structure parsing (`shared/markdown-lines.ts`, `knowledge/sections.ts`) is linear
  and skips lines over 10k characters — keep it that way, the desktop app parses the same notes. At most 4 calls run at
  once; JSON-RPC batches are refused. Never imports `src/main/vault*`, never reads `vault.json`, never resolves
  `{{variables}}`; no git, terminal, settings writes, network (stdio only) or processes of its own (only the shared
  watcher's fixed `wsl.exe inotifywait` backend for `\\wsl.localhost` roots, and `backend/trash.ts`'s fixed Recycle Bin
  call for `delete`) — `tests/unit/mcp/isolation.test.ts` checks the esbuild metafile of `cli.ts`;
  `tests/unit/mcp/paths.test.ts`, `review*.test.ts` and `tokens.test.ts` have a case per attack. Test hooks `SEC_EDIT_TEST_MCP_CONFIRM` /
  `SEC_EDIT_TEST_MCP_FOLDER` (`path.delimiter`-separated = several picks; each confirm is logged as `[sec-edit:mcp-confirm]`) exist in main only; the Node-mode server applies env-guard's scrub itself when it runs from
  `app.asar.unpacked` (`src/mcp/env-boot.ts`), so `SEC_EDIT_CONFIG_DIR`, `SEC_EDIT_TRASH_DIR` and the `SEC_EDIT_MCP_*`
  knobs work in dev and tests only.
  **One switch for writes:** `MCP_WRITES_ENABLED` (`src/shared/mcp.ts`, now `true`). `false` ships a read-only build:
  the server serves every folder read-only (as `--read-only`), main refuses Read-write (`ENOTSUP`), Settings shows it
  disabled; tests keep the write code covered (`writes: true` / `writesEnabled: true`) and one asserts the gate.
  **Writes** (read-write folders only; `--read-only` removes them; `Folder.checkWritable()` in the tool and again in the
  guard; a per-session quota, `WriteQuota`): every target through `Folder.resolveTarget()` (hidden / key / excluded
  names, links, hard links, spelling aliases → one neutral `EACCES: Cannot change <path>`, so exclusions cannot be
  probed; file types by `writeTypeProblem`: notes `.md .markdown .txt` only unless the folder has `allowCode` (mcp.json),
  `NEVER_EXTS` (shell / script / shortcut types incl. `.js` `.py`) never; no part may be a link; the existing part spelled
  exactly as asked), then the existing `Workspace` write path (atomic, EOL / BOM / encoding kept, Windows-1252 text it
  cannot hold refused) with `folder.guard()` as its `WriteGuard`: inside the path's exclusive slot right before the disk
  changes it re-checks that nothing on the path is a link (no write through one, no swapped-in link to `.git/hooks`),
  the spelling, the visibility, the precondition (etag = mtime + size; a whole-file overwrite needs `if_match`) and
  captures the bytes being replaced (and reserves their journal room: `EQUOTA` aborts before the disk changes). The guard
  is `strict`: the Workspace then refuses a link or hard link at commit, never rewrites in place, creates folders one level
  at a time, re-verifies the parent's realpath before and after the write / rename (and takes a landed entry back), pins
  the file a write replaces with a hard link next to it (`.~*.sec-edit.bak`, dev/ino must equal the guarded file; no hard
  links on the volume → the same check on the name) and puts it back when the folder moved, and renames without
  clobbering (`link` + `unlink`, `EEXIST` for a file created in the window; the source must still be the guarded entry
  (dev/ino) in its verified folder before the link and before its old name goes; a failed `unlink` removes the new link).
  A strict delete trashes only the guarded entry (dev/ino). Residual: a swap between the last check and the rename
  syscall itself. **Placeholders** (`src/mcp/placeholders.ts`): variables files (`variables.fileName`, any folder) are
  off limits; frontmatter `vars` / `target` / `env` / `secrets` are compared **as parsed** (yaml `parseDocument`, keys
  by scalar value, like `parseNoteMeta`), and quoted / explicit / tagged / flow / duplicate spellings or frontmatter that
  does not parse are refused; fence `{…}` attribute lines (any container) are frozen. Secret names (`secrets:`, `vault`
  / `vault:*` values incl. `T.field` and the bare field, note frontmatter, closed over values, **and every name nothing
  defines** — One fills those from remembered form values; built-ins only while not redefined) are frozen **note-wide
  without a markdown parse**: no edit adds or changes a line holding one (multi-line `{{\n name }}` and `>`-prefixed
  forms included) or adds an occurrence; the lines directly above and below each one stay exactly as they are (or stay
  absent: start / end of file) — that alone stops any block grammar from turning a secret line into a new code block;
  the fence lines down to the last secret line stay as they are. On top, every markdown-it `fence` / `code_block` that
  holds a secret cannot change at all, parsed with One's preview options, footnotes and **One's own block rules**
  (`src/shared/md-block-rules.ts`: frontmatter, `%%`, `$$`, `\pagebreak`; the preview registers the same module, so a
  new preview block rule goes there). Residual (later item: a One-side warning on Run for AI-written blocks): a new
  block without placeholders may still use a shell variable a frozen secret block exported. No variables file between note and share root → every non-built-in name is secret. Moves check
  both places; the server never resolves a value. **Sweeping or unrevertable changes ask the user through MCP, never an OS dialog**
  (`tools/write.ts` `askUser`, `confirm.ts`): a folder delete (alone or in a batch), a batch delete of more than
  `MCP_CONFIRM_OVER` (10, `shared/mcp.ts`) items, a `replace_in_files` over more than 10 files; one question per call.
  Everything else is unconfirmed (Revert covers it; batch moves lose nothing). The question is built by the server only:
  sanitized folder-relative paths (no control / bidi / zero-width characters, quotes replaced, parts cut at 40, the
  whole at 120), counts, the size (lstat sums, never contents), at most 3 hidden names, find / replace text cut at 60;
  no other argument text. Legacy clients that declared form elicitation (2025-06-18+) get `elicitation/create` (our
  ids `one-ask-N`, 120 s, then `notifications/cancelled`); 2026-07-28 clients that declared it get `resultType:
  "input_required"` (MRTR) with an HMAC-sealed, expiring, single-use `requestState`; others two steps (a summary plus a
  one-time code: random, 5 min, spent on use). Answer and code are bound to the exact operation (`target`: tool, folder,
  path set or find + replace + scope + case) and a fingerprint of the contents (every entry / file stamp): anything else
  or changed contents asks again. Only `accept` with `confirm: true` proceeds, after a re-survey. Folder trash: one call
  per folder, no journal copy (hidden contents are never read): audit row `delete (folder)`, note "restore from the
  Recycle Bin", no Revert. **Windows: by the user's choice no Recycle-Bin pre-check and no Windows prompt
  (`OnlyErrorDialogs`): a bin that is off or too small deletes the folder permanently, and the question says so**;
  refused off fixed local drives (exit 3) and for a reparse point (exit 4). macOS only on the home volume; Linux the
  same-device XDG trash. Batches (`paths`, max 100; `replace_in_files`, max 200 changed files) run item by item past
  failures, one answer line per item, one journal group (one Revert; folder entries have none), one audit row with
  `items`; **`undo`** (`tools/write.ts` `undoGroup`): only a group this server process made (`Journal.ownGroup`: the
  full id or the 8-character code answers show; anything else → `EACCES: only changes from this session can be undone
  here; use Revert in One`), only in its folder while still shared and writable, all or nothing via
  `revertGroupReport` (the same preconditions as One's Revert; every changed file is named), once only (the shared
  `reverted` mark), one quota unit, no confirmation; the answer is counts only, never content; folder deletes are
  `trash` notes in their group (no copy): "restore … from the Recycle Bin"; batch `move` keeps the subfolders below the common parent of `paths` (`batchDestinations`; `flat` = all
  directly in `to_folder`, `to_paths` = one destination each), makes missing parents level by level (strict
  `mkdirStrict`, through the resolver's destination check), reuses existing folders, never overwrites a file and never
  merges a folder into an existing one of the same name (EEXIST with a hint); the quota counts each changed item. `replace_in_files`: `find` is literal (escaped, never a regex), `query`
  takes file filters only (`in:` refused) via the search parser in `noRegex` mode; visible, type-allowed text files;
  each file through `overwrite` (stamp guard + placeholder rules: files that would touch a secret line are skipped and
  named). `replace_text all` refuses the whole call when any match touches a secret line or its neighbour (names the
  lines). Folder `move` takes hidden items along (walked, never read); refused: links / special files inside, any entry
  whose visibility would change, hidden files when the nearest variables file differs; caps 10,000 visible files,
  200,000 entries. Binary files are never
  written, moved or deleted; deletes go to the Recycle Bin only (`ETRASH`, nothing deleted, when there is none); a file delete always
  keeps a journal copy, even with undo off (or is refused); folder deletes and moves: see above. **Journal**
  (`src/mcp/journal.ts`, `<app data>/mcp-history/<group>/`, mcp.json `undo { on, days }`, 100 MB cap, 64 MB per
  session): old bytes per change; groups of the running session and of the last 24 h are never evicted (new writes get `EQUOTA` instead; two busy
  sessions can thus block MCP writes for up to 24 h — fails closed, by design). Revert runs in
  **main** (`McpService.revert`, `mcp:revert`) only while the folder is still shared, through the same resolver and guard,
  all or nothing, only onto files still as MCP left them; it is restorative, so it also works once the folder is
  read-only again. MCP-written notes get no special trust: they render through the normal sanitizer like any outside edit. Tests
  never use the real trash: injected trash or `XDG_DATA_HOME` / `HOME` under `.tmp/` (`tests/unit/mcp/writes.test.ts`).
- **One's own data folder is never served** (settings, mcp.json, the vault, git trust, the text cache, bookmarks): `BackendService`
  opens every workspace with `deny: [configDir, cacheDir]`, and `Workspace.real()` refuses (`EACCES`) any path inside a
  denied folder — as written or where it really is — and the walk leaves it out. It matters when the open folder
  contains it (the home folder on Windows: `AppData` is no dot name): a page taken over cannot rewrite `mcp.json`.
- **Packaged builds:** `scripts/fuses.mjs` sets the Electron fuses (RunAsNode **on** for the web-server child and the MCP server; NODE_OPTIONS and `--inspect` **off**), and `main/env-guard.ts` drops every `SEC_EDIT_*` variable but four harmless ones — a new test hook is automatically dead when packaged; don't add one that must work there. The packaged E2E therefore drives the app over Chromium's DevTools port (`tests/e2e/electron/packaged.spec.ts`).
- **Licences in packaged builds:** `package.mjs` writes `LICENSE.txt` (One, GPL-3.0-or-later), `LICENSE.electron.txt` and `THIRD-PARTY-NOTICES.txt` next to the executable (`scripts/notices.mjs`: every production package from the lockfile with its root licence files). When the build starts shipping a file a package bundles under **its own** licence (new pdf.js data in `vite.config.ts`, another native helper in `stage.mjs`), add that licence file to `BUNDLED_LICENCES`; a listed file that disappears fails the build.

## Running Playwright in parallel
Also pass a private results dir, or parallel runs clobber `test-results/`:
`SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer npx playwright test tests/e2e/<area> --output $PWD/.tmp/<area>/test-results`

## Version control (lead only)
- **Agents never run `git commit`, `git tag`, `git push` or anything that changes history.** The lead commits only verified-green states.
- Commits: short subject titles (e.g. "Add multi-core search indexing"), no long bodies, **no co-author / tool trailers or links**. Author = the repo-local identity.
- Before each release: `npm run security` (npm audit, outdated packages, newest Electron patch + end of support, fuses of a built package; exit 1 = fix first). Electron patches carry Chromium security fixes: take them every release.
- Each iteration ends with `npm run iteration -- "summary"` (bumps the minor version, commits `Release vX.Y.0`, adds an annotated tag).
