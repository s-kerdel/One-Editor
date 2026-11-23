# 09 - Reference: ownership

> **WHEN TO READ THIS:** you must know which area owns a folder or file before you edit it.
> **WHAT YOU GET:** the path -> owner table, the shared-files rule, and per-area notes (chunks, slots, storage).
> **NEXT FILE:** `09-reference-app.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Layout and ownership

**Only edit what you own.** Shared files: see below.

| Path | Owner |
|---|---|
| `src/backend/`, `src/main/`, `src/server/`, `src/renderer/platform/`, `src/renderer/app/`, `src/renderer/styles/app.css`, `src/renderer/main.tsx`, `src/shared/api.ts`, packaging, `tests/e2e/electron/` | **shell** |
| `src/renderer/editor/` | **editor** |
| `src/renderer/preview/` | **preview** |
| `src/search/`, `src/renderer/search/` | **search** |
| `src/format/`, `src/shared/languages.ts`, `src/shared/associations.ts` | **format** |
| `src/knowledge/`, `src/renderer/knowledge/`, `src/shared/wikilinks.ts` | **knowledge** |
| `src/renderer/overview/` | **overview** |
| `src/renderer/terminal/`, `src/main/terminal*.ts`, `src/shared/terminal.ts` | **terminal** |
| `src/backend/git*.ts`, `src/shared/git.ts`, `src/renderer/git/` | **git** |
| `src/renderer/variables/`, `src/main/vault*.ts`, `src/shared/vault.ts` | **variables** |
| `src/main/web-server*.ts`, `src/shared/web-server.ts`, `src/renderer/webserver/` | **shell** |
| `src/main/update-check*.ts`, `src/shared/update-check.ts`, `src/renderer/updates/`, `scripts/shipped-deps.mjs` | **shell** |
| `src/renderer/whitespace/` | **variables** |
| `src/renderer/pdf/` | **pdf** |
| `src/mcp/`, `src/main/mcp*.ts`, `src/shared/mcp.ts`, `src/renderer/mcp/`, `build/windows/One MCP.cmd`, `build/linux/one-mcp.sh` | **mcp** |
| `src/renderer/nav/`, `src/shared/nav.ts` | **nav** |
| `src/renderer/bookmarks/`, `src/shared/bookmarks.ts` | **shell** |
| `tests/unit/<area>/`, `tests/e2e/<area>*.spec.ts` | the area's owner |

## Shared files (integration points)

- `src/renderer/main.tsx`, `src/renderer/app/app.ts`, `src/renderer/app/commands.ts`, `src/shared/api.ts`, `src/shared/paths.ts`.
- You MAY make **small additive edits** to them (e.g. one `installX()` call in `main.tsx`, a new optional field).
- Always Read immediately before Edit (other agents edit concurrently), never rewrite/reformat these files, never remove others' code.

## Area notes

### format: `src/format/`

- file type associations: see "A file's language"

### overview: `src/renderer/overview/`

- file overview, right column; shell's `Layout` hosts it, state in `ui.overviewVisible` / `ui.overviewWidth`

### terminal: `src/renderer/terminal/`

- integrated terminal + Claude Code / Opencode glue; shell's `Layout` hosts the bottom panel while `panelOpen`

### variables: `src/renderer/variables/`

- {{variables}}, environments / targets, secrets vault, smart paste; the editor chunk holds only `variables/cm.ts`, the rest is the lazy `variables` chunk; `variables/slot.ts` is the status-bar slot

### shell: `src/main/web-server*.ts`

- "Start web server": browser mode for the open folder as a child process, desktop only; `webserver/slot.ts` is the status-bar corner slot, the rest is the lazy `web-server-ui` chunk, which also carries the corner's MCP icon (`mcp/indicator.tsx`, re-exported: no extra chunk); Settings → Browser mode

### shell: `src/main/update-check*.ts`

- "Security updates": opt-in check for a newer Electron patch / end of support / known vulnerabilities in what the build ships, desktop only.
- **Files** (UI: Settings → Security updates):
  - pure rules in `shared/update-check.ts`;
  - requests, cache `<app data>/update-check.json` (findings + summary of what was checked) and the weekly rule in `main/update-check.ts`;
  - `updates/slot.ts` is the status-bar corner slot;
  - the rest (incl. `updates/summary.tsx`, the Settings summary) is the lazy `updates-ui` chunk, loaded after the idle Popups chunk.
- `build-node.mjs` writes `dist/main/shipped-deps.json` from the lockfile: names + versions of every non-dev package

### variables: `src/renderer/whitespace/`

- trailing whitespace: paste trim via CodeMirror's `clipboardInputFilter`, trim on save through format's `beforeSave` hook in `src/format/install.ts`, the `editor.trimWhitespace` command; editor chunk only

### pdf: `src/renderer/pdf/`

- **PDF viewer:** lazy chunk `PdfView` on pdf.js's `PDFViewer`.
  - `engine.ts` is the only place documents are opened: security options live there.
  - `model.ts`: pure helpers.
  - pdf.js data assets are copied by `vite.config.ts` → `pdfjs/`.
  - The worker gets `PDF_WORKER_CSP` from `src/shared/pdf.ts` in `main.ts` / `server.ts`.

### mcp: `src/mcp/`

- **MCP server:** a separate Node program, `dist/mcp/cli.mjs`.
  - MCP clients (LM Studio, Codex CLI, Claude) start it over **stdio** with the app's executable in Node mode.
  - One lazy `Workspace` + on-demand search / link indexes per shared folder.
  - Main owns `<app data>/mcp.json`.
  - Settings → MCP server is the lazy `mcp-ui` chunk, zero startup bytes.
  - The status-bar corner icon is `mcp/indicator.tsx` (slot `mcp/slot.ts`) in the idle web-server-ui chunk.
- `src/knowledge/sections.ts` (document map for `read_file` parts / `get_outline`) stays **knowledge**'s

### nav: `src/renderer/nav/`

- **Go back / forward:**
  - `nav/install.ts` is the startup stub: two key bindings, mouse side buttons, the buttons' state `navCan`, ~0.4 kB gzip;
  - `nav/buttons.tsx` = the status bar's ← → (startup; with the stub's part ~0.4 kB gzip; shell's `StatusBar` renders them; → is the ← glyph mirrored in CSS);
  - `nav/impl.ts` = recorder + restore + recent-places list, lazy on idle;
  - `nav/places.ts` = list labels, lazy on first list;
  - `nav/history.ts` = the pure stack.

### shell: `src/renderer/bookmarks/`

- Bookmarks panel: one lazy chunk `bookmarks/Panel.tsx` = UI + its store `store.ts` (re-exported) + `bookmarks.css`; startup = the panel registration and its `Mod-Alt-k` command in `app/shell.ts`, the glyph in `icons.tsx`.
- Storage = `BackendService.bookmarks(op?)` → `<app data>/bookmarks/<folder id>.json`, see Extension points
