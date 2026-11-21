// MCP server end to end: the official SDK client (dev dependency) starts the built server
// (`node dist/mcp/cli.mjs --stdio`, built by scripts/build-node.mjs --only mcp into .tmp/mcp/dist) on a
// temp copy of the fixture folder, and calls every tool. No browser: run with E2E_SKIP_BUILD=1 to skip
// the renderer build. SEC_EDIT_MCP_CLI=<cli.mjs> tests another build (e.g. dist/mcp/cli.mjs).
import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_WRITES_ENABLED } from '../../src/shared/mcp';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const FIXTURE = path.join(ROOT, 'tests/fixtures/workspace');
const BASE = process.env.SEC_EDIT_E2E_TMP ? path.join(process.env.SEC_EDIT_E2E_TMP, 'mcp') : path.join(ROOT, '.tmp/mcp/e2e');
let CLI = process.env.SEC_EDIT_MCP_CLI ?? '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  if (CLI) return;
  const out = path.join(ROOT, '.tmp/mcp/dist');
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-node.mjs'), '--only', 'mcp', '--outdir', out], { cwd: ROOT, stdio: 'pipe' });
  CLI = path.join(out, 'mcp/cli.mjs');
});

interface Rig {
  dir: string;
  ws: string;
  config: string;
  writeConfig(c: unknown): void;
  env: Record<string, string>;
}

async function rig(o: { enabled?: boolean; mode?: 'read' | 'write'; settings?: Record<string, unknown>; env?: Record<string, string> } = {}): Promise<Rig> {
  await fsp.mkdir(BASE, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(BASE, 'run-'));
  const ws = path.join(dir, 'workspace');
  const config = path.join(dir, 'config');
  await fsp.cp(FIXTURE, ws, { recursive: true });
  await fsp.mkdir(config, { recursive: true });
  // Things that must stay invisible: a dot folder, a key file, an excluded folder, a link out of the folder.
  await fsp.mkdir(path.join(ws, '.secret'));
  await fsp.writeFile(path.join(ws, '.secret/plan.md'), 'HIDDENWORD in a dot folder');
  await fsp.writeFile(path.join(ws, 'id_rsa'), 'HIDDENWORD key');
  await fsp.mkdir(path.join(ws, 'node_modules'));
  await fsp.writeFile(path.join(ws, 'node_modules/x.md'), 'HIDDENWORD excluded');
  await fsp.mkdir(path.join(dir, 'outside'));
  await fsp.writeFile(path.join(dir, 'outside/out.md'), 'HIDDENWORD outside');
  await fsp.symlink(path.join(dir, 'outside/out.md'), path.join(ws, 'notes/escape.md'));
  await fsp.writeFile(path.join(ws, 'notes/long.md'), Array.from({ length: 2000 }, (_, i) => `row ${i + 1}`).join('\n'));
  const writeConfig = (c: unknown) => fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify(c));
  writeConfig({ version: 1, enabled: o.enabled ?? true, folders: [{ id: 'a1b2c3d4', alias: 'fixture', path: ws, mode: o.mode ?? 'read' }] });
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ 'mcp.maxReadKB': 4, ...o.settings }));
  // HOME and XDG_DATA_HOME inside the run folder: a delete's trash can never reach the real home.
  return { dir, ws, config, writeConfig, env: { SEC_EDIT_CONFIG_DIR: config, SEC_EDIT_MCP_POLL_MS: '150', TMPDIR: path.join(dir, 'tmp'), HOME: dir, XDG_DATA_HOME: path.join(dir, 'xdg'), ...o.env } };
}

async function connect(r: Rig, args: string[] = []) {
  fs.mkdirSync(r.env.TMPDIR, { recursive: true });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio', ...args], env: { PATH: process.env.PATH ?? '', ...r.env }, stderr: 'pipe' });
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

const text = (r: any, i = 0): string => r.content[i].text;
const json = (r: any) => JSON.parse(text(r));

test.afterAll(async () => {
  await fsp.rm(BASE, { recursive: true, force: true }).catch(() => {});
});

test('every tool answers over stdio; hidden files stay hidden', async () => {
  const r = await rig();
  const { client } = await connect(r);
  try {
    expect(client.getServerVersion()?.name).toBe('one');
    expect(client.getInstructions()).toContain('search_text');
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(['list_folders', 'list_files', 'read_file', 'read_section', 'get_outline', 'search_text', 'search_files', 'search_headings', 'list_tags', 'get_links', 'get_related']);
    // Read-only folder: no write tools, and every tool says it only reads.
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
    const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });

    expect(json(await call('list_folders')).folders).toEqual([{ folder: 'fixture', name: 'workspace', mode: 'read-only', index: 'not built' }]);

    const top = json(await call('list_files', { depth: 2 }));
    expect(top.entries).toContain('notes/kubernetes.md');
    for (const p of ['.secret/', 'id_rsa', 'node_modules/', 'notes/escape.md']) expect(top.entries).not.toContain(p);

    const page = await call('read_file', { path: 'notes/long.md', max_lines: 50 });
    expect(json(page)).toMatchObject({ path: 'notes/long.md', lines: '1-50', total_lines: 2000, next_offset_line: 51, truncated: true });
    expect(text(page, 1).split('\n')).toHaveLength(50);
    const crlf = json(await call('read_file', { path: 'notes/windows-crlf.md' }));
    expect(crlf.eol).toBe('crlf');

    for (const p of ['.secret/plan.md', 'id_rsa', 'node_modules/x.md', 'notes/escape.md', '../outside/out.md', 'nope.md']) {
      const res: any = await call('read_file', { path: p });
      expect(res.isError, p).toBe(true);
      expect(text(res)).not.toContain(r.dir);
    }

    const sec = await call('read_section', { path: 'README.md', heading: 'Commands' });
    expect(text(sec, 1)).toContain('git push --force-with-lease');
    const fm = json(await call('read_section', { path: 'notes/Daily notes.md', frontmatter_key: 'tags' }));
    expect(fm.value).toEqual(['journal', 'daily']);

    const outline = json(await call('get_outline', { path: 'README.md' }));
    expect(outline.headings.map((h: any) => h.text)).toEqual(['Welcome', 'Commands']);
    const code = json(await call('get_outline', { path: 'code/app.ts' }));
    expect(code.symbols.length).toBeGreaterThan(0);

    const hits = json(await call('search_text', { query: 'needle haystack' }));
    expect(hits.results.map((x: any) => x.path)).toEqual(['deep/nested/folder/Deep note.md']);
    expect(json(await call('search_text', { query: 'HIDDENWORD' })).results).toEqual([]);
    expect(json(await call('search_text', { query: 'kubectl path:notes/' })).results[0].path).toBe('notes/kubernetes.md');

    expect(json(await call('search_files', { query: 'kube' })).results[0]).toBe('notes/kubernetes.md');
    expect(json(await call('search_headings', { query: 'cheatsheet' })).results[0]).toMatchObject({ path: 'notes/kubernetes.md', heading: 'Kubernetes cheatsheet' });

    const tags = json(await call('list_tags'));
    expect(tags.tags.map((t: any) => t.tag)).toEqual(expect.arrayContaining(['tag', 'tag/project', 'idea', 'journal', 'daily']));
    expect(json(await call('list_tags', { tag: 'journal' })).notes).toEqual(['notes/Daily notes.md']);

    const links = json(await call('get_links', { path: 'README.md' }));
    expect(links.outgoing.find((l: any) => l.target === 'Daily notes').path).toBe('notes/Daily notes.md');
    expect(links.backlinks.map((b: any) => b.from)).toEqual(['notes/Daily notes.md']);

    const rel = json(await call('get_related', { path: 'README.md' }));
    expect(rel.neighbours.map((n: any) => n.path)).toEqual(['notes/Daily notes.md']);

    // A note written outside: its backlink is there on the next call (watcher → index).
    await fsp.writeFile(path.join(r.ws, 'notes/new.md'), '# New\n\nPoints at [[README]].\n');
    await expect.poll(async () => json(await call('get_links', { path: 'README.md', direction: 'backlinks' })).backlinks.map((b: any) => b.from), { timeout: 10_000 }).toContain('notes/new.md');

    // Resources: one://<folder>/<path>
    const res = await client.listResources();
    expect(res.resources.some((x) => x.uri === 'one://fixture/notes/Daily%20notes.md')).toBe(true);
    expect(res.resources.some((x) => x.uri.includes('secret') || x.uri.includes('id_rsa'))).toBe(false);
    const doc = await client.readResource({ uri: 'one://fixture/notes/Daily%20notes.md' });
    expect((doc.contents[0] as any).text).toContain('# Daily notes');
    await expect(client.readResource({ uri: 'one://fixture/%2e%2e/outside/out.md' })).rejects.toThrow();
    expect((await client.listResourceTemplates()).resourceTemplates[0].uriTemplate).toBe('one://{folder}/{+path}');
  } finally {
    await client.close();
  }
  // The activity log: tool and path, never text or queries.
  const log = fs.readFileSync(path.join(r.config, 'mcp-audit.jsonl'), 'utf8');
  expect(log).toContain('"client":"e2e-client"');
  expect(log).toContain('"tool":"read_file"');
  expect(log).not.toContain('needle');
});

test('switched off: refuses to run, says how to turn it on', async () => {
  const r = await rig({ enabled: false });
  const child = spawn(process.execPath, [CLI, '--stdio'], { env: { PATH: process.env.PATH ?? '', ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise<number | null>((res) => child.on('exit', res));
  expect(code).toBe(1);
  expect(out).toBe('');
  expect(err).toContain('Settings → MCP server');
  await expect(connect(r)).rejects.toThrow();
});

test('switching off in One ends a running server; removing a folder updates the tool list at once', async () => {
  const r = await rig();
  await fsp.mkdir(path.join(r.dir, 'second'));
  r.writeConfig({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'fixture', path: r.ws, mode: 'read' }, { id: 'e5f6a7b8', alias: 'second', path: path.join(r.dir, 'second'), mode: 'read' }] });
  const { client, transport } = await connect(r);
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => void changed++);
  let closed = false;
  transport.onclose = () => void (closed = true);
  expect(json(await client.callTool({ name: 'list_folders', arguments: {} })).folders).toHaveLength(2);
  r.writeConfig({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'fixture', path: r.ws, mode: 'read' }] });
  await expect.poll(() => changed, { timeout: 5000 }).toBeGreaterThan(0);
  const gone: any = await client.callTool({ name: 'list_files', arguments: { folder: 'second' } });
  expect(gone.isError).toBe(true);
  expect(text(gone)).toContain('Unknown folder "second"');
  r.writeConfig({ version: 1, enabled: false, folders: [] });
  await expect.poll(() => closed, { timeout: 5000 }).toBe(true);
});

test('--folder narrows to one folder, --read-only keeps a read-write folder read-only', async () => {
  const r = await rig({ mode: 'write' });
  const { client } = await connect(r, ['--folder', 'fixture', '--read-only']);
  try {
    expect(json(await client.callTool({ name: 'list_folders', arguments: {} })).folders[0].mode).toBe('read-only');
  } finally {
    await client.close();
  }
  const bad = spawn(process.execPath, [CLI, '--stdio', '--folder', 'nope'], { env: { PATH: process.env.PATH ?? '', ...r.env } });
  expect(await new Promise((res) => bad.on('exit', res))).toBe(1);
});

test('the index is freed when the folder has been idle', async () => {
  const r = await rig({ env: { SEC_EDIT_MCP_IDLE_MS: '1200' } });
  const { client } = await connect(r);
  try {
    await client.callTool({ name: 'search_text', arguments: { query: 'kubectl' } });
    expect(json(await client.callTool({ name: 'list_folders', arguments: {} })).folders[0].index).toMatch(/^ready/);
    await expect.poll(async () => json(await client.callTool({ name: 'list_folders', arguments: {} })).folders[0].index, { timeout: 6000 }).toBe('not built');
    // …and comes back on the next search.
    expect(json(await client.callTool({ name: 'search_text', arguments: { query: 'kubectl' } })).results.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test('stdout carries JSON-RPC only, in both protocol eras', async () => {
  const r = await rig();
  const child = spawn(process.execPath, [CLI, '--stdio'], { env: { PATH: process.env.PATH ?? '', ...r.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const send = (m: unknown) => child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
  const modern = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' } };
  send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: modern } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { _meta: modern, name: 'search_text', arguments: { query: 'kubectl' } } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } } });
  send('this is not json');
  send({ jsonrpc: '2.0', id: 4, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_file', arguments: { path: '../../etc/passwd' } } });
  send({ jsonrpc: '2.0', id: 6, method: 'no/such/method' });
  await expect.poll(() => out.split('\n').filter(Boolean).length, { timeout: 15_000 }).toBe(7);
  child.stdin.end();
  await new Promise((res) => child.on('exit', res));
  const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const m of msgs) expect(m.jsonrpc).toBe('2.0');
  const by = new Map(msgs.map((m) => [m.id, m]));
  expect(by.get(1).result.supportedVersions).toContain('2026-07-28');
  expect(by.get(2).result.resultType).toBe('complete');
  expect(JSON.parse(by.get(2).result.content[0].text).results[0].path).toBe('notes/kubernetes.md');
  expect(by.get(3).error.code).toBe(-32022);
  expect(by.get(null).error.code).toBe(-32700);
  expect(by.get(4).result.protocolVersion).toBe('2025-03-26');
  expect(by.get(5).result.isError).toBe(true);
  expect(by.get(6).error.code).toBe(-32601);
});

test('this build: a read-write folder in mcp.json is still served read-only (MCP_WRITES_ENABLED off)', async () => {
  test.skip(MCP_WRITES_ENABLED, 'writes are on in this build');
  const r = await rig({ mode: 'write' });
  const { client } = await connect(r);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.some((t) => t.annotations?.readOnlyHint === false)).toBe(false);
    expect(json(await client.callTool({ name: 'list_folders', arguments: {} })).folders[0].mode).toBe('read-only');
    await expect(client.callTool({ name: 'write_file', arguments: { path: 'x.md', content: 'x' } })).rejects.toThrow(/Unknown tool/);
    expect(fs.existsSync(path.join(r.ws, 'x.md'))).toBe(false);
  } finally {
    await client.close();
  }
});

test('read-write folder: write tools edit, move and delete (to the trash inside the run folder); read-only lists none', async () => {
  test.skip(!MCP_WRITES_ENABLED, 'writes are switched off in this build (MCP_WRITES_ENABLED)');
  const r = await rig({ mode: 'write' });
  const { client } = await connect(r);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['write_file', 'append_file', 'patch_file', 'replace_text', 'move_file', 'create_folder', 'delete_file']));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res: any = await client.callTool({ name, arguments: args });
      expect(res.isError, `${name}: ${text(res)}`).toBeFalsy();
      return json(res);
    };
    const meta = json(await client.callTool({ name: 'read_file', arguments: { path: 'notes/windows-crlf.md' } }));
    await call('write_file', { path: 'notes/windows-crlf.md', content: '# Replaced\n\nby the AI\n', if_match: meta.etag });
    expect(fs.readFileSync(path.join(r.ws, 'notes/windows-crlf.md'), 'utf8')).toBe('# Replaced\r\n\r\nby the AI\r\n');
    await call('patch_file', { path: 'README.md', heading: 'Commands', operation: 'append', content: 'echo added' });
    expect(fs.readFileSync(path.join(r.ws, 'README.md'), 'utf8')).toContain('#tag/project #idea\necho added'); // the section's last line
    await call('replace_text', { path: 'notes/kubernetes.md', old: 'Get pods in all namespaces:', new: 'All pods:' });
    const moved = await call('move_file', { from: 'notes/Daily notes.md', to: 'journal/Daily notes.md' });
    expect(moved.to).toBe('journal/Daily notes.md');
    await call('create_folder', { path: 'archive' });
    const name = 'notes/kubernetes.md';
    await call('delete_file', { path: name });
    expect(fs.existsSync(path.join(r.ws, name))).toBe(false);
    // The XDG trash of this run (XDG_DATA_HOME), never the real home's.
    expect(fs.readdirSync(path.join(r.dir, 'xdg/Trash/files'))).toContain('kubernetes.md');
    expect(fs.readFileSync(path.join(r.dir, 'xdg/Trash/info/kubernetes.md.trashinfo'), 'utf8')).toContain(`Path=${encodeURI(path.join(r.ws, name))}`);
    expect(os.homedir()).not.toBe(r.dir);
    // Off limits whatever the mode.
    for (const p of ['.secret/plan.md', 'id_rsa', 'node_modules/x.md', 'notes/escape.md']) {
      const res: any = await client.callTool({ name: 'write_file', arguments: { path: p, content: 'x' } });
      expect(res.isError, p).toBe(true);
    }
    expect(fs.readFileSync(path.join(r.dir, 'outside/out.md'), 'utf8')).toBe('HIDDENWORD outside');
  } finally {
    await client.close();
  }
  const log = fs.readFileSync(path.join(r.config, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(log.find((x) => x.tool === 'write_file' && x.ok).journal).toMatch(/^[a-z0-9]+-[a-f0-9]{8}$/);
  // --read-only on the same read-write folder: no write tool at all.
  const ro = await connect(r, ['--read-only']);
  try {
    expect((await ro.client.listTools()).tools.some((t) => t.annotations?.readOnlyHint === false)).toBe(false);
  } finally {
    await ro.client.close();
  }
});

test('settings.json fails closed: broken at start → refuses to run; broken later → the last good exclusions stay', async () => {
  const r = await rig({ settings: { excludeGlobs: ['node_modules', 'notes'] } });
  const settingsFile = path.join(r.config, 'settings.json');
  const { client } = await connect(r);
  try {
    const read = async () => ((await client.callTool({ name: 'read_file', arguments: { path: 'notes/kubernetes.md' } })) as any).isError;
    expect(await read()).toBe(true);
    fs.writeFileSync(settingsFile, '{ "excludeGlobs": ["node_modules", '); // half-written / hand-broken
    await new Promise((res) => setTimeout(res, 600)); // a few polls
    expect(await read()).toBe(true); // still excluded
  } finally {
    await client.close();
  }
  const child = spawn(process.execPath, [CLI, '--stdio'], { env: { PATH: process.env.PATH ?? '', ...r.env } });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  expect(await new Promise((res) => child.on('exit', res))).toBe(1);
  expect(err).toContain('settings.json cannot be used');
});
