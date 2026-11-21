// Regression tests for the security review of the MCP server (findings 1–14 + write-phase demands),
// ported from the reviewer's repro scripts (.tmp/review-mcp/scratch/exp-*.ts) to the current source.
// Timings use wide margins (the suite runs in parallel): they catch quadratic blow-ups, not jitter.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import { McpProtocol, checkArgs, type ToolDef } from '../../../src/mcp/protocol';
import { Visibility, cleanPath, writeTypeProblem } from '../../../src/mcp/folders';
import { WriteQuota } from '../../../src/mcp/writes';
import { isPackagedCli } from '../../../src/mcp/env-boot';
import { scrubPackagedEnv } from '../../../src/main/env-guard';
import { documentMap } from '../../../src/knowledge/sections';
import { extractNote, parseFrontmatter } from '../../../src/knowledge/extract';
import { outline } from '../../../src/search/symbols';
import { parseStructure } from '../../../src/search/markdown';
import { globSearch } from '../../../src/search/engine';
import { parseQuery } from '../../../src/search/query';
import { createExcludeMatcher } from '../../../src/backend/exclude';
import { BackendService } from '../../../src/backend/service';
import { ToolError } from '../../../src/mcp/protocol';
import type { McpConfig } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const servers: OneMcpServer[] = [];
beforeAll(() => {
  tmp = path.join(BASE, `review-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const s of servers) await s.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fresh(name: string) {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function put(root: string, rel: string, text: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
}
async function make(root: string, settings: Partial<Settings> = {}, mode: 'read' | 'write' = 'read', extra: Record<string, unknown> = {}) {
  let s: Settings = { ...DEFAULT_SETTINGS, ...settings } as Settings;
  const server = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: s, transport: 'stdio', win: false, idleMs: 60_000, indexWaitMs: 8000, ...extra });
  servers.push(server);
  const cfg: McpConfig = { version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode }] };
  server.applyConfig(cfg);
  let id = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) => server.protocol.handle({ jsonrpc: '2.0', id: id++, method, params }) as Promise<any>;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'review' } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.error) return { rpcError: r.error, isError: true, head: null as any, text: '' };
    const c = r.result.content as Array<{ text: string }>;
    let head: any = c[0]?.text;
    try {
      head = JSON.parse(c[0].text);
    } catch {}
    return { isError: !!r.result.isError, head, text: c[0]?.text ?? '', body: c[1]?.text };
  };
  const setFolder = (p: Partial<McpConfig['folders'][number]>) => server.applyConfig({ ...cfg, folders: [{ ...cfg.folders[0], ...p }] });
  return { server, rpc, call, setFolder, setSettings: (p: Partial<Settings>) => server.applySettings((s = { ...s, ...p } as Settings)) };
}
const ms = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe('P1-1 ReDoS: no regex in MCP searches', () => {
  it('a catastrophic pattern is plain text: it answers at once, and the process stays responsive', async () => {
    const root = fresh('redos');
    put(root, 'notes/plain.md', '# Ordinary note\n\nThis is a perfectly normal sentence written in a note today!\n');
    const { call, rpc } = await make(root);
    await call('search', { query: 'warmup' });
    for (const q of ['/^(\\w+\\s?)+x/', '/^(\\w+\\s?)+$/', '/(a|a)*b/i']) {
      const t0 = Date.now();
      const search = call('search', { query: q });
      const pinged = rpc('ping').then(() => Date.now() - t0);
      const r = await search;
      expect(Date.now() - t0, q).toBeLessThan(2000);
      expect(await pinged).toBeLessThan(2000);
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^No matches/);
    }
    expect((await call('search', { query: 'x', regex: true })).text).toMatch(/Unknown parameter "regex"/);
  });

  it('parseQuery with noRegex keeps /…/ as text; the UI path still has regexes', () => {
    expect(parseQuery('/a+b/', { noRegex: true }).clauses[0].atoms[0]).toMatchObject({ kind: 'text', value: '/a+b/' });
    expect(parseQuery('a+', { noRegex: true, regex: true }).clauses[0].atoms[0].kind).toBe('text');
    expect(parseQuery('/a+b/').clauses[0].atoms[0].kind).toBe('regex');
  });

  it('path: / file: globs match without backtracking (same results as before)', () => {
    expect(globSearch('*.md', 'notes/a.md')).toBe(true);
    expect(globSearch('notes/*.md', 'x/notes/a.md')).toBe(true);
    expect(globSearch('notes/*.md', 'notes/sub/a.md')).toBe(false); // * stays inside one folder
    expect(globSearch('notes/**/a.md', 'notes/sub/deep/a.md')).toBe(true);
    expect(globSearch('a?c', 'xabcx')).toBe(true);
    expect(globSearch('a?c', 'a/c')).toBe(false);
    const evil = `${'*a'.repeat(12)}*b`;
    const victim = `${'a'.repeat(250)}/x.md`;
    expect(ms(() => {
      for (let i = 0; i < 2000; i++) globSearch(evil, victim);
    })).toBeLessThan(3000);
  });
});

describe('P1-2 / P1-3 super-linear parsing (shared knowledge + search code)', () => {
  it('documentMap is linear: ~100 KB of "x ^b" lines (was 7.4 s at 98 KB)', () => {
    const big = Array.from({ length: 25_000 }, () => 'x ^b').join('\n'); // ~122 KB
    expect(ms(() => documentMap(big))).toBeLessThan(1500);
    const lone = Array.from({ length: 20_000 }, () => '^b').join('\n');
    expect(ms(() => documentMap(lone))).toBeLessThan(1500);
    const items = Array.from({ length: 4_000 }, (_, i) => `${' '.repeat(i % 200)}- x ^b`).join('\n');
    expect(ms(() => documentMap(items))).toBeLessThan(1500);
  });

  it('long lines of spaces: headings, frontmatter keys, fences, PHP outline', () => {
    const sp = ' '.repeat(40_000);
    expect(ms(() => documentMap(`---\na${sp}b\n---\n`))).toBeLessThan(300);
    expect(ms(() => parseFrontmatter([`a${sp}b`]))).toBeLessThan(300);
    expect(ms(() => documentMap(`# a${sp}b\n`))).toBeLessThan(300);
    expect(ms(() => extractNote('n.md', `# a${sp}b\n${'## h '.repeat(1)}${sp}x\n`))).toBeLessThan(300);
    expect(ms(() => parseStructure('n.md', `# a${sp}b\n\`\`\`\n${sp}x\n> ${sp}x\n\`\`\`\n`))).toBeLessThan(300);
    const php = Array.from({ length: 4_000 }, () => ' '.repeat(399)).join('\n');
    expect(ms(() => outline('x.php', php))).toBeLessThan(2000);
    expect(outline('x.php', '  public static function go() {}')).toEqual([expect.objectContaining({ text: 'go', detail: 'function' })]);
  });

  it('heading parsing keeps its results (closing #s, no-space, 7 #s, long lines skipped)', () => {
    const n = extractNote('n.md', '# Title ##\n#nospace\n####### seven\n## Sub # not closing#\n   ### Indented\n#\n');
    expect(n.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Title'],
      [2, 'Sub # not closing#'],
      [3, 'Indented'],
      [1, ''],
    ]);
    expect(extractNote('n.md', `# ${'x'.repeat(10_001)}\n`).headings).toEqual([]); // over the structure cap
    expect(parseFrontmatter(['a: b', 'key :  value', 'k:v', 'tags:', '  - x'])).toEqual({ a: 'b', key: 'value', tags: ['x'] });
  });

  it('an index over a crafted 40 KB heading answers quickly (was 4.3 s blocked)', async () => {
    const root = fresh('heading-index');
    put(root, 'evil.md', `# a${' '.repeat(40_000)}b\n`);
    const { call } = await make(root);
    const t0 = Date.now();
    await call('list_tags');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('P1-4 excludes cannot leak through link aliases (links are never followed)', () => {
  it('rooted exclude docs/private + link pub → docs: nothing of it in any answer', async () => {
    const root = fresh('alias');
    put(root, 'docs/public.md', '# Public\n\nnothing here\n');
    put(root, 'docs/private/secret.md', '---\ntags: [topsecret-tag]\n---\n# Secret plan\n\nthe launch code is zebra42\n');
    fs.symlinkSync('docs', path.join(root, 'pub'), 'dir');
    const { call, rpc } = await make(root, { excludeGlobs: ['node_modules', 'docs/private'] });
    expect((await call('read_file', { path: 'docs/private/secret.md' })).isError).toBe(true);
    expect((await call('read_file', { path: 'pub/private/secret.md' })).isError).toBe(true);
    expect((await call('read_file', { path: 'pub/public.md' })).isError).toBe(true); // through a link at all
    expect((await call('list_files', { path: 'pub', depth: 2 })).isError).toBe(true);
    const entries: string[] = (await call('list_files', { depth: 3 })).text.split('\n').slice(1);
    expect(entries).toContain('docs/public.md');
    expect(entries.some((e) => e.startsWith('pub') || e.includes('private'))).toBe(false);
    const res = await rpc('resources/list', {});
    expect(res.result.resources.map((r: any) => r.uri).some((u: string) => /\/pub\/|private|secret/.test(u))).toBe(false);
    expect((await call('list_tags')).text).not.toContain('topsecret');
    const hit = (await call('search', { query: 'zebra42' })).text;
    expect(hit).toMatch(/^No matches/);
    const typo = (await call('search', { query: 'launch zebre42' })).text;
    expect(typo).not.toMatch(/zebra42|secret/i);
    expect((await call('search', { query: 'secret plan', mode: 'headings' })).text).toMatch(/^No headings match/);
    expect((await call('search', { query: 'secret', mode: 'names' })).text).toBe('No file names match');
    expect((await call('search', { query: 'tag:topsecret-tag', mode: 'files' })).text).toMatch(/^No matches/);
  });
});

describe('P1-6 / P1-7 changes during a call in flight', () => {
  it('an exclude added while a call runs applies at once, and stays applied', async () => {
    const root = fresh('busy-exclude');
    put(root, 'notes/a.md', '# A\n');
    put(root, 'private/p.md', 'EXCLUDED-CONTENT\n');
    const { server, call, setSettings } = await make(root, { excludeGlobs: ['node_modules'] });
    expect((await call('read_file', { path: 'private/p.md' })).isError).toBe(false);
    await call('search', { query: 'EXCLUDED' });
    const f = server.pool.list()[0];
    let release!: () => void;
    const slow = f.use(() => new Promise<void>((r) => (release = r)));
    setSettings({ excludeGlobs: ['node_modules', 'private'] });
    expect((await call('read_file', { path: 'private/p.md' })).text).toMatch(/^ENOENT/); // while the other call still runs
    expect((await call('search', { query: 'EXCLUDED-CONTENT' })).text).toMatch(/^No matches/);
    release();
    await slow;
    for (let i = 0; i < 3; i++) await call('list_files', {});
    expect((await call('read_file', { path: 'private/p.md' })).text).toMatch(/^ENOENT/);
  });

  it('a folder removed mid-call is not read any more, and does not wake again', async () => {
    const root = fresh('removed');
    put(root, 'notes/a.md', 'STILL-READABLE\n');
    const { server } = await make(root);
    const f = server.pool.list()[0];
    const r = await f
      .use(async () => {
        server.applyConfig({ version: 1, enabled: true, folders: [] });
        await new Promise((res) => setTimeout(res, 20));
        return f.readText('notes/a.md').then((t) => `READ OK: ${t.content.trim()}`, (e) => `refused: ${e.message}`);
      })
      .catch((e) => `refused: ${e.message}`);
    expect(r).toMatch(/^refused: The folder "notes" is no longer shared/);
    expect(f.isWarm).toBe(false);
  });
});

describe('P2-8 exclude patterns with globs', () => {
  it('**/secrets, private/*.md and docs/**/drafts hide what they say (and only that)', () => {
    const m = createExcludeMatcher(['**/secrets', 'private/*.md', 'docs/**/drafts', 'Build'], false);
    for (const p of ['secrets', 'a/secrets/b.md', 'a/b/SECRETS', 'private/x.md', 'private/x.md/inner', 'docs/drafts/a.md', 'docs/a/b/drafts', 'x/build/y']) expect(m.path(p), p).toBe(true);
    for (const p of ['private/x.txt', 'private/sub/x.md', 'mysecrets/a.md', 'docs/a.md', 'a/private/x.md']) expect(m.path(p), p).toBe(false);
    // No backtracking blow-up on crafted names.
    const g = createExcludeMatcher([`${'*a'.repeat(15)}*b`, `${'**/'.repeat(10)}x`], false);
    expect(ms(() => g.path(`${'a/'.repeat(30)}${'a'.repeat(200)}`))).toBeLessThan(500);
  });
});

describe('P2-9 resources/list paging across folders', () => {
  it('every file exactly once', async () => {
    const a = fresh('res-a');
    const b = fresh('res-b');
    for (let i = 0; i < 50; i++) put(a, `a${String(i).padStart(3, '0')}.md`, 'x');
    for (let i = 0; i < 500; i++) put(b, `b${String(i).padStart(3, '0')}.md`, 'x');
    const { server, rpc } = await make(a);
    server.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'a', path: a, mode: 'read' }, { id: 'bbbbbbbb', alias: 'b', path: b, mode: 'read' }] });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await rpc('resources/list', cursor ? { cursor } : {});
      seen.push(...r.result.resources.map((x: any) => x.uri));
      cursor = r.result.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    expect(new Set(seen).size).toBe(550);
    expect(seen.length).toBe(550);
  });
});

describe('P2-10 / P2-12 protocol limits', () => {
  it('at most 4 tool calls run at once; batches are refused', async () => {
    let running = 0;
    let peak = 0;
    const slow: ToolDef = {
      name: 'slow',
      title: 's',
      description: 'slow tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
    };
    const p = new McpProtocol({ info: { name: 'one', version: '1' }, instructions: '', tools: () => [slow] });
    await p.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) => p.handle({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name: 'slow' } }) as Promise<any>));
    expect(all.every((r) => r.result.content[0].text === 'ok')).toBe(true);
    expect(peak).toBe(4);
    expect(((await p.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }])) as any).error.message).toMatch(/Batches/);
  });

  it('"constructor" / "__proto__" are not parameters', () => {
    const schema = { type: 'object' as const, properties: { a: { type: 'string' as const, description: 'a' } }, additionalProperties: false as const };
    expect(() => checkArgs(schema, { constructor: 1 } as any)).toThrow(/Unknown parameter "constructor"/);
    expect(() => checkArgs(schema, JSON.parse('{"__proto__": 1}'))).toThrow(/Unknown parameter "__proto__"/);
  });
});

describe('P2-11 / P2-13 / P2-14 names, short names, grants, One’s data folder', () => {
  it('more key files are hidden, with or without any setting', () => {
    const v = new Visibility([]); // no user excludes at all: the built-in rules still hold
    for (const p of ['x.p8', 'id_xmss', 'backup.kdb', 'host.keytab', 'secring.gpg', 'mail.gpg', 'wallet.dat', 'prod.tfstate', 'prod.tfstate.backup', '.env', 'id_rsa', '.git/config']) expect(v.hidden(p), p).toBe(true);
  });

  it('Windows rules refuse 8.3 short names', () => {
    for (const p of ['GIT~1/config', 'GIT~1/hooks/pre-commit', 'ID_RSA~1', 'PRIVAT~1/x.md', 'NOTES~1.MD']) expect(() => cleanPath(p, { win: true }), p).toThrow(ToolError);
    expect(cleanPath('a~b.md', { win: true })).toBe('a~b.md');
  });

  it('the server re-checks every mcp.json entry: no drive root, home folder or app data folder', async () => {
    const home = fresh('home');
    const inside = fresh('home/notes');
    const { server, call } = await make(inside, {}, 'read', { homedir: home });
    server.applyConfig({
      version: 1,
      enabled: true,
      folders: [
        { id: 'aaaaaaaa', alias: 'root', path: '/', mode: 'write' },
        { id: 'bbbbbbbb', alias: 'home', path: home, mode: 'write' },
        { id: 'cccccccc', alias: 'appdata', path: path.join(tmp, 'cfg'), mode: 'write' },
        { id: 'dddddddd', alias: 'around', path: tmp, mode: 'write' },
        { id: 'eeeeeeee', alias: 'notes', path: inside, mode: 'read' },
      ],
    });
    expect((await call('list_folders')).text.split('\n').slice(1).map((r) => r.split(' ')[0])).toEqual(['notes']);
  });

  it('file RPCs never reach One’s data folder, even inside the open folder (desktop and browser mode)', async () => {
    const root = fresh('home-like');
    const configDir = path.join(root, 'AppData', 'sec-edit');
    put(root, 'AppData/sec-edit/settings.json', '{}');
    put(root, 'AppData/other/x.md', 'fine');
    put(root, 'notes/a.md', 'a');
    const svc = new BackendService(configDir, {}, { cacheDir: '' });
    await svc.openWorkspace(root);
    const ws = svc.workspace!;
    const tree = await ws.listTree();
    const names = JSON.stringify(tree);
    expect(names).toContain('other');
    expect(names).not.toContain('sec-edit');
    for (const p of ['AppData/sec-edit/settings.json', 'AppData/sec-edit/mcp.json', 'AppData/sec-edit/vault.json']) {
      await expect(ws.readFile(p), p).rejects.toMatchObject({ code: 'EACCES' });
      await expect(ws.writeFile(p, '{"enabled":true}'), p).rejects.toMatchObject({ code: 'EACCES' });
    }
    await expect(ws.rename('notes/a.md', 'AppData/sec-edit/a.md')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(ws.remove('AppData/sec-edit/settings.json')).rejects.toMatchObject({ code: 'EACCES' });
    expect((await ws.readFile('AppData/other/x.md')).content).toBe('fine');
    expect(fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8')).toBe('{}');
    svc.dispose();
  });
});

describe('write phase: links, types, placeholders, quota, writable check, packaged env', () => {
  let root: string;
  let t: Awaited<ReturnType<typeof make>>;
  beforeAll(async () => {
    root = fresh('write-rules');
    put(root, 'notes/a.md', 'alpha\n');
    put(root, 'notes/vars.md', 'run `ssh {{host}}`\n');
    put(root, 'conf.json', '{}');
    fs.mkdirSync(path.join(root, '.git/hooks'), { recursive: true });
    fs.symlinkSync('a.md', path.join(root, 'notes/alias.md'));
    fs.symlinkSync('notes', path.join(root, 'linkdir'), 'dir');
    t = await make(root, {}, 'write', { quota: new WriteQuota({ session: 1000, perMinute: 1000 }), trash: async () => {}, writes: true });
  });

  it('no writes through links, neither a link file nor a linked folder', async () => {
    // One neutral refusal for every "where" (hidden, excluded, a link, a hard link).
    expect((await t.call('write_file', { path: 'notes/alias.md', content: 'x', if_match: '1-1' })).text).toBe('EACCES: Cannot change notes/alias.md');
    expect((await t.call('write_file', { path: 'linkdir/new.md', content: 'x' })).text).toBe('EACCES: Cannot change linkdir/new.md');
    expect((await t.call('append_file', { path: 'linkdir/a.md', content: 'x' })).text).toBe('EACCES: Cannot change linkdir/a.md');
    expect(fs.readFileSync(path.join(root, 'notes/a.md'), 'utf8')).toBe('alpha\n');
  });

  it('a file swapped for a link (to .git/hooks) after the check is refused at commit', async () => {
    const f = t.server.pool.list()[0];
    put(root, 'notes/victim.md', 'v');
    const target = await f.use(() => f.resolveTarget('notes/victim.md', { kind: 'file', exists: 'must' }));
    fs.rmSync(path.join(root, 'notes/victim.md'));
    fs.symlinkSync(path.join(root, '.git/hooks/pre-commit'), path.join(root, 'notes/victim.md'));
    const ws = await f.workspace();
    await expect(ws.writeFile(target.key, '#!/bin/sh\nevil', {}, f.guard())).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    expect(fs.existsSync(path.join(root, '.git/hooks/pre-commit'))).toBe(false);
  });

  it('the writable check runs again at commit (mode flipped to read-only mid-call)', async () => {
    const f = t.server.pool.list()[0];
    const target = await f.use(() => f.resolveTarget('notes/later.md', { kind: 'file', exists: 'mustNot' }));
    f.mode = 'read';
    try {
      const ws = await f.workspace();
      await expect(ws.createFile(target.key, 'x', f.guard({ expect: 'absent' }))).rejects.toMatchObject({ code: 'EREADONLY' });
    } finally {
      f.mode = 'write';
    }
    expect(fs.existsSync(path.join(root, 'notes/later.md'))).toBe(false);
  });

  it('file types: notes only by default; code with the folder grant (mcp.json); scripts and shortcuts never', async () => {
    expect((await t.call('write_file', { path: 'new.json', content: '{}' })).text).toMatch(/only notes/);
    t.setSettings({ 'mcp.allowCode': true } as Partial<Settings>); // the old settings key widens nothing
    expect((await t.call('write_file', { path: 'new.json', content: '{}' })).text).toMatch(/only notes/);
    t.setFolder({ allowCode: true });
    expect((await t.call('write_file', { path: 'new.json', content: '{}' })).isError).toBe(false);
    for (const p of ['x.bat', 'x.cmd', 'x.ps1', 'x.lnk', 'x.url', 'x.vbs', 'x.reg', 'desktop.ini', 'autorun.inf', 'x.desktop', 'x.js', 'x.py', 'x.pyw']) expect((await t.call('write_file', { path: p, content: 'x' })).text, p).toMatch(/never written/);
    t.setFolder({ allowCode: false });
    expect(writeTypeProblem('a/b.MD', false)).toBeNull();
    expect(writeTypeProblem('Notes.TXT', false)).toBeNull();
    expect(writeTypeProblem('x.ts', true)).toBeNull();
    expect(writeTypeProblem('x.ps1', true)).toMatch(/never/);
  });

  it('{{placeholders}}: with no variables file every name but the built-ins is secret, note-wide (prose too)', async () => {
    expect((await t.call('write_file', { path: 'notes/new-cmd.md', content: 'curl https://x/?k={{api_key}} in prose' })).text).toMatch(/^ESECRET: .*no variables file/);
    expect((await t.call('append_file', { path: 'notes/vars.md', content: 'also `scp f {{host}}:`' })).text).toMatch(/^ESECRET/); // inline code too
    expect((await t.call('append_file', { path: 'notes/vars.md', content: '```sh\nscp f {{host}}:\n```' })).text).toMatch(/^ESECRET: .*no variables file/);
    expect((await t.call('append_file', { path: 'notes/vars.md', content: '```vue\n<p>{{ title }}</p>\n```' })).text).toMatch(/^ESECRET: .*right next to/); // right below a secret line
    expect((await t.call('append_file', { path: 'notes/a.md', content: '```vue\n<p>{{ title }}</p>\n```' })).isError).toBe(false); // built-ins
    expect((await t.call('replace_text', { path: 'notes/vars.md', old: 'run', new: 'start' })).text).toMatch(/^ESECRET/); // its line holds {{host}}
  });

  it('a per-session write quota (count and rate)', () => {
    let now = 0;
    const q = new WriteQuota({ session: 3, perMinute: 2 }, () => now);
    q.take();
    q.take();
    expect(() => q.take()).toThrow(/in a minute/);
    now += 61_000;
    q.take();
    expect(() => q.take()).toThrow(/limit of 3/);
  });

  it('packaged builds: the CLI drops SEC_EDIT_* test hooks (SEC_EDIT_TRASH_DIR, SEC_EDIT_CONFIG_DIR…)', () => {
    expect(isPackagedCli('C:\\Apps\\One\\resources\\app.asar.unpacked\\dist\\mcp\\cli.mjs')).toBe(true);
    expect(isPackagedCli('/opt/one/resources/app.asar.unpacked/dist/mcp/cli.mjs')).toBe(true);
    expect(isPackagedCli('/home/u/sec-edit/dist/mcp/cli.mjs')).toBe(false);
    const env: NodeJS.ProcessEnv = { SEC_EDIT_TRASH_DIR: '/x', SEC_EDIT_CONFIG_DIR: '/y', SEC_EDIT_MCP_POLL_MS: '1', SEC_EDIT_TIMINGS: '1', PATH: '/bin' };
    scrubPackagedEnv(env);
    expect(env).toEqual({ SEC_EDIT_TIMINGS: '1', PATH: '/bin' });
  });
});
