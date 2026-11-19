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
| `src/backend/git*.ts`, `src/shared/git.ts`, `src/renderer/git/` (status, tree marks, change bars, diff view, Source control pane; one `git(op, …)` RPC; the startup stub `git/install.ts` fills `gitUi` slots that FileTree / StatusBar / Popups / the editor read). **When** git runs is decided only by `backend/git-monitor.ts` (debounce, single-flight, adaptive interval, paused while hidden, multi-repo); `backend/git-wsl.ts` runs git inside WSL for `\\wsl.localhost` roots; every spawn is logged via `backend/git-activity.ts`. Read paths never write the repository; the one exception is the monitor's opt-out index stat-cache refresh (`GitService.refreshIndex`: hooks off, skipped while `index.lock` exists, never killed). Don't add renderer-side status polling: report triggers instead (`git('nudge')`, `git('visibility')`) | **git** |
| `src/renderer/variables/`, `src/main/vault*.ts`, `src/shared/vault.ts` ({{variables}}, environments / targets, secrets vault, smart paste; the editor chunk holds only `variables/cm.ts`, the rest is the lazy `variables` chunk; `variables/slot.ts` is the status-bar slot) | **variables** |
| `src/renderer/whitespace/` (trailing whitespace: paste trim via CodeMirror's `clipboardInputFilter`, trim on save through format's `beforeSave` hook in `src/format/install.ts`, the `editor.trimWhitespace` command; editor chunk only) | **variables** |
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
- Indexing (search + knowledge read the same paged text stream, `app/workspace-text.ts`): the backend skips
  git-ignored files, lockfiles, `*.min.*` / `*.map` and files over `search.maxFileSizeKB` (`Workspace.textPaths()`;
  the tree still lists them), reads in worker threads and keeps a text cache in the app's data folder (never the workspace).
  Search is sharded over workers (`src/search/shards.ts`, exact two-phase merge — keep `tests/unit/search/shards.test.ts` green).
  Emit `app.events.emit('index:stale')` after a setting that changes what is indexed (both indexes rebuild).
- Shared helpers: `src/shared/paths.ts` (POSIX rel paths), `src/shared/languages.ts` (ext/fence → CM/Shiki/Prettier ids),
  `src/shared/wikilinks.ts` (parse + resolve `[[links]]`).
- Global `window.__secEdit` = `app` (for E2E introspection). `html[data-ready="true"]` once booted.
- Terminal (desktop only): `app.runInTerminal?.(code, { lang })` pastes a shell code block into the terminal
  (never presses Enter by default) — feature-detect it, it is unset in the browser. `isRunnableFence(lang)` from
  `src/renderer/terminal/run.ts` (dependency-free) says which fences get a "Run in terminal" button.
  Keys a focused widget must keep from the global keymap: `setGlobalKeyFilter()` in `commands.ts` (the terminal uses it).
  Terminals use their own `term:*` IPC channels (`src/shared/terminal.ts`), not `RPC_METHODS`: they need the sender's identity.
- Variables: `app.variables` (`VariablesApi` in `src/renderer/variables/api.ts`) — `renderHook(path)` for markdown-it
  (`RenderOptions.vars`; export passes `{ export: true }`), `copyCode` / `runCode` / `forTargets` for code-block buttons
  (resolve placeholders, ask for missing values), `prepare(path)` before an export. Event `variables:changed` = re-render.
  Precedence lives in ONE function: `lookup()` in `variables/resolve.ts`. Secrets: `vault:*` IPC (`src/shared/vault.ts`,
  safeStorage in `src/main/vault.ts`); browser mode keeps them in memory only. Per-folder env / target / remembered
  values: localStorage `sec-edit-vars:<root>` (not settings: the registry test guards every dotted key that is read).

### Global keybinding allocation (avoid conflicts)
| Owner | Keys |
|---|---|
| shell | `Mod-s` save, `Mod-w` close tab, `Mod-n` new note, `Mod-Shift-b` sidebar, `Mod-e` toggle edit/preview, `Mod-\` split, `Ctrl-Tab`/`Ctrl-Shift-Tab` tabs, `Mod-,` settings, `Mod-=`/`Mod--`/`Mod-0` zoom |
| search | `Mod-p`/`Mod-o` quick open, `Mod-Shift-p`/`F1` palette, `Mod-Shift-f` find in files, `Mod-Shift-h` replace in files, `Mod-Shift-o` go to heading, `Mod-t` workspace symbol/heading |
| format | `Shift-Alt-f` format document, `Mod-Alt-f` format selection/code block |
| editor (CM-local, not global) | `Mod-b` bold, `Mod-i` italic, `Mod-k` link, `Mod-f`/`Mod-h` in-file find/replace, `Mod-d`, `Mod-/`, `Mod-Enter` toggle checkbox, `Alt-Up/Down` move line, `Mod-Shift-v` paste exactly as copied (plain text, no trailing-whitespace trim, no smart paste), `/` slash menu, `Alt-F10` focus formatting toolbar, … |
| knowledge | `Mod-Alt-o` outline, `Mod-Alt-l` backlinks, `Mod-Alt-g` graph |
| git | `Mod-Shift-g` Source control panel, `Alt-F5` / `Shift-Alt-F5` next / previous change; pane-local `Mod-Enter` commit; diff view `F7` / `Shift-F7`, `Esc` |
| overview | `Mod-Alt-b` toggle file overview (right sidebar) |
| terminal | ``Mod-` `` toggle / focus / hide panel, ``Mod-Shift-` `` (+ `Mod-Shift-~`) new terminal |
| terminal (xterm-local, focused terminal only) | `Mod-Shift-c`/`Mod-Shift-v` copy/paste, `Mod-f` find, `Shift-Insert`/`Ctrl-Insert`; Windows also `Ctrl-c` (with a selection) / `Ctrl-v`; macOS `Cmd-c/v/f/a/k` |

While a terminal has focus **only** `APP_KEYS_IN_TERMINAL` (`src/renderer/terminal/keys.ts`) reach global commands on
Windows/Linux — everything else goes to the shell (readline's `Ctrl-w/e/n/t/k/b/r`, F-keys for htop/mc). Add a key
there only if it must beat the shell.

## Rules
1. **Paths**: everything crossing the backend boundary is workspace-relative POSIX (`notes/a.md`). Never build paths with `\`.
   Windows matters: CRLF files (content is LF-normalised, EOL restored on save), case-insensitive FS, drive letters, `\\` in absolute paths.
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
7. Keep the renderer secure: `contextIsolation`, sandboxed preload, DOMPurify on all rendered HTML, no `eval`.
8. No new top-level frameworks (no React/Vue/Tailwind). Small focused libs are fine.
9. Code comments explain *why*, briefly.

## Running Playwright in parallel
Also pass a private results dir, or parallel runs clobber `test-results/`:
`SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer npx playwright test tests/e2e/<area> --output $PWD/.tmp/<area>/test-results`

## Version control (lead only)
- **Agents never run `git commit`, `git tag`, `git push` or anything that changes history.** The lead commits only verified-green states.
- Commits: short subject titles (e.g. "Add multi-core search indexing"), no long bodies, **no co-author / tool trailers or links**. Author = the repo-local identity.
- Each iteration ends with `npm run iteration -- "summary"` (bumps the minor version, commits `Release vX.Y.0`, adds an annotated tag).
