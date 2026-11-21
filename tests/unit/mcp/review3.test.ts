// Security re-check, round 3 (part 1), ported from .tmp/review-mcp/scratch2/exp-*.ts to the live source:
// inline-code ReDoS, One's data folder leaking into the index (watcher, links, on-request reads), hard
// links, grant re-check on the real path, and the read-only gate of this build (MCP_WRITES_ENABLED).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { MCP_WRITES_ENABLED } from '../../../src/shared/mcp';
import { OneMcpServer } from '../../../src/mcp/server';
import { Workspace } from '../../../src/backend/workspace';
import { extractNote, maskInlineCode } from '../../../src/knowledge/extract';
import { documentMap } from '../../../src/knowledge/sections';
import { inlineSpans, parseStructure } from '../../../src/search/markdown';
import { blankCodeSpans, codeSpans } from '../../../src/shared/markdown-lines';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `review3-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const fresh = (name: string) => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const put = (root: string, rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const ms = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

async function server(root: string, mode: 'read' | 'write', extra: Record<string, unknown> = {}) {
  const s = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, ...extra });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode }] });
  let id = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) => s.protocol.handle({ jsonrpc: '2.0', id: id++, method, params }) as Promise<any>;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'review3' } });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    if (r.error) return { rpc: r.error.code as number, isError: true, text: r.error.message as string, head: null as any };
    const t = r.result.content[0].text as string;
    let head: any = t;
    try {
      head = JSON.parse(t);
    } catch {}
    return { isError: !!r.result.isError, text: t, head, body: r.result.content[1]?.text as string | undefined };
  };
  return { s, rpc, call };
}

describe('1. inline code: linear code-span scan (knowledge + search)', () => {
  // Runs of 1, 2, 3 … k backticks separated by "x": no run has a partner of the same length.
  const runs = (k: number) => Array.from({ length: k }, (_, i) => '`'.repeat(i + 1)).join('x');

  it('the code-span table keeps the CommonMark rule', () => {
    expect(codeSpans('a `b` c')).toEqual([[2, 5]]);
    expect(codeSpans('`a``b`')).toEqual([[0, 6]]); // a run of another length stays inside
    expect(codeSpans('``a`b``')).toEqual([[0, 7]]);
    expect(codeSpans('`open and ``x`` only')).toEqual([[10, 15]]); // an unclosed run is literal
    expect(blankCodeSpans('see `[[x]]` and [[y]]')).toBe('see         and [[y]]');
    expect(maskInlineCode('#tag `#not`')).toBe('#tag       ');
    expect(extractNote('a.md', 'a [[real]] `[[code]]` #t `#c`').links.map((l) => l.target)).toEqual(['real']);
  });

  it('a 314 KB line of backtick runs (was 2.9 s, documentMap 5.9 s) and other crafted lines answer fast', () => {
    const line = runs(800);
    expect(line.length).toBeGreaterThan(300_000);
    expect(ms(() => codeSpans(line))).toBeLessThan(200);
    expect(ms(() => documentMap(line))).toBeLessThan(1000);
    expect(ms(() => extractNote('a.md', runs(400)))).toBeLessThan(500);
    expect(ms(() => parseStructure('a.md', `#t ${'`'.repeat(40_000)}x\``))).toBeLessThan(500);
    expect(ms(() => inlineSpans(runs(400)))).toBeLessThan(500);
    // Linear growth: 4× the input stays well under the 16× of a quadratic scan.
    const small = runs(200);
    const big = runs(400);
    const t1 = Math.max(1, ms(() => { for (let i = 0; i < 20; i++) codeSpans(small); }));
    const t2 = ms(() => { for (let i = 0; i < 20; i++) codeSpans(big); });
    expect(t2 / t1).toBeLessThan(10);
  });
});

describe("2. One's data folder never enters the desktop index", () => {
  it('saves inside the denied folder, seen by a recursive watcher, stay out of the listing and the index', async () => {
    const root = fresh('deny-watch');
    const appdata = path.join(root, 'AppData', 'Roaming', 'sec-edit');
    put(appdata, 'settings.json', '{"v":0}');
    put(root, 'notes/a.md', 'hello\n');
    const ws = new Workspace(root, { exclude: ['node_modules'], showHidden: false, deny: [appdata], warmIndexer: false, readThreads: 0, caseSensitive: true, watchMode: 'recursive', debounceMs: 50 });
    cleanup.push(() => ws.dispose());
    const seen: string[] = [];
    ws.onEvents((e) => e.forEach((x) => seen.push(`${x.type} ${x.path}`)));
    await ws.listTree();
    for (let i = 1; i <= 3; i++) {
      fs.writeFileSync(path.join(appdata, 'settings.json'), `{"v":${i},"token":"DENIED-CONTENT"}`);
      await sleep(250);
    }
    put(root, 'notes/b.md', 'new note'); // the watcher does work
    await sleep(400);
    await ws.settle();
    expect(seen.some((e) => e.includes('AppData'))).toBe(false);
    expect(seen).toContain('add notes/b.md');
    expect(ws.filePaths().some((p) => p.includes('AppData'))).toBe(false);
    const r = await ws.readIndexedFiles(['AppData/Roaming/sec-edit/settings.json']);
    expect(r.files).toEqual([]);
    expect(r.gone).toContain('AppData/Roaming/sec-edit/settings.json');
  });

  it('links into the denied folder are not listed, not read in bulk, not read on request', async () => {
    const root = fresh('deny-link');
    const appdata = path.join(root, 'AppData', 'Roaming', 'sec-edit');
    put(appdata, 'settings.json', '{"secretSetting":"DENIED-CONTENT"}');
    put(root, 'notes/a.md', 'hello\n');
    fs.symlinkSync('../AppData/Roaming/sec-edit/settings.json', path.join(root, 'notes/s.json'));
    fs.symlinkSync('../AppData/Roaming/sec-edit', path.join(root, 'notes/data'), 'dir');
    const ws = new Workspace(root, { exclude: ['node_modules'], showHidden: false, deny: [appdata], warmIndexer: false, readThreads: 0, caseSensitive: true });
    cleanup.push(() => ws.dispose());
    await ws.listTree();
    expect(ws.filePaths().sort()).toEqual(['notes/a.md']);
    const page = await ws.readAllTextPage({});
    expect(page.files.some((f) => f.content.includes('DENIED'))).toBe(false);
    await expect(ws.readFile('notes/s.json')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(ws.readFile('notes/data/settings.json')).rejects.toMatchObject({ code: 'EACCES' });
    const r = await ws.readIndexedFiles(['notes/s.json', 'notes/data/settings.json']);
    expect(r.files).toEqual([]);
  });
});

describe('3. hard links are not served', () => {
  it('a hard link inside the folder to an outside file: not readable, not searchable, not a write target', async () => {
    const root = fresh('hard');
    const outside = fresh('hard-outside');
    put(outside, 'hard.md', 'OUTSIDE-HARDLINK-CONTENT\n');
    put(root, 'notes/a.md', '# A\n');
    fs.linkSync(path.join(outside, 'hard.md'), path.join(root, 'notes/hard.md'));
    const { call, s } = await server(root, 'read');
    expect((await call('read_file', { path: 'notes/hard.md' })).text).toBe('ENOENT: Not found: notes/hard.md');
    expect((await call('search_text', { query: 'OUTSIDE-HARDLINK-CONTENT' })).head.total_files).toBe(0);
    const f = s.pool.list()[0];
    await expect(f.use(() => f.resolveTarget('notes/hard.md', { kind: 'file', exists: 'must' }))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('4. grant re-check on the real path', () => {
  it('an mcp.json entry that is a link to the home folder is not served (direct or via link)', async () => {
    const home = fresh('fakehome');
    put(home, 'Documents/private-letter.md', 'HOME-LEVEL FILE\n');
    const link = path.join(tmp, 'homelink');
    fs.symlinkSync(home, link, 'dir');
    const s = new OneMcpServer({ configDir: path.join(tmp, 'cfg'), settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, homedir: home });
    cleanup.push(() => s.dispose());
    s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'direct', path: home, mode: 'read' }, { id: 'bbbbbbbb', alias: 'vialink', path: link, mode: 'read' }] });
    expect(s.pool.list().map((f) => f.alias)).toEqual([]);
  });
});

describe('5. this build ships read-only (MCP_WRITES_ENABLED)', () => {
  it('a folder set to write in mcp.json is served read-only; no write tool is listed or callable', async () => {
    const root = fresh('gate');
    put(root, 'a.md', 'a\n');
    const { call, rpc } = await server(root, 'write'); // no `writes` override: the build's default
    const tools: string[] = (await rpc('tools/list')).result.tools.map((t: any) => t.name);
    const folders = (await call('list_folders')).head.folders;
    if (MCP_WRITES_ENABLED) {
      expect(tools).toContain('write_file');
      return;
    }
    expect(tools.some((n) => /^(write|append|patch|replace|move|create|delete)_/.test(n))).toBe(false);
    expect(folders[0].mode).toBe('read-only');
    expect((await call('write_file', { path: 'b.md', content: 'x' })).rpc).toBe(-32602);
    expect(fs.existsSync(path.join(root, 'b.md'))).toBe(false);
  });
});
