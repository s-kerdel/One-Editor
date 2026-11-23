# 09 - Reference: git

> **WHEN TO READ THIS:** you touch git status, the diff view, staging, the trust gate or a git timeout.
> **WHAT YOU GET:** when git runs, the timeout / Retry contract, one way into a diff, editing in the diff view, the trust gate.
> **NEXT FILE:** `09-reference-terminal.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Overview

- status, tree marks, change bars, diff view, Source control pane; one `git(op, …)` RPC; the startup stub `git/install.ts` fills `gitUi` slots that FileTree / StatusBar / Popups / the editor read.

## When git runs

- **When** git runs is decided only by `backend/git-monitor.ts` (debounce, single-flight, adaptive interval, paused while hidden, multi-repo); `backend/git-wsl.ts` runs git inside WSL for `\\wsl.localhost` roots; every spawn is logged via `backend/git-activity.ts`.
- Read paths never write the repository; the one exception is the monitor's opt-out index stat-cache refresh (`GitService.refreshIndex`: hooks off, skipped while `index.lock` exists, never killed).
- Don't add renderer-side status polling: report triggers instead (`git('nudge')`, `git('visibility')`).

## Git gave no answer in time

- **Git gave no answer in time.** Every call has a time limit; the first look at a folder gets 15 s (`T_DISCOVER`).
  - The backend sends a code, never a wording: `reason: 'timeout'` (status), `error: 'timeout'` (background lists), `GitActionResult.timeout` (actions).
  - Every surface shows the one sentence `GIT_TIMEOUT_TEXT` (`shared/git.ts`) once.
  - Status texts go through `unavailableText()` (`git/ui.tsx`), never `reason text + message`.
- Each surface offers one button, **Retry**, and it **only reads the repository again** — `GitStore.retry()` (one at a time, `retrying` signal → a `fresh` status): pane (`Unavailable`), status-bar item, the failed action's box and toast (`retryRead` in `git/actions.ts`), diff opener toast.
- **Retry never runs a failed action again** (no fetch / pull / push / stage / commit / switch from a retry button, no re-opened diff): the user starts it again by hand once git answers; don't add a "repeat the action" path.
- A failed first look is not final: `GitMonitor.retryDiscovery()` (single-flight, `GitService.reprobe()`) runs on a `fresh` status and, after a timeout, on window focus (≥ 10 s apart).

## Commit selection is the index

- Commit selection **is the index**: pane boxes = `stage` / `unstage`, batched in `git/selection.ts`; no app-side selection state.
  - Parts of a file = `git('hunks', path, from?)`: blocks composed from HEAD→index and index→worktree `-U0` diffs (`backend/git-hunks.ts`).
  - And `git('stageHunks', path, picks, from?)`: `git apply --cached --unidiff-zero` with patches built from git's own diff bytes. It never touches the working tree.

## One way into a file's diff

- **One way into a file's diff:** `openFileDiff(store, path, row?)` (`git/diff-open.tsx` → `openStaging` in the lazy `git/stage.ts`).
  - It serves "Diff with last commit" (menus, palette, status bar) **and** a click on a Source control row, so both show the same commit boxes.
  - A new entry point calls it, never `openDiffWithHead` / `showDiff` directly (those are the plain view underneath).
- The box style is `git/check.css`, imported by the pane and the diff view (separate chunks).

## Editing in the diff view

- **Editing in the diff view** (`git/diff-edit.ts`, lazy diff chunk): git diffs only on the right side, and only when it IS the workspace file (`editableSide`: HEAD / index → working copy; never HEAD, History).

## Compare

- **Compare** (`compareTargets`): either side that IS a workspace file (a whole file shown exactly as its document / the file on disk is now) takes typed text and blocks from the other side ("apply to the other side", both directions; `DiffViewProps.apply` + `basePath` for the left file);
  - the clipboard, a selection and a remembered text are sources only — never render a control pointing at them;
  - "Ignore whitespace" switches the controls off (`off` = the tooltip).
- The left side of a unified compare has no editor: its changes are `updateOriginalDoc` effects forwarded to the file, undone through `SideHistory` in turn with the editor's own history.
- It is not a second buffer: edits are forwarded to the file's open document (`app.editor.applyChanges`; no tab yet → `app.openFile` on the first edit), document changes flow back (`doc:changed`), so dirty state, `Ctrl+S`, autosave, EOL and disk conflicts are the editor's.
- Blocks of an edited diff are re-read from git after each `doc:saved`; a block ticked on unsaved edits saves first (`saveThenPick`).
- `StagingProps.toggleHunk(index, line?)` + `work` (the text the blocks refer to).

## Trust gate

- **Trust gate** (`backend/git-trust.ts`, enforced in `BackendService.git` before a `GitMonitor` / `GitService` exists).
  - A folder runs **no git at all** (no status, marks, diff, actions, WSL included) until the user says Trust in the Source control panel (`git('trust')` / `git('untrust')`).
  - Until then: `status` answers `{ ok: false, reason: 'untrusted', repoLikely? }`, reads the UI makes by itself answer empty, everything else `EACCES`.
- Remembered per folder (real path, the folder's own case rule) in `<app data>/git-trust.json`, shared by desktop and browser-mode servers; recent folders migrate once.
- Never start git for the open folder outside `BackendService.git`.
- Read paths switch off **every** configured filter driver (all config scopes; only canonical Git LFS, and only when git-lfs exists).
- Tests trust their repos with `trustRepo()` (`tests/e2e/git-helpers.ts`) or `svc.git('trust')`
