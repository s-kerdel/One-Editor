# 09 - Reference: index

> **WHEN TO READ THIS:** a short rule in `00`-`08` is not enough and you need the full contract.
> **WHAT YOU GET:** which `09-reference-*.md` file holds which topic. This is the complete engineering reference.
> **NEXT FILE:** the one file from the table below. Never all of them.

**Grep first, then read only the section you hit:**

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Topic -> file

| You touch | Read |
|---|---|
| a folder you may not own, shared files | `09-reference-ownership.md` |
| `app` API, commands, process rows, variables, settings sync | `09-reference-app.md` |
| status bar, zen, file tree, sidebar panels, bookmarks, Go back / forward | `09-reference-ui.md` |
| indexing, file type associations, symbols, Go to definition, link graph | `09-reference-search.md` |
| git status, diff view, staging, trust gate, timeouts | `09-reference-git.md` |
| terminal, follow (Claude Code / Opencode), AI changes panel | `09-reference-terminal.md` |
| browser mode, web server child, preview sanitizer, sessions | `09-reference-browser-preview.md` |
| **any key binding** | `09-reference-keys.md` |
| numbered rules 1-11, version control (lead only) | `09-reference-rules.md` |
| file access, opening folders, vault, processes, outbound requests, packaging | `09-reference-security.md` |
| MCP server: tools, grants, tokens, path resolver | `09-reference-mcp.md` |
| MCP tools that **change files** | `09-reference-mcp-writes.md` |

## How to use it

1. **Find** the keyword with the grep above.
2. **Read** only that `##` section.
3. **Verify** every name in it with `grep -rn "name" src/` before you use it. The code wins over this text.
4. **Update** the section when you change the contract it describes.

## Stack (one look)

| Part | Uses |
|---|---|
| UI | TypeScript, **Preact + @preact/signals**, **CodeMirror 6** |
| Preview | markdown-it + DOMPurify, Shiki (lazy) |
| Format | Prettier standalone + `@prettier/plugin-php` (lazy, in a worker) |
| Build | Vite (`src/renderer` -> `dist/renderer`), esbuild for Node entries (`scripts/build-node.mjs`) |
| Tests | Vitest (`tests/unit/**`), Playwright (`tests/e2e/**`, browser mode, real server per worker) |

Targets: **Windows first**, Linux and macOS must also work. No vaults, no sync.
