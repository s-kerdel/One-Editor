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
- `--open` / `launchUrl()` pass a one-time `?launch=` code, and never on a command line: `--open` writes it into a **0600 redirect page** (`server/launch-file.ts`, `<app data>/launch/`, folder 0700) and opens that file (Jupyter's pattern; Windows: `explorer.exe`). The file goes once the code is redeemed (`launchUrl(used)`), after `LAUNCH_TTL_MS` (2 min) or when the server exits; leftovers of a killed server are swept on the next write.
- Response headers: index.html `no-store`, `Referrer-Policy: no-referrer`, `X-DNS-Prefetch-Control: off`, `frame-ancestors 'none'`; `/api/file` `no-store` + sandbox CSP. Token / capability compares go through `safeEqual` (byte lengths first).
- Script CSP: only the build's `assets/` + `theme-boot.js` (index.html for `app://`, rewritten per origin by the server, `'self'` under the Vite dev server).

## Pinned servers (every server `cli.ts` starts)

- `cli.ts` always passes `pinRoot: true` and `roots` = **its own folder arguments** (`serve a b`; the first one opens). `startServer` without `pinRoot` is the test harness only.
- `openWorkspace` from the page: only a folder of `roots` or a folder inside one (the switcher, "Open as project", "Open parent folder"). Decided lexically first (an outside path, `\\host\share` too, is never touched), then on the real path (a link leading out is `EACCES`, One's data / cache folder is `EACCES`, a missing folder `ENOENT`), re-checked after the open (a link renamed into place: back to the previous folder).
- `resolvePath` answers only for the open folder; `recentWorkspaces` / `forgetRecent` / `bootstrap().recent` = `roots` when there are several, else `[]`.
- **Settings writes = allowlist** `WEB_SETTINGS` (`server.ts`): the browser build's rows of `settings-registry.ts` minus `preview.remoteImages`. Desktop-only and privacy keys (`terminal.*`, `claude.follow`, `opencode.follow`, `webserver.*`, `mcp.*`, `updates.check`, `zoom`, `windowFrame`, `export.pdfPageNumbers`) are dropped, the rest still saves; one value is at most 64 KB of JSON (`ETOOBIG`), the whole call 256 KB. **A new browser setting adds its key to `WEB_SETTINGS`** (`tests/unit/webserver/server-pin.test.ts` compares it with the registry).
- Every HTTP server (pinned or not): `git('trust')` is `ENOTSUP` (trust comes from the desktop app only; `untrust` works), `revealInFolder` only for a request from loopback (`fromLoopback`), terminal names and PDF export `ENOTSUP`.
- `shared` (default = `pinRoot`; `cli.ts`: `--ipc` or a non-loopback `--host`): also no process list, no OS version. A local `serve` keeps both.

## Browser state per origin

- Browser state is per origin = per port: `cli.ts` remembers the last port per folder (`web-ports.json` in app data, `server/ports.ts`) and tries it first without `--port`; when it is busy, the ready handshake carries `busy` and the info panel says browser state starts empty.

## Sessions per client kind

- Sessions per client kind: every HTTP server (`startServer`, so also the .cmd / `start-web.sh`) runs its `BackendService` with `sessionKind: 'web'` → `sessions/<id>@web.json`; the desktop keeps `sessions/<id>.json`.
- A first browser visit reads the desktop file as a seed, never writes it.
- Settings are shared on purpose.
- Renderer localStorage is per origin (`app://sec-edit` vs `http://127.0.0.1:<port>`), so it never crosses over.

## Web server (desktop: Start web server)

- Web server (desktop only, "Start web server"): main runs `dist/server/cli.mjs <root> --ipc` in a **utilityProcess** (`web-server-child.cjs`, `childOfUtility()`; allowlisted env, `SEC_EDIT_CONFIG_DIR` = userData; no Node mode, the RunAsNode fuse is off). The launchers use the windowless `One --serve`.
- Handshake = Node IPC message `{ type: 'ready', port, token }` / `{ type: 'error' }`, never a parsed log line; `{ type: 'stop' }` or an IPC disconnect (app quit / crash) ends it.
- One server for the whole app (all windows show the same status), never auto-started. It serves the folder of the window that started it; a start for another folder is refused (`EBUSY`). Stopped on quit and once no window has its folder open any more (`rootsChanged`).
- Bridge `secEditBridge.webServer` = `status / start / stop / open / onChange` over `webserver:*` channels (`src/shared/web-server.ts`), re-validated in `src/main/web-server.ts` like the vault; `open` only accepts a link of the running server.
- The token stays out of logs and the activity log (UI shows the address only; Copy uses the full link). Open asks the child for the redirect file: `{ type: 'launch', file: true }` → `{ type: 'launch', file }` (absolute path of the 0600 page, see "Browser-mode access") or `{ type: 'launch', error }`; main opens that file. The older `{ type: 'launch' }` → `{ type: 'launch', url }` still answers.
- The child is **pinned** like every `cli.ts` server (see "Pinned servers") and **shared** (`--ipc`): no process list, no OS version either.
- The renderer chunk loads after the idle Popups chunk (zero startup bytes but the slot); browser mode has no bridge, so neither commands nor the Settings section (`SectionDef.desktopOnly`) exist there.

## Note content: sanitizer contract

- Note content (preview, embeds, hover, export) — **sanitizer contract** (`preview/sanitize.ts`, `preview/markdown.ts`): the app's classes and `data-*` drive behaviour (Copy / Run, embeds, tasks, media paths) and some are fixed overlays, so they come from the markdown renderer only.
- Every element raw HTML in a note creates is marked (`USER_MARK`) and loses all `data-*` and every class but `USER_CLASSES`.
  - Your own markup in a renderer rule is a `se_html` token (never `html_inline`).
  - ids / names are prefixed `user-content-` (`SANITIZE_NAMED_PROPS`; headings get their slug back from `data-slug`).
- No popover / map / area / background / poster; `.se-preview` has `contain: paint`.
- **Copy / Run read the source**: `fenceAt(renderedSource, data-src-line)` (sections, `embedSourceOf(body)` for embeds) — never DOM text.
- **Remote media**: `preview/remote.ts` decides (Settings `preview.remoteImages` ask / always / never, per folder `SessionState.remoteImages` via `folderValue` / `setFolderValue`, never localStorage; "Load" per note).
  - Pass `remote` in `RenderOptions` (`renderOptionsFor` does).
  - Blocked media become `img.se-remote-blocked` placeholders.
  - Event `media:policy` = re-render.
- The static CSP still lists https:/http: for images (it cannot be per folder): the sanitizer is the gate.
