# sec-edit ("One") - LLM instructions (the one entry file)

> **WHEN TO READ THIS:** every turn, before any tool call.
> **WHAT YOU GET:** the hard rules, the 10-step workflow, which file to open for your task, and the index of every `docs/llm/` file.
> **NEXT FILE:** `docs/llm/00-START-HERE.md` (the checklist with exact commands).

**This is the only entry file.** Every other doc is in `docs/llm/`. Open **one** file at a time, only when its row below says so.

Electron + browser-mode Markdown/code editor. TypeScript, Preact + signals, CodeMirror 6.
One renderer, two backends: Electron main (IPC) and a local HTTP server (browser mode).

## Hard rules (never break)

1. **Reuse, do not invent.** Find the existing function first (`docs/llm/02-find-existing-logic.md`). Copy the nearest example. Change the minimum.
2. **Verify before you use.** Before you write a function, file or command name, prove it exists:
   `grep -rn "nameYouWant" src/ | head`. No hit = it does not exist. Do not use it.
3. **STOP AND ASK** when the grep recipes find no precedent. Say "no existing pattern found for X". Do not make one up.
4. **Stay inside this folder.** Temp files go in `.tmp/<area>/` only. Never `/tmp`, never `/mnt/c`, never delete outside `.tmp/`.
5. **Never run git commands that change history** (`commit`, `tag`, `push`, `reset`, `rebase`, `stash`). The lead commits.
6. **Paths crossing the backend are workspace-relative POSIX** (`notes/a.md`). Never build a path with `\`.
7. **Every disk access for a path goes through `Workspace.real()`** (`src/backend/workspace.ts`). Never `fs` on a path from the page.
8. **No new dependency, framework or IPC channel family** without asking first.
9. **Run only your own tests** plus `npx tsc --noEmit -p .`. Never the full suite, never loops, never benchmarks.
10. **Nothing heavy at startup.** New UI code goes in a lazy chunk (`import()`), not in a startup module.
11. **No screenshots for review.** Tests prove it; the user tries a build.
12. **Before removing, refactoring or "simplifying" anything, read `docs/llm/10-decisions.md` and the load-bearing list** (`docs/llm/04-rules-and-pitfalls.md`, section "Load-bearing - do not touch").

## The 10-step workflow

| # | Step | Do this |
|---|---|---|
| 1 | **Understand** | Restate the task in one sentence. Name the area (table below). |
| 2 | **Route** | Open the playbook for the task type (`docs/llm/03-playbooks.md`). |
| 3 | **Locate** | Use `docs/llm/02-find-existing-logic.md` + grep. Find the nearest existing example. |
| 4 | **Verify names** | `grep -rn` every symbol and path you plan to use. |
| 5 | **Plan** | List the files to edit, in order. 1 line each. If more than ~6 files: stop and ask. |
| 6 | **Edit** | Read the file right before editing it. Small additive edits. Do not reformat. |
| 7 | **Typecheck** | `npx tsc --noEmit -p .` must be clean. |
| 8 | **Test** | Add or extend ONE test file. Run only that file (`docs/llm/05-testing-and-verify.md`). |
| 9 | **Docs** | User-visible change: `docs/USER-GUIDE.md`. New contract or key: the matching `docs/llm/09-reference-*.md`. |
| 10 | **Hand over** | Report: files changed, tests run + result, what you could not verify. No commit. |

## Routing: task -> file to read

| Task | Read | Start in |
|---|---|---|
| Add a setting | `03-playbooks.md` A | `src/renderer/app/settings-registry.ts` |
| Add a command / shortcut | `03-playbooks.md` B | `src/renderer/app/commands.ts`, `shell.ts`, `shell-commands.ts` |
| Add a backend call (both modes) | `03-playbooks.md` C | `src/shared/api.ts`, `src/backend/service.ts` |
| Add a sidebar panel | `03-playbooks.md` D | `src/renderer/app/shell.ts` (bookmarks example) |
| Add an MCP tool | `03-playbooks.md` E | `src/mcp/tools/links.ts` |
| Add a language / file type | `03-playbooks.md` F | `src/shared/languages.ts` |
| Add a test | `03-playbooks.md` G + `05-testing-and-verify.md` | `tests/unit/<area>/`, `tests/e2e/` |
| Fix a bug | `03-playbooks.md` H | the failing area's folder |
| "Where is X done?" | `02-find-existing-logic.md` | - |
| "Which process owns X?" | `01-architecture-map.md` | - |
| A test fails | `05-testing-and-verify.md` ("Failing test -> debug steps") | - |
| Build fails / app will not start / read logs | `06-setup-and-debugging.md` | - |
| Unknown word in the code | `07-glossary-and-conventions.md` | - |
| See a real change, file by file | `08-worked-examples.md` | - |
| Remove / refactor / "simplify" something | `10-decisions.md` + `04-rules-and-pitfalls.md` (Load-bearing) | - |
| Full contract behind a short rule | `09-reference.md` (index) | - |

All files in the **Read** column live in `docs/llm/`.

## Area -> folder

| Area | Folders |
|---|---|
| shell | `src/backend/` `src/main/` `src/server/` `src/renderer/app/` `src/renderer/platform/` |
| editor | `src/renderer/editor/` |
| preview | `src/renderer/preview/` |
| search | `src/search/` `src/renderer/search/` |
| format | `src/format/` `src/shared/languages.ts` `src/shared/associations.ts` |
| knowledge | `src/knowledge/` `src/renderer/knowledge/` `src/shared/wikilinks.ts` |
| git | `src/backend/git*.ts` `src/renderer/git/` `src/shared/git.ts` |
| terminal | `src/renderer/terminal/` `src/main/terminal*.ts` `src/shared/terminal.ts` |
| mcp | `src/mcp/` `src/main/mcp*.ts` `src/renderer/mcp/` `src/shared/mcp.ts` |
| other | `overview/` `nav/` `bookmarks/` `variables/` `pdf/` `whitespace/` `updates/` `webserver/` under `src/renderer/` |

## Commands you may run

```bash
npx tsc --noEmit -p .                              # typecheck (always)
npx vitest run tests/unit/<area>/<file>.test.ts    # ONE unit test file (~0.7 s)
npm run test:e2e:file -- tests/e2e/<file>.spec.ts  # ONE E2E file; reuses the build while src/ is unchanged (~2-6 s)
npm run trace:summary -- .tmp/e2e-file/<spec name>/results   # a failed browser E2E as text
npm run build                                      # only when asked for a build
```

Typecheck takes ~1.6 s. Fastest command per change + the failing-test checklist: `docs/llm/05-testing-and-verify.md` (FAST LOOP).

## Do not run

`npx vitest run` (no path) - `npx playwright test` (no path) - `npm run test:all` - `npm install` -
`npm run iteration` (its version bump differs from the real tags: ask first) - `npm run package:*` - any `git` command that writes.

## Index: every file in `docs/llm/`

**Guides (`00`-`08`, `10`): read the one whose WHEN matches.**

| File | Purpose | Read WHEN |
|---|---|---|
| `00-START-HERE.md` | checklist for one change, exact commands | **every task**, first |
| `01-architecture-map.md` | processes, folder map, data flow, where state lives | you do not know which process or folder owns something |
| `02-find-existing-logic.md` | "I need X" -> `file` + `function` to reuse | **before writing any new function** |
| `03-playbooks.md` | recipes A-H: files to touch, in order | you know the task type |
| `04-rules-and-pitfalls.md` | DO / DON'T list | before editing paths, files, security, keys, startup code |
| `05-testing-and-verify.md` | FAST LOOP table, which test type, what "done" means, failing-test checklist | you add or run a test, or a test fails |
| `06-setup-and-debugging.md` | debug tools without a display, build + run commands, error -> fix table | a command fails, the app does not start, or you need logs |
| `07-glossary-and-conventions.md` | naming, code style, project terms, release rules | a word is unclear, or you must name a new thing |
| `08-worked-examples.md` | 4 real commits, file by file | you want to see a finished change |
| `10-decisions.md` | tried / removed / rejected / chosen on purpose -> why | **before you remove, refactor or "simplify" anything** |

**Reference (`09-reference-*.md`): the full contracts. Long. Never read one whole.**

```bash
grep -n "keyword" docs/llm/09-reference*.md   # then read only the lines you hit
```

| File | Purpose | Read WHEN you touch |
|---|---|---|
| `09-reference.md` | topic -> reference file table, stack | you do not know which reference file to grep |
| `09-reference-ownership.md` | path -> owner table, shared-files rule | a folder or file you may not own |
| `09-reference-app.md` | `app` API, commands, process rows, variables, settings sync | the app shell extension points |
| `09-reference-ui.md` | status bar, zen, file tree, panels, bookmarks, Go back / forward | those UI parts |
| `09-reference-search.md` | indexing, file type associations, symbols, Go to definition, link graph | search, languages or knowledge |
| `09-reference-git.md` | git status, diff view, staging, trust gate, timeouts | anything git |
| `09-reference-terminal.md` | terminal, follow hooks, AI changes panel | the terminal or Claude Code / Opencode follow |
| `09-reference-browser-preview.md` | browser mode, web server child, preview sanitizer, sessions | `src/server/` or rendered note HTML |
| `09-reference-keys.md` | **global key allocation table**, terminal key rules | **any key binding** |
| `09-reference-rules.md` | numbered rules 1-11 (code cites "rule N"), release rules | the reasoning behind a rule; a release question |
| `09-reference-security.md` | file access, vault, processes, outbound requests, packaging | security contracts: **STOP AND ASK** first |
| `09-reference-mcp.md` | MCP tools, grants, tokens, path resolver | `src/mcp/` or `src/main/mcp*.ts` |
| `09-reference-mcp-writes.md` | write guard, placeholders, confirmation, journal | an MCP tool that changes files: **STOP AND ASK** first |

**The code wins over the docs.** Verify every name with `grep -rn "name" src/` before you use it.
