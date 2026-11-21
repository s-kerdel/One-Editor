// Search tools: full text (One's query syntax), file names (fuzzy), headings across notes. The index is
// built on the first call (indexes.ts); while it is still building the answer says so and is partial.
import { fuzzyFilter } from '../../search/fuzzy';
import type { SearchMatch } from '../../search/types';
import { ToolError, type ToolDef } from '../protocol';
import type { Folder } from '../folders';
import type { FolderIndex } from '../indexes';
import { READ_ONLY, fit, folderParam, inFolder, json, limitParam, ok, rowLimit, type ToolEnv } from './common';

const SNIPPET = 160;

export function snippet(m: Pick<SearchMatch, 'lineText' | 'start'>): string {
  const t = m.lineText;
  if (t.length <= SNIPPET) return t.trim();
  const from = Math.max(0, Math.min(m.start - 50, t.length - SNIPPET));
  return `${from > 0 ? '…' : ''}${t.slice(from, from + SNIPPET).trim()}${from + SNIPPET < t.length ? '…' : ''}`;
}

/** The folder's index, waited for up to indexWaitMs; `partial` tells the model when it is not complete. */
export async function readyIndex(env: ToolEnv, f: Folder): Promise<{ ix: FolderIndex; partial: string | undefined }> {
  const ix = await f.indexes();
  const done = await ix.ready(env.indexWaitMs);
  if (done) await ix.settle();
  return { ix, partial: done ? undefined : `Index ${ix.progress()}: results may be incomplete, try again shortly.` };
}

export function searchTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'search_text',
      title: 'Search text',
      description:
        'Full-text search in a folder. Words must all appear (any order); "exact phrase"; -word excludes; a OR b. Filters: path:notes/ file:todo ext:md tag:project in:heading|code|text|frontmatter|link. Returns matching lines (1-based) per file.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          query: { type: 'string', description: 'What to find, in the syntax above (plain text: no regular expressions).', maxLength: 500 },
          case_sensitive: { type: 'boolean', description: 'Default: only when the query has capital letters.' },
          limit: limitParam('files (default 10)'),
          per_file: { type: 'integer', description: 'Most matching lines per file (default 3).', minimum: 1, maximum: 20 },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const query = String(a.query).trim();
          if (!query) throw new ToolError('EINVAL', 'query is empty');
          const { ix, partial } = await readyIndex(env, f);
          const limit = rowLimit(env, a.limit, 10);
          // No regex here, ever: a client's pattern would run unbounded on this thread (`/…/` is plain text).
          const res = ix.engine.search(query, {
            noRegex: true,
            caseSensitive: a.case_sensitive === undefined ? 'smart' : a.case_sensitive === true,
            limit: limit + 5, // room for paths the re-check drops
            maxMatchesPerFile: (a.per_file as number | undefined) ?? 3,
          });
          if (res.error) throw new ToolError('EINVAL', `Query problem: ${res.error}`);
          const shown = await f.visibleOnly(res.results.map((r) => r.path));
          const rows = res.results
            .filter((r) => shown.has(r.path))
            .slice(0, limit)
            .map((r) => ({ path: r.path, matches: r.matches.map((m) => ({ line: m.line + 1, text: snippet(m) })), ...(r.totalMatches > r.matches.length ? { more_matches: r.totalMatches - r.matches.length } : {}) }));
          const page = fit(rows, env.limits().readChars);
          return ok(
            json({
              query,
              total_files: res.totalFiles,
              total_matches: res.totalMatches,
              results: page.items,
              truncated: page.cut || res.totalFiles > page.items.length || undefined,
              ...(res.fuzzy ? { fuzzy: true, corrections: res.corrections } : {}),
              ...(res.suggestions?.length ? { did_you_mean: res.suggestions.map((s) => s.to) } : {}),
              ...(partial ? { index: partial } : {}),
            }),
          );
        }),
    },
    {
      name: 'search_files',
      title: 'Find files by name',
      description: 'Finds files by name or path, fuzzy (like quick open): "mtg notes" finds meetings/2026-notes.md. Best match first.',
      inputSchema: {
        type: 'object',
        properties: { folder: folderParam, query: { type: 'string', description: 'Part of a file name or path.', maxLength: 200 }, limit: limitParam('files') },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const query = String(a.query).trim();
          if (!query) throw new ToolError('EINVAL', 'query is empty');
          const limit = rowLimit(env, a.limit);
          const all: string[] = [];
          const hits = fuzzyFilter(query, await f.filePaths(), (p) => p, limit + 5, { path: true, collect: all });
          const shown = await f.visibleOnly(hits.map((h) => h.item));
          const results = hits.map((h) => h.item).filter((p) => shown.has(p)).slice(0, limit);
          return ok(json({ query, results, total: all.length, truncated: all.length > results.length || undefined }));
        }),
    },
    {
      name: 'search_headings',
      title: 'Find headings',
      description: 'Finds Markdown headings across all notes, fuzzy. Use read_section with the heading to read that part.',
      inputSchema: {
        type: 'object',
        properties: { folder: folderParam, query: { type: 'string', description: 'Words of the heading.', maxLength: 200 }, limit: limitParam('headings') },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const query = String(a.query).trim();
          if (!query) throw new ToolError('EINVAL', 'query is empty');
          const { ix, partial } = await readyIndex(env, f);
          const limit = rowLimit(env, a.limit);
          const hits = ix.engine.headings(query, { limit: limit + 5 });
          const shown = await f.visibleOnly([...new Set(hits.map((h) => h.path))]);
          const rows = hits.filter((h) => shown.has(h.path)).slice(0, limit).map((h) => ({ path: h.path, line: h.line + 1, level: h.level, heading: h.text }));
          const page = fit(rows, env.limits().readChars);
          return ok(json({ query, results: page.items, truncated: page.cut || undefined, ...(partial ? { index: partial } : {}) }));
        }),
    },
  ];
}
