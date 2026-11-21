// Knowledge tools: tags, and a note's links (outgoing, backlinks) or its neighbourhood (related notes that
// share links or tags, notes two links away). KnowledgeIndex + connections.ts; plain-text answers.
import { isMarkdown } from '../../shared/paths';
import { localGraph, relatedNotes } from '../../knowledge/connections';
import { ToolError, type ToolDef } from '../protocol';
import { READ_ONLY, inFolder, notMarkdown, rowLimit, type ToolEnv } from './common';
import { P, count, fitRows, line, oneLine, reply } from './format';
import { readyIndex } from './search';

const notIndexed = (key: string) => new ToolError('ENOENT', `Not in the index: ${key} (too large, git-ignored, or just created; try again shortly)`);

export function linkTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'list_tags',
      title: 'List tags',
      description: 'Tags used in the notes, most used first, with note counts.',
      inputSchema: { type: 'object', properties: { folder: P.folder, limit: P.limit('tags (default 25)') }, additionalProperties: false },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const { ix, partial } = await readyIndex(env, f);
          const limit = rowLimit(env, a.limit);
          const flat: Array<{ tag: string; count: number }> = [];
          const walk = (nodes: ReturnType<typeof ix.knowledge.tags>) => {
            for (const n of nodes) {
              flat.push({ tag: n.tag, count: n.count });
              walk(n.children);
            }
          };
          walk(ix.knowledge.tags());
          flat.sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag));
          const page = fitRows(flat.slice(0, limit).map((t) => `#${t.tag} (${t.count})`), env.limits().readChars);
          const shown = page.rows.length < flat.length ? `${page.rows.length} of ${count(flat.length, 'tag')}` : count(flat.length, 'tag');
          return reply(line(shown, flat.length > 0 && 'notes with a tag: search "tag:name" mode=files', partial), ...page.rows);
        }),
    },
    {
      name: 'get_links',
      title: 'Links of a note',
      description: 'Links of a Markdown note: outgoing and backlinks, with lines. show=related: notes sharing its links or tags, and notes two links away.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('Note, e.g. notes/todo.md'),
          show: { type: 'string', description: 'both (default), outgoing, backlinks, or related.', enum: ['both', 'outgoing', 'backlinks', 'related'] },
          limit: P.limit('rows per list (default 25)'),
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const { key } = await f.resolve(a.path);
          const show = (a.show as string | undefined) ?? 'both';
          if (show !== 'backlinks' && !isMarkdown(key)) throw notMarkdown(key);
          const { ix, partial } = await readyIndex(env, f);
          const k = ix.knowledge;
          const limit = rowLimit(env, a.limit);
          const head: Array<string | false> = [key];
          const rows: string[] = [];
          if (show === 'related') {
            if (!k.note(key)) throw notIndexed(key);
            const g = localGraph(k, key, 2, limit * 2 + 1);
            const direct = new Set(k.linksFrom(key));
            for (const p of k.linksTo(key)) direct.add(p);
            const far = g.nodes.slice(1).map((n) => n.id).filter((p) => !direct.has(p));
            const rel = relatedNotes(k, key, { limit });
            const shown = await f.visibleOnly([...new Set([...far, ...rel.map((r) => r.path)])]);
            const relRows = rel.filter((r) => shown.has(r.path)).map((r) => `  ${line(r.path, r.links > 0 && count(r.links, 'shared link'), r.tags.length > 0 && `tags ${r.tags.join(', ')}`)}`);
            const farRows = far.filter((p) => shown.has(p)).slice(0, limit).map((p) => `  ${p}`);
            head.push(count(relRows.length, 'related note'), count(farRows.length, 'note', 'notes') + ' two links away');
            if (relRows.length) rows.push('related (shared links / tags):', ...relRows);
            if (farRows.length) rows.push('two links away:', ...farRows);
          } else {
            if (show !== 'backlinks') {
              if (!k.note(key)) throw notIndexed(key);
              const links = k.outgoing(key);
              const targets = await f.visibleOnly([...new Set(links.map((l) => l.path).filter((p): p is string => !!p))]);
              const out = links.slice(0, limit).map((l) => {
                const target = l.link.target + (l.link.heading ? `#${l.link.heading}` : '') + (l.link.block ? `#^${l.link.block}` : '');
                // A target that exists but is hidden reads as missing, like everywhere else.
                const p = l.path && targets.has(l.path) ? l.path : null;
                return `  ${l.link.line + 1}: ${p === target ? p : `${target} → ${p ?? 'missing'}`}${l.link.embed ? ' (embed)' : ''}`;
              });
              head.push(links.length > out.length ? `${out.length} of ${links.length} outgoing` : `${out.length} outgoing`);
              rows.push('outgoing (line: link → file):', ...out);
            }
            if (show !== 'outgoing') {
              const back = k.backlinks(key);
              const from = await f.visibleOnly([...new Set(back.slice(0, limit * 3).map((b) => b.from))]);
              const inc = back
                .filter((b) => from.has(b.from))
                .slice(0, limit)
                .map((b) => `  ${b.from}:${b.line + 1}: ${oneLine(b.context.text)}`);
              head.push(back.length > inc.length ? `${inc.length} of ${count(back.length, 'backlink')}` : count(inc.length, 'backlink'));
              rows.push('backlinks (file:line: text):', ...inc);
            }
          }
          const page = fitRows(rows, env.limits().readChars);
          return reply(line(...head, page.cut && 'cut: pass a smaller limit or one list', partial), ...page.rows);
        }),
    },
  ];
}
