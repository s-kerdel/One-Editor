// Knowledge tools: tags, links in and out of a note, its neighbourhood (KnowledgeIndex + connections.ts).
import { isMarkdown } from '../../shared/paths';
import { localGraph, relatedNotes } from '../../knowledge/connections';
import { ToolError, type ToolDef } from '../protocol';
import { READ_ONLY, fit, folderParam, inFolder, json, limitParam, notMarkdown, ok, pathParam, rowLimit, type ToolEnv } from './common';
import { readyIndex } from './search';

const round2 = (n: number) => Math.round(n * 100) / 100;

export function linkTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'list_tags',
      title: 'List tags',
      description: 'Without tag: the tags used in the notes, most used first, with how many notes carry each. With tag: the notes carrying it (nested tags included: project also finds project/alpha).',
      inputSchema: {
        type: 'object',
        properties: { folder: folderParam, tag: { type: 'string', description: 'A tag, with or without # (e.g. project).', maxLength: 200 }, limit: limitParam('rows') },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const { ix, partial } = await readyIndex(env, f);
          const limit = rowLimit(env, a.limit);
          const extra = partial ? { index: partial } : {};
          const tag = typeof a.tag === 'string' ? a.tag.trim().replace(/^#/, '') : '';
          if (tag) {
            const notes = ix.knowledge.notesWithTag(tag);
            const shown = await f.visibleOnly(notes.slice(0, limit + 5));
            const page = notes.filter((p) => shown.has(p)).slice(0, limit);
            return ok(json({ tag, notes: page, total: notes.length, truncated: notes.length > page.length || undefined, ...extra }));
          }
          const flat: Array<{ tag: string; count: number }> = [];
          const walk = (nodes: ReturnType<typeof ix.knowledge.tags>) => {
            for (const n of nodes) {
              flat.push({ tag: n.tag, count: n.count });
              walk(n.children);
            }
          };
          walk(ix.knowledge.tags());
          flat.sort((x, y) => y.count - x.count || x.tag.localeCompare(y.tag));
          const page = fit(flat.slice(0, limit), env.limits().readChars);
          return ok(json({ tags: page.items, total: flat.length, truncated: flat.length > page.items.length || undefined, ...extra }));
        }),
    },
    {
      name: 'get_links',
      title: 'Links of a note',
      description: 'Links of a Markdown note: outgoing (what it links to; path null = the target does not exist) and backlinks (notes linking to it, with the line).',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('The note.'),
          direction: { type: 'string', description: 'outgoing, backlinks, or both (default).', enum: ['both', 'outgoing', 'backlinks'] },
          limit: limitParam('links per direction'),
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const { key } = await f.resolve(a.path);
          const { ix, partial } = await readyIndex(env, f);
          const k = ix.knowledge;
          const dir = (a.direction as string | undefined) ?? 'both';
          const limit = rowLimit(env, a.limit);
          const out: Record<string, unknown> = { path: key };
          if (dir !== 'backlinks') {
            if (!isMarkdown(key)) throw notMarkdown(key);
            if (!k.note(key)) throw new ToolError('ENOENT', `Not in the index: ${key} (too large, git-ignored, or just created; try again shortly)`);
            const links = k.outgoing(key);
            const targets = await f.visibleOnly([...new Set(links.map((l) => l.path).filter((p): p is string => !!p))]);
            const rows = links.slice(0, limit).map((l) => ({
              target: l.link.target + (l.link.heading ? `#${l.link.heading}` : '') + (l.link.block ? `#^${l.link.block}` : ''),
              // A target that exists but is hidden reads as missing, like everywhere else.
              path: l.path && targets.has(l.path) ? l.path : null,
              line: l.link.line + 1,
              ...(l.link.embed ? { embed: true } : {}),
            }));
            out.outgoing = rows;
            if (links.length > rows.length) out.outgoing_total = links.length;
          }
          if (dir !== 'outgoing') {
            const back = k.backlinks(key);
            const from = await f.visibleOnly([...new Set(back.slice(0, limit * 3).map((b) => b.from))]);
            const rows = back
              .filter((b) => from.has(b.from))
              .slice(0, limit)
              .map((b) => ({ from: b.from, line: b.line + 1, text: b.context.text }));
            out.backlinks = rows;
            if (back.length > rows.length) out.backlinks_total = back.length;
          }
          const fitted = fit([out], env.limits().readChars);
          if (fitted.cut) throw new ToolError('ETOOBIG', 'Too many links to show: pass a smaller limit or one direction');
          return ok(json({ ...out, ...(partial ? { index: partial } : {}) }));
        }),
    },
    {
      name: 'get_related',
      title: 'Related notes',
      description: 'Notes around a Markdown note: neighbours (linked either way; depth 2 adds their neighbours) and related notes that share links or tags without linking directly.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('The note.'),
          depth: { type: 'integer', description: '1 (default): direct neighbours. 2: also neighbours of neighbours.', minimum: 1, maximum: 2 },
          limit: limitParam('notes per list'),
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const { key } = await f.resolve(a.path);
          if (!isMarkdown(key)) throw notMarkdown(key);
          const { ix, partial } = await readyIndex(env, f);
          const k = ix.knowledge;
          if (!k.note(key)) throw new ToolError('ENOENT', `Not in the index: ${key} (too large, git-ignored, or just created; try again shortly)`);
          const limit = rowLimit(env, a.limit);
          const depth = (a.depth as number | undefined) === 2 ? 2 : 1;
          const g = localGraph(k, key, depth, limit + 1);
          const out = new Set(k.linksFrom(key));
          const inc = k.linksTo(key);
          const neigh = g.nodes.slice(1).map((n) => ({ path: n.id, hop: out.has(n.id) || inc.has(n.id) ? 1 : 2, ...(out.has(n.id) ? { links_to: true } : {}), ...(inc.has(n.id) ? { linked_from: true } : {}) }));
          const rel = relatedNotes(k, key, { limit }).map((r) => ({ path: r.path, score: round2(r.score), shared_links: r.links, ...(r.tags.length ? { shared_tags: r.tags } : {}) }));
          const shown = await f.visibleOnly([...new Set([...neigh.map((n) => n.path), ...rel.map((r) => r.path)])]);
          return ok(json({ path: key, neighbours: neigh.filter((n) => shown.has(n.path)), related: rel.filter((r) => shown.has(r.path)), ...(partial ? { index: partial } : {}) }));
        }),
    },
  ];
}
