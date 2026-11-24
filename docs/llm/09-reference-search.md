# 09 - Reference: search, languages, symbols, knowledge

> **WHEN TO READ THIS:** you touch indexing, file type associations, code symbols, Go to definition or the link graph.
> **WHAT YOU GET:** one resolution per concern (`languageForPath`, `outline()`, the resolver) and their limits.
> **NEXT FILE:** `09-reference-git.md`

**Do not read this file whole.** Find your keyword, then read only that section:

```bash
grep -n "keyword" docs/llm/09-reference*.md
```

## Indexing

- **Indexing:** search + knowledge read the same paged text stream, `app/workspace-text.ts`.
  - The backend skips git-ignored files, lockfiles, `*.min.*` / `*.map` and files over `search.maxFileSizeKB` (`Workspace.textPaths()`; the tree still lists them).
  - **Name-only entries** (`textpass.nameOnlyFile`: `content: ''`, `binary: true`): a file that exists but whose content cannot be indexed gets a path-metadata-only document, so `ext:pdf`, `file:report`, `path:` and a plain filename term find it — never a content term. Two ways it arises: a name that is not text (`isProbablyTextName` false, e.g. `.pdf` / `.png`) is added by `Indexer.nameOnlyPaths()` **without ever reading the bytes**; a text-named file that decodes to null (binary / NUL) or is over `maxFileSizeKB` becomes name-only inside the read pass. The `binary: true` flag is the existing FileData idiom, so MCP content search and the knowledge index skip these docs.
  - **Never in the index, not even by name:** git-ignored files, lockfiles and `*.min.*` / `*.map` (the tree still lists them). Oversized is *not* in this list — it stays as a name-only entry.
- **A term exclusion hides a file by name / path as well as content** (`report -"secret"` drops `secret-report.pdf`): `Plan.excludePaths` gates `n.pathRanges(e)` in `engine.matchSteps`. The ≤3-letter literal-flag rule is untouched (`query.ts` `looksLikeFlag`), so `-bar` stays a literal term (no exclusion). Negated *filters* (`-file:` / `-path:` / `-ext:`) already path-filter through `buildFileFilter` — a separate path from the `negative` clause list, so no double-apply. The whole-query **verbatim rescue still overrides an exclusion** (name or content alike), unchanged.
  - It reads in worker threads.
  - It keeps a text cache in the app's data folder (never the workspace).
- Search is sharded over workers (`src/search/shards.ts`, exact two-phase merge — keep `tests/unit/search/shards.test.ts` green).
- Emit `app.events.emit('index:stale')` after a setting that changes what is indexed (both indexes rebuild).
- **Excluded / hidden places never enter the backend index**, however they are touched (`tests/unit/backend/workspace.test.ts`):
  - `Workspace.noteEntry` / `noteParents` refuse them;
  - `readFile` of one (Go to definition reading `vendor/`) neither notes it nor puts it on the poller's hot list;
  - `filePaths()` / `readable()` filter them.
- An open excluded file is still searchable while open (open documents' live text always is) and leaves the index when it closes.
- `readFile(path, { maxBytes })` refuses (`ETOOBIG`) before reading a bigger file: use it as a cheap probe.
- `readFile(path, { asText: true })` = "Open as text anyway": the first `MAX_AS_TEXT_BYTES` (2 MB) of a file
  `decode()` refuses, decoded best-effort; `{ asText: 'full' }` reads the whole file but refuses (`ETOOBIG`)
  above `MAX_AS_TEXT_FULL_BYTES` (16 MB). Either way the result **keeps `binary: true`**, so it never reaches
  the index and never becomes savable (the renderer's `doc.binary` guards all still apply; `doc.asText` only
  switches the viewer screen for the editor).
- The index may be built **on demand** (`search.indexing`).
  - A feature that reads it must ask for it: `searchClient.start()` / `(app as any).knowledge.ensure()` (search, mentions, headings already do).
  - It must show "Indexing… x / y" (`searchClient.progress`) instead of an empty state.
  - `indexDeferred` (`search/demand.ts`) = not built yet.

## A file's language (file type associations)

- **A file's language — one resolution: `languageForPath(path)`** (`src/shared/languages.ts`): the user's **file type associations** first (setting `files.associations`, Settings → Files: `{ "*.ctp": "php" }`), then the built-in table.
- Everything that needs "what language is this file" calls it (editor grammar + comment tokens + indentation, status bar, formatter, outline / overview / symbol index, Go to definition, search's `lang:`, embeds): never read an extension table of your own, and never read the setting yourself.
- **Patterns** (`src/shared/associations.ts`, pure) match the lower-cased **base name** only, in three shapes:
  - `*.ctp` (suffix, compound too: `*.tpl.php`);
  - `dockerfile.*` (prefix);
  - `jenkinsfile` (whole name).
- Order: whole name > longest suffix > longest prefix.
- No other wildcard, no regex, a lookup bounded by `MAX_PATTERN` (64) whatever the name; ≤ `MAX_ASSOCIATIONS` (100) rows.
- The value is a language id or alias of the table.
- **Markdown notes and viewer files (`RESERVED`: md / markdown / mdx, pdf, images) are never re-mapped**: `isMarkdown()` keeps deciding what a note is.
- The stored value is cleaned on every read (`cleanAssociations`: hand-edited or hostile settings.json → valid, canonical, unique rows; nothing throws); writes go through `withAssociation` (rows this build cannot read stay in the file; nothing left = null, the default).
- **The table is module state, one per JS realm**, set with `setFileAssociations(raw)` (true = changed):
  - the renderer in the editor's `applySettings` (before the first document);
    - a change re-resolves open code files in place (`reconfigureLanguage`, which `setLanguage` shares) and fires `onLanguageChange`, so the status bar and the overview's outline follow;
    - a per-file language mode still wins;
  - each search shard on a `fileTypes` message (`search/client.ts` sends it to a new shard first and on `settings:changed`);
  - the format worker gets none (`format/install.ts` names the language of a mapped file in the request).
- The backend needs no language: the app's index options carry the patterns (`IndexOptions.textPatterns`, `appIndexOptions` in `service.ts`), so a mapped name is **text for the indexer** (searched, symbol-indexed) like a built-in one.
- A change saves, then emits `index:stale` (`app/file-types.ts`, the two `INDEX_KEYS` lists).
- **App-level only**: the value comes from the app's settings.json, never from the open folder.
- The **MCP server installs nothing** and keeps the built-in text names; it reads the key for one thing, refusing more writes (`09-reference-mcp-writes.md`).
- UI: `app/FileTypesSetting.tsx` (control type `associations`, Settings chunk; what you type goes through `patternFromInput`: `ctp` = `.ctp` = `*.ctp`) and the status bar's language picker ("Set language for all *.ctp files…", Popups → Settings' re-export `setFileAssociation`).
- The tree icon is still by extension (`icons.tsx`, startup).
- Tests: `tests/unit/format/associations.test.ts`, `editor/file-types.test.ts`, `app/file-types.test.tsx`, `backend/file-types.test.ts`, `mcp/file-types.test.ts`, `tests/e2e/file-types.spec.ts`.

## Code symbols

- **Code symbols — one extraction** (search, `src/search/symbols.ts`):
  - `outline()`: palette `@`, MCP outline;
  - `codeSymbols()`: the file overview (`overview/symbols.ts` only re-exports);
  - `extractDefs()`: the symbol index, Go to definition.
    - It adds: enclosing class, class end, `extends`, PHP namespace / traits.
    - It adds index-only kinds marked `extra` (PHP properties / constants / enum cases, JS/TS fields) that the outline and overview never show.
- **A new language** = patterns in `LANG_PATTERNS` (+ `NO_GENERIC` if the generic scan mis-reads it). It needs:
  - each pattern anchored, no two adjacent parts able to match the same characters (lines are capped at 400);
  - a cheap gate (`starts` / `sigil` / `needs`) so most lines skip its regex;
  - a case in `tests/unit/search/symbols.test.ts` (language table + pathological lines).
- Existing languages' outline must not change (that file pins it).
- Index contract values (`DEF_LANGS`, language families `familyOf` / `familyLangs`, `compareDefHits`) live in `symbols.ts` too (`search/defs.ts` is types only: a module of its own became one more tiny shared chunk).

## Workspace symbol index

- **Workspace symbol index** (search): the app's shards run `new SearchEngine({ defs: true })` (MCP / replace engines have none).
  - Code files are queued at `upsert` and extracted in idle slices once a build is done (`SearchHost.drainDefs`), never on the build's critical path.
  - Any query that reads definitions finishes the queue first (`flushDefs`), so answers are exact.
- **Lookup by exact name** (`Map`, lower-cased key):
  - `SearchEngine.definitions`;
  - `ShardedSearch.definitions` (merge = `compareDefHits` order + limit, `tests/unit/search/defs-index.test.ts`);
  - `searchClient.definitions(q)`.
- Workspace symbols ride on `headings(…, { symbols: true })` (non-empty query, ≤ 20 per file across the workspace).
- Narrow a lookup **in the query** (`ns`, `classLike`, `containers`, `topLevel`, `member`, `near`): the shards filter and order (`defOrder(near)`, the same total order everywhere) before the 500 cap, so a common name cannot crowd out the right hit.
- Extraction is linear on any input: class bodies, PHP traits and JS members come from ONE stack pass over the brace depths (`bodies()`), never a scan per class; one cap per file (`MAX_DEFS`), ≤ 32 traits per class; `flushDefs` checks its budget after every file.

## Go to definition

- **Go to definition** (search): pure resolver `src/search/goto/`.
  - `resolve.ts` orchestrates imports → members → same file → same-language index.
  - `php.ts`: namespace / `use` / PSR-4 as **text**.
  - `js.ts`: imports.
  - `context.ts`: identifier + hints.
  - `paths.ts` = `safeRel` / `safeJoin`, through which **every path derived from file contents** passes before a read (attack table `tests/unit/search/goto-paths.test.ts`).
- It sees the app only through `GotoEnv` (reads, tree, index), so it is unit-tested on a fake workspace (`goto-resolve.test.ts`).
- The app side is the lazy chunk `renderer/search/gotodef.tsx` (env over `app.backend.readFile` + open docs + `app.tree` + `searchClient`, picker, toasts, Find usages).
  - It loads the search implementation by `import('./impl')`, not via the stub (`./index`: that static import split `app/lazy` into its own startup chunk).
- **Work per click is bounded** (`Session` in `resolve.ts`): ≤ 150 reads, ≤ 32 M characters, ≤ 64 class resolutions (memoized per file + name + namespace), ≤ 32 traits / `export *` followed per step, 5 levels; past a budget it answers with what it has (`truncated`).
- **Parses are cached per text and linear.**
  - `jsModule` / `pyImports` / `phpParse` find each statement start once and use forward-only pointers for where a clause ends (no regex that re-scans a window from every line start).
  - Only the first 2 M characters.
  - PSR-4 maps are `Map` + `Set` (≤ 5,000 prefixes, ≤ 16 folders each, files over 2 MB skipped).
- Existence is the tree (`known()`) or a size-limited probe (`readFile(path, { maxBytes: 0 })`), never a full read; reads use `maxBytes` too.
- A generation token drops results the user no longer waits for (F12 auto-repeat, another file).
- The editor chunk holds only the forwarders (`editor/gotodef.ts`: `Mod`+click, `F12` / `Shift-F12`, the underline decoration; `goToDefinitionAt` / `findUsagesAt` for the menu and palette).
- Same-file jumps call `app.markNavigation?.()`.
- A new surface that wants "definition of X": call those, don't resolve names yourself.

## Link graph

- Link graph (knowledge): `KnowledgeIndex` keeps adjacency patched per edit — `linksFrom(path)` (unique resolved notes), `linksTo(path)` (live set), `tagsOf` / `notesTagged` (incremental tag index).
- **Neighbourhood queries go through `src/knowledge/connections.ts`** (`relatedNotes` = co-citation + coupling + shared tags with a work budget, `localGraph` capped, `orphanNotes`, `notesWithoutIncoming`).
  - Never scan all notes on a note switch.
  - Perf guard: `tests/e2e/knowledge-connections-perf.spec.ts`, < 16 ms at 10k notes.
- The overview's **Connections** section is the lazy chunk `knowledge/Connections.tsx` (reuses `overview/parts.tsx` + overview row classes); collapsed (its default) it computes only its header count — no lists, graph, related notes or mention scan.
- Section / sub-section open state is `overview/sections.ts`: the user's toggle wins (remembered), else the default (entries → open, 0 → closed; give a new list a `count`, `null` = "…" while unknown); `knowledge/graph-canvas.ts` is the canvas renderer shared with the graph view.
- Keyless knowledge commands register from the chunk (`addCommandSource`, `registerKnowledgeCommands` in `knowledge/impl.tsx`): only key-bound ones live in the stub.

## Link hover preview

- Link hover preview (knowledge, `knowledge/link-preview.ts`, setting `links.hoverPreview`): one popup for every surface.
- The editor reports the link under the pointer via `EditorHost.hoverLink(link | null, from)` (`editor/hover.ts`, forwarded by `editor/integration.ts` to `app.knowledge.linkPreview`); rendered Markdown (`.se-preview a`, note embeds) is picked up by delegation.
- Content = `knowledge/excerpt.ts` (start of note / `#heading` / `#^block`, via preview's `extractSection`) through the preview pipeline (`renderOptionsFor`: sanitised, `{{variables}}` resolved), lazy chunk `knowledge/hover-render.ts`.
- A new link surface: report hovers the same way instead of drawing its own tooltip.
