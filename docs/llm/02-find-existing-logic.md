# 02 - Find existing logic (reuse table)

> **WHEN TO READ THIS:** before you write ANY new function. "I need to do X" -> look it up here.
> **WHAT YOU GET:** `file` + `function` to reuse, plus grep recipes to find what is not listed.
> **NEXT FILE:** `03-playbooks.md`

**Rule: if a row matches, call that function. Do not write a second one.**
**Rule: before using a name from this table, confirm it:** `grep -n "name" <file>`.

## Grep recipes (use these first)

```bash
grep -rn "export .*function NAME\|export const NAME" src/ | head   # where is NAME defined
grep -rn "NAME(" src/ --include=*.ts --include=*.tsx | head         # who calls NAME (copy a call)
grep -rn "Text the user sees" src/ | head                           # find UI by its label
grep -rn "'area\.settingKey'" src/ | head                           # where a setting is read
grep -rn "keys: \[" src/renderer | grep "Mod-Alt-k"                 # is this shortcut taken
grep -rn "id: 'view\." src/renderer | head                          # command ids of a category
grep -n  "keyword" docs/llm/09-reference*.md | head                 # the written rule
ls tests/unit/<area>/ tests/e2e/ | grep -i keyword                  # the existing test
git log --oneline -- path/to/file | head                            # how this file changed before
```

No hit after these = **no precedent. STOP AND ASK.**

## App core (renderer)

| I need to... | Reuse | File |
|---|---|---|
| open a file (optionally at a line) | `app.openFile(path, { line, col, length })` | `src/renderer/app/app.ts` (impl: `documents.ts`) |
| save / close a tab | `app.saveFile(path?)`, `app.closeTab(path)` | `src/renderer/app/app.ts` |
| show a toast (with buttons) | `app.toast(message, kind, ms, actions)` | `src/renderer/app/app.ts` |
| react to a lifecycle event | `app.events.on('doc:saved' \| 'doc:changed' \| 'active:changed' \| 'file:renamed' \| 'workspace:opened' \| 'settings:changed', fn)` | `AppEvents` in `src/renderer/app/app.ts` |
| list all files in the folder | `app.files.value` (signal) | `src/renderer/app/app.ts` |
| call the backend | `app.backend.<method>()` | `BackendApi` in `src/shared/api.ts` |
| know desktop vs browser | `app.backend.kind === 'electron'` | `src/shared/api.ts` |
| know the OS | `app.backend.os`, `isMac` | `src/renderer/app/commands.ts` |
| confirm / prompt / custom dialog | `ui.confirmDialog()`, `ui.promptDialog()`, `ui.ask()` | `src/renderer/app/ui.ts` |
| context menu | `ui.openContextMenu(e, items)` with `ui.MenuItem[]` | `src/renderer/app/ui.ts` |
| tree row / tab / panel menus | `rowMenu()`, `tabMenu()`, `panelMenu()` | `src/renderer/app/Popups.tsx` |
| create / rename / move / delete / duplicate files | `newNote`, `renameTo`, `moveInto`, `deletePaths`, `duplicate` | `src/renderer/app/fileops.ts` |
| reveal a file in the tree / OS | `revealInTree`, `revealInOs` | `src/renderer/app/fileops.ts` |
| copy text to the clipboard | `copyText` | `src/renderer/app/fileops.ts` |
| error -> readable text | `errText` | `src/renderer/app/fileops.ts` |
| load the Popups chunk from startup code | `popups()` (never a second `import('./Popups')`) | `src/renderer/app/fileops.ts` |
| lazy component / lazy module / idle work | `lazyComponent()`, `lazy()`, `afterBootIdle()`, `onIdle()` | `src/renderer/app/lazy.tsx` |
| draw an icon / add a glyph | `<Icon>`, `addIcons({ name: 'svg path' })` | `src/renderer/app/icons.tsx` |
| log to the activity log | `logActivity()` | `src/renderer/app/activity.ts` |
| re-read a file changed on disk | `handleFsEvents()` | `src/renderer/app/disk-sync.ts` |
| read all workspace text (index) | `streamAllText`, `readAllTextShared` | `src/renderer/app/workspace-text.ts` |

## Settings

| I need to... | Reuse | File |
|---|---|---|
| declare a setting (control, default, label) | add a row to `defs` -> `SETTINGS` | `src/renderer/app/settings-registry.ts` |
| read a setting | `app.settings.value['area.key']` | signal in `src/renderer/app/app.ts` |
| write a setting | `updateSettings({ 'area.key': v })` | `src/renderer/app/settings.ts` |
| apply a setting to CSS / DOM | `applySettingsToDom()` | `src/renderer/app/settings.ts` |
| typed defaults for built-in keys | `Settings`, `DEFAULT_SETTINGS` | `src/shared/api.ts` |
| terminal settings | `TERMINAL_SETTING_DEFS`, `readTerminalSettings()` | `src/renderer/terminal/settings.ts` |
| mark "this setting changes the index" | both `INDEX_KEYS` lists | `src/backend/service.ts`, `src/renderer/app/settings-sync.ts` |
| backend save (merge + file lock) | `BackendService.saveSettings()` | `src/backend/service.ts` |

## Commands and keys

| I need to... | Reuse | File |
|---|---|---|
| register a command | `registerCommand({ id, title, keys?, when?, run })`, `registerCommands([...])` | `src/renderer/app/commands.ts` |
| register keyless commands lazily | `addCommandSource(() => import(...))` | `src/renderer/app/commands.ts`; example `registerShellCommands` in `shell-commands.ts` |
| run a command by id | `runCommand(id)` | `src/renderer/app/commands.ts` |
| show a key nicely | `prettyKey()`, `normalizeKey()` | `src/renderer/app/commands.ts` |
| let a focused widget keep keys | `addGlobalKeyFilter()`, `setGlobalKeyFilter()` | `src/renderer/app/commands.ts` |
| editor-local Markdown keys | the keymap list | `src/renderer/editor/mdkeys.ts` |
| keys that reach the app from a focused terminal | `APP_KEYS_IN_TERMINAL` | `src/renderer/terminal/keys.ts` |
| panel shortcut table | `PANEL_KEYS` | `src/renderer/app/ui.ts` |
| which keys are taken | table "Global keybinding allocation" | `docs/llm/09-reference-keys.md` |

## Paths and file safety (security: read `04-rules-and-pitfalls.md`)

| I need to... | Reuse | File |
|---|---|---|
| join / dirname / basename / ext of a workspace path | `join`, `dirname`, `basename`, `extname`, `stem`, `normalize` | `src/shared/paths.ts` |
| "is this a Markdown note" | `isMarkdown(path)` | `src/shared/paths.ts` |
| absolute path of a workspace path, **checked for links** | `await ws.real(rel, 'follow' \| 'entry')` | `Workspace` in `src/backend/workspace.ts` |
| lexical containment checks | `resolveInside`, `isInsideDir`, `escapesRoot`, `windowsNameProblem` | `src/backend/pathsafe.ts` |
| a path derived from **file contents** | `safeRel`, `safeJoin` | `src/search/goto/paths.ts` |
| file outside the open folder | `isExtPath`, `extIdOf`, `BackendService.openExternalFile` | `src/shared/external.ts`, `src/backend/service.ts` |
| read / write / create / rename / remove | `Workspace.readFile`, `writeFile`, `createFile`, `createDir`, `rename`, `remove` | `src/backend/workspace.ts` |
| atomic write | `atomicWrite` | `src/backend/workspace.ts` |
| encoding / EOL | `decode`, `encode`, `detectEol`, `toLf`, `withEol` | `src/backend/textcodec.ts` |
| move to the OS trash | `platformTrash` | `src/backend/trash.ts` |
| backend error with a code | `new BackendFailure(code, message)` | `src/backend/errors.ts` |
| JSON file in app data | `readJson`, `writeJson`, `withFileLock` | `src/backend/service.ts`, `src/backend/filelock.ts` |
| app data / cache folder | `defaultConfigDir`, `defaultCacheDir` | `src/backend/appdata.ts` |
| exclude globs | `createExcludeMatcher` | `src/backend/exclude.ts` |
| case sensitivity of the folder | `WorkspaceInfo.caseSensitive` (renderer), `Workspace.foldsCase` (backend) | `src/shared/api.ts`, `src/backend/workspace.ts` |
| Windows system program path | `winSystemExe` | `src/backend/winsys.ts` |
| quote a path for cmd.exe | `cmdQuote` | `src/main/terminal-shells.ts` |
| URL of a workspace file for `<img>` | `fileUrl(backend, rootAbs, rel)` | `src/renderer/platform/index.ts` |
| is a URL safe to hand to the OS | `isExternalUrl` | `src/shared/api.ts` |

## Languages

| I need to... | Reuse | File |
|---|---|---|
| language of a file (**the only way**) | `languageForPath(path)` | `src/shared/languages.ts` |
| language of a code fence | `languageForFence(name)` | `src/shared/languages.ts` |
| formatter for a file / fence | `formatterForPath`, `formatterForFence` | `src/shared/languages.ts` |
| the language table | `LANGUAGES`, `languageById` | `src/shared/languages.ts` |
| user file-type associations | `setFileAssociation` (UI), `cleanAssociations`, `withAssociation` | `src/renderer/app/file-types.ts`, `src/shared/languages.ts` |
| outline / symbols of code | `outline`, `codeSymbols`, `extractDefs`, `LANG_PATTERNS` | `src/search/symbols.ts` |

## Feature areas

| I need to... | Reuse | File |
|---|---|---|
| any git operation | `git(op, ...args)` / `gitCall()`; ops in `GitOps` | `src/renderer/git/rpc.ts`, `src/shared/git.ts`; backend `BackendService.git` |
| open a file's diff | `openFileDiff(store, path, row?)` | `src/renderer/git/diff-open.tsx` |
| git timeout text | `GIT_TIMEOUT_TEXT`, `unavailableText()` | `src/shared/git.ts`, `src/renderer/git/ui.tsx` |
| search / definitions / headings | `searchClient` (`start()`, `definitions()`, `progress`) | `src/renderer/search/client.ts` |
| open search panel / palette | `openSearch`, `openPalette`; `app.openSearch?.(query)` | `src/renderer/search/index.tsx` |
| go to definition / find usages | `goToDefinitionAt`, `findUsagesAt` | `src/renderer/editor/gotodef.ts` |
| parse / resolve `[[wikilinks]]` | `parseWikiLink`, `findWikiLinks`, `resolveWikiTarget` | `src/shared/wikilinks.ts` |
| follow a wikilink | `app.openLink?.(target, fromPath)` | `src/renderer/app/app.ts` |
| related notes / local graph | `relatedNotes`, `localGraph` | `src/knowledge/connections.ts` |
| render Markdown to safe HTML | `renderMarkdown`, `renderOptionsFor`, `sanitizeHtml` | `src/renderer/preview/markdown.ts`, `preview/index.ts`, `preview/sanitize.ts` |
| code block source for Copy / Run | `fenceAt` | `src/renderer/preview/markdown.ts` |
| format a document / selection | `formatDocument`, `formatSelection`, `formatInWorker` | `src/format/install.ts`, `src/format/client.ts` |
| run code before save | `setBeforeSave` | `src/renderer/app/documents.ts` |
| paste a command into the terminal | `app.runInTerminal?.(code, { lang })`, `isRunnableFence`, `prepareRunText` | `src/renderer/terminal/run.ts` |
| `{{variables}}` | `app.variables` (`VariablesApi`) | `src/renderer/variables/api.ts` |
| mark a deliberate jump for Back/Forward | `app.markNavigation?.()` | `src/renderer/app/app.ts` |
| show a row in the Process explorer | `registerProcessSource` (backend), `registerUiProcessSource` (renderer) | `src/backend/processes.ts`, `src/renderer/app/process-explorer/sources.ts` |
| status-bar corner icon | slot signal pattern | `src/renderer/mcp/slot.ts`, `StatusCorner` in `src/renderer/app/StatusBar.tsx` |
| MCP tool helpers | `inFolder`, `rowLimit`, `READ_ONLY`, `line`, `reply`, `withBody`, `fitRows`, `P` | `src/mcp/tools/common.ts`, `src/mcp/tools/format.ts` |
| MCP path resolution | `folder.resolve()`, `folder.resolveTarget()`, `folder.visibleOnly()` | `src/mcp/folders.ts` |
| product name / window title | `BRAND`, `brandTitle` | `src/shared/brand.ts` |

## Windows (desktop)

| I need to... | Reuse | File |
|---|---|---|
| open a new window from the UI | `app.backend.newWindow?.()` (command `window.new`) | `src/renderer/app/shell.ts`, `BackendApi` in `src/shared/api.ts` |
| open a folder from the UI (main picks the window) | `openWorkspace(abs)` (asks `openFolderWindow` first) | `src/renderer/app/documents.ts` (impl: `doc-save.ts`) |
| decide which window a launched path goes to | `planLaunch()` | `src/main/windows.ts` |
| run window routing one step at a time | `serial()`, `route()`, `routeLaunch()` | `src/main/main.ts` |
| find a window by sender / folder / focus | `trustedCtx(e)`, `registry.byRoot()`, `registry.lastFocused()`, `windowWith()` | `src/main/main.ts`, `WindowRegistry` in `src/main/windows.ts` |
| reach a window's folder from main | `ctx.backend.<member>` (never its `BackendService`) | `WindowBackend` in `src/main/window-backend.ts` |
| send an app-level status to every window | `broadcast(channel, payload)` | `src/main/main.ts` |
| parent a dialog to the right window | `dialogParent(asker)` | `src/main/main.ts` |
| place a new window | `cascadeBounds()` | `src/main/windows.ts` |
| bring a window to the front | `focusWindow(c)` | `src/main/main.ts` |

## Styling

| I need... | Reuse |
|---|---|
| colours | CSS variables in `src/renderer/styles/app.css` (`--bg`, `--text`, `--accent`, `--code-bg`) |
| corner radius | `--radius-sm`, `--radius`, `--radius-lg`, `--radius-xl`, `--radius-pill` |
| dialog / palette / picker base classes | `src/renderer/app/overlays.css` (import it in your chunk) |
| my own CSS | a `.css` file in my area folder, classes prefixed `se-` |

## Not in this table?

1. Run the grep recipes at the top.
2. `grep -n "keyword" docs/llm/09-reference*.md` (extension points: `09-reference-app.md`, `09-reference-ui.md`).
3. Still nothing: **STOP AND ASK. Do not invent a helper.**
