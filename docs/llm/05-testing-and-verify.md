# 05 - Testing and verify

> **WHEN TO READ THIS:** you changed code and need to prove it works, or you must add a test.
> **WHAT YOU GET:** the FAST LOOP table (fastest command per change), which test type to pick, what "done" means, and the failing-test checklist.
> **NEXT FILE:** `06-setup-and-debugging.md` (if a command fails)

## FAST LOOP (use this first)

**Pick your row. Run that one command. Then `npx tsc --noEmit -p .`.** Durations measured on the dev machine, 2026-11-23.

| You changed | Fastest command | Takes |
|---|---|---|
| any `.ts` / `.tsx` | `npx tsc --noEmit -p .` | **~1.6 s** |
| logic with a unit test | `npx vitest run tests/unit/<area>/<file>.test.ts` | **~0.7 s** + the tests |
| one unit case | same + `-t "part of the name"` | **~0.7 s** |
| UI flow, first run | `npm run test:e2e:file -- tests/e2e/<file>.spec.ts` | **~4-6 s** (builds, ~3.5 s) |
| UI flow, **only the test changed** | same command again | **~2 s** (build reused) |
| one E2E case | same + `-g "part of the title"` | **~2 s** |
| desktop-only, first run | `npm run test:e2e:file -- tests/e2e/electron/<file>.spec.ts` | **~5-8 s** (stages the app) |
| desktop-only, only the test changed | same command again | **~3 s** |

- **`npm run test:e2e:file`** (`scripts/e2e-file.mjs`) puts everything in `.tmp/e2e-file/<spec name>/`. It rebuilds **only when `src/` or a build config changed**.
- It **refuses to run without a spec file.** Force a rebuild with `E2E_REBUILD=1` in front.
- Two runs of the **same** spec at once: give one `E2E_AREA=<name>` in front.
- A test fails? Go to **"Failing test -> debug steps"** at the end of this file.

## Project rule (important)

- **You run only your own tests** (the files you added or changed) **plus `tsc`.**
- **One full run per iteration happens elsewhere** (the lead, in a release snapshot). Never run the whole suite.
- **No review screenshots.** UI is proven by E2E tests; the user tries a build.
- A test you did not write fails? **Report it. Do not change it.**

## Which test for which change

| You changed | Test type | Folder | Speed |
|---|---|---|---|
| pure logic: `src/shared/`, `src/search/`, `src/knowledge/`, `src/format/`, reducers, parsers | **vitest (node)** | `tests/unit/<area>/` | seconds |
| `src/backend/` (`BackendService`, `Workspace`, git) | **vitest (node)**, temp folder | `tests/unit/backend/`, `tests/unit/git/` | seconds |
| `src/mcp/` | **vitest (node)** | `tests/unit/mcp/` | seconds |
| a Preact component in isolation | **vitest + happy-dom** | `tests/unit/<area>/*.test.tsx` | seconds |
| a UI flow (click, type, key, menu) that exists in both modes | **Playwright browser** | `tests/e2e/*.spec.ts` | builds the renderer first |
| desktop-only: terminal, window frame, vault, native dialogs, `src/main/` | **Playwright Electron** | `tests/e2e/electron/*.spec.ts` | slow, stages the app |

**Pick the cheapest type that can fail for your bug.** Most changes need only vitest.

## Commands (copy-paste)

### Typecheck - always

```bash
npx tsc --noEmit -p .
```

Empty output = clean. Fix only your own errors.

### Unit - one file

```bash
npx vitest run tests/unit/<area>/<file>.test.ts
npx vitest run tests/unit/<area>/<file>.test.ts -t "part of the test name"   # one case
```

- DOM test: first line of the file must be `// @vitest-environment happy-dom`.
- Temp folders: use `os.tmpdir()` (vitest sets `TMPDIR` to `.tmp/tmp`) or a path under `.tmp/<area>/`.
- **Do not run** `perf.test.ts` / `*-perf.test.ts` files (timing tests).

**Optional - which unit tests import the files I changed?** List first, never run blind:

```bash
npm run test:changed:list     # prints the test files; runs nothing
npm run test:changed          # runs them - only when the list has 10 files or fewer
```

- More than 10 files listed: **do not run it.** Run your own test file only.
- A change to `package.json`, `vitest.config.ts` or `vite.config.ts` lists **every** file. Do not run it then.

### Browser E2E - one file

```bash
npm run test:e2e:file -- tests/e2e/<file>.spec.ts
npm run test:e2e:file -- tests/e2e/<file>.spec.ts -g "part of the title"   # one case
```

- First run builds the renderer into `.tmp/e2e-file/<spec name>/renderer`. Later runs reuse it until `src/` changes.
- Results and traces: `.tmp/e2e-file/<spec name>/results/`.
- Everything after the spec path goes to Playwright unchanged (`-g`, `--trace on`, `--workers 1`).
- **Do not run** `perf*.spec.ts`, `*-perf.spec.ts`, `*-shots.spec.ts`, `journey-scale.spec.ts`, `search-scale.spec.ts`.

The long form does the same, but **rebuilds on every run** (`E2E_SKIP_BUILD=1` in front reuses the build):

```bash
SEC_EDIT_RENDERER_OUT=$PWD/.tmp/<area>/renderer \
  npx playwright test tests/e2e/<file>.spec.ts --output $PWD/.tmp/<area>/test-results
```

### Electron E2E - one file (only for desktop-only changes)

```bash
npm run test:e2e:file -- tests/e2e/electron/<file>.spec.ts
```

- First run stages a production app into `.tmp/e2e-file/<spec name>/app`. Later runs reuse it until `src/` changes.
- Xvfb starts on `:99` by itself if `DISPLAY` is not set (`tests/e2e/electron/global-setup.ts`).
- This is the heaviest command you may run. **One file at a time.**
- Long form (stages on every run): `npx playwright test -c playwright.electron.config.ts tests/e2e/electron/<file>.spec.ts`

### Build - only when asked to hand over a build

```bash
npm run build
```

## How to write each kind

### Unit (node) - copy `tests/unit/app/panel-menu.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { menuPanels } from '../../../src/renderer/app/ui';   // import from src with a relative path

describe('menuPanels', () => {
  it('no setting: the registered order', () => {
    expect(menuPanels([{ id: 'files' }], null).map((p) => p.id)).toEqual(['files']);
  });
});
```

### Backend - copy `tests/unit/bookmarks/service.test.ts`

Pattern: `mkdtemp` -> write files -> `new BackendService(cfg)` -> `openWorkspace(root)` -> call -> `dispose()` -> `rm`.

### Component - copy `tests/unit/app/status-corner.test.tsx`

Pattern: `// @vitest-environment happy-dom`, `render(<X />, host)` inside `act()`, query the DOM.

### Browser E2E - copy `tests/e2e/smoke.spec.ts`

```ts
import { test, expect } from './harness';

test('opens a file', async ({ page, ws }) => {
  await ws.open(page);                                   // waits for html[data-ready="true"]
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
});
```

| Helper | What |
|---|---|
| `ws.open(page)` | load the app, wait until booted |
| `ws.root`, `ws.read(rel)`, `ws.write(rel, text)` | the temp copy of `tests/fixtures/workspace/` |
| `window.__secEdit` | the `app` singleton inside `page.evaluate` |
| `tests/e2e/editor-helpers.ts` | `openNote`, `content`, `cursorTo`, `setTheme` |
| `tests/e2e/git-helpers.ts` | `initRepo`, `trustRepo`, `gitReady`, `refreshGit` |

- Each worker gets a **fresh server + fresh workspace copy**. Create extra files in `beforeEach` under `ws.root`.
- **Never edit existing fixture files.**
- Prefer stable selectors: `data-row="<setting key>"`, `data-nav="<section>"`, `button[data-panel="<id>"]`, `getByRole`.
- Git features need `trustRepo(ws.root)` first (git runs only in trusted folders).

### Electron E2E - copy a case from `tests/e2e/electron/app.spec.ts`

```ts
import { test, expect } from './fixture';

test('launches', async ({ el }) => {
  const { page } = await el.launch();     // default args: [el.ws]
  await expect(page.locator('.se-tree-row').first()).toBeVisible();
});
```

- Terminal tests run real bash: give them a private `HOME` under `el.tmp`.
- Test hooks are env vars `SEC_EDIT_TEST_*`; they only work with `SEC_EDIT_TEST=1` and are dead in packaged builds.

## Tests that guard rules (run them when you touch the thing)

| You touched | Run |
|---|---|
| any setting | `tests/unit/settings/registry.test.ts` |
| MCP tool text or schema | `tests/unit/mcp/budget.test.ts`, `tests/unit/mcp/tools.test.ts` |
| anything `src/mcp/` imports | `tests/unit/mcp/isolation.test.ts` |
| path rules (MCP / go to definition) | `tests/unit/mcp/paths.test.ts`, `tests/unit/search/goto-paths.test.ts` |
| `src/search/symbols.ts` | `tests/unit/search/symbols.test.ts` |
| `src/shared/languages.ts` / associations | `tests/unit/format/languages.test.ts`, `tests/unit/format/associations.test.ts` |
| the sidebar bar / panels | `tests/unit/app/panel-menu.test.ts` |
| terminal keys | `tests/unit/terminal/keys.test.ts` |
| `src/backend/workspace.ts` | `tests/unit/backend/workspace.test.ts` |

## Definition of done

- [ ] `npx tsc --noEmit -p .` is clean.
- [ ] One test (new or extended) **fails without your change and passes with it**.
- [ ] You ran that test file and it passed. You pasted the result line in your report.
- [ ] Guard tests from the table above pass, if you touched their subject.
- [ ] `git status --short` lists only planned files. Nothing committed.
- [ ] Docs updated if user-visible (`docs/USER-GUIDE.md`) or a contract changed (the matching `09-reference-*.md`).
- [ ] No process of yours is still running. Temp output is under `.tmp/`.
- [ ] Your report says what was **not** verified (for example: "desktop path not run").

## Failing test -> debug steps

**Do the steps in order. Stop at the first one that explains the failure.**

1. **Read the error block** in the terminal: the message, the `>` source line, the `Call log`.
2. **Rerun only that case.** Unit: add `-t "name"`. E2E: add `-g "title"` (build is reused, ~2 s).
3. **Compare with the table below.** Known symptom = apply its fix.
4. **E2E: read the page at the failure.** Open the `error-context.md` path the terminal printed (page snapshot as text).
5. **E2E: see the renderer console.** Put `E2E_CONSOLE=1` in front of the command. Lines start with `[renderer:error]`, `[renderer:pageerror]`, `[main]`.
6. **Browser E2E: read the trace as text.** `npm run trace:summary -- .tmp/e2e-file/<spec name>/results`
7. **Check the fix direction:** the test must fail **without** your change. If it also fails on untouched code, it is not your bug: report it.
8. **Still unknown after 3 attempts: STOP AND ASK.** Paste the error block and the `trace:summary` output.

- **Never** make a test pass by raising a timeout, adding a sleep, or deleting an assertion.
- **Never** use `--debug`, `--ui` or `--headed`: this machine has no display. More tools: `06-setup-and-debugging.md`.

| Symptom | Likely cause | Do |
|---|---|---|
| `Renderer not built at ...` | `E2E_SKIP_BUILD=1` without a build | use `npm run test:e2e:file`, or drop `E2E_SKIP_BUILD` once |
| `Another run (pid N) uses .tmp/e2e-file/...` | the same spec is already running | wait, or put `E2E_AREA=<name>` in front |
| E2E still shows old behaviour | a stale build was reused | put `E2E_REBUILD=1` in front once; report it |
| `no Settings control for "x.y"` | you read a setting with no registry row | playbook A in `03-playbooks.md` |
| budget test fails | MCP description too long | shorten the text |
| timeout waiting for `html[data-ready="true"]` | the app crashed at boot | rerun with `E2E_CONSOLE=1`; check your startup import |
| passes alone, fails together | not your call | report it; the lead runs the combined suite |
