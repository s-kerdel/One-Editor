# 09 - Reference: MCP server (structure, grants, tokens, resolver)

> **WHEN TO READ THIS:** you touch `src/mcp/`, `src/main/mcp*.ts` or add an MCP tool.
> **WHAT YOU GET:** how a tool is built, who owns grants and tokens, the one path resolver. Writes: next file.
> **NEXT FILE:** `09-reference-mcp-writes.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## MCP server: structure and tools

- MCP server (mcp, desktop: Settings → MCP server): `src/mcp/server.ts` puts the folder pool, the tools and the resources behind one `McpProtocol` (`protocol.ts`: JSON-RPC, dual-era — legacy `initialize` and the stateless 2026-07-28 per-request `_meta`).
- The transport is separate: `stdio.ts` today; an HTTPS transport goes next to it as `http.ts` and drives the same `OneMcpServer`.
- **A new tool** is a flat-schema `ToolDef` in `src/mcp/tools/*`:
  - schema: `additionalProperties: false`, no top-level `oneOf`, a description on the tool and every parameter, name `^[a-zA-Z0-9_-]{1,64}$`, annotations set;
  - every path goes through the folder's resolver (`folder.resolve` / `readText` / `list`);
  - output paths from an index go through `visibleOnly()`;
  - answers are sized by `env.limits()` (`mcp.maxReadKB` / `mcp.maxResults`, registry rows; a pinned web server cannot write `mcp.*`).
- A tool that changes files sets `write: true` (unlisted unless some folder is read-write) and refuses `folder.mode !== 'write'` itself (`inWritable` in `tools/write.ts`);
  - its targets come from `folder.resolveTarget()` and it changes the disk only through `src/mcp/writes.ts` (Workspace write path + `folder.guard()` + a journal entry + `folder.changed()` for the indexes);
  - its `ToolResult.journal` (never sent to the client) becomes the activity row's Revert.
- **Tokens are the budget** (main clients: small local models in LM Studio).
  - Tool definitions + `INSTRUCTIONS` ride along on every turn, so descriptions stay short.
  - Say each thing once: syntax in the tool, workflow in the instructions, per-call hints in the answer.
  - `tests/unit/mcp/budget.test.ts` pins their size. Re-measure before raising it.
- Answers are **plain text** through `tools/format.ts` (`line()` = parts joined by " · ", `reply()`, `withBody()`, `P.*` shared params).
  - One summary line (`path · etag … · lines 1-40 of 300 · more: offset_line=41`), then rows or the raw file text.
  - A hint only when something was cut.
  - Errors are one line: `CODE: message`.
- **Never JSON** (keys repeated per row, escaped quotes).
- **tools/list is a view** (`describeTool`):
  - `maxLength` is enforced by `checkArgs` but not advertised;
  - `ServerHooks.hiddenParams` drops `folder` while one folder is shared (still accepted);
  - annotations carry the title only for clients before 2025-06-18.
- **Prefer a parameter or `mode` on an existing tool over a new tool.**
  - Structured copies of query filters (`path`, `ext`…) are deliberately not parameters (`argHint` points the model at the query).
- **stdout is the protocol channel:** `cli.ts` imports `stdout-guard.ts` first. Never write to stdout anywhere else.

## Inbound access for AI clients: one feature

- **Inbound access for AI clients: one feature** (`src/mcp`, Settings → MCP server).
- Off by default.
- Main owns `<app data>/mcp.json` (on/off, the folder allow-list, per-folder mode and `allowCode`, `undo`, token hashes; read-only by default);
  - every widening step is a **native dialog** in main. The widening steps are:
    - turning on;
    - sharing folders (rules in the next bullet);
    - later per-folder widening: allowing writes, code files in a folder;
    - undo copies off;
    - creating / regenerating / revoking a token;
  - **sharing folders** goes only through main's folder dialog (`multiSelections`):
    - the page never passes a path or a mode; `mcp:addFolder` takes no argument;
    - every "Add folders…" step (one folder or several) gets exactly **one** native confirm (`foldersConfirm`);
    - the confirm lists each alias + real path and, apart, every refused one with its reason (`folderProblem`, already shared, picked twice, over the limit);
    - nothing to add = reasons + "OK" only;
    - aliases are in sorted path order;
    - its buttons **[Add read-only] [Add and allow changes] [Cancel]** (Cancel the default) and its checkbox **"Also code and config files"** (counted only with allow changes; `folderChoice`) set mode and `allowCode` for every folder of that step;
    - mode and `allowCode` come from the dialog's own response; nothing else asks for them;
  - narrowing needs none.
- Grants never live in settings.json: `BackendService.saveSettings` drops every `mcp.*` key but the two result limits (`isMainOwnedKey`), and the server reads none from there.

## Live files

- **Live files ("MCP active"):** a running stdio server keeps `<app data>/mcp-live/<pid>-<random>.json` (`src/mcp/live.ts`) holding only `{ v, pid, client (its token's name), started, lastCall }` — never a path, file name, query, text or token.
- Made after the token check, `lastCall` written at most every 5 s (a trailing write keeps the newest), temp + rename, removed on exit; an unwritable app data folder is skipped silently; nothing on stdout.
- Main lists them as `McpStatus.sessions` (`{ client, started, lastCall, idle }`; idle = no call for 2 min) and pushes changes over the existing `onChange`.
  - The watcher is `McpService.watchSessions`, started 3 s after launch: `fs.watch` + a 15 s poll.
  - Files of processes that are gone (`process.kill(pid, 0)`, EPERM = alive) are removed, also at start.
  - A file whose name and pid disagree is ignored.
- A reused pid is accepted (rare).
- Renderer: only the status-bar corner icon (`mcp/indicator.tsx`), which listens to `onChange` (no polling): shown while `enabled`, accent while `sessions` has entries, a 1 s pulse when the newest `lastCall` grows; click = Settings → MCP server at Recent activity (`revealActivity()` in mcp-ui).
- **Residual:** `excludeGlobs` is still a page setting, so a page can narrow the exclusions without a dialog (main-owned MCP excludes are a later item).

## Access tokens

- **Access tokens** (`src/mcp/tokens.ts`, parsing in `shared/mcp.ts`; transport-neutral, a future HTTPS transport takes them as bearer tokens): `one_` + 43 base64url (256 random bits), one per client, named.
- At rest mcp.json keeps only `{ id, name, sha256, hint (4 chars), created, lastUsed }`; main also keeps the raw token encrypted with `safeStorage` (`mcp-tokens.json`, never `vault.json`, no `vault:*` key; no keyring → show-once).
- **The raw token never reaches the page.**
  - `mcp:copySetup` / create / regenerate / turning on make main write the finished snippet to the clipboard and answer "copied".
  - Copying again asks first: "Copy setup with the access token?".
  - Any copy is cleared after 2 minutes if the clipboard still holds it.
  - `McpStatus.tokens` carries names, dates, the hint.
- Clients pass it in `env` (`ONE_MCP_TOKEN`), **never argv** (every snippet is a config file, Claude Code's too: a `~/.claude.json` `mcpServers` entry, not `claude mcp add --env …`, which shell history keeps; the CLI refuses any argument containing `one_` + 20 token characters, and no CLI message repeats an argument).
- `cli.ts` hashes it at startup and compares with `timingSafeEqual` against every stored hash.
  - It refuses (one stderr line, exit 1, no stdout) when the token is missing / unknown / revoked.
  - It drops it from `process.env`.
  - It exits when it is revoked while running.
  - Audit rows carry the token's id and name. `lastUsed` is set by main from the activity log.
- Refused folders (`src/mcp/grant.ts` `folderProblem`): a drive root, the home folder itself, anything inside or around the app data folder, its text cache (`defaultCacheDir`: `%LOCALAPPDATA%\sec-edit` on Windows) or One's program folders (`oneInstallDirs`: the executable's folder, `process.resourcesPath`, a macOS bundle's `Contents`; in a dev run that is `node_modules/electron/dist`, so the checkout itself is refused) — checked by main when adding **and by the server for every mcp.json entry** (the file is not trusted). The MCP workspace also denies the cache folder (`deny`).
- The server refuses to run while off or while settings.json exists but cannot be parsed (at run time it keeps the last good settings: exclusions never fail open), exits once switched off (it polls mcp.json); a removed folder fails every call in flight at its next disk step and never wakes again.

## One resolver

- **One resolver** for every path a tool or resource takes: `Folder.resolve()` (`src/mcp/folders.ts`). It checks in this order:
  1. **String rules first** (`cleanPath`): no `..`, no absolute / drive / UNC / `\\?\` paths, `/` only, no control characters, no Unicode look-alikes, Windows name rules on Windows, 8.3 short names (`GIT~1`) on **every** platform (Linux / WSL reach FAT and NTFS volumes too, and realpath keeps the short spelling there).
  2. **Then the one visibility rule** (`Visibility`): dot segments and `KEY_FILE_GLOBS` built in (never from settings.json: keys, key stores, `.asc`, `.ovpn`, `.tfvars`, `.tfstate`, netrc, kubeconfigs…), plus the user's excludeGlobs. It is case-, NFC- and NFKC-insensitive.
  3. **Then `Workspace.real()`.**
  4. **Then no links at all:**
     - the MCP workspace runs with `links: 'skip'` (links are not listed, watched, indexed or followed);
     - no part of a path may be a link;
     - the real path must equal the key exactly (no link, case or 8.3 alias of an excluded place).
- Reads re-check at the moment of the read (`readResolved`).
- Settings changes swap the visibility at once and drop the indexes (totals, tags, typo corrections never outlive an exclusion).
- Hidden answers `ENOENT` exactly like missing; messages carry the folder-relative path only — never a raw exception message (Node's carry host paths).
- Searches never run a regex (`noRegex`; `path:` globs use `globSearch`, a state-set matcher; a phrase across inline markers uses `loosePhrase`, a scanner with a per-document step budget; `.gitignore` patterns use `globMatcher`, a state-set matcher); structure parsing (`shared/markdown-lines.ts`, `knowledge/sections.ts`) is linear and skips lines over 10k characters — keep it that way, the desktop app parses the same notes.
- At most 4 calls run at once; JSON-RPC batches are refused.
- Never imports `src/main/vault*`, never reads `vault.json`, never resolves `{{variables}}`;
  - no git, terminal, settings writes, network (stdio only) or processes of its own;
    - the only exceptions: the shared watcher's fixed `wsl.exe inotifywait` backend for `\\wsl.localhost` roots, and `backend/trash.ts`'s fixed Recycle Bin call for `delete`;
  - `tests/unit/mcp/isolation.test.ts` checks the esbuild metafile of `cli.ts`;
  - `tests/unit/mcp/paths.test.ts`, `review*.test.ts` and `tokens.test.ts` have a case per attack.
- Test hooks `SEC_EDIT_TEST_MCP_CONFIRM` / `SEC_EDIT_TEST_MCP_FOLDER` exist in main only.
  - `path.delimiter`-separated = several picks. Each confirm is logged as `[sec-edit:mcp-confirm]`.
  - The Node-mode server applies env-guard's scrub itself when it runs from `app.asar.unpacked` (`src/mcp/env-boot.ts`).
  - So `SEC_EDIT_CONFIG_DIR`, `SEC_EDIT_TRASH_DIR` and the `SEC_EDIT_MCP_*` knobs work in dev and tests only.
