# 06 - Setup and debugging

> **WHEN TO READ THIS:** a command fails, the app does not start, or you need to run it / read its logs.
> **WHAT YOU GET:** the FAST LOOP for debugging, environment facts, build + run commands for both modes, WSL/Xvfb notes, an error -> fix table.
> **NEXT FILE:** back to `00-START-HERE.md`

This file is kept apart on purpose. **Do not load it unless something is broken or you must run the app.**

## FAST LOOP: debugging (no display needed)

**A test failed? Use the checklist in `05-testing-and-verify.md` ("Failing test -> debug steps") first.** These are its tools. Durations measured 2026-11-23.

| You need | Exact command | Takes |
|---|---|---|
| rerun **one** unit case | `npx vitest run tests/unit/<area>/<file>.test.ts -t "name"` | ~0.7 s |
| rerun **one** E2E case | `npm run test:e2e:file -- tests/e2e/<file>.spec.ts -g "title"` | ~2 s |
| **renderer console + page errors** in the test output | `E2E_CONSOLE=1 npm run test:e2e:file -- tests/e2e/<file>.spec.ts -g "title"` | ~2 s |
| **main process output** (Electron spec) | same `E2E_CONSOLE=1`, with a `tests/e2e/electron/` spec: lines start with `[main]` | ~3 s |
| **trace as text**: failed step, console, page errors | `npm run trace:summary -- .tmp/e2e-file/<spec name>/results` | <1 s |
| a trace for a **passing** browser test | add `--trace on` to the E2E command, then `trace:summary` | ~2 s |
| every console line of a trace, not only errors | `TRACE_ALL=1 npm run trace:summary -- <results folder>` | <1 s |
| page content at the failure | open the `error-context.md` path printed under the error | - |
| is the build stale? | `E2E_REBUILD=1` in front of the E2E command | +3.5 s |
| typecheck | `npx tsc --noEmit -p .` | ~1.6 s |
| renderer build only | `npm run build:renderer` | ~3.5 s |

- **Traces exist for browser E2E only**, and only for a failed test (`trace: 'retain-on-failure'` in `playwright.config.ts`).
- **Electron E2E keeps no trace.** Use `E2E_CONSOLE=1` and `error-context.md`.
- `--debug`, `--ui`, `--headed` and `npx playwright show-trace` **need a display. Do not use them here.** The user can open a `trace.zip` on their side.
- `trace:summary` needs the `unzip` program. It only reads.
- **Print from a test** with `console.log(...)`: it shows in the test output. Remove it before hand-over.
- **Print from the page** with `console.log(...)` in `src/renderer/`: visible only with `E2E_CONSOLE=1`. Remove it before hand-over.

## Environment (this machine)

| Fact | Value |
|---|---|
| OS | Linux under **WSL2**. No sudo. The user runs the app on **Windows** (cross-packaged from here). |
| Node | v24 (`node -v`). Bundles target `node22`. |
| Dependencies | already installed in `node_modules/`. **Do not run `npm install`.** |
| Module type | ESM (`"type": "module"` in `package.json`). Scripts are `.mjs`. |
| Path alias | `@shared/*` -> `src/shared/*` (`tsconfig.json`, `vitest.config.ts`). |
| Temp | `.tmp/` (gitignored). vitest and Playwright set `TMPDIR=.tmp/tmp` themselves. |
| Display | Electron needs X. Sudo-free Xvfb: `~/.local/xvfb/start-xvfb.sh :99`. |

## Build

```bash
npm run build                                   # renderer (vite) + node entries (esbuild) -> dist/
npm run build:node                              # node entries only (main, preload, server, mcp)
node scripts/build-node.mjs --only server       # one of: electron | server | mcp
npx tsc --noEmit -p .                           # typecheck only, no output files
```

| Output | From |
|---|---|
| `dist/renderer/` | `src/renderer/` (Vite) |
| `dist/main/main.cjs`, `dist/main/preload.cjs` | `src/main/` |
| `dist/server/cli.mjs` | `src/server/cli.ts` |
| `dist/mcp/cli.mjs` | `src/mcp/cli.ts` |

**Vite does not typecheck.** A green build does not mean `tsc` is clean. Always run `tsc`.

## Run (only when the task needs it)

Prefer tests over running the app. If you must run it, use a **private profile** so the user's real settings stay untouched.

### Browser mode

```bash
mkdir -p .tmp/run/ws .tmp/run/config
SEC_EDIT_CONFIG_DIR=$PWD/.tmp/run/config npm run serve -- $PWD/.tmp/run/ws
```

- Prints `sec-edit serving <root>` and a URL **with an access token**. Default port 4317.
- Usage: `serve [folder ...] [--port N] [--host H] [--open]` (see `src/server/cli.ts`).
- **Pinned:** the page opens only the folders given (the first one opens) and folders inside them. Several: `npm run serve -- <folderA> <folderB>`.
- It runs until stopped. **Stop it when done** (Ctrl+C / kill the process).
- Needs `dist/` (run `npm run build` first).

### Desktop (Electron)

```bash
~/.local/xvfb/start-xvfb.sh :99
DISPLAY=:99 SEC_EDIT_USER_DATA=$PWD/.tmp/run/userData npm run electron -- --disable-gpu $PWD/.tmp/run/ws
```

- Under Xvfb you cannot see the window. Use it only to check that it starts and to read stdout.
- Keep the main log: add `SEC_EDIT_TIMINGS=1 SEC_EDIT_GIT_LOG=1` in front and `2>&1 | tee .tmp/run/main.log` at the end.
- For real behaviour use an Electron E2E test instead (`05-testing-and-verify.md`).
- **Windowless servers** (what the packaged launchers run, `src/main/launch-mode.ts`): `npm run electron -- --ozone-platform=headless --serve <folder>` or `... --mcp-stdio`. No display needed.

### Never

- Never run a Windows `.exe` from WSL. Never touch `/mnt/c`.
- Never run `npm run package:*` unless explicitly asked (it writes to `release/`).

## Useful environment variables (dev and tests only)

| Variable | Effect | Read in |
|---|---|---|
| `SEC_EDIT_CONFIG_DIR` | app data folder for server / MCP | `src/backend/appdata.ts` |
| `SEC_EDIT_USER_DATA` | Electron `userData` folder | `src/main/main.ts` |
| `SEC_EDIT_RENDERER_OUT` | private renderer build dir for E2E | `tests/e2e/global-setup.ts`, `tests/e2e/harness.ts` |
| `E2E_SKIP_BUILD=1` | reuse the renderer build (`test:e2e:file` sets it when the build is fresh) | `tests/e2e/global-setup.ts` |
| `E2E_CONSOLE=1` | print renderer console, page errors, main output in E2E | `tests/e2e/harness.ts`, `tests/e2e/electron/fixture.ts` |
| `E2E_AREA`, `E2E_REBUILD=1` | folder name under `.tmp/e2e-file/`; force the build | `scripts/e2e-file.mjs` |
| `SEC_EDIT_ELECTRON_APP`, `SEC_EDIT_SKIP_STAGE`, `SEC_EDIT_KEEP_STAGE` | staged app folder; reuse it; do not delete it (`test:e2e:file` sets them) | `tests/e2e/electron/global-setup.ts` |
| `SEC_EDIT_TEST=1` | enables `SEC_EDIT_TEST_*` hooks (set by the Electron fixture) | `src/main/main.ts` |
| `SEC_EDIT_TEST_GIT_TRUST` | `allow` (default) / `deny`: answers main's git-trust box in tests, logged as `[sec-edit:git-trust]` | `src/main/main.ts` |
| `SEC_EDIT_TEST_WEBSERVER_LAN` | `allow` (default) / `deny`: answers the LAN web-server confirm, logged as `[sec-edit:webserver-confirm]` | `src/main/main.ts` |
| `SEC_EDIT_PACKAGED_DIR` | folder of a test package (`scripts/package.mjs --out <dir> --test-package`) | `tests/e2e/electron/packaged.spec.ts` |
| `SEC_EDIT_TIMINGS=1` | print `[sec-edit:timings]` launch timings | `src/main/main.ts` |
| `SEC_EDIT_GIT_LOG=1` | print every git spawn | `src/backend/git-activity.ts` |
| `SEC_EDIT_WATCH` | force a file-watcher mode | `src/backend/watcher.ts` |

Packaged builds drop every `SEC_EDIT_*` variable except four (`PACKAGED_ENV_ALLOWED` in `src/main/env-guard.ts`).

## Where to look when debugging

| Symptom is in | Look at |
|---|---|
| main process | Electron **stdout / stderr** (lines start with `[sec-edit]`) |
| renderer | In tests: `E2E_CONSOLE=1` (table at the top). By hand: DevTools console, `Ctrl+Shift+I` (desktop) or the browser's DevTools |
| app state | `window.__secEdit` in the console (`.activePath.value`, `.settings.value`, `.docs`) |
| what ran in the background | the activity log in the status bar (`src/renderer/app/ActivityLog.tsx`) |
| processes / workers | palette -> "Developer: Process explorer" |
| git | `SEC_EDIT_GIT_LOG=1`; remember the trust gate |
| a failed Playwright test | `npm run trace:summary -- .tmp/e2e-file/<spec name>/results` + the `error-context.md` next to the trace |
| Xvfb | `~/.local/xvfb/xvfb.log` |
| browser-mode server | its terminal output; HTTP answers `{ ok: false, error: { code, message } }` |

## Error -> cause -> fix

| Error / symptom | Cause | Fix |
|---|---|---|
| `sec-edit: ... is not built yet - run npm run build` | no `dist/` | `npm run build` |
| `Renderer not built at ...` (E2E) | `E2E_SKIP_BUILD=1` but no build in `SEC_EDIT_RENDERER_OUT` | use `npm run test:e2e:file`, or run once without `E2E_SKIP_BUILD` |
| `Another run (pid N) uses .tmp/e2e-file/...` | the same spec is already running | wait, or put `E2E_AREA=<name>` in front |
| `usage: npm run test:e2e:file -- ...` | no spec file given | add the `tests/e2e/<file>.spec.ts` path after `--` |
| `Port N is in use. Pass --port <n>.` | another server is running | stop it, or `--port 4399` |
| Electron exits at once / "cannot open display" | no X server | `~/.local/xvfb/start-xvfb.sh :99` and `DISPLAY=:99` |
| page shows `Failed to start: ...` | renderer boot threw (`boot().catch` in `src/renderer/main.tsx`) | read the message; usually a bad startup import or a missing token |
| timeout on `html[data-ready="true"]` | same as above | rerun with `E2E_CONSOLE=1`; read the `[renderer:pageerror]` line |
| `EACCES ... Untrusted sender` | IPC from a non-app frame, or the old page right after an in-place folder switch (`staleRealm`, until it reloads) | not your bug; do not weaken `trustedSender` / `trustedCtx` |
| `EACCES: This folder was not chosen in the app` | `openWorkspace` without a vouch | E2E: `app.evaluate(() => globalThis.__secEditVouch(path))` |
| `EACCES: This web server only serves the folders it was started for` | the page opened a folder outside the server's folder arguments | pass that folder to `serve` |
| `EACCES: One's own data folder cannot be opened as a folder` | the test folder is inside `SEC_EDIT_CONFIG_DIR` / userData | keep the workspace next to the config folder, not inside it |
| `EACCES: Git's own folder (.git) cannot be changed from One` | a page write under `.git` (`protectGitDir`) | by design; set up repos from the test (`git-helpers.ts`) |
| `OUTSIDE_WORKSPACE` | a symlink leads out of the folder, or a bad relative path | fix the path; never bypass `ws.real()` |
| `ENOTSUP` in browser mode | desktop-only call (terminal, `exportPdf`) | feature-detect in the renderer |
| `NO_WORKSPACE` | no folder open | call `openWorkspace` first (tests: the harness does) |
| git UI empty, status `untrusted` | folder not trusted | tests: `trustRepo(root)`; app: Trust in Source control, then **Trust** in the native box |
| `EACCES: Trust this folder in the desktop app` / `ENOTSUP` on `git('trust')` | no `ServiceHooks.confirmTrust` (unit-test service, MCP) / an HTTP server never grants trust | tests: `trustRepo(root)` |
| `no Settings control for "x.y"` (vitest) | setting read without a registry row | add the row (`03-playbooks.md` A) |
| a lazy panel / Settings shows nothing, no error | two files differ only by case, or wrong export name in `import().then((m) => m.X)` | check the export name with grep; never case-only twins |
| pill shows an empty box | icon name not registered at startup | `addIcons({...})` in the stub or `icons.tsx` |
| key does nothing in the terminal | not in `APP_KEYS_IN_TERMINAL` | by design; add only if needed |
| terminal: `posix_spawnp failed` (macOS) | node-pty helper lost its execute bit | `node scripts/postinstall.mjs` |
| `inotify watch limit reached` | huge folder on Linux | harmless warning in tests |
| tests see the project's own git repo | temp workspace outside `.tmp/` | keep temp under `.tmp/` (configs set `GIT_CEILING_DIRECTORIES`) |
| startup bundle test fails | you added a static import to a startup module | make it `import()`; see `04-rules-and-pitfalls.md` section 6 |
| `tsc` errors in files you did not touch | another change in progress | report them; do not fix |

## Inspect the startup bundle (only if asked)

```bash
npm run analyze
node tests/perf/bundle-report.mjs dist/renderer
```

## Clean up

```bash
ls .tmp/<area>/            # your outputs
rm -rf .tmp/<area>/        # only inside .tmp/
```

Never delete anything outside `.tmp/`. Never `git clean`, `git checkout -- .` or `git reset`.
