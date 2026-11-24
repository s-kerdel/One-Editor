# 09 - Reference: UI (status bar, zen, tree, panels, bookmarks, nav)

> **WHEN TO READ THIS:** you change the status bar, zen mode, the file tree, sidebar panels, bookmarks or Go back / forward.
> **WHAT YOU GET:** the contracts and bundler rules for those UI parts.
> **NEXT FILE:** `09-reference-search.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Status bar layout and corner slots

- **Status bar layout** (shell, `app/StatusBar.tsx`): `← → │ folder · crumbs · save · git · vars ··· activity · [Ln/Col · words · EOL · encoding · language · mode] │ MCP · :port · ⛨ n`.
- The far-right **corner** (`StatusCorner`, `.se-status-corner`, its `│` = `::before`) holds what is *on*: MCP server (`mcp/slot.ts`), web server (`webserver/slot.ts`), security findings (`updates/slot.ts`, always last).
- Normally it is empty and not rendered.
- **Corner slot pattern:** a startup `signal<ComponentType | null>` in `<area>/slot.ts` (just the signal).
  - The lazy chunk sets it **only while its icon shows** and back to `null` otherwise (an `effect` on its status).
  - So the corner and its `│` go when the last icon goes.
  - Never render `null` from a set slot.
- A new indicator = one slot + one fixed position in `StatusCorner` (startup cost ~40 B).
- Its component rides in an existing idle, desktop-only chunk (re-export it, like `installMcpIndicator` from `web-server-ui`; Popups calls it) rather than a new chunk, and imports only **types** from a shared module another lazy chunk uses (a value import splits that module out).
- Items after the spacer move left when the corner appears: keep corner icons rare (things that are on).

## Sidebar panels and the sidebar menu

- **Sidebar panels and the sidebar menu** (shell): `app.registerPanel({ id, title, icon, order, component })` before the first render (an `installX()` in main.tsx; the glyph at startup: `icons.tsx` or the stub's `addIcons`, else the pill draws an empty box).
- Default places by `order`: Files 0 · Search 10 · Git 12 · **Bookmarks 20** │ Outline 30 · Backlinks 31 · Tags 32.
- **Every bar is `ui.menuPanels(app.panels, settings['sidebar.panels'], open)`** (shelf pills, classic icon bar, zen strip; never map `app.panels` yourself).
- Setting `sidebar.panels` = `{ order, hidden }` (null = default), written only by `app/panel-menu.ts` (Settings → Appearance → Sidebar menu, `SidebarMenuSetting.tsx`; the pills' right-click "Hide …" reaches it through Settings' re-export, so it stays in the Settings chunk).
- **Merge rule** (pure, `tests/unit/app/panel-menu.test.ts`):
  - stored order over the registered panels;
  - a panel the order lacks (new in a later version) goes right after its default predecessor and is never hidden;
  - stored ids nobody registers are skipped but kept in the setting (another build's panel keeps its place);
  - the open panel shows while hidden;
  - at least one entry stays;
  - the default arrangement stores null.
- It runs in the first render (settings come with `bootstrap`; `applySessionLayout` restores `sidebarPanel` unchecked before the panels exist, so a hidden saved panel is in the first frame too): nothing jumps.
- A hidden panel must stay reachable: a key in `ui.PANEL_KEYS` (register that command yourself) or, without one, the generic palette command "View: Show <title>" (`shell-commands.ts`).
- Right-click menu: `Popups.panelMenu(id)` (Shelf's `panelMenu`, also used by classic).

## Bookmarks

- **Bookmarks** (shell, `src/renderer/bookmarks/`): workspace-relative POSIX paths + an optional label, **data only** (nothing in the backend touches a bookmarked path).
- One RPC, `bookmarks(op?)`: no argument reads;
  - an op (`shared/bookmarks.ts` `BookmarkOp`: add / remove / move with `before`, label, rename) is validated by `cleanOp` / `cleanPath`;
    - path rules: relative, `/` only, no `.` / `..` / empty segments, no drive / UNC / backslash / control characters (attack table in `tests/unit/bookmarks/model.test.ts`);
  - the op is applied to the file **as it is on disk** under the file lock;
    - desktop and browser mode share `<app data>/bookmarks/<folder id>.json`; never in the folder.
- The renderer applies the same op at once and takes the answer.
- **Following renames:**
  - Popups' `movePath` reports every move made in One (`renamed(from, to, true)`: folders too, even empty ones);
  - `file:renamed` per file;
  - outside renames are guessed from one watcher batch (`fsMoves`: same name elsewhere, or the only same-kind add in the same folder; never when ambiguous or re-added in place).
- A new way to rename / move in One calls `renamed(from, to, true)` from the bookmarks chunk.
- Missing targets (not in `app.tree`) are drawn greyed with Remove.
- Menu items: `bookmarkItem()` in Popups (tree row, selection via `topLevel()`, tab).
- Drops on the Bookmarks pill are delegated from the chunk (document listeners on `button[data-panel="bookmarks"]`): no startup code.

## File tree selection

- File tree selection (shell): **`ui.treeSelection` stays the focused row**; alone it is the selection, so callers that set it (reveal, new note, rename) keep working and simply drop a multi-selection.
- Several rows = **`ui.treeMulti`** `{ focus, anchor, paths }`, valid only while `focus === treeSelection` (a subscription in `ui.ts` clears it otherwise; the focus may be unselected after a Ctrl+click).
- Read with `ui.isTreeSelected(p)`, write with `ui.setTreeSel(sel | null, focus)`.
- The steps (toggle, range, prune of vanished rows, select all, open several, `topLevel()`) and the tree's keys (`treeKey(e, view)`) are the lazy `app/tree-select.ts`.
  - FileTree `import()`s it on the tree's focus (the idle Popups chunk carries it too).
  - So startup pays only for drawing (`.selected` / `.focused`, `.se-tree.multi`, the "N selected" foot).
- Keys pressed before it is in are claimed and replayed in order, a frame apart (rows re-render between): a new tree key goes into `treeKey`, not FileTree.
- Actions on several rows: `rowMenu(node, selection)` → `selectionMenu` in Popups (only multi-item actions; one-item ones are left out); `deletePaths` / `moveInto` take lists and reduce them with `topLevel()` themselves.
- A new multi-item tree action goes into `selectionMenu`; git adds its own through the optional `GitUi.menuMany(paths)`.

## Calm file tree

- **Calm file tree**, three settings:
  - `git.treeColors`: off = `gitUi.row()` / `Mark` draw nothing; drawing only, never a git run;
  - `tree.folderColors`: `hue` | `one` → `<html data-folders="one">`;
  - `tree.folderColor` → token **`--folder-color`**, derived per theme by `app/accent.ts` like the accent, cached as `sec-edit-folder` for theme-boot.js; unset = `--ft-folder`.
- Draw folder icons with `.se-ficon-folder` and they follow both.

## Zen mode

- **Zen mode** (shell, "View: Toggle zen mode", `Mod-Alt-z`): the flag is **`ui.zen`** (null = off, else the layout to restore).
  - Files: stub `app/zen.tsx`, the lazy chunk `app/zen-impl.ts` + `zen-strip.tsx` + `zen.css`.
  - The toggle button is `ZenButton` in `app/Shelf.tsx`: shelf foot, classic icon bar, the left strip's foot, the tab strip's end.
- Entering saves sidebar visibility / panel, the overview, the process dock and (with `zen.keepTerminal` off) the terminal panel, closes them through **their own signals** and goes full screen; leaving restores exactly that.
- Tabs stay; the sidebar and the overview (if it was open: `ui.zen.overviewVisible`) are **strips** (`.se-zen-strip`, lazy, resolved before the first zen frame: main.tsx awaits `preloadZenUi()` when restored).
- Showing a panel in zen (`sidebarVisible` / `overviewVisible`, by strip click or its shortcut) is a **peek**: `.se-zen-peek`.
  - It is absolutely placed, rendered *after* `.se-content` and no-drag (Chromium: the last region box wins).
  - It is closed by a press in `.se-main` outside peeks / strips, focus moving into `.se-content`, or `Esc`.
  - It is never restored (`applySessionLayout`, skeleton cache).
- Status bar only with `zen.keepStatusBar`.
- `zen.keepTerminal` (default on): zen leaves `terminal/state.panelOpen` alone in **both** directions — entering saves no `ui.zen.terminal`, so leaving never reopens a panel the user closed in zen (no asymmetric restore). Off: the old save / close / restore pair. It does **not** apply mid-zen (unlike `keepStatusBar`): it takes effect at the next enter / leave. `Mod-\`` (`terminal.toggle`) is already in `APP_KEYS_IN_TERMINAL`, so it works in zen and from a focused shell: no new key.
- `zen.fullScreen` (default on):
  - desktop: `zenFullScreen(on)` → `main/zen-fullscreen.ts`. It remembers the pre-zen state, never leaves a full screen the user had, and forgets its claim when the user leaves it. window-state.json keeps the pre-zen `maximized`;
  - browser: Fullscreen API inside the toggle's gesture + `navigator.keyboard.lock(['Escape'])`.
- Leaving full screen from outside does **not** end zen.
- `zen.keepFileTree` is retired: a stored value is ignored.
- **Import `app/zen.tsx` only from startup modules no lazy chunk reaches** (Layout, shell, main.tsx), and add no new import to `Shelf.tsx` / `Tabs.tsx` for zen: either made rolldown split startup code into an extra chunk (a few hundred bytes more, measured).
- **Bundler, two more rules (measured with bookmarks):** a lazy chunk must not statically import `app/Shelf.tsx` (only classic.tsx does, grandfathered): the Bookmarks panel doing so split commands / fileops / settings into three extra startup chunks (+2.5 kB gzip).
- And every lazy chunk a startup module's `import()` reaches, **with its own static deps**, is a file name in the entry's preload table and an index on every such call site (see rule 2 in `09-reference-rules.md` for call sites).
  - So keep a feature in **one** chunk instead of a small shared one (~20–30 B gzip each).
  - Examples: the bookmarks store is re-exported by `bookmarks/Panel.tsx`; the sidebar-menu writes live in the Settings chunk.
- **Contract:** a panel that opens *itself* (not on a user action: auto-open on an event, a restored flag) must not while `ui.zen.value` is set; a user action may open it (a peek; leaving zen still restores the pre-zen layout).
- Saved in the session (`SessionState.zen`) and in the skeleton cache (`sec-edit-layout` `z` → `<html data-zen="on[ status][ ov]">` by theme-boot.js), so the first paint already has the strips.

## Navigation history (Go back / forward)

- **Navigation history** (nav, Go back / Go forward) is recorded centrally. Each of these makes an entry:
  - a file switch (`active:changed`, so every `app.openFile` caller is covered);
  - a cursor jump of more than 10 lines that is not an edit (the editor's `onCursor(edited)`).
- Typing and small moves update the current one. Jumps < 350 ms apart coalesce.
- **Don't patch callers.**
- Only if your feature makes a deliberate move those rules can't see (a short jump, a page of a viewer doc) call `app.markNavigation?.()` right before it (valid 1 s, feature-detect: set when the chunk is in).
- Viewer docs report their page with `app.events.emit('viewer:page', path, page)`; an unmarked page change is scrolling.
- Inputs all end in `go(dir, source)` (`nav/impl.ts`), de-duplicated in `shared/nav.ts`: on Windows one side-button press arrives as a DOM mouse event **and** a BrowserWindow `app-command` (main → `app:navigate` → `backend.onNavCommand`).
- The history is per window (sessionStorage `sec-edit-nav:<root>`, 50 entries), not in the session file.
- E2E handle: `window.__secEditNav` = `{ history, go }`.
- **Buttons** (`nav/buttons.tsx`, setting `nav.buttons`, default on): `StatusBar` renders them **first in `.se-status`** (`← → │ folder · crumbs`; both sidebar styles), so they follow the status bar: zen hides them unless `zen.keepStatusBar` (keys + side buttons still work).
- The `│` is the group's `::after` (goes with the setting); the buttons share the `.se-status-item` / `.se-status-btn` rules (app.css).
- **The tab strip has no nav cell** (it had one in v0.5.1): `ShelfReveal` is its own ruled cell again — don't reserve strip space for them.
- Greyed out = `aria-disabled` (stays focusable), from the stub's `navCan` signals, which `impl.ts` `sync()`s only when the stack changes (never per keystroke).
- Right-click / long press / `Shift+F10` → `openPlaces` → `history.places(dir)` labelled by `describePlace`, in the shared context menu, **opened upwards**.
  - Upwards = `clientY: r.top - 4`: the menu host flips it to end over the button, like the status bar's folder menu.
  - A pick is `jump(entry)` (`history.goTo`, the places in between stay).
