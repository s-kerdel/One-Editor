# 09 - Reference: MCP writes (guard, placeholders, confirmation, journal)

> **WHEN TO READ THIS:** you touch an MCP tool that changes files. **STOP AND ASK first.**
> **WHAT YOU GET:** the write switch, the write guard, frozen placeholders, user confirmation, batches, undo and the journal.
> **NEXT FILE:** `00-START-HERE.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## One switch for writes

- **One switch for writes:** `MCP_WRITES_ENABLED` (`src/shared/mcp.ts`, now `true`).
- `false` ships a read-only build: the server serves every folder read-only (as `--read-only`), main refuses Read-write (`ENOTSUP`), Settings shows it disabled; tests keep the write code covered (`writes: true` / `writesEnabled: true`) and one asserts the gate.

## Writes

- **Writes** exist in read-write folders only; `--read-only` removes them.
  - `Folder.checkWritable()` runs in the tool and again in the guard.
  - A per-session quota applies: `WriteQuota`.
- **First, the resolver:** every target goes through `Folder.resolveTarget()`.
  - Hidden / key / excluded names, links, hard links and spelling aliases → one neutral `EACCES: Cannot change <path>`, so exclusions cannot be probed.
  - File types are checked by `writeTypeProblem`: notes `.md .markdown .txt` only, unless the folder has `allowCode` (mcp.json).
  - `NEVER_EXTS` (shell / script / shortcut types incl. `.js` `.py`): never.
  - No part may be a link.
  - The existing part must be spelled exactly as asked.
- **Then the existing `Workspace` write path**, with `folder.guard()` as its `WriteGuard`.
  - The write path is atomic and keeps EOL / BOM / encoding. Windows-1252 text it cannot hold is refused.
- **The guard runs inside the path's exclusive slot, right before the disk changes.** It re-checks:
  - that nothing on the path is a link (no write through one, no swapped-in link to `.git/hooks`);
  - the spelling;
  - the visibility;
  - the precondition (etag = mtime + size; a whole-file overwrite needs `if_match`).
- The guard also captures the bytes being replaced and reserves their journal room: `EQUOTA` aborts before the disk changes.
- **The guard is `strict`.** The Workspace then:
  - refuses a link or hard link at commit;
  - never rewrites in place;
  - creates folders one level at a time;
  - re-verifies the parent's realpath before and after the write / rename (and takes a landed entry back);
  - pins the file a write replaces with a hard link next to it (`.~*.sec-edit.bak`) and puts it back when the folder moved;
    - the pin's dev/ino must equal the guarded file; no hard links on the volume → the same check on the name;
  - renames without clobbering (`link` + `unlink`):
    - `EEXIST` for a file created in the window;
    - the source must still be the guarded entry (dev/ino) in its verified folder before the link and before its old name goes;
    - a failed `unlink` removes the new link.
- A strict delete trashes only the guarded entry (dev/ino).
- Residual: a swap between the last check and the rename syscall itself.

## Placeholders

- **Placeholders** (`src/mcp/placeholders.ts`):
  - **Variables files** (`variables.fileName`, any folder) are off limits.
  - **Frontmatter** `vars` / `target` / `env` / `secrets` are compared **as parsed** (yaml `parseDocument`, keys by scalar value, like `parseNoteMeta`).
  - Refused: quoted / explicit / tagged / flow / duplicate spellings, or frontmatter that does not parse.
  - **Fence `{…}` attribute lines** (any container) are frozen.
- **Secret names are frozen note-wide, without a markdown parse.**
  - Secret names are: `secrets:`, `vault` / `vault:*` values incl. `T.field` and the bare field, note frontmatter, closed over values.
  - **Also every name nothing defines:** One fills those from remembered form values.
  - Built-ins: only while not redefined.
  - no edit adds or changes a line holding one (multi-line `{{\n name }}` and `>`-prefixed forms included) or adds an occurrence;
  - the lines directly above and below each one stay exactly as they are (or stay absent: start / end of file) — that alone stops any block grammar from turning a secret line into a new code block;
  - the fence lines down to the last secret line stay as they are.
- On top, every markdown-it `fence` / `code_block` that holds a secret **cannot change at all**.
  - It is parsed with One's preview options, footnotes and **One's own block rules** (`src/shared/md-block-rules.ts`: frontmatter, `%%`, `$$`, `\pagebreak`).
  - The preview registers the same module, so a new preview block rule goes there.
- Residual (later item: a One-side warning on Run for AI-written blocks): a new block without placeholders may still use a shell variable a frozen secret block exported.
- No variables file between note and share root → every non-built-in name is secret.
- Moves check both places; the server never resolves a value.

## Confirmation: sweeping or unrevertable changes

- **Sweeping or unrevertable changes ask the user through MCP, never an OS dialog** (`tools/write.ts` `askUser`, `confirm.ts`). One question per call. They are:
  - a folder delete (alone or in a batch);
  - a batch delete of more than `MCP_CONFIRM_OVER` (10, `shared/mcp.ts`) items;
  - a `replace_in_files` over more than 10 files.
- Everything else is unconfirmed (Revert covers it; batch moves lose nothing).
- The question is built by the server only: sanitized folder-relative paths (no control / bidi / zero-width characters, quotes replaced, parts cut at 40, the whole at 120), counts, the size (lstat sums, never contents), at most 3 hidden names, find / replace text cut at 60; no other argument text.
- **How the question is asked depends on the client:**
  - Legacy clients that declared form elicitation (2025-06-18+) get `elicitation/create` (our ids `one-ask-N`, 120 s, then `notifications/cancelled`).
  - 2026-07-28 clients that declared it get `resultType: "input_required"` (MRTR) with an HMAC-sealed, expiring, single-use `requestState`.
  - Others get two steps: a summary plus a one-time code (random, 5 min, spent on use).
- Answer and code are bound to the exact operation (`target`: tool, folder, path set or find + replace + scope + case) and a fingerprint of the contents (every entry / file stamp): anything else or changed contents asks again.
- Only `accept` with `confirm: true` proceeds, after a re-survey.
- Folder trash: one call per folder, no journal copy (hidden contents are never read): audit row `delete (folder)`, note "restore from the Recycle Bin", no Revert.
- **Windows: by the user's choice no Recycle-Bin pre-check and no Windows prompt (`OnlyErrorDialogs`).**
  - **A bin that is off or too small deletes the folder permanently, and the question says so.**
  - Refused off fixed local drives (exit 3) and for a reparse point (exit 4).
- macOS: only on the home volume. Linux: the same-device XDG trash.
- Batches (`paths`, max 100; `replace_in_files`, max 200 changed files) run item by item past failures, one answer line per item, one journal group (one Revert; folder entries have none), one audit row with `items`;
  - **`undo`** (`tools/write.ts` `undoGroup`):
    - only a group this server process made (`Journal.ownGroup`: the full id or the 8-character code answers show);
    - anything else → `EACCES: only changes from this session can be undone here; use Revert in One`;
    - only in its folder while still shared and writable;
    - all or nothing via `revertGroupReport` (the same preconditions as One's Revert; every changed file is named);
    - once only (the shared `reverted` mark);
    - one quota unit, no confirmation;
  - the answer is counts only, never content;
  - folder deletes are `trash` notes in their group (no copy): "restore … from the Recycle Bin";
  - batch `move` keeps the subfolders below the common parent of `paths` (`batchDestinations`):
    - `flat` = all directly in `to_folder`; `to_paths` = one destination each;
    - it makes missing parents level by level (strict `mkdirStrict`, through the resolver's destination check);
    - it reuses existing folders;
    - it never overwrites a file and never merges a folder into an existing one of the same name (EEXIST with a hint);
  - the quota counts each changed item.
- **`replace_in_files`:**
  - `find` is literal (escaped, never a regex).
  - `query` takes file filters only (`in:` refused) via the search parser in `noRegex` mode.
  - It covers visible, type-allowed text files.
  - Each file goes through `overwrite` (stamp guard + placeholder rules). Files that would touch a secret line are skipped and named.
- `replace_text all` refuses the whole call when any match touches a secret line or its neighbour (names the lines).
- Folder `move` takes hidden items along (walked, never read); refused: links / special files inside, any entry whose visibility would change, hidden files when the nearest variables file differs; caps 10,000 visible files, 200,000 entries.
- Binary files are never written, moved or deleted; deletes go to the Recycle Bin only (`ETRASH`, nothing deleted, when there is none); a file delete always keeps a journal copy, even with undo off (or is refused); folder deletes and moves: see above.

## Journal

- **Journal** (`src/mcp/journal.ts`): old bytes per change.
  - Where: `<app data>/mcp-history/<group>/`. Setting: mcp.json `undo { on, days }`.
  - Size: 100 MB cap, 64 MB per session.
  - Groups of the running session and of the last 24 h are never evicted. New writes get `EQUOTA` instead.
  - Two busy sessions can thus block MCP writes for up to 24 h. It fails closed, by design.
- Revert runs in **main** (`McpService.revert`, `mcp:revert`) only while the folder is still shared, through the same resolver and guard, all or nothing, only onto files still as MCP left them; it is restorative, so it also works once the folder is read-only again.
- MCP-written notes get no special trust: they render through the normal sanitizer like any outside edit.
- Tests never use the real trash: injected trash or `XDG_DATA_HOME` / `HOME` under `.tmp/` (`tests/unit/mcp/writes.test.ts`).

## File type associations are not a grant

- **File type associations are not a grant** (`files.associations`, a page-writable setting: a page taken over can add rows).
- For MCP writes they can therefore only refuse **more** (`writeTypeProblem(key, allowCode, mapped)`, `Folder.mappedLanguage()`): the name's own rule (`NEVER_EXTS`, notes, the code grant, text names) is decided first and stays;
  - a name that passes is then held to the rule of the language the user opens it as — `notes.txt` mapped to PHP needs `allowCode` like a `.php` file, anything mapped to a never-written language (JavaScript, Python, PowerShell, Batch) is never written.
- A mapping makes **no** name writable (`*.ctp` → PHP stays "no text file extension" even with the code grant), changes nothing the server lists, reads or indexes, and is not in `VISIBILITY_KEYS`.
- `tests/unit/mcp/file-types.test.ts` holds the property (for every language, with and without the grant: what the name alone refuses stays refused).
- Elsewhere a mapping only changes how a file inside the open folder is highlighted, formatted and indexed as text; a settings file inside the opened folder is never read.
