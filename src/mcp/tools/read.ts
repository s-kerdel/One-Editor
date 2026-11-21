// Read tools: folders, listings, file text (paged), one section, the outline. Line numbers are 1-based.
import path from 'node:path';
import { isMarkdown } from '../../shared/paths';
import { documentMap, findBlock, findSection, frontmatterValue, sliceLines } from '../../knowledge/sections';
import { outline } from '../../search/symbols';
import { ToolError, type ToolDef } from '../protocol';
import { READ_ONLY, etagOf, fit, folderParam, inFolder, json, ok, pathParam, takeLines, type ToolEnv } from './common';

const DEFAULT_LINES = 400;

export function readTools(env: ToolEnv): ToolDef[] {
  return [
    {
      name: 'list_folders',
      title: 'List shared folders',
      description: 'Lists the folders the user shared with you in One, with their access mode. Start here when unsure which folder to use.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ_ONLY,
      async run() {
        const folders = env.pool.list().map((f) => ({ folder: f.alias, name: path.basename(f.root), mode: f.mode === 'write' ? 'read-write' : 'read-only', index: f.indexState }));
        return ok(json({ folders, hint: folders.length ? undefined : 'No folders are shared. The user can add one in One → Settings → MCP server.' }));
      },
    },
    {
      name: 'list_files',
      title: 'List files',
      description: 'Lists files and subfolders of a folder (folders end with "/"). Paged: pass next_cursor back as cursor for more.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('Subfolder to list; leave out for the top.'),
          depth: { type: 'integer', description: 'How many levels deep: 1 (default) to 3.', minimum: 1, maximum: 3 },
          cursor: { type: 'string', description: 'next_cursor from the previous page.', maxLength: 20 },
          limit: { type: 'integer', description: 'Entries per page (default and maximum set in One; usually 100).', minimum: 1, maximum: 2000 },
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
          const page = fit(
            r.entries.slice(from, from + limit).map((e) => (e.dir ? `${e.path}/` : e.path)),
            env.limits().readChars,
          );
          const next = from + page.items.length < r.entries.length ? String(from + page.items.length) : null;
          return ok(json({ folder: f.alias, path: r.key, entries: page.items, total: r.entries.length, next_cursor: next, truncated: r.truncated || undefined }));
        }),
    },
    {
      name: 'read_file',
      title: 'Read a file',
      description: 'Reads a text file. Long files come in pages: pass next_offset_line back as offset_line. The first block is JSON about the file (etag, lines); the second is the text.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('File to read.'),
          offset_line: { type: 'integer', description: 'First line to return (1 = start of file).', minimum: 1 },
          max_lines: { type: 'integer', description: `Most lines to return (default ${DEFAULT_LINES}; the size limit set in One applies too).`, minimum: 1, maximum: 5000 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const file = await f.readText(a.path);
          const meta = { path: file.path, etag: etagOf(file), size: file.size, ...(file.encoding !== 'utf8' ? { encoding: file.encoding } : {}), ...(file.bom ? { bom: true } : {}), eol: file.eol };
          if (file.binary) return ok(json({ ...meta, binary: true, note: 'Binary file: no text to show.' }));
          const lines = file.content.split('\n');
          const from = ((a.offset_line as number | undefined) ?? 1) - 1;
          if (from > 0 && from >= lines.length) throw new ToolError('EINVAL', `offset_line is past the end (the file has ${lines.length} lines)`);
          const t = takeLines(lines, from, (a.max_lines as number | undefined) ?? DEFAULT_LINES, env.limits().readChars);
          const more = t.end < lines.length;
          return ok(json({ ...meta, lines: `${from + 1}-${t.end}`, total_lines: lines.length, next_offset_line: more ? t.end + 1 : null, truncated: more, ...(t.lineCut ? { line_cut: true } : {}) }), { type: 'text', text: t.text });
        }),
    },
    {
      name: 'read_section',
      title: 'Read one section',
      description: 'Reads one part of a Markdown note: a heading section (with its subsections), a block (^id), or a frontmatter key. Pass exactly one of heading, block, frontmatter_key.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: folderParam,
          path: pathParam('Markdown note.'),
          heading: { type: 'string', description: 'Heading text, or nested headings joined with " > " (e.g. "Plans > 2026").', maxLength: 500 },
          block: { type: 'string', description: 'Block id, with or without ^ (e.g. ^summary).', maxLength: 100 },
          frontmatter_key: { type: 'string', description: 'A key of the YAML frontmatter (e.g. status).', maxLength: 100 },
        },
        required: ['path'],
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const which = (['heading', 'block', 'frontmatter_key'] as const).filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
          if (which.length !== 1) throw new ToolError('EINVAL', 'Pass exactly one of: heading, block, frontmatter_key');
          const file = await f.readText(a.path);
          if (file.binary) throw new ToolError('EINVAL', `Binary file: ${file.path}`);
          const map = documentMap(file.content);
          const base = { path: file.path, etag: etagOf(file) };
          if (which[0] === 'frontmatter_key') {
            const v = frontmatterValue(file.content, map, a.frontmatter_key as string);
            if (!v) throw new ToolError('ENOENT', `No frontmatter key "${String(a.frontmatter_key).slice(0, 100)}" in ${file.path}${map.frontmatter?.keys.length ? `. Keys: ${map.frontmatter.keys.map((k) => k.key).join(', ')}` : ' (it has no frontmatter)'}`);
            return ok(json({ ...base, kind: 'frontmatter', key: v.key, value: v.value, start_line: v.line + 1, end_line: v.end + 1 }), { type: 'text', text: sliceLines(file.content, v.line, v.end) });
          }
          let range: { start: number; end: number; extra: Record<string, unknown> };
          if (which[0] === 'block') {
            const b = findBlock(map, a.block as string);
            if (!b) throw new ToolError('ENOENT', `No block "${String(a.block).slice(0, 100)}" in ${file.path}${map.blocks.length ? `. Blocks: ${map.blocks.slice(0, 30).map((x) => `^${x.id}`).join(', ')}` : ''}`);
            range = { start: b.start, end: b.end, extra: { kind: 'block', block: b.id } };
          } else {
            const h = findSection(map, (a.heading as string).split(' > '));
            if (!h) throw new ToolError('ENOENT', `No heading "${String(a.heading).slice(0, 200)}" in ${file.path}${map.headings.length ? `. Headings: ${map.headings.slice(0, 30).map((x) => x.text).join(' | ')}` : ' (it has no headings)'}`);
            range = { start: h.line, end: h.end, extra: { kind: 'heading', heading: h.text, level: h.level } };
          }
          const lines = file.content.split('\n');
          const t = takeLines(lines, range.start, range.end - range.start + 1, env.limits().readChars);
          const cut = t.end <= range.end;
          return ok(json({ ...base, ...range.extra, start_line: range.start + 1, end_line: range.end + 1, truncated: cut, ...(cut ? { next_offset_line: t.end + 1, hint: 'Read the rest with read_file and offset_line.' } : {}) }), { type: 'text', text: t.text });
        }),
    },
    {
      name: 'get_outline',
      title: 'Outline of a file',
      description: 'The map of a file: for Markdown its headings (with their line ranges), block ids and frontmatter keys; for code its functions and classes.',
      inputSchema: { type: 'object', properties: { folder: folderParam, path: pathParam('File.') }, required: ['path'], additionalProperties: false },
      annotations: READ_ONLY,
      run: (a) =>
        inFolder(env, a, async (f) => {
          const file = await f.readText(a.path);
          if (file.binary) throw new ToolError('EINVAL', `Binary file: ${file.path}`);
          const budget = env.limits().readChars;
          const base = { path: file.path, etag: etagOf(file), total_lines: file.content.split('\n').length };
          if (!isMarkdown(file.path)) {
            const syms = fit(outline(file.path, file.content).map((s) => ({ line: s.line + 1, kind: s.detail ?? s.kind, name: s.text })), budget);
            return ok(json({ ...base, symbols: syms.items, truncated: syms.cut || undefined }));
          }
          const map = documentMap(file.content);
          const fm = map.frontmatter ? { start_line: map.frontmatter.start + 1, end_line: map.frontmatter.end + 1, keys: map.frontmatter.keys.map((k) => k.key) } : null;
          const heads = fit(map.headings.map((h) => ({ line: h.line + 1, end_line: h.end + 1, level: h.level, text: h.text })), Math.floor(budget * 0.8));
          const blocks = fit(map.blocks.map((b) => ({ id: b.id, line: b.line + 1 })), Math.floor(budget * 0.2));
          return ok(json({ ...base, frontmatter: fm, headings: heads.items, blocks: blocks.items, truncated: heads.cut || blocks.cut || undefined }));
        }),
    },
  ];
}
