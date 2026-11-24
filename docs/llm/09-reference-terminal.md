# 09 - Reference: terminal, follow, AI changes

> **WHEN TO READ THIS:** you touch the terminal, the Claude Code / Opencode follow hooks or the AI changes panel.
> **WHAT YOU GET:** the `term:follow` / `term:changes` contracts, timing, caps and known limits.
> **NEXT FILE:** `09-reference-browser-preview.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Terminal

- Terminal (desktop only): `app.runInTerminal?.(code, { lang })` pastes a shell code block into the terminal (never presses Enter by default) — feature-detect it, it is unset in the browser.
- `isRunnableFence(lang)` from `src/renderer/terminal/run.ts` (dependency-free) says which fences get a "Run in terminal" button.
- Keys a focused widget must keep from the global keymap: `setGlobalKeyFilter()` in `commands.ts` (the terminal uses it).
- Terminals use their own `term:*` IPC channels (`src/shared/terminal.ts`), not `RPC_METHODS`: they need the sender's identity.

## Follow Claude's edits

- **Follow Claude's edits** (terminal, preview): setting `claude.follow`, **off by default**.
  - Opencode has its own, `opencode.follow` (see "AI changes" below).
  - Each setting gates only its own agent: `followsAgent()` in `terminal/settings.ts`, read by the manager at spawn and by `entry.ts` per event.
  - Off = the agent starts as in any terminal.
- A Claude preset terminal gets `<app data>/claude-follow/<128-bit hex>/` (0700, removed on exit / quit, stale ones after a day). It holds:
  - `settings.json`, passed with `claude --settings`: user / project Claude settings are never touched;
  - the inbox `in/`.
- The hook (`FOLLOW_HOOK`, `main/terminal-follow.ts`) is a **fixed** sh string; the folder reaches it only as env `ONE_FOLLOW_DIR` (WSL: `WSLENV` `/p`), never by string building.
- **Main reads `in/ev.*.json`:**
  - checks: lstat + `O_NOFOLLOW`, regular, ≤ 1 MB;
  - rate: ≤ 40 per scan and ≤ 80 per second, then a 1 s pause (an edit is two files, before + after);
  - files are deleted after reading; contents are never logged.
- Main then allow-lists event + tool and maps the path into the open folder (`mapFollowPath` + `Workspace.real`). Anything else is dropped.
  - `mapFollowPath` takes the folder as One names it or, for a folder opened through a link / `/tmp` on macOS, as it really is: `FollowCtx.realRoot`.
- Main then sends `term:follow` `{ id, agent, kind, path?, hint?, lines?, probe? }` to the owning window:
  - `agent` = `'claude'` | `'opencode'`: the UI names it in its toasts ("Opencode edited x") and reads that agent's setting;
  - `lines` = the changed new-file lines from the response's `structuredPatch` (`patchLines`): undocumented, so validated and optional;
  - `probe` = one added line's text.
- **The UI flashes only once the document shows the edit:** the probe matches, or the hint is unique after the reload.
- **Contract:** an inbox event can only make One show a file inside the open folder — never write, run or open anything else.
- UI = the lazy chunk `terminal/follow.ts` (no focus change).

- **Events:** `kind` = `edit` / `write` / `stop` / `prompt`.
- `prompt` = `UserPromptSubmit`; its hook (`FOLLOW_PROMPT_HOOK`, also fixed) drains stdin and drops a **constant**: the user's prompt is never written to disk.
- It must print nothing (that event's stdout goes into Claude's context).
- `PreToolUse` (same four tools, the same fixed `FOLLOW_HOOK`: prints nothing, exits 0, so it never decides a call) is read as `pre` = "this file is about to change": it only feeds the change list, it is never a follow event.

- **When the inbox is read** (`FOLLOW_TIMING`): `fs.watch` is the normal path, a scan 10 ms after a change event (measured ≈ 20 ms from the hook's rename to the window; it was 60 ms + the read).
- The poll is only the safety net for a file system without change events: every 250 ms while a session is hot — a turn is running (at most 10 min without any event: an interrupted turn sends no Stop) or an event came in the last 5 s — and every 2 s when idle (one directory read).
- One timer for all sessions; `tests/unit/terminal/follow.test.ts` measures both paths and counts the reads of a working and an idle session.

- **Queue, not "latest":** `follow.ts` shows every edit in order, one at a time (`pump` / `show`); nothing cancels an older edit.
- A clean open document is re-read at once through the watcher's own entry (`disk-sync.handleFsEvents([{ type: 'change', path }])`: same conflict rules by construction; `reloadFromDisk` is the conflict banner's "take disk" and does nothing without a conflict).
- **A dirty document is never reloaded, flashed or marked.**
- `diskUpdate` (800 ms) is only the fallback.
- Files changing faster than 1 / s: jump to the newest, the skipped ones keep their marks.

- **State** (`terminal/follow-marks.ts`, CodeMirror only, unit-tested without a DOM): `followField` holds two sets of line decorations — flashes (`spec.until`, each ends by itself) and "changed this turn" marks (`spec.turn`).
- `followAdd` adds, `followSync { now, turn }` drops ended flashes and other turns' marks; both sets map through changes.
- Clearing = `turnNo++` (next prompt, or palette "Claude: Clear change marks"): the document on screen syncs now, other tabs on `active:changed`.
- Marks for a file that is not on screen wait per path (`pending`).

- **Caps:** queue 50, files per turn 200, waiting ranges per file 200, ranges per event 20, marks per file 2000, lines per flash 400.
- Known gap: waiting marks are line numbers of the file as it was at that edit; later edits of a file that is not open do not move them.

## AI changes panel

- **AI changes** (terminal, preview; panel `aichanges`, key `Mod-Alt-a`, desktop only): what an agent terminal started from One changed, per file with + / −, grouped by turn.
- **One contract for every agent:** `term:changes` `{ id, agent, busy, turns, files }` = a terminal's **whole** list.
  - Limits: ≤ 500 rows, at most every 50 ms, only when it moved.
  - A row = `AgentChangeFile { path, status, additions, deletions, turn, exact }`: one row per file, counts for the session so far.
  - `turn` = the turn (1-based count of the user's prompts) that last changed it.
  - `exact: false` = a live estimate.
- Shared main code is `main/terminal-changes.ts` (path rules `cleanRel` / `toRel`, `mergeRanges`, `touchRow` / `snapshotRows`, the throttled `ChangesSender`): a new agent adds a tracker that fills a row map and calls the sender, nothing in the renderer.
- Same contract as follow: a row can only name a file inside the open folder (lexical rule in the model, `Workspace.real` before any follow event; opening a row goes through the normal file RPC).

- **Claude Code** (`claude.follow`): the hook path above feeds `main/terminal-claude-changes.ts` (pure).
- `pre` → the row appears before the write; `PostToolUse` → + / − of that call (`patchCounts` next to `patchLines`, else from the call's input), summed per file, `exact: false`; `Stop` → **git's numstat** replaces the estimates and adds files only git saw change (a shell command), `exact: true`.
- Rows Claude's tools named stay when git lists them no more (committed, git-ignored); rows only git saw go when git drops them; what was already uncommitted when the session started (the baseline numstat, asked once) is never listed; a row a refused / failed call announced goes at Stop.
- **Git only through the backend**: `git('numstat')`.
  - `GitService.numstat` runs `git diff --raw --numstat -z --relative HEAD` with the service's safety switches, bounded, for every repository in the folder. Parser: `backend/git-numstat.ts`.
  - So the trust gate applies: an untrusted or non-git folder answers null and the estimates stay.
- `main.ts` hands it in as `follow.numstat`; terminal code never starts git.
- Asked at session start (baseline) and once per Stop, never polled.
- Known limits: untracked new files keep their estimate (numstat lists tracked files); numbers are the file's difference from the last commit, so earlier uncommitted edits of a file Claude also edits count in; an interrupted turn (Esc) sends no Stop — "working" stays until the next turn ends.

- **Opencode** (`opencode.follow`; off = plain `opencode`, no server): opencode's built-in edit / write / shell tools do not go through MCP, so MCP cannot see them; its own server does.
- An `opencode` preset terminal gets a private `opencode serve --hostname 127.0.0.1 --port 0` started by main (`main/terminal-opencode.ts`; its own process group, killed as a group with the terminal — Windows: tree kill, an npm shim goes through cmd.exe, `planOpencodeServe`; inside the default shell's WSL distro: `planOpencodeServeWsl`, ended by closing its stdin, see below);
  - the address + generated password are read from its stdout, kept in memory only, and given to the TUI (`opencode --server <url>`) as env `OPENCODE_PASSWORD` — never argv, never the server's own env (the agent's shell commands would inherit it), never the renderer / a file / the log.
- Main only GETs, loopback only: `127.0.0.1`, plus `[::1]` with the same port for a server inside WSL (never another address, `parseHandshake` only ever reads a `127.0.0.1` one); redirects are errors, every body is size-capped, every request has its own abort scope (nothing is left on the tracker's signal).
- It subscribes to `GET /api/event` (`types` filter).
  - It asks `GET /api/session/{id}/diff` (`context=0`, first..last turn, single flight, debounced) for the exact +/− numbers.
  - It resyncs from the session list on every (re)connect. Nothing is replayed after a gap.
  - A stream that opens and ends at once backs off like a refused one.
- Pure part = `terminal-opencode-model.ts`.
- Rules worth keeping (each has a regression test): the events name no tool, so only a call whose **input is a write** (`content` / `oldString` / `newString` / a patch) announces a row — a read / search / list under a path never does;
  - an announced row goes when its call fails or the turn ends without it;
  - a subagent's session (`parentID`) counts no turn and sends no `prompt` / `stop`;
  - session ids are id characters only (they go into request paths);
  - the sessions a folder already had at the first look are its history — remembered (`dormant`), listed only once one shows activity (the user resumed it);
  - relative paths are relative to opencode's project root, which is above the open folder when the session's `subpath` says so (`worktreeOf`) — the rest of that project is dropped, not mis-placed.
- **WSL** (Windows, the ★ default shell is a distro): `detectOpencode(d, { wsl })` looks inside it first — fixed script `OPENCODE_WSL_LOOKUP` via `bash -lic` (PATH, then `~/.opencode/bin`, `~/.local/bin`, `~/.npm-global/bin`) — then natively. Result `via: 'wsl'` + `distro`, cached per distro like Claude.
  - `planOpencode` then starts `wsl.exe -d <distro> --cd … -e bash -lic 'cd -- "$0"; exec "$1"' <folder> <path>`: the found path is an argument, never script text.
  - **Follow inside WSL:** the private server runs **in that distro** — `planOpencodeServeWsl` = `wsl.exe -d <distro> --cd <linux folder> -e bash -lic OPENCODE_WSL_SERVE <linux folder> <path>`, the folder's Linux name from `wslPathFor` (null: another distro's folder, a network share → no server at all). The TUI attaches with `--server <url>` (one more argument) and the password only as `OPENCODE_PASSWORD` carried by `WSLENV` — never argv, and never the server's own environment (`OPENCODE_WSL_SERVE` unsets both password names; main strips them from the child's env too).
  - `OPENCODE_WSL_SERVE` (fixed text): `cd` must work; `setsid` + `set +m` give the server a process group of its own (the agent's shell commands included); `cat >/dev/null` holds it on stdin and the `EXIT` trap ends that group — main closing the pipe, wsl.exe dying or One crashing all read as end-of-file there. **No single quotes anywhere**: `wsl.exe` re-quotes each argument for the distro with `'`, so a `'` in the script ends that quote there — bash waits for the rest of it and the server is never started. The `planOpencode` script above uses `"` only: that is the form proven to survive `wsl.exe`.
  - It prints `one-cwd <pwd -P>` first: the folder **as opencode names it** (link-free). The tracker then uses `root` = the Linux folder, `realRoot` = that line, `platform: 'linux'`, so Linux paths become workspace-relative paths and `worktreeOf` uses the POSIX rule.
  - Tracked only after `reach()` proves main can talk to it: the address it printed, else `[::1]` with the same port, proven by an authenticated GET it answers. The TUI keeps the server's own `127.0.0.1` address (it lives in the same distro).
  - Two handshake waits: `HANDSHAKE_MS` (15 s), and `WSL_SERVER_MS` (40 s) once `one-cwd` arrived — there only `opencode serve` is slow (its own runtime + the folder over drvfs); the short wait alone writes off a working first start.
  - **When it fails** the terminal runs plain opencode and `spawn` answers `notice` (a toast): `wslFollowNotice(why)` picks the sentence for the part that failed — `folder` (no path in that distro), `spawn` / `answer` (never reported itself there), `reach` (answers there, WSL does not forward its localhost to Windows). Never one general "WSL is not supported": each line sends the user to what is actually broken.
  - Missing: the hint says "In a terminal (WSL · <distro>)" + the Linux install command (`opencodeHint(platform, distro)`); PowerShell / npm only for native Windows.
- Known limits: a `!cmd` the user types in the TUI shows at the next turn, binary files read +0 −0, git-ignored files have no exact stats, non-git folders only get the edit tool's own counts.
- Recorded fixture: `tests/fixtures/opencode/` (opencode 2.3.2); re-record when opencode changes its event shapes (the `subpath` / project-root rule and the write-input rule are read off that recording and opencode's behaviour, not a documented contract).
- Attaching to an opencode the user started themselves is a TODO (needs a credential decision).

- **UI** = lazy `terminal/changes/` (`store.ts` + `Panel.tsx`, order 14).
- The store keeps **one list per agent terminal** (≤ 8; the panel shows the one prompted last, a switcher appears with a second terminal; an ended terminal's list stays until cleared) and is pure reducers (`reduceChanges`, `reduceFold`, `reduceReviewed`, `reduceClear`, `groupByTurn`) behind signals.
- The panel draws one foldable group per turn, newest first ("Turn N · k files · +a −d"): the newest is open, a new turn folds the older ones, a fold made by hand holds until the next turn starts.
- UI-only state, never sent anywhere: folds, "reviewed" (dims a row until the agent changes it again — same numbers and turn = same row) and "Clear" (the rows shown go and stay away until they change; main keeps sending the whole list).
- Right-click (the app's `ui.openContextMenu`): a row → Open / Show diff vs last commit (`openFileDiff`) / Reveal in Files / Copy path / Copy relative path / Mark as reviewed; a turn → Collapse / Expand, Collapse others, Expand all, Mark all as reviewed, Copy file list.
- Keys in the list: ↑ ↓ walk headers and rows, ← folds (from a row: to its header), → unfolds / steps in, Enter / Space are the buttons' own.
