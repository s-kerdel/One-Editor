// `undo`: the AI undoes its own change from THIS session by the undo code its answer showed. All or nothing,
// only onto files still as the change left them (like Revert in One), only in a folder still shared and
// writable, once only (the reverted mark is shared with One's Revert). Never returns file content.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { parseActivityLine } from '../../../src/shared/mcp';
import { OneMcpServer } from '../../../src/mcp/server';
import { WriteQuota } from '../../../src/mcp/writes';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `undo-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
let n = 0;

function workspace(files: Record<string, string>) {
  const root = path.join(tmp, `ws${++n}`);
  for (const [p, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), t);
  }
  return { root, cfg: path.join(tmp, `cfg${n}`) };
}

async function server(w: { root: string; cfg: string }, mode: 'read' | 'write' = 'write') {
  const s = new OneMcpServer({
    configDir: w.cfg,
    settings: { ...DEFAULT_SETTINGS },
    transport: 'stdio',
    win: false,
    writes: true,
    indexWaitMs: 15_000,
    trash: async (p) => fs.rmSync(p, { recursive: true, force: true }),
    quota: new WriteQuota({ session: 10_000, perMinute: 10_000 }),
  });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: w.root, mode }] });
  let id = 1;
  await s.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'unit' } } });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await s.protocol.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } })) as any;
    return { isError: !!r.result?.isError, text: (r.result?.content?.[0]?.text ?? r.error?.message) as string };
  };
  const get = (rel: string) => (fs.existsSync(path.join(w.root, rel)) ? fs.readFileSync(path.join(w.root, rel), 'utf8') : null);
  return { s, call, get };
}
const code = (t: string) => /undo: ([a-f0-9]{8})/.exec(t)![1];

describe('undo', () => {
  it('a single write; once only; the answer is a summary (never file content); one activity row', async () => {
    const w = workspace({ 'a.md': 'SECRET-OLD-TEXT\n' });
    const t = await server(w);
    const r = (await t.call('append_file', { path: 'a.md', content: 'NEW LINE' })).text;
    const u = await t.call('undo', { id: code(r) });
    expect(u.text).toBe('Undone: 1 file restored');
    expect(u.text).not.toContain('SECRET-OLD-TEXT');
    expect(t.get('a.md')).toBe('SECRET-OLD-TEXT\n');
    expect((await t.call('undo', { id: code(r) })).text).toMatch(/^EALREADY: Already undone/);
    await t.s.audit.flush();
    const rows = fs.readFileSync(path.join(w.cfg, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map((l) => parseActivityLine(l)!);
    expect(rows.filter((x) => x.tool === 'undo' && x.ok)).toEqual([expect.objectContaining({ items: 1, journal: null })]);
    expect(fs.existsSync(path.join(w.cfg, 'mcp-history'))).toBe(true);
  });

  it('a replace_in_files batch, a batch move and a batch delete of files: each undone with its one code', async () => {
    const w = workspace({ 'n/a.md': 'old\n', 'n/b.md': 'old old\n', 'm/x.md': 'x\n', 'm/y.md': 'y\n' });
    const t = await server(w);
    const rep = (await t.call('replace_in_files', { find: 'old', replace: 'new' })).text;
    expect((await t.call('undo', { id: code(rep) })).text).toBe('Undone: 2 files restored');
    expect([t.get('n/a.md'), t.get('n/b.md')]).toEqual(['old\n', 'old old\n']);
    const mv = (await t.call('move', { paths: ['m/x.md', 'm/y.md'], to_folder: 'arch' })).text;
    expect((await t.call('undo', { id: code(mv) })).text).toBe('Undone: 2 moved back');
    expect([t.get('m/x.md'), t.get('arch/x.md')]).toEqual(['x\n', null]);
    const del = (await t.call('delete', { paths: ['m/x.md', 'm/y.md'] })).text;
    expect(t.get('m/x.md')).toBeNull();
    expect((await t.call('undo', { id: code(del) })).text).toBe('Undone: 2 files restored');
    expect([t.get('m/x.md'), t.get('m/y.md')]).toEqual(['x\n', 'y\n']);
    const all = (await t.call('replace_text', { path: 'n/b.md', old: 'old', new: 'z', all: true })).text;
    expect((await t.call('undo', { id: code(all) })).text).toBe('Undone: 1 file restored');
  });

  it('a file changed since → refused, naming every one; nothing undone (all or nothing)', async () => {
    const w = workspace({ 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
    const t = await server(w);
    const r = (await t.call('replace_in_files', { find: '\n', replace: '!\n' })).text;
    fs.writeFileSync(path.join(w.root, 'a.md'), 'edited by the user\n');
    fs.writeFileSync(path.join(w.root, 'c.md'), 'edited too\n');
    expect((await t.call('undo', { id: code(r) })).text).toBe('EXTERNAL_CHANGE: Changed since: a.md, c.md. Nothing was reverted.');
    expect(t.get('b.md')).toBe('b!\n');
  });

  it('a change from another session (a fresh server on the same history) → refused: Revert in One', async () => {
    const w = workspace({ 'a.md': 'a\n' });
    const first = await server(w);
    const r = (await first.call('append_file', { path: 'a.md', content: 'x' })).text;
    const second = await server(w);
    expect((await second.call('undo', { id: code(r) })).text).toBe('EACCES: only changes from this session can be undone here; use Revert in One');
    expect((await first.call('undo', { id: 'deadbeef' })).text).toMatch(/^EACCES: only changes from this session/);
  });

  it('a folder delete keeps no copy: "restore it from the Recycle Bin"; files of the same batch do come back', async () => {
    const w = workspace({ 'proj/x.md': 'x\n', 'proj/.env': 'E=1\n', 'f.md': 'f\n' });
    const t = await server(w);
    // A batch of folders and files asks first (no elicitation here: two steps).
    const ask = (await t.call('delete', { paths: ['proj'] })).text;
    const only = (await t.call('delete', { paths: ['proj'], confirm: /confirm: (\S+)$/.exec(ask)![1] })).text;
    expect((await t.call('undo', { id: code(only) })).text).toBe('ENOTUNDOABLE: Not undoable here: restore proj from the Recycle Bin');
    fs.mkdirSync(path.join(w.root, 'proj2'));
    fs.writeFileSync(path.join(w.root, 'proj2/y.md'), 'y\n');
    const ask2 = (await t.call('delete', { paths: ['proj2', 'f.md'] })).text;
    const mixed = (await t.call('delete', { paths: ['proj2', 'f.md'], confirm: /confirm: (\S+)$/.exec(ask2)![1] })).text;
    expect((await t.call('undo', { id: code(mixed) })).text).toBe('Undone: 1 file restored; folder proj2: restore from the Recycle Bin');
    expect(t.get('f.md')).toBe('f\n');
  });

  it('a folder that is read-only now → refused', async () => {
    const w = workspace({ 'a.md': 'a\n' });
    const t = await server(w);
    const r = (await t.call('append_file', { path: 'a.md', content: 'x' })).text;
    t.s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: w.root, mode: 'read' }, { id: 'bbbbbbbb', alias: 'other', path: workspace({}).root, mode: 'write' }] });
    expect((await t.call('undo', { id: code(r) })).text).toMatch(/^EACCES: .*read-only/);
    expect(t.get('a.md')).toBe('a\nx\n');
  });
});
