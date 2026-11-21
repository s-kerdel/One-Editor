// Read tools: folders, listings, file text (paged, or one part: heading / block / frontmatter key), the
// outline. Plain-text answers (format.ts); line numbers are 1-based. A read that passes the etag it
// already has (if_none_match) gets "unchanged" instead of the text again.
import path from 'node:path';
import { isMarkdown } from '../../shared/paths';
import { documentMap, findBlock, findSection, frontmatterValue } from '../../knowledge/sections';
import { outline } from '../../search/symbols';
import { ToolError, type ToolDef } from '../protocol';
import type { TextFile } from '../folders';
import { READ_ONLY, etagOf, inFolder, takeLines, type ToolEnv } from './common';
import { P, count, etagPart, fitRows, line, oneLine, reply, withBody } from './format';

const DEFAULT_LINES = 400;
const PARTS = ['heading', 'block', 'frontmatter_key'] as const;

/** Names joined with ", ", within `budget` characters (each at most 200); "+N more" when cut. */
function fitNames(names: readonly string[], budget: number): string {
  const f = fitRows(names.map((n) => oneLine(n, 200)), budget);
  return f.rows.join(', ') + (f.cut ? ` (+${names.length - f.rows.length} more)` : '');
}

/** The file's facts for a summary line: etag always, eol / encoding / BOM only when unusual. */
const fileParts = (f: TextFile) => [etagPart(etagOf(f)), f.eol !== 'lf' && f.eol, f.encoding !== 'utf8' && f.encoding, f.bom && 'bom'];

export function readTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'list_folders',
      title: 'List shared folders',
      description: 'Shared folders and their access (read-only or read-write).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      async run() {
        const all = env.pool.list();
        if (!all.length) return reply('No folders are shared. The user can add one in One → Settings → MCP server.');
        // The folder's own name only (never its location), and only when it says more than the alias.
        const rows = all.map((f) => {
          const name = path.basename(f.root);
          return line(name.toLowerCase() === f.alias ? f.alias : `${f.alias} (${name})`, f.mode === 'write' ? 'read-write' : 'read-only', `index ${f.indexState}`);
        });
        return reply(count(all.length, 'folder'), ...rows);
      },
    },
    {
      name: 'list_files',
      title: 'List files',
      description: 'Files and subfolders (folders end with "/"), as paths in the folder.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path('Subfolder (default: top)'),
          depth: { type: 'integer', description: 'Levels: 1 (default) to 3.', minimum: 1, maximum: 3 },
          cursor: { type: 'string', description: 'From "more: cursor=…".', maxLength: 20 },
          limit: { type: 'integer', description: 'Max entries (default 100).', minimum: 1, maximum: 2000 },
        },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const r = await f.list(a.path ?? '', (a.depth as number | undefined) ?? 1);
          const max = env.limits().results * 4;
          const limit = Math.min(max, (a.limit as number | undefined) ?? max);
          const from = a.cursor === undefined ? 0 : Number(a.cursor);
          if (!Number.isInteger(from) || from < 0) throw new ToolError('EINVAL', 'cursor is not one this tool returned');
          const page = fitRows(
            r.entries.slice(from, from + limit).map((e) => (e.dir ? `${e.path}/` : e.path)),
            env.limits().readChars,
          );
          const end = from + page.rows.length;
          const shown = from || end < r.entries.length ? `${from + 1}-${end} of ${r.entries.length} entries` : count(r.entries.length, 'entry', 'entries');
          const head = line(r.key ? `${r.key}/` : '', shown, end < r.entries.length && `more: cursor=${end}`, r.truncated && 'listing cut: folder too large');
          return reply(head, ...page.rows);
        }),
    },
    {
      name: 'read_file',
      title: 'Read a file',
      description:
        'Reads a text file. First line: etag and line range, then the raw text. Big files come in pages ("more: offset_line=…"). Only a part: heading, block or frontmatter_key; a range: offset_line + max_lines.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: P.folder,
          path: P.path(),
          heading: { type: 'string', description: 'Only this section, e.g. "Plans > 2026".', maxLength: 500 },
          block: { type: 'string', description: 'Only this block, e.g. ^summary.', maxLength: 100 },
          frontmatter_key: { type: 'string', description: 'Only this frontmatter key.', maxLength: 100 },
          offset_line: { type: 'integer', description: 'First line (1-based).', minimum: 1 },
          max_lines: { type: 'integer', description: `Max lines (default ${DEFAULT_LINES}).`, minimum: 1, maximum: 5000 },
          if_none_match: { type: 'string', description: 'etag of your last read: answers "unchanged" instead of the same text.', maxLength: 64 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const which = PARTS.filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
          if (which.length > 1) throw new ToolError('EINVAL', 'Pass at most one of: heading, block, frontmatter_key');
          const file = await f.readText(a.path);
          const etag = etagOf(file);
          if (typeof a.if_none_match === 'string' && a.if_none_match.trim() === etag) return reply(line(file.path, etagPart(etag), 'unchanged'));
          if (file.binary) return reply(line(file.path, ...fileParts(file), 'binary: no text'));
          const lines = file.content.split('\n');
          const total = lines.length;
          // The range to read (0-based, inclusive) and what it is, for the summary line.
          let start = 0;
          let end = total - 1;
          let what: string | null = null;
          if (which.length) {
            const map = documentMap(file.content);
            if (which[0] === 'frontmatter_key') {
              const v = frontmatterValue(file.content, map, a.frontmatter_key as string);
              if (!v) throw new ToolError('ENOENT', `No frontmatter key "${String(a.frontmatter_key).slice(0, 100)}" in ${file.path}${map.frontmatter?.keys.length ? `. Keys: ${fitNames(map.frontmatter.keys.map((k) => k.key), 2000)}` : ' (it has no frontmatter)'}`);
              [start, end, what] = [v.line, v.end, `frontmatter ${v.key}`];
            } else if (which[0] === 'block') {
              const b = findBlock(map, a.block as string);
              if (!b) throw new ToolError('ENOENT', `No block "${String(a.block).slice(0, 100)}" in ${file.path}${map.blocks.length ? `. Blocks: ${map.blocks.slice(0, 30).map((x) => `^${x.id}`).join(', ')}` : ''}`);
              [start, end, what] = [b.start, b.end, `block ^${b.id}`];
            } else {
              const h = findSection(map, (a.heading as string).split(' > '));
              if (!h) throw new ToolError('ENOENT', `No heading "${String(a.heading).slice(0, 200)}" in ${file.path}${map.headings.length ? `. Headings: ${map.headings.slice(0, 30).map((x) => x.text).join(' | ')}` : ' (it has no headings)'}`);
              [start, end, what] = [h.line, h.end, `heading "${h.text}"`];
            }
          }
          if (a.offset_line !== undefined) {
            const o = (a.offset_line as number) - 1;
            if (o > end || o < start) throw new ToolError('EINVAL', what ? `offset_line is outside ${what} (lines ${start + 1}-${end + 1})` : `offset_line is past the end (the file has ${total} lines)`);
            start = o;
          }
          const t = takeLines(lines, start, Math.min((a.max_lines as number | undefined) ?? DEFAULT_LINES, end - start + 1), env.limits().readChars);
          const last = t.end - 1; // last line returned (0-based)
          const whole = !what && start === 0 && last === total - 1;
          const range = whole ? (file.content ? count(total, 'line') : 'empty') : start === last ? `line ${start + 1} of ${total}` : `lines ${start + 1}-${last + 1} of ${total}`;
          const more = last < end ? `more: offset_line=${last + 2}${what ? ` max_lines=${end - last}` : ''}` : null;
          const head = line(file.path, ...fileParts(file), what, range, t.lineCut && `line ${start + 1} cut at ${Math.round(env.limits().readChars / 1024)} kB`, more);
          return withBody(head, t.text);
        }),
    },
    {
      name: 'get_outline',
      title: 'Outline of a file',
      description: 'Map of a file, to read only the part you need: Markdown headings with line ranges, block ids, frontmatter keys; code: functions and classes.',
      inputSchema: { type: 'object', properties: { folder: P.folder, path: P.path() }, required: ['path'], additionalProperties: false },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const file = await f.readText(a.path);
          if (file.binary) throw new ToolError('EINVAL', `Binary file: ${file.path}`);
          const budget = env.limits().readChars;
          const total = file.content.split('\n').length;
          if (!isMarkdown(file.path)) {
            const all = outline(file.path, file.content).map((s) => `${s.line + 1} ${s.detail ?? s.kind} ${s.text}`);
            const syms = fitRows(all, budget);
            return reply(line(file.path, etagPart(etagOf(file)), count(total, 'line'), syms.cut ? `${syms.rows.length} of ${all.length} symbols` : count(all.length, 'symbol')), ...syms.rows);
          }
          const map = documentMap(file.content);
          // The answer stays within the read budget: frontmatter keys 10 %, headings 70 %, blocks 20 %.
          const fm = map.frontmatter && `frontmatter ${map.frontmatter.start + 1}-${map.frontmatter.end + 1}: ${fitNames(map.frontmatter.keys.map((k) => k.key), Math.floor(budget * 0.1))}`;
          const heads = fitRows(
            map.headings.map((h) => `${h.line + 1}-${h.end + 1} ${'#'.repeat(h.level)} ${h.text}`),
            Math.floor(budget * 0.7),
          );
          const blocks = fitRows(
            map.blocks.map((b) => `^${b.id} ${b.start + 1}-${b.end + 1}`),
            Math.floor(budget * 0.2),
          );
          const cut = (heads.cut || blocks.cut) && `cut: showing ${heads.rows.length} of ${map.headings.length} headings, ${blocks.rows.length} of ${map.blocks.length} blocks`;
          return reply(line(file.path, etagPart(etagOf(file)), count(total, 'line'), count(map.headings.length, 'heading'), cut), fm, ...heads.rows, blocks.rows.length ? `blocks: ${blocks.rows.join(', ')}` : null);
        }),
    },
  ];
}
