# 09 - Reference: rules 1-11 and version control

> **WHEN TO READ THIS:** you need the full reasoning behind a rule in `04-rules-and-pitfalls.md`.
> **WHAT YOU GET:** the numbered engineering rules (code and comments cite them as "rule N") and the lead-only release rules.
> **NEXT FILE:** `09-reference-security.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Rule 1: Paths

- **Paths**: everything crossing the backend boundary is workspace-relative POSIX (`notes/a.md`).
- Never build paths with `\`.
- Windows matters: CRLF files (content is LF-normalised, EOL restored on save), case-insensitive FS, drive letters, `\\` in absolute paths.
- **Case sensitivity is per folder, never per OS**: read `WorkspaceInfo.caseSensitive` (renderer) / `Workspace.foldsCase` (backend).
- A `\\wsl.localhost` root on Windows is case-sensitive; never fold case because of `process.platform` or `backend.os`.

## Rule 2: Launch speed is a feature

- **Launch speed is a feature.**
- Nothing heavy at startup: Shiki, Prettier, KaTeX, Mermaid, language grammars → `import()` lazily on first use.
- Workers for CPU work (search index, formatting).
- Don't block first paint.
- **Startup bundle** (`node tests/perf/bundle-report.mjs <renderer dir>`; target < 100 kB, perf.spec): a module is never split by export, so a function only a lazy chunk calls still ships at startup when it lives in a startup module.
- Put it in that chunk, or in a module only that chunk imports (`app/file-rules.ts` → Popups; `setDocEol` / `cycleContentWidth` live in doc-chrome, `openFolderInteractive` in shell-commands).
- Every `import()` **call site** in a startup chunk repeats the target's preload list: startup modules load Popups only through `popups()` (`app/fileops.ts`; 11 sites were ~0.9 kB), do the same for any lazy chunk several startup modules import.
- `vite.config.ts` (`trackStartupChunks` + `modulePreload.resolveDependencies`) drops the startup chunks from every `import()` preload list: they are loaded before any import runs (~0.9 kB of no-op entries). index.html's own modulepreload links are untouched.

## Rule 3: Styling

- **Styling**: use CSS variables from `src/renderer/styles/app.css` (`--bg`, `--text`, `--accent`, `--code-bg`, …) so dark/light themes work.
- Corners: never hard-code `border-radius` — use `--radius-sm` / `--radius` / `--radius-lg` / `--radius-xl` (and `--radius-pill` for pills); "square" corner style flattens them.
- Text column: `--content-width`, `--editor-line-height`.
- Accent tokens are user-tunable: never hard-code the blue.
- Two sidebar styles exist (setting `sidebarStyle`: `shelf` default, `classic`): the root has `.ui-shelf` / `.ui-classic`; scope style-specific sidebar/tree CSS under those classes.
- **Integrated window frame** (desktop default, root class `.frame-integrated`): there is no OS title bar — the tab strip (`.se-topline`), the shelf head, the classic Files header and activity bar are `-webkit-app-region: drag`.
- Anything clickable you put there must be **no-drag**: `button`, `input`, `select`, `a`, `[role=tab|button]` and `[tabindex]` already are (app.css); otherwise add class `se-no-drag`.
- Floating UI over the strip (menus, dialogs) must be no-drag too.
- Don't place anything under the window controls: the strip reserves them via `--wco-right`.
- Put your CSS in your own folder (e.g. `src/renderer/editor/editor.css`) and import it from your module.
- **Prefix classes `se-`.**
- **app.css holds only first-screen styles:**
  - classic-only rules are in `app/classic.css` (classic chunk);
  - the palette, dialog, picker and stepper bases (`.se-palette*`, `.se-dialog*`, `.se-picker*`, `.se-stepper`) are in `app/overlays.css`: import it from any chunk that renders them;
  - `.se-overlay` and `.se-menu*` stay in app.css.
- Icons: `app/icons.tsx` holds only first-screen glyphs; others are in the lazy `app/icon-pack.ts` or your chunk's `addIcons()`.
- An `<Icon>` whose name isn't registered yet draws an empty box and redraws when it arrives.
- **No two source files may differ only by case** (`settings.ts` + `Settings.tsx`): on macOS / Windows an import of `./Settings` resolves to the wrong one and the lazy chunk silently exports nothing (Settings stopped opening on macOS this way; the component is now `SettingsOverlay.tsx`).
- Check: `git ls-files | grep -E '\.(ts|tsx|js|mjs)$' | sed -E 's/\.[^./]+$//' | sort -f | uniq -di`.

## Rule 4: Dependencies

- **Dependencies**: install ONLY via `flock .tmp/sec-edit-npm.lock npm install <pkg>` (serialises concurrent agents).
- Edit `package.json` scripts ONLY via `flock .tmp/sec-edit-npm.lock npm pkg set scripts.x="..."`.

## Rule 5: Testing is mandatory

- **Testing is mandatory.**
- Unit tests in `tests/unit/<area>/`, E2E in `tests/e2e/<area>*.spec.ts` using `tests/e2e/harness.ts` (fresh server + temp workspace copy per worker).
- Run E2E with a **private build dir** so parallel agents don't clobber each other: `SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer npx playwright test tests/e2e/<area> --output $PWD/.tmp/<area>/test-results` (the private results dir keeps parallel runs from clobbering `test-results/`).
- Unit: `npx vitest run tests/unit/<area>`.
- Typecheck: `npx tsc --noEmit -p .` (must stay clean — fix your own errors, don't touch others').
- DOM unit tests: add `// @vitest-environment happy-dom` at the top.
- Add fixture files under `tests/fixtures/workspace/` only if needed and **don't modify existing fixtures** (other tests depend on them).

## Rule 6: Electron E2E

- **Electron E2E** (shell): Xvfb is available sudo-free: `~/.local/xvfb/start-xvfb.sh :99` then run Electron with `DISPLAY=:99` and `--disable-gpu`.
- Native save dialog (PDF export) in tests: `SEC_EDIT_TEST_SAVE_PATH=default|cancel|<abs path>` (only with `SEC_EDIT_TEST`).
- Desktop-only RPC methods (`exportPdf`, `showExportedFile`) are refused by the HTTP server with `ENOTSUP`, and so is every terminal name (`isTerminalMethod`): browser mode never exposes a shell.
- Terminal E2E (`tests/e2e/electron/terminal.spec.ts`) runs real bash; give it a private `HOME` (a developer's `~/.bashrc` may `cd ~`).
- `node-pty` is native: `build-node.mjs` keeps it external, `stage.mjs` copies only the target's binaries, `package.mjs` unpacks it to `app.asar.unpacked`.

## Rule 7: Keep the renderer secure

- Keep the renderer secure: `contextIsolation`, sandboxed preload, DOMPurify on all rendered HTML (the sanitizer contract in `09-reference-browser-preview.md`: no app classes / data-* from notes, no remote media unless allowed), no `eval`.

## Rule 8: No new top-level frameworks

- No new top-level frameworks (no React/Vue/Tailwind).
- Small focused libs are fine.

## Rule 9: Code comments

- Code comments explain *why*, briefly.

## Rule 10: Stay inside the project

- **Stay inside the project.**
- Temp files, test workspaces and outputs go in `<project>/.tmp/<area>/` only.
- Never write outside the project (no `/tmp`, no Windows side via `/mnt/c` or `%TEMP%`, no user folders) and never run Windows executables via WSL interop.
- If a test truly needs that (e.g. real NTFS), stop and ask the lead, who asks the user first. vitest and both Playwright configs set `TMPDIR=<project>/.tmp/tmp`; for ad-hoc scripts (benchmarks, node -e) set `TMPDIR=$PWD/.tmp/tmp` yourself.

## Rule 11: This machine is the user's own PC

- **This machine is the user's own PC.**
- Never run synthetic CPU load generators, repeated full-suite cycles or long benchmark sessions without the lead's approval (the lead asks the user first).
- Keep verification bounded: one full run per change set, one heavy job at a time, and kill your orphan processes when done.

## Version control (lead only)

- **Agents never run `git commit`, `git tag`, `git push` or anything that changes history.**
- The lead commits only verified-green states.
- **Commit subject: one line that sums up the change in plain words.** What is actually done (`git log --oneline -10`):
  - feature commits since v0.5.4: a long summary, `Area: what changed; next change; next change` (100-350 characters);
  - small fixes and older commits: a short title ("Add multi-core search indexing").
- **No body** (the subject carries everything), **no co-author / tool trailers or links**.
- Author = the repo-local identity (a GitHub noreply address). Do not change git config.
- Why these rules, and other choices made on purpose: `10-decisions.md`.
- Before each release: `npm run security` (npm audit, outdated packages, newest Electron patch + end of support, fuses of a built package; exit 1 = fix first).
- Electron patches carry Chromium security fixes: take them every release.
- **Each iteration ends with one release commit + one annotated tag.** Title: `Release v0.5.x`. Tag: the same `v0.5.x`.
- **The number is a patch bump:** `v0.5.4` -> `v0.5.5` -> `v0.5.6`. A minor bump (`v0.4.9` -> `v0.5.0`) is rare and the lead decides it. Current version: `v0.5.5`.
- **`scripts/iteration.mjs` (`npm run iteration -- "summary"`) differs:** it bumps the **minor** version (`v0.5.5` -> `v0.6.0`). **Ask the lead before running it.**
- The script needs a clean tree. It sets `version` in `package.json`, commits and tags.
- **The commit shown in Settings gets `-dirty`** (`scripts/stage.mjs`): when `git status --porcelain --untracked-files=no` prints anything at stage time — tracked edits, staged or not. Untracked files (a new test file) never make it dirty. The string is baked into the build, so that build keeps saying `-dirty` after the tree is clean again.
