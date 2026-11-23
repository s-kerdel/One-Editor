# 10 - Decisions (tried / removed / rejected / chosen on purpose)

> **WHEN TO READ THIS:** before you remove, refactor, rename or "simplify" anything, or before you propose an idea that feels obvious.
> **WHAT YOU GET:** one row per decision: what was decided, why, and what you must NOT do. Evidence = git log, code comments, the lead.
> **NEXT FILE:** `04-rules-and-pitfalls.md` (section "Load-bearing - do not touch").

**Rule: a decision here is final for you.** Do not undo it. Do not "improve" it. If your task needs it changed: **STOP AND ASK**.

**"reason not recorded - ask the lead"** means exactly that. Do not guess a reason. Do not treat a missing reason as permission.

Look up a commit: `git show --stat <hash>` (read-only). Versions are the release tags (v0.1.0 ... v0.5.5).

## 1. Product and process

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| lead | **One is the only editor.** The Zed / Obsidian / VS Code / PhpStorm modes were removed. | reason not recorded - ask the lead | Add an editor mode, a "keymap preset" or an "open in other editor" feature. |
| lead | **Windows is a target platform** (04 calls it the primary target). | reason not recorded - ask the lead | Write POSIX-only code. Drop CRLF, drive-letter or case-folding handling. |
| lead | **Releases are patch tags**: one release commit + one annotated tag per iteration. | reason not recorded - ask the lead | Bump minor or major. Tag. Run `npm run iteration` (it bumps the minor). |
| v0.2.4 (d1d9ae7), v0.3.0 (f0d1448) | **Temp files, test output and packaging stay inside the project** (`.tmp/`). | Rule 10: nothing outside the project without the user's approval. | Use `/tmp`, `/mnt/c`, `%TEMP%` or a user folder. |
| v0.4.1 (f72b16f) | **No load generators, loops or long benchmarks** without approval. | Rule 11: this machine is the user's own PC. | Run the full suite, a benchmark loop or a CPU burner. |
| v0.4.6 (e4566d4) | **The app is called One.** Data folder, internal name and env prefix stay `sec-edit`. | reason not recorded - ask the lead | Rename `SEC_EDIT_*`, `sec-edit-*` keys or the data folder to "one". |
| v0.4.8 (2b30a23) | **Licence: GPL-3.0-or-later**; licence texts ship in packaged builds (4f9eeed). | reason not recorded - ask the lead | Add a dependency without asking (its licence must fit). Remove the notices. |
| all commits | **Commit subject = a feature summary** in plain words. No body, no trailers. | See `09-reference-rules.md`, "Version control". | Commit at all. Add co-author or tool lines. |

## 2. Startup speed

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| v0.2.0 (09d0144), v0.4.5 (6a76185) | **The `core` chunk group holds only `app` and `ui`** (`vite.config.ts`). | A larger group was tried: it saved 1.7 kB gzip but made the warm launch ~12 ms slower (80 -> 94 ms), measured. | Add modules to the `core` group. |
| v0.2.0 (1c2156a) | **Indexing runs in a worker**, not on the main thread. | Rule 2: CPU work goes in workers; do not block first paint. | Index, parse or format on the UI thread. |
| v0.4.7 (c121508) | **Browser-mode platform code loads only in browser mode.** | Desktop startup bundle went down to 37.5 kB gzip (commit subject). | Import `src/renderer/platform/web.ts` statically. |
| code | **Windows and Linux have no application menu** (`src/main/main.ts`). | File header: saves startup time and stray accelerators like Ctrl+R / Ctrl+W. | Add a default menu or menu accelerators there. |
| code | **The renderer is served from an `app://` scheme**, not `file://`. | `src/main/main.ts` header: V8 code cache works only there. | Load the page from `file://`. |
| code | **The text cache file is uncompressed** (`src/backend/indexcache.ts`). | Compression was measured: inflating 26 MB cost ~250 ms before the first page; a CRC check is ~10 ms. | Add gzip / compression to the cache. |
| code | **16 libuv threads only for slow roots** (WSL, UNC, network). | `src/main/main.ts`: on a local disk 16 threads only contend; the launch tree walk took ~2x as long. | Set `UV_THREADPOOL_SIZE` for every launch. |

## 3. Security

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| v0.4.6 (6f3c20a) | **Git runs only in trusted folders** (trust gate). | `src/backend/git.ts`: a downloaded folder with a hostile `.git/config` must not get code execution by being opened. | Spawn git outside `BackendService`. Skip the gate "for read-only commands". |
| v0.4.6 (6f3c20a) | **Browser token travels in the `x-sec-edit-token` header only.** | `src/server/server.ts`: cookies ignore ports, so every server on 127.0.0.1 would get it; no cookie also means no CSRF. | Put the token in a cookie or a URL. |
| code | **Browser mode has no terminal.** Terminal names answer `ENOTSUP`. | Rule 6: browser mode never exposes a shell. | "Fix" the missing terminal in browser mode. |
| code | **Main opens only folders it saw itself** (`OpenGate`). | `src/main/open-gate.ts`: a taken-over page must not turn "this folder" into "any folder of this user". | Open a folder from a path string the page sent. |
| code | **Windows system programs run by absolute path** (`winSystemExe`). | `src/backend/winsys.ts`: a bare name resolves in the current directory first, and that can be the untrusted open folder. | Spawn `powershell.exe`, `wsl.exe`, `git.exe` by bare name. |
| code | **A shared vault key (`vault:<key>`) works from any folder** by design, behind a native dialog. | `src/main/vault.ts` + `src/main/main.ts`: the user decides in a dialog the page cannot answer. | Scope shared keys to a folder. Answer the dialog from the page. |
| v0.5.2 (f1948ca) | **MCP live files: small regular files only, no blocking opens, one scan at a time.** | Commit subject says "safely"; detail: reason not recorded - ask the lead. | Read them with a plain unbounded read. |
| 2026-11-23 (working tree) | **Opencode inside WSL starts plain: no private server, no password into the distro**, even with `opencode.follow` on (toast says so). Lookup + start mirror Claude's WSL path. | Bug: Windows build + WSL default shell said "Opencode is not installed. In PowerShell: npm i -g opencode-ai" (`detectOpencode` was native only). Server in WSL: loopback reach from Windows and ending it with the terminal are unproven. | Start `opencode serve` through `wsl.exe`, or pass `OPENCODE_PASSWORD` via `WSLENV`, without proving both on Windows first. |
| v0.5.5 (654267d) | **File type associations: MCP writes can only get stricter.** | Commit subject; detail: reason not recorded - ask the lead. | Let an association loosen what an MCP write accepts. |

## 4. Git

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| code | **Only read commands**, with `GIT_OPTIONAL_LOCKS=0`. | `src/backend/git.ts`: `status` must never rewrite the index (no index hooks run). | Add a git call that mutates a repo outside the existing action paths. |
| code | **The index refresh is never killed.** | `src/backend/git-wsl.ts`: a killed git can leave `index.lock` behind. | Add a kill / timeout to the refresh. |
| v0.5.5 (e81328f) | **Retry only reads the repository again.** It never repeats a fetch, push or other action. | Commit subject. | Re-run the failed action on Retry. |
| v0.5.5 (e81328f) | **First look at git may take 15 s** (`T_DISCOVER`). | `src/backend/git.ts`: a cold git start can be slow (security scan of the binary, Defender); a miss is not final. | Lower it. Cache a timed-out first look for the session. |
| v0.2.0 (8d15e11) | **`GitMonitor` alone decides when status runs.** | Section 4 of `04-rules-and-pitfalls.md`; detail: reason not recorded - ask the lead. | Poll git from the renderer. Use `git('nudge')`. |

## 5. Keys and platforms

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| lead + code | **No globalShortcut and no before-input-event handler in main.** Verified: no hit in `src/`. | reason not recorded - ask the lead | Register an OS-wide shortcut or intercept keys in main. |
| v0.5.4 (9b3efd2) | **F12 = Go to definition.** DevTools moved to Ctrl+Shift+I. | Commit subject + `09-reference-keys.md`. | Bind F12 to DevTools again. |
| v0.5.5 (36d8866) | **macOS menu has no Reload accelerator** (`appMenuTemplate`). | `src/main/app-menu.ts`: a reload kills every terminal's shell, and Ctrl+R is the shell's reverse search. | Restore Electron's default menu. Add an accelerator without Cmd. |
| v0.5.5 (36d8866) | **A file opened from outside becomes a tab.** It never changes the open folder. | Commit subject + `src/main/main.ts` comment. | Switch the workspace when a file is opened. |
| v0.5.5 (71225bf) | **Mac: a Cmd chord made by a keyboard remapper is read as Ctrl in the terminal** (`REMAP_GAP_MS`). | `src/renderer/terminal/keys.ts`: Karabiner turned Ctrl+C / Ctrl+R into Cmd chords; the shell never got them. | Remove the detection as "odd timing code". |
| v0.2.4 (6d0608c) | **Case sensitivity is decided per folder, never per OS.** | Rule 1: a `\\wsl.localhost` root on Windows is case-sensitive. | Fold case because of `process.platform`. |
| rule 3 | **No two source files differ only by case.** The old Settings component file became `SettingsOverlay.tsx`. | Rule 3: on macOS / Windows the import resolved to the wrong file; Settings stopped opening on macOS. | Create a case-only twin file. |
| v0.5.5 (e7e042b) | **App icon: 16 and 32 px images are raw pixels** (ic04 / ic05). | Commit subject: macOS showed noise at small sizes otherwise. | "Simplify" the icns packer to PNG-only entries. |

## 6. UI

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| v0.4.2 (7028a98) | **Process explorer is docked under the editor**, not a modal. | reason not recorded - ask the lead | Turn it back into a dialog. |
| code | **Setting `zen.keepFileTree` was removed on purpose.** A stored value is ignored. | `src/renderer/app/settings-registry.ts` says "gone on purpose"; reason not recorded - ask the lead. | Re-add the setting or read the old value. |
| code | **The overview panel has no close button.** | `src/renderer/overview/OverviewPanel.tsx`: in the top-right corner it would sit next to the window's own close button. | Add a close button there. |
| v0.5.5 (b7ad1ee) | **Follow toggles (`claude.follow`, `opencode.follow`) are separate and off by default.** | reason not recorded - ask the lead | Merge them or turn them on by default. |
| v0.5.4 (1568f7e) | **Go to definition: linear parsers, per-click budgets, PSR-4 caps; excluded files stay out of the index.** | Review fixes (commit subject); detail: reason not recorded - ask the lead. | Remove a cap or budget. Add a backtracking regex parser. |
| v0.3.1 (42f1c38) | **Search index builds at launch or on demand** (setting `search.indexing`). | reason not recorded - ask the lead | Assume the index exists. Call `searchClient.start()` when you need it. |

## 7. Tests and dev loop

| Version | Decision | Why | Do NOT |
|---|---|---|---|
| 2026-11-23 (after v0.5.5) | **vitest pool / isolation stay at the defaults.** | Measured, 16 cores: full unit run 28.2 s for 203 files; one file 0.7 s. The wall time is one serial file (`tests/unit/git/ops.test.ts`, 18.9 s) plus the serial timing project, not worker start-up. | Set `isolate: false` or change the pool "for speed" without a measured full run. |
| 2026-11-23 | **`tsc` stays non-incremental.** | Measured: `npx tsc --noEmit -p .` takes 1.6 s (TypeScript 7). A build-info file would save nothing worth a stale-cache risk. | Add `incremental` / a tsbuildinfo file. |
| 2026-11-23 | **Build reuse lives in `scripts/e2e-file.mjs` only.** Plain `npx playwright test` still builds on every run. | Measured: renderer build ~3.5 s of a 6.1 s one-spec run; reuse gives 2.5 s. The lead's full run in a release snapshot must never see a stale build. | Move the freshness check into `tests/e2e/global-setup.ts` or make it the default. Narrow the stamp's inputs (all of `src/` on purpose). |
| 2026-11-23 | **E2E fixed sleeps (`waitForTimeout`) were not mass-replaced.** | 205 literal sleeps, 128.5 s summed (static count). Many are "wait, then assert nothing happened"; each needs its spec re-run to prove a condition wait is equal. | Replace a sleep without running that spec before and after. |

## How to add a row (lead only)

1. One row per decision. Put the version or commit hash in column 1.
2. **Why** must quote evidence: a commit subject, a code comment, or the lead's words.
3. No evidence = write "reason not recorded - ask the lead".
