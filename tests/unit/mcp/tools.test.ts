// Tool answers through the real server object (no transport): bounds and paging sized by the result
// limits, sections, outline, links, tags, related notes, the folder parameter, write-scope listing.
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
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as any;
  if (r.error) throw new Error(`rpc ${r.error.code}: ${r.error.message}`);
  return r.result as { content: Array<{ text: string }>; isError?: boolean };
}
const data = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call(name, args);
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
};
const errorOf = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, JSON.stringify(r)).toBe(true);
  return r.content[0].text;
};

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
  w('bin.dat', Buffer.from([0, 1, 2, 3, 0, 255]).toString('latin1'));
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
  it('pages a long file within the size limit and hands back the next offset', async () => {
    const r = await call('read_file', { path: 'long.md' });
    const meta = JSON.parse(r.content[0].text);
    expect(r.content[1].text.length).toBeLessThanOrEqual(4 * 1024);
    expect(meta.total_lines).toBe(3000);
    expect(meta.truncated).toBe(true);
    expect(meta.next_offset_line).toBeGreaterThan(1);
    expect(meta.etag).toMatch(/^[\d.]+-\d+$/);
    const next = await call('read_file', { path: 'long.md', offset_line: meta.next_offset_line, max_lines: 3 });
    expect(next.content[1].text.split('\n')[0]).toBe(`line ${meta.next_offset_line} ${'x'.repeat(20)}`);
    expect(JSON.parse(next.content[0].text).lines).toBe(`${meta.next_offset_line}-${meta.next_offset_line + 2}`);
  });

  it('cuts a single line longer than the limit and says so', async () => {
    const meta = JSON.parse((await call('read_file', { path: 'huge-line.md' })).content[0].text);
    expect(meta.line_cut).toBe(true);
    expect(meta.next_offset_line).toBeNull();
  });

  it('reports EOL, never returns binary bytes, refuses offsets past the end', async () => {
    const crlf = await call('read_file', { path: 'crlf.md' });
    expect(JSON.parse(crlf.content[0].text).eol).toBe('crlf');
    expect(crlf.content[1].text).not.toContain('\r');
    const bin = await data('read_file', { path: 'bin.dat' });
    expect(bin.binary).toBe(true);
    expect(await errorOf('read_file', { path: 'long.md', offset_line: 99999 })).toMatch(/past the end/);
    expect(await errorOf('read_file', { path: 'many' })).toMatch(/^EISDIR/);
  });
});

describe('list_files', () => {
  it('pages with a cursor (page = 4 × results per call), folders end with "/"', async () => {
    const top = await data('list_files', {});
    expect(top.entries).toContain('many/');
    expect(top.entries.indexOf('many/')).toBe(0); // folders first
    const p1 = await data('list_files', { path: 'many', limit: 5 });
    expect(p1.entries).toHaveLength(5);
    expect(p1.total).toBe(12);
    const p2 = await data('list_files', { path: 'many', limit: 5, cursor: p1.next_cursor });
    expect(p2.entries[0]).toBe('many/n05.md');
    const all = await data('list_files', { path: 'many' });
    expect(all.entries).toHaveLength(12); // under the 20-entry cap
    const deep = await data('list_files', { depth: 2, limit: 100 });
    expect(deep.entries.length).toBeLessThanOrEqual(20);
    expect(await errorOf('list_files', { path: 'a.md' })).toMatch(/^ENOTDIR/);
    expect(await errorOf('list_files', { cursor: 'x' })).toMatch(/cursor/);
  });
});

describe('sections and outline', () => {
  it('read_section by nested heading, block (paragraph and list item) and frontmatter key', async () => {
    const h = await call('read_section', { path: 'hub.md', heading: 'Plans > 2026' });
    expect(JSON.parse(h.content[0].text)).toMatchObject({ kind: 'heading', heading: '2026', level: 3, start_line: 12 });
    expect(h.content[1].text).toContain('Plan text for 2026.');
    expect(h.content[1].text).not.toContain('Other');
    const plans = await call('read_section', { path: 'hub.md', heading: 'plans' });
    expect(plans.content[1].text).toContain('# not a heading'); // code fence stays inside the section
    const b = await call('read_section', { path: 'hub.md', block: '^summary' });
    expect(b.content[1].text).toBe('Block paragraph line one\nand two ^summary');
    const li = await call('read_section', { path: 'hub.md', block: 'item' });
    expect(li.content[1].text).toBe('- item one ^item\n  - child');
    const fm = await data('read_section', { path: 'hub.md', frontmatter_key: 'status' });
    expect(fm.value).toBe('draft');
    expect(await errorOf('read_section', { path: 'hub.md', heading: 'Nope' })).toMatch(/Headings: Hub \| Plans/);
    expect(await errorOf('read_section', { path: 'hub.md' })).toMatch(/exactly one/);
  });

  it('get_outline: headings with ranges (not the one in a code fence), blocks, frontmatter keys', async () => {
    const o = await data('get_outline', { path: 'hub.md' });
    expect(o.headings.map((h: any) => h.text)).toEqual(['Hub', 'Plans', '2026', 'Other']);
    expect(o.headings[1]).toMatchObject({ line: 10, level: 2 });
    expect(o.blocks.map((b: any) => b.id)).toEqual(['summary', 'item']);
    expect(o.frontmatter.keys).toEqual(['title', 'tags', 'status']);
  });
});

describe('search, tags, links, related', () => {
  it('search_text caps files at the results limit and lines per file', async () => {
    const r = await data('search_text', { query: 'needle', limit: 50, per_file: 1 });
    expect(r.results.length).toBe(5);
    expect(r.total_files).toBe(14);
    expect(r.truncated).toBe(true);
    expect(r.results[0].matches).toHaveLength(1);
    expect(r.results[0].matches[0].line).toBeGreaterThan(0);
    expect(await errorOf('search_text', { query: 'x', regex: true })).toMatch(/Unknown parameter "regex"/);
  });

  it('search_files and search_headings', async () => {
    expect((await data('search_files', { query: 'n03' })).results[0]).toBe('many/n03.md');
    const h = await data('search_headings', { query: 'plans' });
    expect(h.results[0]).toMatchObject({ path: 'hub.md', heading: 'Plans', line: 10 });
  });

  it('list_tags counts nested tags and lists notes for one tag', async () => {
    const t = await data('list_tags');
    expect(t.tags.find((x: any) => x.tag === 'project').count).toBe(2);
    expect((await data('list_tags', { tag: '#project' })).notes.sort()).toEqual(['a.md', 'hub.md']);
  });

  it('get_links: outgoing (unresolved = null) and backlinks with the line', async () => {
    const l = await data('get_links', { path: 'hub.md' });
    expect(l.outgoing.map((o: any) => [o.target, o.path])).toEqual([
      ['a', 'a.md'],
      ['b', 'b.md'],
      ['missing note', null],
    ]);
    expect(l.backlinks.map((b: any) => b.from).sort()).toEqual(['a.md', 'b.md']);
    expect(l.backlinks[0].line).toBe(3);
    const back = await data('get_links', { path: 'a.md', direction: 'backlinks' });
    expect(back.outgoing).toBeUndefined();
    expect(back.backlinks.map((b: any) => b.from).sort()).toEqual(['b.md', 'c.md', 'hub.md']);
  });

  it('get_related: neighbours and co-cited notes', async () => {
    const r = await data('get_related', { path: 'c.md' });
    expect(r.neighbours.map((n: any) => n.path)).toEqual(['a.md']);
    expect(r.related.map((x: any) => x.path)).toContain('hub.md');
    const two = await data('get_related', { path: 'c.md', depth: 2 });
    expect(two.neighbours.some((n: any) => n.hop === 2)).toBe(true);
  });

  it('a file changed on disk shows up in the next search (watcher → index)', async () => {
    fs.writeFileSync(path.join(root, 'c.md'), '# C\n\nAlso [[a]] and a fresh zebracorn.\n');
    await expect.poll(async () => (await data('search_text', { query: 'zebracorn' })).results.length, { timeout: 8000 }).toBe(1);
  });
});

describe('folder parameter, scope', () => {
  it('is optional with one folder, required with several, and unknown names are listed', async () => {
    server.applyConfig(cfg([{}]));
    expect(await errorOf('list_files', {})).toMatch(/Several folders are shared: pass "folder" \(one of: notes, x0\)/);
    expect(await errorOf('list_files', { folder: 'nope' })).toMatch(/Unknown folder "nope". Shared folders: notes, x0/);
    expect((await data('list_files', { folder: 'x0' })).entries).toEqual([]);
    const folders = await data('list_folders');
    expect(folders.folders.map((f: any) => [f.folder, f.mode])).toEqual([
      ['notes', 'read-only'],
      ['x0', 'read-only'],
    ]);
    server.applyConfig(cfg());
  });

  it('a read-only server lists only read-only tools (annotations say so)', async () => {
    const r = (await server.protocol.handle({ jsonrpc: '2.0', id: 99, method: 'tools/list' })) as any;
    const names = r.result.tools.map((t: any) => t.name);
    expect(names).toEqual(['list_folders', 'list_files', 'read_file', 'read_section', 'get_outline', 'search_text', 'search_files', 'search_headings', 'list_tags', 'get_links', 'get_related']);
    for (const t of r.result.tools) {
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.inputSchema.oneOf ?? t.inputSchema.anyOf).toBeUndefined();
      expect(t.description.length).toBeGreaterThan(20);
      for (const p of Object.values(t.inputSchema.properties) as any[]) expect(p.description.length).toBeGreaterThan(5);
    }
  });

  it('records each call in the activity log (no content, no query)', async () => {
    await server.audit.flush();
    const log = fs.readFileSync(path.join(tmp, 'config', 'mcp-audit.jsonl'), 'utf8');
    expect(log).toContain('"tool":"read_file"');
    expect(log).toContain('"path":"long.md"');
    expect(log).not.toContain('needle');
    expect(log).not.toContain('line 1 x');
  });
});
