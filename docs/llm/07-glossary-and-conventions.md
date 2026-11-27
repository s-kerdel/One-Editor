# 07 - Glossary and conventions

> **WHEN TO READ THIS:** a word in the code or docs is unclear, or you must name a new thing.
> **WHAT YOU GET:** naming rules, file layout, code style, commit/release rules, and the project's terms.
> **NEXT FILE:** `08-worked-examples.md`

## Naming (copy these patterns exactly)

| Thing | Pattern | Real examples |
|---|---|---|
| module file | `kebab-case.ts` | `settings-registry.ts`, `disk-sync.ts`, `git-monitor.ts` |
| component file | `PascalCase.tsx` | `FileTree.tsx`, `StatusBar.tsx`, `SettingsOverlay.tsx` |
| CSS file | next to its module, kebab-case | `src/renderer/bookmarks/bookmarks.css` |
| CSS class | `se-` prefix | `.se-tree-row`, `.se-status-corner`, `.se-no-drag` |
| startup stub function | `installX()` | `installNav()`, `installTerminal()`, `installGitLazy()` |
| command id | `category.action` | `file.save`, `view.toggleZen`, `nav.back` |
| command title | `Category: Action` | `File: Save`, `View: Toggle zen mode` |
| key spec | CodeMirror style | `Mod-Shift-p`, `Alt-ArrowLeft`, `Ctrl-Tab` |
| setting key | `area.name` (dotted) | `nav.buttons`, `git.enabled`, `terminal.fontSize` |
| setting DOM id | `set-` + key with `-` | `set-nav-buttons` (made by `idFor`) |
| app event | `noun:verb` | `doc:saved`, `active:changed`, `index:stale` |
| IPC channel | `family:name` | `rpc:readFile`, `term:spawn`, `vault:get`, `fs:events` |
| error code | upper-case | `ENOENT`, `EINVAL`, `EACCES`, `ENOTSUP`, `OUTSIDE_WORKSPACE`, `NO_WORKSPACE`, `EXTERNAL_CHANGE` |
| env variable | `SEC_EDIT_*` | `SEC_EDIT_CONFIG_DIR`, `SEC_EDIT_TEST` |
| localStorage key | `sec-edit-*` | `sec-edit-layout`. Never keyed by folder: per-folder values go in `SessionState` (`folderValue`) |
| unit test | `tests/unit/<area>/<name>.test.ts(x)` | `tests/unit/app/panel-menu.test.ts` |
| browser E2E | `tests/e2e/<area>-<name>.spec.ts` | `tests/e2e/nav-buttons.spec.ts` |
| Electron E2E | `tests/e2e/electron/<name>.spec.ts` | `tests/e2e/electron/terminal.spec.ts` |
| MCP tool name | `snake_case` | `list_tags`, `get_links`, `write_file` |

**Never** create two files whose names differ only by case.

## File layout rules

- One area = one folder under `src/renderer/<area>/` (+ `src/<area>/` for pure logic, + `src/shared/<area>.ts` for shared types).
- A feature = a **tiny startup stub** (`install.ts` or `index.tsx`) + **one lazy chunk** (the rest).
- Pure logic (no DOM, no Node) goes where it can be unit-tested without a browser: `src/shared/`, `src/search/`, `src/knowledge/`.
- Every source file starts with a short comment: what it is and why it exists. Keep that habit.

## Code style (match the file you edit)

| Rule | Detail |
|---|---|
| Language | TypeScript, `strict`. No `any` unless the neighbours use it for the same thing. |
| Formatting | 2 spaces, single quotes, semicolons, trailing commas. Long lines are normal here. **Do not reformat.** |
| UI | Preact function components + `@preact/signals`. Read `signal.value` in render; it re-renders. |
| State | signals on `app` or in `ui.ts`. No new global store. |
| Imports | relative within an area; `@shared/...` for `src/shared/`. Types: `import type`. |
| Comments | brief, explain **why**. No "what" comments. |
| Errors (backend) | `throw new BackendFailure(code, message)` |
| Errors (renderer) | `app.toast(message, 'error')`; text via `errText(err)` |
| User text | sentence case, plain words, no jargon. "Could not save settings: ..." |
| Optional features | feature-detect: `app.runInTerminal?.(...)`, `app.backend.git?.(...)` |

## Commit and release conventions (lead only - you never commit)

- **Agents never run** `git commit`, `git tag`, `git push` or anything that changes history.
- Commit author = the repo-local identity (a GitHub `noreply` address). Do not change git config.
- **Commit subject = one line that sums up the feature in plain words**, as the user sees it. It may be long (100-350 characters).
  - Shape: `Area: what changed; next change; next change` (parts split by `;`). Example start: `Git: "git didn't answer in time" is one sentence with a Retry ...`.
  - Small fixes keep a short subject (`Expect the one-dialog folder share in the desktop MCP test`).
- **No body. No co-author trailers, no tool links.**
- **One annotated tag per iteration, as a patch bump:** `v0.5.4` -> `v0.5.5` -> `v0.5.6`. Current version: `v0.5.5`.
- The release commit is titled `Release v0.5.x` (same number as the tag and as `version` in `package.json`).
- **`npm run iteration` bumps the MINOR version** (`v0.5.5` -> `v0.6.0`). That is not what the tags do. **Ask the lead before running it.**
- Before a release the lead runs `npm run security` and the full suites once, in a snapshot worktree.
- Only versioned zips go into `release/`.
- Details: section "Version control (lead only)" at the end of `09-reference-rules.md`.

Your part ends at the hand-over report (`00-START-HERE.md` step 10).

## Glossary

| Term | Meaning |
|---|---|
| **One** | the product name users see (`BRAND` in `src/shared/brand.ts`). Internal name, data folder and env prefix stay `sec-edit`. |
| **workspace** / **open folder** | the one folder the user opened. Class `Workspace` (`src/backend/workspace.ts`). No vaults. |
| **rel path** | workspace-relative POSIX path, `''` = the root. Type `RelPath`. |
| **external file** | a file outside the open folder, opened as a tab. Its id starts with `::ext:` (`src/shared/external.ts`). |
| **backend** | `BackendService`: the same code behind Electron main and the HTTP server. In the renderer: `app.backend`. |
| **desktop** / **Electron mode** | the Electron app. `app.backend.kind === 'electron'`. |
| **browser mode** / **web** | the UI served by `src/server/` to a normal browser. `kind === 'web'`. |
| **pinned server** | every server `cli.ts` starts (`pinRoot`): only its folder arguments and folders inside them. **`shared`** (desktop or LAN) also hides machine info (`SHARED`). |
| **bridge** | `window.secEditBridge`, exposed by `src/main/preload.ts`. Exists only on the desktop. |
| **RPC** | a request/response backend call listed in `RPC_METHODS`. |
| **shell** | (1) the app frame area: layout, tree, tabs, settings (`src/renderer/app/`). (2) a terminal shell. Context decides. |
| **startup chunk** / **stub** | code loaded before first paint. Must stay tiny. |
| **lazy chunk** | code loaded later with `import()`. |
| **Popups chunk** | `src/renderer/app/Popups.tsx`: dialogs, context menus, pickers. Loaded on idle. |
| **panel** | a sidebar view registered with `app.registerPanel` (Files, Search, Git, Bookmarks, ...). |
| **shelf** / **classic** | the two sidebar styles (`sidebarStyle`). Root class `.ui-shelf` / `.ui-classic`. |
| **overview** | the right column with outline, tasks, connections (`src/renderer/overview/`). |
| **zen** | distraction-free mode (`ui.zen`). Panels become strips and peeks. |
| **status corner** | far-right status-bar area for things that are *on* (`StatusCorner`). |
| **slot** | a `signal<ComponentType \| null>` that a lazy chunk fills (`src/renderer/mcp/slot.ts`). |
| **knowledge** | wikilinks, backlinks, tags, graph (`src/knowledge/`). |
| **wikilink** | `[[note]]`, `[[note#heading]]`, `[[note#^block]]`. |
| **live / source / split / preview** | the four `viewMode` values of a Markdown note. |
| **index** | the search + link index built from workspace text. May be built on demand. |
| **shard** | one search worker holding part of the index (`src/search/shards.ts`). |
| **defs** | the code-symbol index used by Go to definition. |
| **trust gate** | git runs only in folders the user trusted (`src/backend/git-trust.ts`). Trust is granted only in main's native box (`confirmTrust`). |
| **monitor** | `GitMonitor`: the only thing that decides when git status runs. |
| **open gate** / **vouch** | main only opens folders/files it saw itself (`src/main/open-gate.ts`). |
| **vault** | encrypted secrets store for `{{variables}}` (`src/main/vault.ts`). |
| **variables** | `{{name}}` placeholders in notes, with environments and targets. |
| **follow** | showing files an AI agent terminal edits, as it edits them (`claude.follow`, `opencode.follow`). |
| **AI changes** | the sidebar panel listing files an agent terminal changed. |
| **MCP** | Model Context Protocol server (`src/mcp/`): lets AI clients read/write shared folders. |
| **journal** | undo history of MCP writes (`src/mcp/journal.ts`). |
| **app data** | the config folder (`defaultConfigDir()`): settings, sessions, bookmarks, mcp.json. Never the open folder. |
| **session** | per-folder UI state (open tabs, layout, `{{variable}}` values, remote-images choice, recent files): `SessionState`. |
| **windowless launch** | `One --mcp-stdio` / `One --serve`: the MCP or web server in One's own process, no window (`src/main/launch-mode.ts`). |
| **stale realm** | the old page of a window after an in-place folder switch: refused by main until it reloads (`staleRealm`). |
| **lead** | the human or main agent that integrates, runs the full suite and commits. |
| **iteration** | one release cycle: features -> one combined test run -> tag. |
| **Mod** | Ctrl on Windows/Linux, Cmd on macOS. |
| **fixture** | `tests/fixtures/workspace/`, copied fresh for each test worker. |
