// One search tool, four modes: full text in One's query syntax (matching lines, or just paths + counts as
// a cheap first pass), fuzzy file names, fuzzy headings. The index is built on the first call
// (indexes.ts); while it is still building the answer says so and is partial. Plain-text answers.
import { fuzzyFilter } from '../../search/fuzzy';
import type { SearchMatch, SearchResponse, SearchResult } from '../../search/types';
import { ToolError, type ToolDef } from '../protocol';
import type { Folder } from '../folders';
import type { FolderIndex } from '../indexes';
import { READ_ONLY, inFolder, rowLimit, type ToolEnv } from './common';
import { P, count, fitGroups, fitRows, line, oneLine, reply } from './format';

const SNIPPET = 160;
const MAX_CONTEXT = 5;

/** The hit's line, at most SNIPPET characters around the hit. `indent`: keep the leading blanks (code in context). */
export function snippet(m: Pick<SearchMatch, 'lineText' | 'start'>, indent = false): string {
  const t = indent ? m.lineText.trimEnd() : m.lineText;
  if (t.length <= SNIPPET) return indent ? t : t.trim();
  const from = Math.max(0, Math.min(m.start - 50, t.length - SNIPPET));
  return `${from > 0 ? '…' : ''}${t.slice(from, from + SNIPPET).trim()}${from + SNIPPET < t.length ? '…' : ''}`;
}

/** The folder's index, waited for up to indexWaitMs; `partial` tells the model when it is not complete. */
export async function readyIndex(env: ToolEnv, f: Folder): Promise<{ ix: FolderIndex; partial: string | undefined }> {
  const ix = await f.indexes();
  const done = await ix.ready(env.indexWaitMs);
  if (done) await ix.settle();
  return { ix, partial: done ? undefined : `index ${ix.progress()}: results may be incomplete, try again shortly` };
}

/** Rows of one file: hit lines as `N: text`, with `context` lines around them as `N- text` (grep style). */
function fileRows(r: SearchResult, context: number, content: string | undefined): string[] {
  // A hit on the file's path is no line of the file (the engine reports it as line 1 with the path as text).
  const inText = r.matches.filter((m) => m.context !== 'path');
  const out: string[] = inText.length < r.matches.length ? ['  (path matches)'] : [];
  if (!context || content === undefined) return [...out, ...inText.map((m) => `  ${m.line + 1}: ${snippet(m)}`)];
  const lines = content.split('\n');
  const hits = new Map(inText.map((m) => [m.line, m]));
  let prev = -2;
  for (const m of inText) {
    const from = Math.max(0, m.line - context, prev + 1);
    const to = Math.min(lines.length - 1, m.line + context);
    if (prev >= 0 && from > prev + 1) out.push('  --');
    for (let i = from; i <= to; i++) {
      const h = hits.get(i);
      out.push(h ? `  ${i + 1}: ${snippet(h, true)}` : `  ${i + 1}- ${snippet({ lineText: lines[i], start: 0 }, true)}`);
    }
    prev = Math.max(prev, to);
  }
  return out;
}

/** What the engine adds besides results: typo corrections, suggestions, query warnings, a partial index. */
function notes(res: SearchResponse, partial: string | undefined): Array<string | false | undefined> {
  return [
    !!res.fuzzy && !!res.corrections?.length && `no exact match, typo-tolerant: ${res.corrections.map((c) => `${c.from} → ${c.to.join('/')}`).join(', ')}`,
    !!res.suggestions?.length && `did you mean: ${res.suggestions.map((s) => s.to).join(', ')}`,
    ...(res.warnings ?? []).map((w) => `note: ${w}`),
    partial,
  ];
}

export function searchTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'search',
      title: 'Search',
      description:
        'Full-text search (no regex): all words must appear, lowercase = any case; "exact phrase"; -word excludes; a OR b. ' +
        'Filters go in the query, -filter negates: path:notes/ file:todo ext:php,sql lang:sql tag:project in:code|block|inline|text|heading|frontmatter|link|path case:yes. ' +
        'E.g. "deploy path:notes/ -path:archive", "select ext:php,sql", "tag:idea in:heading".',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          query: { type: 'string', description: 'Words and filters.', maxLength: 500 },
          mode: {
            type: 'string',
            description: 'lines (default): matching lines. files: paths + match counts only (cheap first look). names / headings: fuzzy file names / headings (plain words).',
            enum: ['lines', 'files', 'names', 'headings'],
          },
          context: { type: 'integer', description: 'Lines around each hit.', minimum: 0, maximum: MAX_CONTEXT },
          per_file: { type: 'integer', description: 'Max lines per file (default 3).', minimum: 1, maximum: 20 },
          limit: P.limit('files (default 10; other modes 25)'),
        },
        required: ['query'],
        additionalProperties: false,
      },
      argHint: 'Filters go inside query, e.g. query: "deploy path:notes/ ext:md".',
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const query = String(a.query).trim();
          if (!query) throw new ToolError('EINVAL', 'query is empty');
          const mode = (a.mode as string | undefined) ?? 'lines';
          if (mode === 'names') return names(env, f, query, a.limit);
          if (mode === 'headings') return headings(env, f, query, a.limit);
          const files = mode === 'files';
          const { ix, partial } = await readyIndex(env, f);
          const limit = rowLimit(env, a.limit, files ? undefined : 10);
          // No regex here, ever: a client's pattern would run unbounded on this thread (`/…/` is plain text).
          const res = ix.engine.search(query, {
            noRegex: true,
            caseSensitive: 'smart',
            limit: limit + 5, // room for paths the re-check drops
            maxMatchesPerFile: files ? 1 : ((a.per_file as number | undefined) ?? 3),
          });
          if (res.error) throw new ToolError('EINVAL', `Query problem: ${res.error}`);
          const shown = await f.visibleOnly(res.results.map((r) => r.path));
          const hits = res.results.filter((r) => shown.has(r.path)).slice(0, limit);
          // Filter-only queries (ext:sql, tag:x) select files without counting matches.
          const filterOnly = res.totalMatches === 0 && res.totalFiles > 0;
          const total = filterOnly ? count(res.totalFiles, 'file') : `${count(res.totalMatches, 'match', 'matches')} in ${count(res.totalFiles, 'file')}`;
          if (!hits.length) return reply(line('No matches (all words must appear: try fewer words, OR, or fewer filters)', ...notes(res, partial)));
          const context = (a.context as number | undefined) ?? 0;
          const groups = hits.map((r): string[] => {
            if (filterOnly) return [r.path];
            if (files) return [`${r.path} (${r.totalMatches})`];
            // Hits, not lines (two on one line = 2 matches, 1 row): the total only when rows do not show them all.
            const more = r.totalMatches > r.matches.length ? ` (${count(r.totalMatches, 'match', 'matches')})` : '';
            return [r.path + more, ...fileRows(r, context, context ? ix.engine.getContent(r.path) : undefined)];
          });
          const page = fitGroups(groups, env.limits().readChars);
          const cut = page.cut || res.totalFiles > page.groups;
          const head = line(total, cut && `showing ${page.groups}`, cut && 'more: raise limit or narrow (path: ext: tag:)', ...notes(res, partial));
          return reply(head, ...page.rows);
        }),
    },
  ];
}

async function names(env: ToolEnv, f: Folder, query: string, asked: unknown) {
  const limit = rowLimit(env, asked);
  const all: string[] = [];
  const hits = fuzzyFilter(query, await f.filePaths(), (p) => p, limit + 5, { path: true, collect: all });
  const shown = await f.visibleOnly(hits.map((h) => h.item));
  const rows = hits.map((h) => h.item).filter((p) => shown.has(p)).slice(0, limit);
  if (!rows.length) return reply('No file names match');
  const page = fitRows(rows, env.limits().readChars);
  const cut = page.cut || all.length > page.rows.length;
  return reply(line(cut ? `${page.rows.length} of ${count(all.length, 'file')}` : count(rows.length, 'file'), 'best first'), ...page.rows);
}

async function headings(env: ToolEnv, f: Folder, query: string, asked: unknown) {
  const { ix, partial } = await readyIndex(env, f);
  const limit = rowLimit(env, asked);
  const hits = ix.engine.headings(query, { limit: limit + 5 });
  const shown = await f.visibleOnly([...new Set(hits.map((h) => h.path))]);
  const rows = hits
    .filter((h) => shown.has(h.path))
    .slice(0, limit)
    .map((h) => `${h.path}:${h.line + 1} ${'#'.repeat(h.level)} ${oneLine(h.text, 200)}`);
  if (!rows.length) return reply(line('No headings match', partial));
  const page = fitRows(rows, env.limits().readChars);
  return reply(line(count(page.rows.length, 'heading'), 'best first', 'read one: read_file with heading', partial), ...page.rows);
}
