# 03 - Playbooks (step-by-step recipes)

> **WHEN TO READ THIS:** you know the task type and want the files to touch, in order.
> **WHAT YOU GET:** 8 recipes (A-H). Each: files in order + the existing example to copy.
> **NEXT FILE:** `05-testing-and-verify.md`

**For every recipe:** open the "copy from" example first. Copy it. Change the minimum.
Line numbers are approximate. Find the exact spot with the grep shown.

---

## A. Add a setting

**Copy from:** `confirmDelete` (one-line toggle) or `nav.buttons` in `src/renderer/app/settings-registry.ts`.

```bash
grep -n "key: 'confirmDelete'\|key: 'nav.buttons'" src/renderer/app/settings-registry.ts
```

| # | File | Do |
|---|---|---|
| 1 | `src/renderer/app/settings-registry.ts` | Add one object to `defs` inside the right section block: `key`, `section`, `label`, `description` (**one line, max 100 chars**), `default`, `control`. |
| 2 | (your feature file) | Read it: `app.settings.value['area.name']`. Treat a missing value as the default (`!== false` for a default-on toggle). |
| 3 | `tests/unit/settings/registry.test.ts` | Nothing to add. Just run it (step below). |
| 4 | `docs/USER-GUIDE.md` | One line about the setting. |

**Rules**
- **Use a dotted key**: `area.name` (`nav.buttons`, `git.enabled`). No edit in `src/shared/api.ts` is needed (`Settings` has an index signature).
- `section` must be an existing `SectionId`. `control.type` must be an existing `Control` type (`toggle`, `segmented`, `select`, `number`, `text`, `list`, ...).
- `select` / `segmented` options must contain the default value.
- Desktop only: add `desktopOnly: true`.
- Terminal settings go in `TERMINAL_SETTING_DEFS` in `src/renderer/terminal/settings.ts` instead.
- Changes what gets indexed: add the key to **both** `INDEX_KEYS` lists (`src/backend/service.ts`, `src/renderer/app/settings-sync.ts`).
- Write from code with `updateSettings({ 'area.name': value })` (`src/renderer/app/settings.ts`). Never call `saveSettings` directly from UI code.

```bash
npx vitest run tests/unit/settings/registry.test.ts
```

---

## B. Add a command / keyboard shortcut

**Copy from:** `view.bookmarks` in `src/renderer/app/shell.ts` (with a key) or any entry in `registerShellCommands` in `src/renderer/app/shell-commands.ts` (no key).

| # | Do |
|---|---|
| 1 | **Check the key is free:** table "Global keybinding allocation" in `09-reference-keys.md` + `grep -rn "Mod-Alt-x" src/renderer`. |
| 2 | **Has a global key:** add `{ id, title, keys: ['Mod-Alt-x'], run }` to the area's startup stub (`installX()`), e.g. `registerCommands([...])` in `src/renderer/app/shell.ts` (~line 106). Keep `run` tiny: it should `import()` the real code. |
| 3 | **No key (palette only):** add it to the area's lazy command file, e.g. `registerShellCommands` in `src/renderer/app/shell-commands.ts` (~line 40). |
| 4 | **Editor-only key** (works only inside CodeMirror): add to the keymap in `src/renderer/editor/mdkeys.ts`, and list it with `displayKeys` (not `keys`) on a command. |
| 5 | Add the key to the allocation table in `09-reference-keys.md`. |
| 6 | Test: an E2E that presses the key (`page.keyboard.press('Control+Shift+P')`, see `tests/e2e/shell-zen.spec.ts`). |

**Rules**
- `id` = `category.action` (`view.toggleZen`). `title` = `Category: Action` (`View: Toggle zen mode`).
- Key syntax: `Mod-Shift-p`. `Mod` = Ctrl on Windows/Linux, Cmd on macOS.
- `keys` are **global** and beat the editor. Do not steal an editor key.
- Must work while a terminal has focus: add it to `APP_KEYS_IN_TERMINAL` (`src/renderer/terminal/keys.ts`). Only if truly needed.
- Desktop only: `when: () => app.backend.kind === 'electron'`.

---

## C. Add a backend call that works in BOTH Electron and browser mode

**Copy from:** `bookmarks` (`src/shared/api.ts` ~line 253 and ~336; `src/backend/service.ts` ~line 574; test `tests/unit/bookmarks/service.test.ts`).

```bash
grep -n "bookmarks" src/shared/api.ts src/backend/service.ts
```

**First ask: can it be an op of an existing call?** Git: add an op to `GitOps` (`src/shared/git.ts`). Bookmarks: add a `BookmarkOp`. That is preferred over a new method.

| # | File | Do |
|---|---|---|
| 1 | `src/shared/api.ts` | Add the method to `interface BackendApi` (~line 206). Add its name to `RPC_METHODS` (~line 311). |
| 2 | `src/backend/service.ts` | Add `async myCall(arg: unknown)` to `class BackendService`. **Validate every argument** (they come from the page). Throw `new BackendFailure('EINVAL', '...')` on bad input. |
| 3 | (renderer) | Call `app.backend.myCall(...)`. Errors arrive as `RpcError` with `.code`. |
| 4 | `tests/unit/<area>/service.test.ts` | Copy `tests/unit/bookmarks/service.test.ts`: `new BackendService(cfg)`, `openWorkspace(root)`, call the method. |

**You do NOT edit** `src/main/main.ts`, `src/main/preload.ts`, `src/server/server.ts`, `src/renderer/platform/`. They loop over `RPC_METHODS`.

**Rules**
- File paths are workspace-relative POSIX. Touch the disk only through `this.ws()` (`Workspace`) methods, or `await ws.real(rel)` first.
- Data that is not a note goes in app data (`this.configDir`), never in the open folder. Use `readJson` / `writeJson` / `withFileLock`.
- **Desktop only?** Add the name to `DESKTOP_ONLY` in `src/server/server.ts` (~line 93), make the `BackendApi` member optional (`myCall?(...)`) and feature-detect in the renderer.
- **Big request body?** Add a limit to `BODY_LIMITS` in `src/server/server.ts` (~line 88).
- **Reads machine-wide data?** A pinned web server must refuse it: add an entry to `PINNED` in `src/server/server.ts`. Ask first.
- **Needs a native dialog, the sender's identity, or a push event?** That is a channel family (`vault:*` style). **STOP AND ASK.**

---

## D. Add a sidebar panel

**Copy from:** Bookmarks. `src/renderer/app/shell.ts` (~line 13 and ~105), `src/renderer/bookmarks/Panel.tsx`, `src/renderer/bookmarks/bookmarks.css`.

| # | File | Do |
|---|---|---|
| 1 | `src/renderer/<area>/Panel.tsx` + `<area>.css` | The component. Import the CSS from it. Classes start with `se-`. Use CSS variables, no fixed colours or radii. |
| 2 | area startup stub (`installX()`), or `src/renderer/app/shell.ts` | `const P = lazyComponent(() => import('../<area>/Panel').then((m) => m.MyPanel));` then `app.registerPanel({ id, title, icon, order, component: P })`. |
| 3 | `src/renderer/app/icons.tsx` or `addIcons({...})` in the stub | The glyph must exist at startup, else the pill shows an empty box. |
| 4 | stub | A command to show it: copy `view.bookmarks`. With a key: also add it to `PANEL_KEYS` in `src/renderer/app/ui.ts` (~line 37). |
| 5 | `src/renderer/main.tsx` | Only if you made a new `installX()`: one line in the "feature modules" block. |
| 6 | tests | E2E: copy `tests/e2e/bookmarks.spec.ts`. Unit (DOM): copy `tests/unit/bookmarks/panel.test.tsx`. |

**Rules**
- `order`: Files 0, Search 10, Git 12, AI changes 14, Bookmarks 20, Outline 30, Backlinks 31, Tags 32.
- The panel chunk must **not** statically import `src/renderer/app/Shelf.tsx`.
- Keep the whole feature in **one** lazy chunk (re-export the store from the panel file).
- Never draw the bar yourself: every bar uses `ui.menuPanels(...)`.
- A panel must not open itself while `ui.zen.value` is set.

---

## E. Add an MCP tool

**Copy from:** `list_tags` (small) or `get_links` in `src/mcp/tools/links.ts` (~lines 15 and 39).

**First ask: can it be a parameter or `mode` of an existing tool?** Preferred. Tool text costs tokens on every turn.

| # | File | Do |
|---|---|---|
| 1 | `src/mcp/tools/<read\|search\|links\|write>.ts` | Add a `ToolDef`: `name`, `title`, short `description`, `inputSchema` (`additionalProperties: false`, description on every parameter), `annotations`, `run`. |
| 2 | same | Wrap `run` in `inFolder(env, a, async (f) => ...)`. Resolve every path with `f.resolve(a.path)`. |
| 3 | same | Answer with `reply(line(...), ...rows)` from `src/mcp/tools/format.ts`. **Plain text, never JSON.** Cap rows with `rowLimit()` and `fitRows()`. |
| 4 | `src/mcp/server.ts` (~line 83) | Only if you made a new tools file: add it to `this.tools`. |
| 5 | `tests/unit/mcp/tools.test.ts` | Add a case (the `call(name, args)` helper is at the top). |
| 6 | `tests/unit/mcp/budget.test.ts` | Run it. It pins the size of all tool descriptions. Shorten your text if it fails. |

**Rules**
- Name: `^[a-zA-Z0-9_-]{1,64}$`. No top-level `oneOf`.
- Paths from an index go through `f.visibleOnly()` before they are shown.
- **A tool that changes files: STOP AND ASK first.** It needs `write: true`, `inWritable`, `folder.resolveTarget()`, `src/mcp/writes.ts` and a journal entry. Copy `write_file` in `src/mcp/tools/write.ts` exactly.
- Never write to stdout. No git, no network, no terminal, no vault in `src/mcp/`.

```bash
npx vitest run tests/unit/mcp/tools.test.ts tests/unit/mcp/budget.test.ts
```

---

## F. Add a language / file type

| Want | Do |
|---|---|
| The **user** maps `*.ctp` to PHP | **No code.** It is a setting: Settings -> Files -> file type associations (`files.associations`). |
| A new built-in language | Steps below. |

**Copy from:** any row of `LANGUAGES` in `src/shared/languages.ts` (~line 21), e.g. the `toml` row.

| # | File | Do |
|---|---|---|
| 1 | `src/shared/languages.ts` | Add one `LanguageInfo` row: `id`, `name`, `aliases`, `extensions` (with dot), optional `cm`, `shiki`, `prettier`, `comment`. |
| 2 | verify | `cm` must be a real `@codemirror/language-data` name, `shiki` a real Shiki id. Check a sibling row. Unsure: leave the field out. |
| 3 | `src/search/symbols.ts` | Optional outline support: patterns in `LANG_PATTERNS` (~line 145), maybe `NO_GENERIC`. Follow the rules in `09-reference-search.md` ("Code symbols"). |
| 4 | `src/renderer/app/icons.tsx` | Optional: tree icon by extension (the map with `'.md': { icon: ... }`). |
| 5 | tests | `tests/unit/format/languages.test.ts`; for symbols `tests/unit/search/symbols.test.ts`. |

**Rules**
- **Never** build your own extension table. Everything calls `languageForPath(path)`.
- Existing languages' outline must not change (`symbols.test.ts` pins it).
- A Prettier plugin for a new language = new dependency = **ask first**.

---

## G. Add a test

Full detail: `05-testing-and-verify.md`.

| Change is in... | Test type | Copy from |
|---|---|---|
| pure logic (`src/shared`, `src/search`, `src/knowledge`, reducers) | vitest, node | `tests/unit/app/panel-menu.test.ts` |
| `BackendService` / `Workspace` | vitest, node, temp dir | `tests/unit/bookmarks/service.test.ts` |
| a Preact component | vitest + `// @vitest-environment happy-dom` | `tests/unit/app/status-corner.test.tsx` |
| MCP tool | vitest | `tests/unit/mcp/tools.test.ts` |
| UI flow, both modes share it | Playwright browser | `tests/e2e/nav-buttons.spec.ts` (uses `tests/e2e/harness.ts`) |
| desktop only (terminal, window, vault, native dialog) | Playwright Electron | `tests/e2e/electron/terminal.spec.ts` (uses `fixture.ts`) |

Put it in `tests/unit/<area>/<name>.test.ts` or `tests/e2e/<area>-<name>.spec.ts`. Prefer **adding a case to an existing file**.

---

## H. Fix a bug

| # | Do |
|---|---|
| 1 | **Reproduce in a test first.** Find the area's test file: `ls tests/unit/<area>/ tests/e2e/ \| grep <area>`. Add a failing case. |
| 2 | Run only that file. Confirm it **fails for the right reason**. |
| 3 | Find the code: grep the visible text or the function name (`02-find-existing-logic.md` recipes). |
| 4 | Read the function and its comments. Comments explain **why**; do not remove a guard you do not understand. |
| 5 | Fix in the **smallest** place. Do not refactor around it. |
| 6 | Run the test again (passes), then `npx tsc --noEmit -p .`. |
| 7 | Check `git log --oneline -- <file> \| head -5`: was this area just changed on purpose? If your fix reverts a recent decision, **STOP AND ASK**. |

**Real example:** commit `6ae3739` fixed a search-panel bug by editing only `src/renderer/search/SearchPanel.tsx` and `tests/e2e/search.spec.ts`. That is the normal size of a fix.

---

## No recipe fits?

Say so. List what you searched. **Do not improvise a new mechanism.**
