# 09 - Reference: app extension points

> **WHEN TO READ THIS:** you need the `app` API, commands, process rows, variables or settings sync.
> **WHAT YOU GET:** the extension points of the app shell. Use these, do not invent parallel mechanisms.
> **NEXT FILE:** `09-reference-ui.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## `app` singleton

- **`app` singleton** (`src/renderer/app/app.ts`):
  - signals `workspace, tree, files, tabs, activePath, settings, overlay, sidebarPanel`;
  - `app.docs` (open documents);
  - `app.events` (`doc:changed`, `doc:saved`, `file:updated`, `workspace:opened`, …);
  - `app.openFile(path, {line,col,length})`, `app.saveFile()`, `app.toast()`, `app.registerPanel()`;
  - `app.editor`, `app.preview`.

## Editor / preview contracts

- Contracts `EditorController` / `PreviewController` are in `app.ts`.
- Keep them backward compatible; add optional members if needed.

## Commands

- Commands: `registerCommand({ id, title, keys?, displayKeys?, keywords?, when?, run })` in `src/renderer/app/commands.ts`.
- `keys` are **global** (capture phase, beat the editor).
- Editor-local shortcuts belong in CodeMirror keymaps — list them via `displayKeys`.

## Module bootstrap

- Module bootstrap: each area exports an `installX()` called from `main.tsx`.

## Shared helpers

- Shared helpers: `src/shared/paths.ts` (POSIX rel paths), `src/shared/languages.ts` (ext/fence → CM/Shiki/Prettier ids), `src/shared/wikilinks.ts` (parse + resolve `[[links]]`).

## E2E handles

- Global `window.__secEdit` = `app` (for E2E introspection).
- `html[data-ready="true"]` once booted.

## Process explorer

- Process explorer ("Developer: Process explorer", shell: `src/shared/processes.ts`, `src/backend/processes.ts`, `src/main/process-rows.ts`, `src/renderer/app/process-explorer/`): if your feature runs a process, thread or worker, give it a row.
- Backend / main: `registerProcessSource({ id, rows(), shellPids?(), ownPids?() })` (`backend/processes.ts`); renderer: `registerUiProcessSource({ id, rows() })` (`app/process-explorer/sources.ts`) **from your lazy chunk**.
- Rows (`ProcRow`) are read only while the explorer is open (every 2 s): keep `rows()` cheap, never spawn or wake a stopped thread for it.
- Child processes (git, terminals, watchers) are found automatically from the OS process tree.

## Build info (Settings footer)

- Build info (`src/renderer/app/build-info.tsx`, in the lazy Settings chunk): version from `package.json`, commit + build date from `scripts/stage.mjs` (`VITE_SEC_EDIT_COMMIT` / `VITE_SEC_EDIT_BUILD_DATE`, `dev` for a plain `npm run build`), Electron/Chromium from the UA, CPU arch from Chromium client hints (**desktop only** — in browser mode they describe the viewing machine).
- The OS version comes from the backend (`osVersion` in `RPC_METHODS` → `BackendService.osVersion()` reads `os.release()` + `SystemVersion.plist` / `/etc/os-release`; parsing and the one-line format are pure in `src/shared/os-version.ts`). A web server that serves one folder only refuses it (`PINNED` in `src/server/server.ts`) → the footer shows the OS name only.

## Viewer docs (PDF)

- Viewer docs (PDF, pdf area): a `.pdf` is never read as text — `loadDoc` makes a `binary` doc without a read, the shell's lazy `Viewer` mounts `pdf/PdfView` per path, unmount = `task.destroy()` (document + worker).
- `openFile(path, { line: 0, page })` → `doc.reveal` / event `viewer:reveal`; a disk change of an open PDF emits `binary:changed` (no read).
- Bytes come through the workspace file URL (`fileUrl`), never an RPC.
- Keys a focused widget must keep from the global keymap can also use `addGlobalKeyFilter()` (stackable; the viewer's `Ctrl+±/F/G/0`).
- PDF text is **not** indexed (no search / OCR) — by decision.

## Variables

- **Variables:** `app.variables` (`VariablesApi` in `src/renderer/variables/api.ts`):
  - `renderHook(path)` for markdown-it (`RenderOptions.vars`; export passes `{ export: true }`);
  - `copyCode` / `runCode` / `forTargets` for code-block buttons (resolve placeholders, ask for missing values);
  - `prepare(path)` before an export.
- Event `variables:changed` = re-render.
- Precedence lives in ONE function: `lookup()` in `variables/resolve.ts`.
- Secrets: `vault:*` IPC (`src/shared/vault.ts`, safeStorage in `src/main/vault.ts`; keys are scoped to the open folder there, see "Vault scope" in `09-reference-security.md`); browser mode keeps them in memory only.
- Per-folder env / target / remembered values: localStorage `sec-edit-vars:<root>` (not settings: the registry test guards every dotted key that is read).

## Settings across processes

- Settings across processes: `saveSettings` merges only the patch into settings.json as it is on disk, under a cross-process lock (`backend/filelock.ts`, `settings.json.lock`, stale after 5 s).
- Each backend watches the file (debounced; own writes give no diff; keys still in flight are skipped) and reports *external* changes: `onExternalSettings` → Electron `settings:changed` (preload channel) / server SSE `event: settings`.
- The renderer re-syncs in `app/settings-sync.ts` (installed by the idle Popups chunk: no startup code).
