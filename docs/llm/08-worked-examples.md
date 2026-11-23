# 08 - Worked examples (from real git history)

> **WHEN TO READ THIS:** you want to see what a finished change looks like, file by file.
> **WHAT YOU GET:** 4 real commits: which files they touched, in what order, and the lesson.
> **NEXT FILE:** `03-playbooks.md` (the matching recipe)

Look at any of them yourself (read-only):

```bash
git show --stat <hash>              # file list
git show <hash> -- path/to/file     # the diff of one file
```

---

## Example 1 - Bug fix: 2 files (`6ae3739`)

**Task:** "A search hit found only by file name should open on click."

| Order | File | Change |
|---|---|---|
| 1 | `tests/e2e/search.spec.ts` | a case that clicks such a row and expects the file to open |
| 2 | `src/renderer/search/SearchPanel.tsx` | the fix, inside the existing row component |

**Lesson**
- A bug fix = **the area's component + the area's existing test file.** Nothing else.
- No new helper, no new file, no refactor.
- Playbook: `03-playbooks.md` H.

---

## Example 2 - A setting plus behaviour: 8 files (`71225bf`)

**Task:** "On macOS, a remapped Cmd chord in the terminal should act as Ctrl. Add a setting to force it."

| Order | File | Change |
|---|---|---|
| 1 | `src/renderer/terminal/keys.ts` | the pure key logic (`createCmdTracker`, type `CmdSendsCtrl`) |
| 2 | `tests/unit/terminal/keys.test.ts` | unit tests for that logic (no DOM needed) |
| 3 | `src/renderer/terminal/settings.ts` | key `terminal.cmdSendsCtrl` in `TERMINAL_SETTING_KEYS`, a validating reader `readCmdSendsCtrl`, one row in `TERMINAL_SETTING_DEFS` |
| 4 | `src/renderer/terminal/entry.ts`, `view.ts` | wire the logic into the existing key handling |
| 5 | `tests/unit/platform/app-menu.test.ts` | guard for the related menu rule |
| 6 | `docs/USER-GUIDE.md`, `docs/llm/09-reference-*.md` | user text + the engineering rule |

The setting row that was added (real code):

```ts
{
  key: TERMINAL_SETTING_KEYS.cmdSendsCtrl,
  section: 'terminal',
  label: '⌘ chords act as Ctrl (macOS)',
  description: 'For Windows-style key remaps: ⌘C / ⌘R send ^C / ^R. Automatic: only when a remapper made them.',
  default: 'auto',
  control: { type: 'segmented', options: [{ v: 'auto', label: 'Automatic' }, { v: 'on', label: 'Always' }, { v: 'off', label: 'Never' }] },
  desktopOnly: true,
},
```

**Lesson**
- **Logic first, in a pure module, with a unit test.** UI wiring second.
- The setting is **one registry row** + **one reader that validates** (`v === 'on' ? 'on' : v === 'off' ? 'off' : 'auto'`). Unknown values fall back to the default.
- No edit to `src/shared/api.ts`: the key is dotted.
- Everything stayed inside the **terminal** area folder.
- Playbook: `03-playbooks.md` A.

---

## Example 3 - Backend call + sidebar panel: Bookmarks (`a136914`, bookmarks part)

**Task:** "Add a Bookmarks panel. Works in the desktop app and in browser mode."

| Order | File | Change |
|---|---|---|
| 1 | `src/shared/bookmarks.ts` (new) | types `Bookmark`, `BookmarkOp`; pure validators `cleanOp`, `cleanPath`, `cleanList`; `applyOp` |
| 2 | `tests/unit/bookmarks/model.test.ts` (new) | attack table for the validators |
| 3 | `src/shared/api.ts` | **+1 method** in `BackendApi`, **+1 name** in `RPC_METHODS` |
| 4 | `src/backend/service.ts` | `async bookmarks(op?: unknown)`: validate with `cleanOp`, store with `readJson` / `writeJson` under `withFileLock` in app data |
| 5 | `tests/unit/bookmarks/service.test.ts` (new) | `new BackendService(cfg)` twice (desktop + `'web'`): both see the same list |
| 6 | `src/renderer/bookmarks/store.ts`, `Panel.tsx`, `bookmarks.css` (new) | the lazy chunk: store + UI + styles |
| 7 | `src/renderer/app/shell.ts` | `lazyComponent(...)`, `app.registerPanel({ id: 'bookmarks', ..., order: 20 })`, command `view.bookmarks` with `Mod-Alt-k` |
| 8 | `src/renderer/app/icons.tsx` | the `bookmark` glyph (must exist at startup) |
| 9 | `src/renderer/app/ui.ts` | `bookmarks: 'Mod-Alt-k'` in `PANEL_KEYS` |
| 10 | `src/renderer/app/Popups.tsx` | menu items ("Bookmark" / "Remove bookmark", `bookmarkItem`) in the existing menus |
| 11 | `tests/e2e/bookmarks.spec.ts`, `tests/unit/bookmarks/panel.test.tsx` (new) | flow + component tests |
| 12 | `docs/USER-GUIDE.md`, `docs/llm/09-reference-*.md` | user text, extension point, key table |

The whole cross-mode wiring was these 4 added lines in `src/shared/api.ts`:

```ts
  /** Bookmarks of the open folder (One's app data, shared by desktop and browser mode): no argument reads, an op
   *  changes the list as it is on disk and returns the new one (shared/bookmarks.ts). */
  bookmarks(op?: import('./bookmarks').BookmarkOp): Promise<import('./bookmarks').Bookmark[]>;
  ...
  'bookmarks',
```

**Lesson**
- **Not touched:** `src/main/main.ts`, `src/main/preload.ts`, `src/server/server.ts`, `src/renderer/platform/`. `RPC_METHODS` wires both modes.
- **One RPC with ops** (`bookmarks(op?)`), not five methods.
- The backend **validates the op itself** (`cleanOp`); it never trusts the renderer.
- Data lives in **app data**, not in the open folder.
- Startup cost = one `registerPanel` line + one command + one glyph. The rest is lazy.
- Playbooks: `03-playbooks.md` C + D.

---

## Example 4 - Cross-cutting feature: 29 files (`654267d`) - what "ask first" looks like

**Task:** "Let users map `*.ctp` to PHP (file type associations)."

| Layer | Files |
|---|---|
| pure rules | `src/shared/associations.ts` (new), `src/shared/languages.ts` |
| setting + UI | `src/renderer/app/settings-registry.ts`, `FileTypesSetting.tsx`, `file-types.ts`, `file-types.css`, `SettingsOverlay.tsx`, `Popups.tsx`, `settings-sync.ts` |
| consumers | `src/renderer/editor/index.ts`, `src/renderer/overview/model.ts`, `src/renderer/search/client.ts`, `src/search/host.ts`, `src/search/protocol.ts`, `src/format/install.ts` |
| backend index | `src/backend/indexer.ts`, `src/backend/service.ts` |
| MCP safety | `src/mcp/config.ts`, `src/mcp/folders.ts`, `src/mcp/tools/write.ts` |
| tests | 5 unit files (`format/associations`, `editor/file-types`, `app/file-types`, `backend/file-types`, `mcp/file-types`) + `tests/e2e/file-types.spec.ts` |
| docs | `docs/llm/09-reference-*.md`, `docs/USER-GUIDE.md` |

**Lesson**
- It crosses **6 areas** and has a **security side** (MCP writes may only get stricter).
- This is **not** a task to start alone. At the plan step (step 5 of the workflow) you would have listed more than 6 files: **STOP AND ASK**, and propose to do it in slices.
- Note the shape even here: **one** resolution function (`languageForPath`) that every consumer calls. No consumer got its own table.

---

## The pattern in all four

```
1. pure logic + unit test      (src/shared, src/search, area folder)
2. backend, if needed          (BackendService + RPC_METHODS)
3. tiny startup wiring         (installX / shell.ts: command, panel, key)
4. lazy UI chunk               (area folder)
5. one E2E for the flow        (tests/e2e)
6. docs                        (docs/USER-GUIDE.md, docs/llm/09-reference-*.md)
```

Smaller task = fewer of these steps. Never more files than the nearest example needed.
