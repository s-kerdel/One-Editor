// Write tools through the real server object: scope (read-only folders), etag preconditions, EOL / BOM /
// encoding kept, refusals (hidden, key, excluded, binary, non-text, links out or to hidden places, caps),
// moves with link rewrites, Recycle Bin deletes, the journal (on / off) and reverts with preconditions,
// and the commit-time guard. Trash: a folder under .tmp/mcp (never the real home).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import { JOURNAL_DIR, revertGroup } from '../../../src/mcp/journal';
import { ToolError } from '../../../src/mcp/protocol';
import { xdgTrash } from '../../../src/backend/trash';
import { WriteQuota } from '../../../src/mcp/writes';
import type { McpConfig } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
let root: string;
let config: string;
let trashDir: string;
let server: OneMcpServer;
let settings: Settings = { ...DEFAULT_SETTINGS, excludeGlobs: ['node_modules', 'Private'] };
let trashFails = false;
const cfg = (mode: 'read' | 'write', extra: McpConfig['folders'] = []): McpConfig => ({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode }, ...extra] });
const abs = (rel: string) => path.join(root, ...rel.split('/'));
const w = (rel: string, data: string | Buffer) => {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), data);
};
const read = (rel: string) => fs.readFileSync(abs(rel), 'utf8');

let id = 10;
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = (await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as any;
  if (r.error) return { rpc: r.error.code, text: r.error.message };
  const text = r.result.content[0].text as string;
  return { isError: !!r.result.isError, text, data: r.result.isError ? null : summary(text), raw: r.result };
}
/** A write answer is one plain line: `Saved a.md · etag 1732…-20 · undo: 1a2b3c4d`. */
const summary = (text: string) => ({ text, created: /^Created /.test(text), etag: /· etag (\S+)/.exec(text)?.[1], undo: /· undo: ([a-f0-9]{8})$/.exec(text)?.[1] });
const ok = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.data!;
};
const err = async (name: string, args: Record<string, unknown>) => {
  const r = await call(name, args);
  expect(r.isError || 'rpc' in r, `${name} should fail: ${r.text}`).toBe(true);
  expect(r.text).not.toContain(tmp); // never a host path
  return r.text;
};
const etag = async (rel: string) => /etag (\S+)/.exec((await call('read_file', { path: rel })).text)![1];
/** The newest audit row of a tool (its journal group). */
const lastRow = async (tool: string) => {
  await server.audit.flush();
  const rows = fs.readFileSync(path.join(config, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return rows.reverse().find((r) => r.tool === tool);
};
const revert = (group: string) => revertGroup(server.pool.get('notes'), path.join(config, JOURNAL_DIR), group, testTrash);
async function testTrash(p: string) {
  if (trashFails) throw new Error('no bin');
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(p, path.join(trashDir, `${path.basename(p)}.${crypto.randomBytes(3).toString('hex')}`));
}

beforeAll(async () => {
  tmp = path.join(BASE, `writes-${crypto.randomBytes(4).toString('hex')}`);
  root = path.join(tmp, 'notes');
  config = path.join(tmp, 'config');
  trashDir = path.join(tmp, 'trash');
  fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
  w('crlf.md', '# CRLF\r\n\r\nline\r\n');
  w('bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# BOM\n')]));
  w('u16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16 text\n', 'utf16le')]));
  w('ansi.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café\n" in Windows-1252
  w('bin.md', Buffer.from([0x23, 0x00, 0x01, 0x02]));
  w('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  w('a.md', '# A\n\nalpha\n');
  w('b.md', '# B\n\nSee [[a]].\n');
  w('c.md', '# C\n\nSee [A](a.md) and [[b]].\n');
  w('hub.md', '---\nstatus: draft\n---\n# Hub\n\n## Plans\nplan\n\n## Log\nentry ^e1\n');
  w('twice.md', 'x and x\n');
  w('.secret/s.md', 'secret');
  w('id_rsa', 'key');
  w('node_modules/m.md', 'dep');
  w('Private/p.md', 'private');
  w('withhidden/.git/config', 'x');
  w('withhidden/n.md', 'n');
  w('sub/keep.md', 'keep');
  fs.symlinkSync(path.join(tmp, 'outside'), abs('out'), 'dir');
  fs.symlinkSync('.secret', abs('link-dot'), 'dir');
  // This file makes far more than 60 changes a minute: the quota has its own test.
  server = new OneMcpServer({ configDir: config, settings, transport: 'stdio', win: false, trash: (p) => testTrash(p), indexWaitMs: 15_000, quota: new WriteQuota({ session: 100_000, perMinute: 100_000 }), writes: true }); // write code on, whatever MCP_WRITES_ENABLED says
  server.applyConfig(cfg('write'));
  await server.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit' } } });
});

afterAll(async () => {
  await server.dispose();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('scope', () => {
  it('write tools are listed only while a folder is read-write, and refuse read-only folders', async () => {
    const names = async () => ((await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/list' })) as any).result.tools.map((t: any) => t.name);
    expect(await names()).toEqual(expect.arrayContaining(['write_file', 'append_file', 'patch_file', 'replace_text', 'move_file', 'create_folder', 'delete_file']));
    server.applyConfig(cfg('read'));
    expect((await names()).some((n: string) => /write|append|patch|replace|move|create|delete/.test(n))).toBe(false);
    expect((await call('write_file', { path: 'x.md', content: 'x' })).rpc).toBe(-32602); // not even callable
    fs.mkdirSync(path.join(tmp, 'other'), { recursive: true });
    server.applyConfig(cfg('read', [{ id: 'bbbbbbbb', alias: 'other', path: path.join(tmp, 'other'), mode: 'write' }]));
    expect(await err('write_file', { folder: 'notes', path: 'x.md', content: 'x' })).toMatch(/^EACCES: The folder "notes" is read-only/);
    server.applyConfig(cfg('write'));
    const tools = ((await server.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/list' })) as any).result.tools;
    for (const t of tools.filter((x: any) => /^(write|append|patch|replace|move|create|delete)_/.test(x.name))) {
      expect(t.annotations.readOnlyHint, t.name).toBe(false);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe('write_file', () => {
  it('creates (with parent folders), refuses to overwrite without the etag, overwrites with it', async () => {
    const c = await ok('write_file', { path: 'new/deep/n.md', content: 'one\r\ntwo' });
    expect(c.created).toBe(true);
    expect(read('new/deep/n.md')).toBe('one\ntwo');
    expect(await err('write_file', { path: 'new/deep/n.md', content: 'x' })).toMatch(/^EEXIST: .*pass if_match/);
    expect(await err('write_file', { path: 'new/deep/n.md', content: 'x', if_none_match: '*' })).toMatch(/^EEXIST/);
    expect(await err('write_file', { path: 'new/deep/n.md', content: 'x', if_match: '1-1' })).toMatch(/^EXTERNAL_CHANGE/);
    expect(await err('write_file', { path: 'new/deep/n.md', content: 'x', if_match: 'bogus' })).toMatch(/^EINVAL/);
    const o = await ok('write_file', { path: 'new/deep/n.md', content: 'three', if_match: c.etag });
    expect(o.created).toBe(false);
    expect(read('new/deep/n.md')).toBe('three');
    expect(o.etag).not.toBe(c.etag);
    expect(await err('write_file', { path: 'gone.md', content: 'x', if_match: c.etag })).toMatch(/^ENOENT/);
  });

  it('keeps CRLF, a BOM, UTF-16 and Windows-1252 as they were; refuses text 1252 cannot hold', async () => {
    await ok('write_file', { path: 'crlf.md', content: '# CRLF\n\nchanged\n', if_match: await etag('crlf.md') });
    expect(fs.readFileSync(abs('crlf.md'), 'utf8')).toBe('# CRLF\r\n\r\nchanged\r\n');
    await ok('write_file', { path: 'bom.md', content: '# BOM 2\n', if_match: await etag('bom.md') });
    expect([...fs.readFileSync(abs('bom.md')).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    await ok('write_file', { path: 'u16.txt', content: 'still utf16\n', if_match: await etag('u16.txt') });
    const u = fs.readFileSync(abs('u16.txt'));
    expect([...u.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(u.subarray(2).toString('utf16le')).toBe('still utf16\n');
    await ok('write_file', { path: 'ansi.txt', content: 'café ok\n', if_match: await etag('ansi.txt') });
    expect([...fs.readFileSync(abs('ansi.txt'))]).toEqual([...Buffer.from('caf'), 0xe9, ...Buffer.from(' ok\n')]);
    expect(await err('write_file', { path: 'ansi.txt', content: 'smile 😀\n', if_match: await etag('ansi.txt') })).toMatch(/Windows-1252/);
  });

  it('refuses binary and non-text targets, hidden / key / excluded names, links out or to hidden places, oversize content', async () => {
    expect(await err('write_file', { path: 'bin.md', content: 'x', if_match: await etag('bin.md') })).toMatch(/^EINVAL: Binary/);
    expect(await err('write_file', { path: 'image.png', content: 'x', if_none_match: '*' })).toMatch(/^EINVAL: Cannot change image.png: only notes/);
    expect(await err('write_file', { path: 'tool.exe', content: 'x' })).toMatch(/^EINVAL: Cannot change tool.exe: program, script and shortcut files are never written/);
    for (const p of ['.secret/x.md', '.env', 'id_rsa', 'keys/server.pem', 'node_modules/x.md', 'private/new.md', 'PRIVATE/new.md', 'notes/.hidden/x.md']) expect(await err('write_file', { path: p, content: 'x' }), p).toMatch(/^EACCES: Cannot change/);
    for (const p of ['out/x.md', 'link-dot/x.md']) expect(await err('write_file', { path: p, content: 'x' }), p).toBe(`EACCES: Cannot change ${p}`); // the same neutral answer
    expect(fs.existsSync(path.join(tmp, 'outside/x.md'))).toBe(false);
    expect(fs.existsSync(abs('.secret/x.md'))).toBe(false);
    for (const p of ['../x.md', '/etc/x.md', 'C:\\x.md', 'a\\b.md']) expect(await err('write_file', { path: p, content: 'x' }), p).toMatch(/^EINVAL/);
    expect(await err('append_file', { path: 'a.md', content: 'x'.repeat(300 * 1024) })).toMatch(/EINVAL|ETOOBIG/);
  });
});

describe('append, patch, replace', () => {
  it('append_file at the end / start, create only when asked', async () => {
    await ok('append_file', { path: 'a.md', content: 'tail' });
    expect(read('a.md')).toBe('# A\n\nalpha\ntail\n');
    await ok('append_file', { path: 'hub.md', content: 'top', position: 'start' });
    expect(read('hub.md').startsWith('---\nstatus: draft\n---\ntop\n# Hub')).toBe(true);
    expect(await err('append_file', { path: 'log/today.md', content: 'x' })).toMatch(/create: true/);
    expect((await ok('append_file', { path: 'log/today.md', content: 'x', create: true })).created).toBe(true);
  });

  it('patch_file by heading, block and frontmatter key; Markdown only', async () => {
    await ok('patch_file', { path: 'hub.md', heading: 'Plans', operation: 'append', content: 'more plan' });
    expect(read('hub.md')).toContain('plan\nmore plan\n');
    await ok('patch_file', { path: 'hub.md', block: 'e1', operation: 'replace', content: 'new entry' });
    expect(read('hub.md')).toContain('new entry ^e1');
    await ok('patch_file', { path: 'hub.md', frontmatter_key: 'status', operation: 'replace', content: 'done' });
    expect(read('hub.md')).toContain('status: done');
    expect(await err('patch_file', { path: 'u16.txt', heading: 'x', operation: 'append', content: 'x' })).toMatch(/Not a Markdown/);
    expect(await err('patch_file', { path: 'hub.md', operation: 'append', content: 'x' })).toMatch(/exactly one/);
    expect(await err('patch_file', { path: 'hub.md', heading: 'Plans', operation: 'append' })).toMatch(/content is needed/);
  });

  it('replace_text: exactly one match', async () => {
    await ok('replace_text', { path: 'a.md', old: 'alpha', new: 'ALPHA' });
    expect(read('a.md')).toContain('ALPHA');
    expect(await err('replace_text', { path: 'twice.md', old: 'x', new: 'y' })).toMatch(/^EAMBIGUOUS: .*2 times/);
    expect(await err('replace_text', { path: 'a.md', old: 'nope', new: 'y' })).toMatch(/^ENOMATCH/);
  });

  it('an edit made outside meanwhile wins: if_match from before the change is refused', async () => {
    const before = await etag('twice.md');
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(abs('twice.md'), 'x and x and changed\n');
    expect(await err('append_file', { path: 'twice.md', content: 'y', if_match: before })).toMatch(/^EXTERNAL_CHANGE/);
    expect(read('twice.md')).toBe('x and x and changed\n');
  });

  it('own writes reach the search index right away', async () => {
    await ok('write_file', { path: 'fresh.md', content: 'a zebrafish appears' });
    await expect.poll(async () => (await call('search', { query: 'zebrafish' })).text, { timeout: 5000 }).toContain('fresh.md');
  });
});

describe('move_file, create_folder, delete_file', () => {
  it('moves a note and rewrites the links that need it; never overwrites', async () => {
    const r = await ok('move_file', { from: 'a.md', to: 'archive/a.md' });
    expect(fs.existsSync(abs('archive/a.md'))).toBe(true);
    expect(fs.existsSync(abs('a.md'))).toBe(false);
    expect(read('c.md')).toContain('[A](archive/a.md)');
    expect(read('b.md')).toContain('[[a]]'); // still resolves by name: untouched
    expect(r.text).toMatch(/^Moved a\.md → archive\/a\.md · etag \S+ · links updated: c\.md · undo: [a-f0-9]{8}$/);
    expect(await err('move_file', { from: 'b.md', to: 'c.md' })).toMatch(/^EEXIST/);
    expect(await err('move_file', { from: 'b.md', to: 'b.exe' })).toMatch(/never written/);
    expect(await err('move_file', { from: 'b.md', to: '.secret/b.md' })).toMatch(/^EACCES/);
    expect(await err('move_file', { from: 'b.md', to: 'link-dot/b.md' })).toBe('EACCES: Cannot change link-dot/b.md');
    expect(await err('move_file', { from: '.secret/s.md', to: 'stolen.md' })).toMatch(/^EACCES/);
    expect(await err('move_file', { from: 'withhidden', to: 'moved' })).toMatch(/hidden, excluded or linked/);
    expect(await err('move_file', { from: 'sub', to: 'sub/inner' })).toMatch(/into itself/);
    expect(await err('move_file', { from: 'bin.md', to: 'bin2.md' })).toMatch(/Binary/);
    expect(await err('move_file', { from: 'image.png', to: 'img.png' })).toMatch(/only notes/);
  });

  it('create_folder; delete_file goes to the trash, never for folders, binaries or non-text files', async () => {
    expect((await ok('create_folder', { path: 'made/here' })).created).toBe(true);
    expect(fs.statSync(abs('made/here')).isDirectory()).toBe(true);
    expect(await err('create_folder', { path: 'made/here' })).toMatch(/^EEXIST/);
    w('trash-me.md', 'bye');
    await ok('delete_file', { path: 'trash-me.md' });
    expect(fs.existsSync(abs('trash-me.md'))).toBe(false);
    expect(fs.readdirSync(trashDir).some((n) => n.startsWith('trash-me.md'))).toBe(true);
    expect(await err('delete_file', { path: 'sub' })).toMatch(/EISDIR|Not a file/);
    expect(await err('delete_file', { path: 'image.png' })).toMatch(/only notes/);
    expect(await err('delete_file', { path: 'bin.md' })).toMatch(/Binary/);
  });

  it('no Recycle Bin → ETRASH, and nothing is deleted', async () => {
    w('stays.md', 'stay');
    trashFails = true;
    try {
      expect(await err('delete_file', { path: 'stays.md' })).toMatch(/^ETRASH: .*Nothing was deleted/);
    } finally {
      trashFails = false;
    }
    expect(read('stays.md')).toBe('stay');
  });

  it('the XDG trash lands where XDG_DATA_HOME says (here: inside .tmp/mcp), never in the real home', async () => {
    const xdg = path.join(tmp, 'xdg');
    const name = `xdg-${crypto.randomBytes(4).toString('hex')}.md`;
    w(name, 'to the xdg trash');
    const s2 = new OneMcpServer({ configDir: config, settings, transport: 'stdio', win: false, trash: (p) => xdgTrash(p, xdg), writes: true });
    s2.applyConfig(cfg('write'));
    await s2.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } });
    const r = (await s2.protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'delete_file', arguments: { path: name } } })) as any;
    expect(r.result.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(xdg, 'Trash/files', name), 'utf8')).toBe('to the xdg trash');
    expect(fs.readFileSync(path.join(xdg, 'Trash/info', `${name}.trashinfo`), 'utf8')).toContain('[Trash Info]');
    expect(fs.existsSync(path.join(os.homedir(), '.local/share/Trash/files', name))).toBe(false);
    await s2.dispose();
  });
});

describe('journal and revert', () => {
  it('reverts an overwrite to the exact old bytes; a second revert or a later change is refused', async () => {
    w('rev.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Old\r\nbody\r\n')]));
    const old = fs.readFileSync(abs('rev.md'));
    await ok('write_file', { path: 'rev.md', content: '# New\n', if_match: await etag('rev.md') });
    const row = await lastRow('write_file');
    expect(row.journal).toMatch(/^[a-z0-9]+-[a-f0-9]{8}$/);
    expect(await revert(row.journal)).toBe(1);
    expect(fs.readFileSync(abs('rev.md')).equals(old)).toBe(true);
    await expect(revert(row.journal)).rejects.toMatchObject({ code: 'EALREADY' });

    await ok('append_file', { path: 'rev.md', content: 'more' });
    const row2 = await lastRow('append_file');
    await new Promise((r) => setTimeout(r, 15));
    fs.appendFileSync(abs('rev.md'), 'edited in One\n');
    const now = fs.readFileSync(abs('rev.md'));
    await expect(revert(row2.journal)).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(fs.readFileSync(abs('rev.md')).equals(now)).toBe(true); // nothing was reverted
  });

  it('reverts a move with its link rewrites (all of it), a delete (from the journal) and a create (to the trash)', async () => {
    const c = read('c.md');
    const b = read('b.md');
    await ok('move_file', { from: 'archive/a.md', to: 'moved/a2.md' });
    expect(read('c.md')).toContain('[A](moved/a2.md)');
    expect(read('b.md')).toContain('[[a2]]'); // the name changed: [[a]] would no longer resolve
    const mv = await lastRow('move_file');
    expect(await revert(mv.journal)).toBe(3); // the move + two link rewrites
    expect(read('c.md')).toBe(c);
    expect(read('b.md')).toBe(b);
    expect(fs.existsSync(abs('archive/a.md'))).toBe(true);
    expect(fs.existsSync(abs('moved/a2.md'))).toBe(false);

    w('del.md', 'deleted text');
    await ok('delete_file', { path: 'del.md' });
    await revert((await lastRow('delete_file')).journal);
    expect(read('del.md')).toBe('deleted text');

    await ok('write_file', { path: 'created.md', content: 'new' });
    await revert((await lastRow('write_file')).journal);
    expect(fs.existsSync(abs('created.md'))).toBe(false);

    await ok('create_folder', { path: 'tmpdir' });
    await revert((await lastRow('create_folder')).journal);
    expect(fs.existsSync(abs('tmpdir'))).toBe(false);
  });

  it('off: no undo copy, no journal id (no Revert); on again: copies again', async () => {
    const groups = () => fs.readdirSync(path.join(config, JOURNAL_DIR)).length;
    server.applyConfig({ ...cfg('write'), undo: { on: false, days: 30 } }); // main-owned (mcp.json)
    const before = groups();
    await ok('append_file', { path: 'b.md', content: 'no copy' });
    expect((await lastRow('append_file')).journal).toBeUndefined();
    expect(groups()).toBe(before);
    server.applyConfig({ ...cfg('write'), undo: { on: true, days: 30 } });
    await ok('append_file', { path: 'b.md', content: 'with copy' });
    expect((await lastRow('append_file')).journal).toBeTruthy();
    expect(groups()).toBe(before + 1);
  });

  it('a tampered history entry cannot reach outside the folder', async () => {
    await ok('append_file', { path: 'b.md', content: 'x' });
    const g = (await lastRow('append_file')).journal;
    const f = path.join(config, JOURNAL_DIR, g, '0.json');
    const e = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...e, path: '../outside/evil.md' }));
    await expect(revert(g)).rejects.toBeInstanceOf(ToolError);
    expect(fs.existsSync(path.join(tmp, 'outside/evil.md'))).toBe(false);
    await expect(revert('../../etc')).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

describe('commit-time guard (the path is checked again where the disk changes)', () => {
  it('a parent swapped for a link to a hidden place after the check is refused at commit', async () => {
    w('swap/x.md', 'x');
    const f = server.pool.get('notes');
    const t = await f.use(() => f.resolveTarget('swap/new.md', { kind: 'file', exists: 'mustNot' }));
    fs.rmSync(abs('swap'), { recursive: true });
    fs.symlinkSync('.secret', abs('swap'), 'dir');
    const ws = await f.workspace();
    await expect(ws.createFile(t.key, 'leak', f.guard({ expect: 'absent' }))).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    expect(fs.existsSync(abs('.secret/new.md'))).toBe(false);
  });

  it('both ends of a rename are checked at commit', async () => {
    w('mv/src.md', 'src');
    fs.mkdirSync(abs('mvdst'), { recursive: true });
    const f = server.pool.get('notes');
    const from = await f.use(() => f.resolveTarget('mv/src.md', { kind: 'file', exists: 'must' }));
    const to = await f.use(() => f.resolveTarget('mvdst/src.md', { kind: 'file', exists: 'mustNot' }));
    fs.rmSync(abs('mvdst'), { recursive: true });
    fs.symlinkSync('.secret', abs('mvdst'), 'dir');
    const ws = await f.workspace();
    await expect(ws.rename(from.key, to.key, f.guard())).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    expect(fs.existsSync(abs('mv/src.md'))).toBe(true);
    expect(fs.existsSync(abs('.secret/src.md'))).toBe(false);
  });

  it('a file replaced between the read and the write is not overwritten', async () => {
    w('race.md', 'v1');
    const f = server.pool.get('notes');
    const t = await f.use(() => f.resolveTarget('race.md', { kind: 'file', exists: 'must' }));
    const r = await f.readText('race.md');
    await new Promise((res) => setTimeout(res, 15));
    fs.writeFileSync(abs('race.md'), 'v2 longer');
    const ws = await f.workspace();
    await expect(ws.writeFile(t.key, 'v3', { expectedMtime: r.mtime }, f.guard({ expect: { mtime: r.mtime, size: r.size } }))).rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(read('race.md')).toBe('v2 longer');
  });
});
