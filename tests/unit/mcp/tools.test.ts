// Tool answers through the real server object (no transport): plain-text formats, bounds and paging sized
// by the result limits, parts of a note, "unchanged" reads, outline, search modes and context, links,
// tags, related notes, the folder parameter (hidden while one folder is shared), write-scope listing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import type { McpConfig } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
let root: string;
let other: string;
let server: OneMcpServer;
const settings: Settings = { ...DEFAULT_SETTINGS, 'mcp.maxReadKB': 4, 'mcp.maxResults': 5 };
const cfg = (extra: Partial<McpConfig['folders'][number]>[] = []): McpConfig => ({
  version: 1,
  enabled: true,
  folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'read' }, ...extra.map((e, i) => ({ id: `bbbbbbb${i}`, alias: `x${i}`, path: other, mode: 'read' as const, ...e }))],
});

let id = 10;
const answers: string[] = [];
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as any;
  if (r.error) throw new Error(`rpc ${r.error.code}: ${r.error.message}`);
  for (const c of r.result.content) answers.push(c.text);
  return r.result as { content: Array<{ text: string }>; isError?: boolean };
}
/** A successful answer: always ONE text block. */
const text = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(r.content[0].text);
  expect(r.content).toHaveLength(1);
  return r.content[0].text;
};
const errorOf = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, JSON.stringify(r)).toBe(true);
  expect(r.content[0].text).not.toContain('\n'); // one line: CODE: message
  return r.content[0].text;
};
const head = (t: string) => t.split('\n')[0];
const body = (t: string) => t.slice(t.indexOf('\n') + 1);
const rows = (t: string) => t.split('\n').slice(1);
const ETAG = /etag ([\d.]+-\d+)/;
const tools = async () => ((await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/list' })) as any).result.tools as any[];

beforeAll(async () => {
  tmp = path.join(BASE, `tools-${crypto.randomBytes(4).toString('hex')}`);
  root = path.join(tmp, 'notes');
  other = path.join(tmp, 'other');
  const w = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  fs.mkdirSync(other, { recursive: true });
  w('long.md', Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`).join('\n'));
  w('huge-line.md', 'y'.repeat(10_000));
  w('crlf.md', '# CRLF\r\n\r\nwindows text\r\n');
  w('empty.md', '');
  w('bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
  w('bigsec.md', ['# Big', ...Array.from({ length: 300 }, (_, i) => `row ${i + 1} ${'z'.repeat(14)}`), '# After', 'tail'].join('\n'));
  w('code.ts', 'export function foo() {\n  return 1;\n}\nclass Bar {}\n');
  w(
    'hub.md',
    [
      '---',
      'title: Hub',
      'tags: [project, project/alpha]',
      'status: draft',
      '---',
      '# Hub',
      '',
      'Links to [[a]] and [[b]] and [[missing note]].',
      '',
      '## Plans',
      '',
      '### 2026',
      'Plan text for 2026.',
      '',
      '```md',
      '# not a heading',
      '```',
      '',
      '## Other',
      'Block paragraph line one',
      'and two ^summary',
      '',
      '- item one ^item',
      '  - child',
      '- item two',
    ].join('\n'),
  );
  w('a.md', '# A\n\nBack to [[hub]]. #project\n\nneedle here');
  w('b.md', '# B\n\nSee [[hub]] and [[a]].\n\nneedle there too');
  w('c.md', '# C\n\nAlso [[a]].\n');
  for (let i = 0; i < 12; i++) w(`many/n${String(i).padStart(2, '0')}.md`, `# Note ${i}\n\nneedle ${i}\n`);
  server = new OneMcpServer({ configDir: path.join(tmp, 'config'), settings, transport: 'stdio', win: false, indexWaitMs: 15_000 });
  server.applyConfig(cfg());
  await server.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit' } } });
});

afterAll(async () => {
  await server.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('read_file', () => {
  it('pages a long file within the size limit: summary line, raw text, the next offset', async () => {
    const t = await text('read_file', { path: 'long.md' });
    const m = /^long\.md · etag [\d.]+-\d+ · lines 1-(\d+) of 3000 · more: offset_line=(\d+)$/.exec(head(t));
    expect(m, head(t)).not.toBeNull();
    expect(Number(m![2])).toBe(Number(m![1]) + 1);
    expect(body(t).length).toBeLessThanOrEqual(4 * 1024);
    expect(body(t).split('\n')[0]).toBe(`line 1 ${'x'.repeat(20)}`);
    const n = Number(m![2]);
    const next = await text('read_file', { path: 'long.md', offset_line: n, max_lines: 3 });
    expect(head(next)).toMatch(new RegExp(`· lines ${n}-${n + 2} of 3000 · more: offset_line=${n + 3}$`));
    expect(rows(next)).toEqual([n, n + 1, n + 2].map((k) => `line ${k} ${'x'.repeat(20)}`));
  });

  it('a whole small file: "N lines", no paging hint; an empty one says so', async () => {
    expect(head(await text('read_file', { path: 'a.md' }))).toMatch(/^a\.md · etag [\d.]+-\d+ · 5 lines$/);
    expect(await text('read_file', { path: 'empty.md' })).toMatch(/^empty\.md · etag [\d.]+-\d+ · empty\n$/);
  });

  it('cuts a single line longer than the limit and says so', async () => {
    const h = head(await text('read_file', { path: 'huge-line.md' }));
    expect(h).toContain('line 1 cut at 4 kB');
    expect(h).not.toContain('more:');
  });

  it('reports an unusual EOL, never returns binary bytes, refuses offsets past the end', async () => {
    const crlf = await text('read_file', { path: 'crlf.md' });
    expect(head(crlf)).toMatch(/^crlf\.md · etag \S+ · crlf · 4 lines$/);
    expect(crlf).not.toContain('\r');
    expect(await text('read_file', { path: 'bin.dat' })).toMatch(/^bin\.dat · etag \S+ · binary: no text$/);
    expect(await errorOf('read_file', { path: 'long.md', offset_line: 99999 })).toMatch(/past the end/);
    expect(await errorOf('read_file', { path: 'many' })).toMatch(/^EISDIR/);
  });

  it('if_none_match with the current etag answers "unchanged" (one line, no text); another etag reads', async () => {
    const etag = ETAG.exec(await text('read_file', { path: 'hub.md' }))![1];
    expect(await text('read_file', { path: 'hub.md', if_none_match: etag })).toBe(`hub.md · etag ${etag} · unchanged`);
    expect(await text('read_file', { path: 'hub.md', heading: 'Plans', if_none_match: etag })).toBe(`hub.md · etag ${etag} · unchanged`);
    expect(body(await text('read_file', { path: 'hub.md', if_none_match: '1-1' }))).toContain('# Hub');
  });
});

describe('parts of a note (read_file heading / block / frontmatter_key) and the outline', () => {
  it('by nested heading, block (paragraph and list item) and frontmatter key', async () => {
    const h = await text('read_file', { path: 'hub.md', heading: 'Plans > 2026' });
    expect(head(h)).toMatch(/^hub\.md · etag \S+ · heading "2026" · lines 12-\d+ of 25$/);
    expect(body(h)).toContain('Plan text for 2026.');
    expect(body(h)).not.toContain('Other');
    expect(body(await text('read_file', { path: 'hub.md', heading: 'plans' }))).toContain('# not a heading'); // code fence stays inside
    const b = await text('read_file', { path: 'hub.md', block: '^summary' });
    expect(head(b)).toContain('block ^summary · lines 20-21 of 25');
    expect(body(b)).toBe('Block paragraph line one\nand two ^summary');
    expect(body(await text('read_file', { path: 'hub.md', block: 'item' }))).toBe('- item one ^item\n  - child');
    const fm = await text('read_file', { path: 'hub.md', frontmatter_key: 'status' });
    expect(head(fm)).toContain('frontmatter status · line 4 of 25');
    expect(body(fm)).toBe('status: draft');
    expect(await errorOf('read_file', { path: 'hub.md', heading: 'Nope' })).toMatch(/Headings: Hub \| Plans/);
    expect(await errorOf('read_file', { path: 'hub.md', heading: 'Plans', block: 'item' })).toMatch(/at most one/);
  });

  it('a section longer than the limit says where the rest is; offset_line continues inside it', async () => {
    const t = await text('read_file', { path: 'bigsec.md', heading: 'Big' });
    const m = /heading "Big" · lines 1-(\d+) of 303 · more: offset_line=(\d+) max_lines=(\d+)$/.exec(head(t));
    expect(m, head(t)).not.toBeNull();
    const rest = await text('read_file', { path: 'bigsec.md', offset_line: Number(m![2]), max_lines: Number(m![3]) });
    expect(rows(rest).at(-1)).toBe(`row 300 ${'z'.repeat(14)}`);
    const inside = await text('read_file', { path: 'bigsec.md', heading: 'Big', offset_line: 300, max_lines: 50 });
    expect(rows(inside)).toEqual([`row 299 ${'z'.repeat(14)}`, `row 300 ${'z'.repeat(14)}`]);
    expect(await errorOf('read_file', { path: 'bigsec.md', heading: 'After', offset_line: 2 })).toMatch(/outside heading "After"/);
  });

  it('get_outline: headings with ranges (not the one in a code fence), blocks, frontmatter keys; code symbols', async () => {
    const o = await text('get_outline', { path: 'hub.md' });
    expect(head(o)).toMatch(/^hub\.md · etag \S+ · 25 lines · 4 headings$/);
    expect(rows(o)[0]).toBe('frontmatter 1-5: title, tags, status');
    const heads = rows(o).filter((r) => /^\d+-\d+ #/.test(r));
    expect(heads.map((r) => r.replace(/^\d+-\d+ #+ /, ''))).toEqual(['Hub', 'Plans', '2026', 'Other']);
    expect(heads[1]).toMatch(/^10-\d+ ## Plans$/);
    expect(rows(o).at(-1)).toBe('blocks: ^summary 20-21, ^item 23-24');
    const code = await text('get_outline', { path: 'code.ts' });
    expect(rows(code)).toEqual(['1 function foo', '4 class Bar']);
  });
});

describe('list_files', () => {
  it('pages with a cursor (page = 4 × results per call), folders end with "/"', async () => {
    const top = rows(await text('list_files', {}));
    expect(top[0]).toBe('many/'); // folders first
    const p1 = await text('list_files', { path: 'many', limit: 5 });
    expect(head(p1)).toBe('many/ · 1-5 of 12 entries · more: cursor=5');
    expect(rows(p1)).toHaveLength(5);
    const p2 = await text('list_files', { path: 'many', limit: 5, cursor: '5' });
    expect(rows(p2)[0]).toBe('many/n05.md');
    const all = await text('list_files', { path: 'many' });
    expect(head(all)).toBe('many/ · 12 entries');
    const deep = await text('list_files', { depth: 2, limit: 100 });
    expect(rows(deep).length).toBeLessThanOrEqual(20);
    expect(await errorOf('list_files', { path: 'a.md' })).toMatch(/^ENOTDIR/);
    expect(await errorOf('list_files', { cursor: 'x' })).toMatch(/cursor/);
  });
});

describe('search', () => {
  it('lines mode caps files at the results limit and lines per file; the summary says what is cut', async () => {
    const t = await text('search', { query: 'needle', limit: 50, per_file: 1 });
    expect(head(t)).toBe('14 matches in 14 files · showing 5 · more: raise limit or narrow (path: ext: tag:)');
    const files = rows(t).filter((r) => !r.startsWith('  '));
    expect(files).toHaveLength(5);
    for (const r of rows(t).filter((x) => x.startsWith('  '))) expect(r).toMatch(/^ {2}\d+: .*needle/);
    expect(await errorOf('search', { query: 'x', regex: true })).toMatch(/Unknown parameter "regex"/);
    // Structured filters are not parameters: the error says where they go.
    expect(await errorOf('search', { query: 'x', path: 'notes/' })).toMatch(/Unknown parameter "path".*Filters go inside query/);
  });

  it('files mode: only paths and match counts', async () => {
    const t = await text('search', { query: 'needle path:many/', mode: 'files' });
    expect(head(t)).toBe('12 matches in 12 files · showing 5 · more: raise limit or narrow (path: ext: tag:)');
    expect(rows(t)).toHaveLength(5);
    for (const r of rows(t)) expect(r).toMatch(/^many\/n\d\d\.md \(1\)$/);
  });

  it('context: lines around each hit, grep style (N: hit, N- context)', async () => {
    const t = await text('search', { query: '"Plan text"', context: 1 });
    expect(rows(t)).toEqual(['hub.md', '  12- ### 2026', '  13: Plan text for 2026.', '  14- ']);
  });

  it('filter-only queries list files; unknown in: values come back as a note; nothing found says how to widen', async () => {
    expect(head(await text('search', { query: 'path:many/ ext:md', mode: 'files' }))).toMatch(/^12 files · showing 5/);
    expect(head(await text('search', { query: 'needle in:bogus' }))).toContain('note: Unknown in:bogus');
    expect(await text('search', { query: 'zzqqxxnothing' })).toMatch(/^No matches \(all words must appear/);
  });

  it('names and headings modes (fuzzy)', async () => {
    expect(rows(await text('search', { query: 'n03', mode: 'names' }))[0]).toBe('many/n03.md');
    expect(rows(await text('search', { query: 'plans', mode: 'headings' }))[0]).toBe('hub.md:10 ## Plans');
  });

  it('a file changed on disk shows up in the next search (watcher → index)', async () => {
    fs.writeFileSync(path.join(root, 'c.md'), '# C\n\nAlso [[a]] and a fresh zebracorn.\n');
    await expect.poll(async () => rows(await text('search', { query: 'zebracorn' }))[0], { timeout: 8000 }).toBe('c.md');
  });
});

describe('tags and links', () => {
  it('list_tags counts nested tags; notes with a tag come from search tag:', async () => {
    const t = await text('list_tags');
    expect(head(t)).toContain('search "tag:name" mode=files');
    expect(rows(t)).toContain('#project (2)');
    expect(rows(await text('search', { query: 'tag:project', mode: 'files' })).map((r) => r.replace(/ \(\d+\)$/, '')).sort()).toEqual(['a.md', 'hub.md']);
  });

  it('get_links: outgoing (missing targets say so) and backlinks with the line', async () => {
    const l = await text('get_links', { path: 'hub.md' });
    expect(head(l)).toBe('hub.md · 3 outgoing · 2 backlinks');
    expect(rows(l)).toEqual(expect.arrayContaining(['  8: a → a.md', '  8: b → b.md', '  8: missing note → missing']));
    expect(rows(l).filter((r) => /^ {2}[ab]\.md:3: /.test(r))).toHaveLength(2);
    const back = await text('get_links', { path: 'a.md', show: 'backlinks' });
    expect(back).not.toContain('outgoing');
    expect(rows(back).slice(1).map((r) => r.trim().split(':')[0]).sort()).toEqual(['b.md', 'c.md', 'hub.md']);
  });

  it('show=related: notes sharing links / tags, and notes two links away', async () => {
    const r = await text('get_links', { path: 'c.md', show: 'related' });
    expect(head(r)).toMatch(/^c\.md · \d+ related notes? · \d+ notes two links away$/);
    const rel = rows(r).slice(rows(r).indexOf('related (shared links / tags):') + 1);
    expect(rel.some((x) => x.startsWith('  hub.md'))).toBe(true);
    expect(rows(r)).toContain('two links away:');
    expect(await errorOf('get_links', { path: 'code.ts', show: 'related' })).toMatch(/Not a Markdown note/);
  });
});

describe('folder parameter, tool list', () => {
  it('is optional with one folder, required with several, and unknown names are listed', async () => {
    server.applyConfig(cfg([{}]));
    try {
      expect(await errorOf('list_files', {})).toMatch(/Several folders are shared: pass "folder" \(one of: notes, x0\)/);
      expect(await errorOf('list_files', { folder: 'nope' })).toMatch(/Unknown folder "nope". Shared folders: notes, x0/);
      expect(await text('list_files', { folder: 'x0' })).toBe('0 entries');
      const f = await text('list_folders');
      expect(rows(f)).toEqual([expect.stringMatching(/^notes · read-only · index /), expect.stringMatching(/^x0 \(other\) · read-only · index /)]);
      // Several folders: every folder-scoped tool advertises `folder`.
      for (const t of await tools()) if (t.name !== 'list_folders') expect(Object.keys(t.inputSchema.properties), t.name).toContain('folder');
    } finally {
      server.applyConfig(cfg());
    }
    // One folder: `folder` is left out of the list, and still accepted.
    for (const t of await tools()) expect(Object.keys(t.inputSchema.properties), t.name).not.toContain('folder');
    expect(head(await text('list_files', { folder: 'notes', path: 'many' }))).toBe('many/ · 12 entries');
  });

  it('a read-only server lists only read-only tools; lean schemas (no maxLength, no duplicated title)', async () => {
    const list = await tools();
    expect(list.map((t) => t.name)).toEqual(['list_folders', 'list_files', 'read_file', 'get_outline', 'search', 'list_tags', 'get_links']);
    for (const t of list) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.annotations.title).toBeUndefined(); // top-level title since 2025-06-18
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.oneOf ?? t.inputSchema.anyOf).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(20);
      for (const p of Object.values(t.inputSchema.properties) as any[]) {
        expect(p.description.length).toBeGreaterThan(5);
        expect(p.maxLength).toBeUndefined();
      }
    }
    // Still enforced, only not advertised.
    expect(await errorOf('search', { query: 'x'.repeat(501) })).toMatch(/too long/);
  });

  it('no answer carries a host path; records each call in the activity log (no content, no query)', async () => {
    for (const a of answers) expect(a).not.toContain(tmp);
    await server.audit.flush();
    const log = fs.readFileSync(path.join(tmp, 'config', 'mcp-audit.jsonl'), 'utf8');
    expect(log).toContain('"tool":"read_file"');
    expect(log).toContain('"path":"long.md"');
    expect(log).not.toContain('needle');
    expect(log).not.toContain('line 1 x');
  });
});
