# 09 - Reference: browser mode, web server, preview sanitizer

> **WHEN TO READ THIS:** you touch `src/server/`, `platform/web.ts`, the web-server child or rendered note HTML.
> **WHAT YOU GET:** token / media / CSP rules, the web-server handshake, the sanitizer contract, sessions per client kind.
> **NEXT FILE:** `09-reference-keys.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Browser-only renderer code

- Browser-only renderer code lives in **`src/renderer/platform/web.ts`** (token, launch code, RPC over fetch, SSE, media HMAC via `platform/hmac.ts`): its own chunk, which the desktop never fetches or evaluates (perf.spec checks the startup chunks for its markers).
- Never import it statically; `platform/index.ts` keeps only sync shims (`fileUrl` / `eventsUrl` / `webToken`), which `web.ts` fills through `installWeb()` as it evaluates.
- **Contract:** the server finds the chunk in Vite's build manifest (`build.manifest` → `.vite/manifest.json`, key `platform/web.ts`; the manifest is never served).
  - Its index.html runs the chunk as a `<script type="module">` **right before the entry**.
  - It adds `modulepreload` for any chunk it imports that index.html doesn't list yet.
- So it downloads in parallel and is installed before `connectBackend()` runs, with no `import()` hop in front of the bootstrap round trip.
- Without it (Vite dev server, older build) `connectBackend()` imports the chunk itself.
- Renaming or moving `web.ts` means updating `BROWSER_CHUNK` in `server.ts`.

## Browser-mode access (token, media, CSP)

- **Browser-mode access** (`src/server/server.ts`, `src/renderer/platform/web.ts`): the token travels in the `x-sec-edit-token` header only and lives in the tab's sessionStorage.
  - **Never a cookie** (cookies ignore ports: every 127.0.0.1 server would get it).
  - Never in a URL the page shows.
  - index.html is a static shell.
- Media GETs carry a **per-file capability** instead: `fileUrl()` → `/api/file?path=…&m=HMAC(mediaKey, root + path)` (key from `bootstrap()`, `platform/hmac.ts` = server's `mediaMac`), the event stream `eventsUrl()` → `ev=`.
- A new GET endpoint for `<img>` / EventSource uses the same scheme, never `?token=`.
- `/api/file` resolves links with `Workspace.real()` (no way out of the folder).
- `--open` / `launchUrl()` pass a one-time `?launch=` code.
- Script CSP: only the build's `assets/` + `theme-boot.js` (index.html for `app://`, rewritten per origin by the server, `'self'` under the Vite dev server).

## Browser state per origin

- Browser state is per origin = per port: `cli.ts` remembers the last port per folder (`web-ports.json` in app data, `server/ports.ts`) and tries it first without `--port`; when it is busy, the ready handshake carries `busy` and the info panel says browser state starts empty.

## Sessions per client kind

- Sessions per client kind: every HTTP server (`startServer`, so also the .cmd / `start-web.sh`) runs its `BackendService` with `sessionKind: 'web'` → `sessions/<id>@web.json`; the desktop keeps `sessions/<id>.json`.
- A first browser visit reads the desktop file as a seed, never writes it.
- Settings are shared on purpose.
- Renderer localStorage is per origin (`app://sec-edit` vs `http://127.0.0.1:<port>`), so it never crosses over.

## Web server (desktop: Start web server)

- Web server (desktop only, "Start web server"): main runs `dist/server/cli.mjs <root> --ipc` as a **child process** (`process.execPath` + `ELECTRON_RUN_AS_NODE`, allowlisted env, `SEC_EDIT_CONFIG_DIR` = userData; packaged: `app.asar.unpacked/dist/server/cli.mjs`).
- Handshake = Node IPC message `{ type: 'ready', port, token }` / `{ type: 'error' }`, never a parsed log line; `{ type: 'stop' }` or an IPC disconnect (app quit / crash) ends it.
- One at a time, never auto-started, stopped on quit and when another folder is opened.
- Bridge `secEditBridge.webServer` = `status / start / stop / open / onChange` over `webserver:*` channels (`src/shared/web-server.ts`), re-validated in `src/main/web-server.ts` like the vault; `open` only accepts a link of the running server.
- The token stays out of logs and the activity log (UI shows the address only; Copy uses the full link; Open asks the child for a one-time link, `{ type: 'launch' }` → `{ type: 'launch', url }`, so no browser command line holds the key).
- `--ipc` and any non-loopback `--host` start the server **pinned** (`pinRoot`): it refuses `openWorkspace` / `resolvePath` outside its folder, lists no recents, no process list, no `terminal.*` / `webserver.*` settings writes.
- The renderer chunk loads after the idle Popups chunk (zero startup bytes but the slot); browser mode has no bridge, so neither commands nor the Settings section (`SectionDef.desktopOnly`) exist there.

## Note content: sanitizer contract

- Note content (preview, embeds, hover, export) — **sanitizer contract** (`preview/sanitize.ts`, `preview/markdown.ts`): the app's classes and `data-*` drive behaviour (Copy / Run, embeds, tasks, media paths) and some are fixed overlays, so they come from the markdown renderer only.
- Every element raw HTML in a note creates is marked (`USER_MARK`) and loses all `data-*` and every class but `USER_CLASSES`.
  - Your own markup in a renderer rule is a `se_html` token (never `html_inline`).
  - ids / names are prefixed `user-content-` (`SANITIZE_NAMED_PROPS`; headings get their slug back from `data-slug`).
- No popover / map / area / background / poster; `.se-preview` has `contain: paint`.
- **Copy / Run read the source**: `fenceAt(renderedSource, data-src-line)` (sections, `embedSourceOf(body)` for embeds) — never DOM text.
- **Remote media**: `preview/remote.ts` decides (Settings `preview.remoteImages` ask / always / never, per folder `sec-edit-remote:<root>`, "Load" per note).
  - Pass `remote` in `RenderOptions` (`renderOptionsFor` does).
  - Blocked media become `img.se-remote-blocked` placeholders.
  - Event `media:policy` = re-render.
- The static CSP still lists https:/http: for images (it cannot be per folder): the sanitizer is the gate.
