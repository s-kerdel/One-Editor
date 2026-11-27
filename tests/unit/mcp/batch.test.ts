// Fewer calls: replace_text all, replace_in_files (preview, then apply: one undo group), batch move
// (paths + to_folder) and batch delete (paths: one undo group for the files). Sweeping ones ask the user
// first: a batch with a folder or over MCP_CONFIRM_OVER items, a replace over MCP_CONFIRM_OVER files; the
// question is bound to the exact operation; a client that cannot ask is refused them. Trash: a fake one.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { MCP_CONFIRM_OVER, parseActivityLine } from '../../../src/shared/mcp';
import { OneMcpServer } from '../../../src/mcp/server';
import { WriteQuota } from '../../../src/mcp/writes';
import { JOURNAL_DIR, revertGroup } from '../../../src/mcp/journal';
import { binWord } from '../../../src/mcp/confirm';
const BIN = binWord(); // "Trash" on macOS, "Recycle Bin" elsewhere: what the server says on this machine

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `batch-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
let n = 0;
const VARS = '# vars\n\n```yaml\nvars:\n  host: example.org\nsecrets: [api_key]\n```\n';

async function rig(o: { era?: 'legacy' | 'modern'; elicit?: boolean; quota?: WriteQuota; files?: Record<string, string> } = {}) {
  const root = path.join(tmp, `ws${++n}`);
  const cfg = path.join(tmp, `cfg${n}`);
  const put = (rel: string, t: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), t);
  };
  put('variables.md', VARS);
  for (const [p, t] of Object.entries(o.files ?? {})) put(p, t);
  const trashed: string[] = [];
  const s = new OneMcpServer({
    configDir: cfg,
    settings: { ...DEFAULT_SETTINGS },
    transport: 'stdio',
    win: false,
    writes: true,
    indexWaitMs: 15_000,
    trash: async (p) => {
      trashed.push(path.relative(root, p));
      fs.rmSync(p, { recursive: true, force: true });
    },
    quota: o.quota ?? new WriteQuota({ session: 10_000, perMinute: 10_000 }),
  });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'write' }] });
  const out: any[] = [];
  s.protocol.attach((m) => out.push(m));
  const caps = o.elicit ? { elicitation: {} } : {};
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'unit' }, 'io.modelcontextprotocol/clientCapabilities': caps };
  let id = 1;
  const modern = o.era === 'modern';
  const rpc = (method: string, params: Record<string, unknown> = {}) => s.protocol.handle({ jsonrpc: '2.0', id: id++, method, params: modern ? { ...params, _meta: meta } : params }) as Promise<any>;
  if (!modern) await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: caps, clientInfo: { name: 'unit' } });
  const raw = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args, ...extra });
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await raw(name, args);
    return { isError: !!r.result?.isError, text: (r.result?.content?.[0]?.text ?? r.error?.message) as string };
  };
  const get = (rel: string) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : null);
  const rows = async () => {
    await s.audit.flush();
    return fs.readFileSync(path.join(cfg, 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map((l) => parseActivityLine(l)!);
  };
  const revert = async (group: string) => revertGroup(s.pool.list()[0], path.join(cfg, JOURNAL_DIR), group, async () => {});
  return { root, s, out, put, get, call, raw, rows, revert, trashed };
}
/** The next elicitation/create the server sent (legacy era), once it is there. */
async function asked(r: { out: any[] }) {
  for (let i = 0; i < 400 && !r.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((res) => setTimeout(res, 5));
  const req = r.out.find((m) => m.method === 'elicitation/create');
  r.out.splice(r.out.indexOf(req), 1);
  return req;
}
const accept = { action: 'accept', content: { confirm: true } };
const notes = (k: number, text = 'old name here\n') => Object.fromEntries(Array.from({ length: k }, (_, i) => [`n/${String(i).padStart(2, '0')}.md`, text]));

describe('replace_text all', () => {
  it('every match in one call, the count in the answer; none → ENOMATCH', async () => {
    const r = await rig({ files: { 'a.md': 'foo, foo and foo\nfoo\n' } });
    expect((await r.call('replace_text', { path: 'a.md', old: 'foo', new: 'bar', all: true })).text).toMatch(/^Replaced 4 in a\.md · etag \S+ · undo: [a-f0-9]{8}$/);
    expect(r.get('a.md')).toBe('bar, bar and bar\nbar\n');
    expect((await r.call('replace_text', { path: 'a.md', old: 'zzz', new: 'y', all: true })).text).toMatch(/^ENOMATCH/);
    expect((await r.call('replace_text', { path: 'a.md', old: 'bar', new: 'x' })).text).toMatch(/^EAMBIGUOUS|occurs/); // without all: still exactly once
  });

  it('a match on (or next to) a secret line refuses the whole call and names the lines', async () => {
    const r = await rig({ files: { 'a.md': 'alpha x\n\nkey {{api_key}} x\nbeta\n\nalpha x\n' } });
    const t = (await r.call('replace_text', { path: 'a.md', old: 'x', new: 'y', all: true })).text;
    expect(t).toMatch(/^ESECRET: Nothing replaced: matches on lines 3 touch a line/);
    expect(r.get('a.md')).toBe('alpha x\n\nkey {{api_key}} x\nbeta\n\nalpha x\n');
    expect((await r.call('replace_text', { path: 'a.md', old: 'alpha', new: 'gamma', all: true })).isError).toBe(false); // lines 1 and 6: free
  });
});

describe('replace_in_files', () => {
  it('preview counts; apply writes the scope only (filters, visible, type policy), one undo group, one Revert for all', async () => {
    const r = await rig({ files: { 'n/a.md': 'old old\n', 'n/b.md': 'old\n', 'other/c.md': 'old\n', 'n/.hidden.md': 'old\n', 'n/d.json': '{"old": 1}\n' } });
    const p = (await r.call('replace_in_files', { find: 'old', replace: 'new', query: 'path:n/', preview: true })).text;
    expect(p).toBe('3 matches in 2 files\nn/a.md (2)\nn/b.md (1)');
    expect(r.get('n/a.md')).toBe('old old\n');
    const a = (await r.call('replace_in_files', { find: 'old', replace: 'new', query: 'path:n/' })).text;
    expect(a).toMatch(/^Replaced 3 in 2 files · undo: [a-f0-9]{8}$/);
    expect([r.get('n/a.md'), r.get('n/b.md'), r.get('other/c.md'), r.get('n/.hidden.md'), r.get('n/d.json')]).toEqual(['new new\n', 'new\n', 'old\n', 'old\n', '{"old": 1}\n']);
    const row = (await r.rows()).reverse().find((x) => x.tool === 'replace_in_files')!;
    expect(row).toMatchObject({ ok: true, items: 2 });
    expect(await r.revert(row.journal!)).toBe(2);
    expect([r.get('n/a.md'), r.get('n/b.md')]).toEqual(['old old\n', 'old\n']);
  });

  it('files where a change would touch a secret line (or its neighbour) are skipped and named; the rest are written', async () => {
    const r = await rig({ files: { 'a.md': 'run old\n', 'b.md': 'x\nold {{api_key}}\n', 'c.md': 'old\n{{api_key}}\n' } });
    const t = (await r.call('replace_in_files', { find: 'old', replace: 'new' })).text;
    expect(t).toMatch(/^Replaced 1 in 1 file · skipped 2: b\.md \(secret line\), c\.md \(secret line\) · undo: /);
    expect([r.get('a.md'), r.get('b.md'), r.get('c.md')]).toEqual(['run new\n', 'x\nold {{api_key}}\n', 'old\n{{api_key}}\n']);
  });

  it('query takes filters only; in: is refused; smart case; the quota counts each changed file', async () => {
    const r = await rig({ files: { 'a.md': 'Old old\n', 'b.md': 'old\n', 'c.md': 'old\n' }, quota: new WriteQuota({ session: 2, perMinute: 100 }) });
    expect((await r.call('replace_in_files', { find: 'old', replace: 'x', query: 'deploy path:a' })).text).toMatch(/^EINVAL: query takes filters only/);
    expect((await r.call('replace_in_files', { find: 'old', replace: 'x', query: 'in:code' })).text).toMatch(/^EINVAL: in: is not supported/);
    expect((await r.call('replace_in_files', { find: 'Old', replace: 'New', preview: true })).text).toBe('1 match in 1 file\na.md (1)');
    const t = (await r.call('replace_in_files', { find: 'old', replace: 'new' })).text;
    expect(t).toMatch(/^Replaced 3 in 2 files · skipped 1: c\.md \(EQUOTA\)/);
  });

  it(`${MCP_CONFIRM_OVER} files apply at once; ${MCP_CONFIRM_OVER + 1} need the user's OK: refused for a client that cannot ask (no code in the answer)`, async () => {
    const r = await rig({ files: { ...notes(MCP_CONFIRM_OVER), 'm/x.md': 'old name here\n' } });
    expect((await r.call('replace_in_files', { find: 'old name', replace: 'new name', query: 'path:n/' })).text).toMatch(/^Replaced 10 in 10 files/);
    r.put('n/10.md', 'new name here\n');
    await expect.poll(async () => (await r.call('replace_in_files', { find: 'new name', replace: 'x', query: 'path:n/', preview: true })).text, { timeout: 8000 }).toMatch(/^11 matches in 11 files/);
    // 11 files now: refused, nothing changed, and nothing the model could send back as the user's yes.
    const no = await r.call('replace_in_files', { find: 'new name', replace: 'final', query: 'path:n/' });
    expect(no.isError).toBe(true);
    expect(no.text).toBe("ENOTSUP: Not replaced: replacing in more than 10 files needs the user's OK, and this app cannot ask for it. The user can do it in One, or in an AI app that can ask (MCP form elicitation).");
    expect(r.get('n/00.md')).toBe('new name here\n');
    expect((await r.call('replace_in_files', { find: 'new name', replace: 'final', query: 'path:n/', confirm: 'AAAA-BBBB' })).text).toMatch(/^EINVAL: Unknown parameter "confirm"/);
    expect(r.get('n/05.md')).toBe('new name here\n');
    expect(r.get('m/x.md')).toBe('old name here\n');
  });

  it('a file changed while the user was asked → not replaced', async () => {
    const r = await rig({ elicit: true, files: notes(MCP_CONFIRM_OVER + 1) });
    const pending = r.call('replace_in_files', { find: 'old', replace: 'new' });
    const req = await asked(r);
    r.put('n/03.md', 'old name here, edited\n');
    await r.s.protocol.handle({ jsonrpc: '2.0', id: req.id, result: accept });
    expect((await pending).text).toBe('EXTERNAL_CHANGE: Not replaced: the files changed while the user was asked. Try again.');
    expect(r.get('n/00.md')).toBe('old name here\n');
  });

  it('elicitation (legacy): accept applies, decline changes nothing; 2026-07-28: input_required, then the retry', async () => {
    for (const [action, want] of [['accept', 'final here\n'], ['decline', 'old name here\n']] as const) {
      const r = await rig({ elicit: true, files: notes(MCP_CONFIRM_OVER + 1) });
      const pending = r.call('replace_in_files', { find: 'old name', replace: 'final' });
      for (let i = 0; i < 400 && !r.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((res) => setTimeout(res, 5));
      const req = r.out.find((m) => m.method === 'elicitation/create');
      expect(req.params.message).toMatch(/^Replace "old name" with "final" in 11 files \(11 matches\)/);
      await r.s.protocol.handle({ jsonrpc: '2.0', id: req.id, result: action === 'accept' ? { action, content: { confirm: true } } : { action } });
      const t = (await pending).text;
      expect(t, action).toMatch(action === 'accept' ? /^Replaced 11 in 11 files/ : /^ECANCELED: Not replaced: the user declined$/);
      expect(r.get('n/07.md')).toBe(want);
    }
    const m = await rig({ era: 'modern', elicit: true, files: notes(MCP_CONFIRM_OVER + 1) });
    const first = await m.raw('replace_in_files', { find: 'old name', replace: 'final' });
    expect(first.result.resultType).toBe('input_required');
    const second = await m.raw('replace_in_files', { find: 'old name', replace: 'final' }, { requestState: first.result.requestState, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
    expect(second.result.content[0].text).toMatch(/^Replaced 11 in 11 files/);
  });

  it('at most 200 files per call', async () => {
    const r = await rig({ files: notes(201, 'zz\n') });
    expect((await r.call('replace_in_files', { find: 'zz', replace: 'y' })).text).toMatch(/^ETOOBIG: 201 files match: at most 200/);
  });
});

describe('batch move (paths + to_folder)', () => {
  it('each item on its own (one line each), one undo group: one Revert moves them all back', async () => {
    const r = await rig({ files: { 'a.md': 'see [B](b.md)\n', 'b.md': 'b\n', 'c.md': 'c\n', 'arch/c.md': 'taken\n', 'dir/.git/config': 'x\n' } });
    const t = (await r.call('move', { paths: ['a.md', 'b.md', 'c.md', 'dir', 'gone.md'], to_folder: 'arch' })).text.split('\n');
    expect(t[0]).toMatch(/^Moved 3 of 5 items into arch · undo: [a-f0-9]{8}$/);
    expect(t.slice(1)).toEqual([expect.stringMatching(/^ok a\.md → arch\/a\.md/), expect.stringMatching(/^ok b\.md → arch\/b\.md/), 'EEXIST c.md: Already exists: arch/c.md', 'ok dir → arch/dir', 'ENOENT gone.md: Not found: gone.md']);
    expect(r.get('arch/a.md')).toBe('see [B](b.md)\n'); // both moved: the link still fits
    expect(r.get('arch/dir/.git/config')).toBe('x\n');
    const row = (await r.rows()).reverse().find((x) => x.tool === 'move')!;
    expect(row).toMatchObject({ items: 5, path: 'a.md +4 more' });
    await r.revert(row.journal!);
    expect([r.get('a.md'), r.get('b.md'), r.get('dir/.git/config')]).toEqual(['see [B](b.md)\n', 'b\n', 'x\n']);
  });

  it('from/to and paths/to_folder are exclusive; a single rename still works', async () => {
    const r = await rig({ files: { 'a.md': 'a\n' } });
    expect((await r.call('move', { from: 'a.md', paths: ['a.md'], to_folder: 'x' })).text).toMatch(/^EINVAL: Pass from \+ to \(one item\), or paths \+ to_folder/);
    expect((await r.call('move', { paths: ['a.md'] })).text).toMatch(/^EINVAL: Pass both paths and to_folder/);
    expect((await r.call('move', { from: 'a.md', to: 'b.md' })).text).toMatch(/^Moved a\.md → b\.md/);
  });
});

describe('batch delete (paths)', () => {
  it(`${MCP_CONFIRM_OVER} files go at once with undo copies in one group (one Revert); a missing one does not stop the rest`, async () => {
    const r = await rig({ files: notes(MCP_CONFIRM_OVER - 1) });
    const list = [...Object.keys(notes(MCP_CONFIRM_OVER - 1)), 'nope.md'];
    const t = (await r.call('delete', { paths: list })).text.split('\n');
    expect(t[0]).toMatch(/^Deleted 9 of 10 items \((?:Recycle Bin|Trash)\) · undo: [a-f0-9]{8}$/);
    expect(t.at(-1)).toBe('ENOENT nope.md: Not found: nope.md');
    expect(r.trashed).toHaveLength(9);
    const row = (await r.rows()).reverse().find((x) => x.tool === 'delete')!;
    expect(row).toMatchObject({ items: 10, ok: true });
    expect(await r.revert(row.journal!)).toBe(9);
    expect(r.get('n/04.md')).toBe('old name here\n');
  });

  it(`${MCP_CONFIRM_OVER + 1} files ask first (one question with totals and the first names); refused for a client that cannot ask`, async () => {
    const files = notes(MCP_CONFIRM_OVER + 2);
    const list = Object.keys(files).slice(0, MCP_CONFIRM_OVER + 1);
    const no = await rig({ files });
    expect((await no.call('delete', { paths: list })).text).toBe("ENOTSUP: Not deleted: deleting more than 10 items at once needs the user's OK, and this app cannot ask for it. The user can do it in One, or in an AI app that can ask (MCP form elicitation).");
    expect(no.trashed).toEqual([]);
    const r = await rig({ elicit: true, files });
    const pending = r.call('delete', { paths: list });
    const req = await asked(r);
    expect(req.params.message).toBe('Delete 11 files: "n/00.md", "n/01.md", "n/02.md" and 8 more? 11 files, 0 folders, 154 B in all. It goes to the ' + BIN + '.');
    expect(r.trashed).toEqual([]);
    await r.s.protocol.handle({ jsonrpc: '2.0', id: req.id, result: accept });
    expect((await pending).text).toMatch(/^Deleted 11 of 11 items/);
  });

  it('a batch with a folder asks once for everything; then folders go whole, files keep undo copies', async () => {
    const r = await rig({ elicit: true, files: { 'a.md': 'a\n', 'proj/x.md': 'x\n', 'proj/.env': 'E=1\n' } });
    const pending = r.call('delete', { paths: ['a.md', 'proj'] });
    for (let i = 0; i < 400 && !r.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((res) => setTimeout(res, 5));
    const asks = r.out.filter((m) => m.method === 'elicitation/create');
    expect(asks).toHaveLength(1);
    expect(asks[0].params.message).toBe('Delete 1 folder with everything in them and 1 file: "a.md", "proj"? 3 files, 0 folders, 8 B in all (including hidden items such as .env). It goes to the ' + BIN + '.');
    await r.s.protocol.handle({ jsonrpc: '2.0', id: asks[0].id, result: { action: 'accept', content: { confirm: true } } });
    const t = (await pending).text.split('\n');
    expect(t).toEqual([expect.stringMatching(/^Deleted 2 of 2 items \((?:Recycle Bin|Trash)\) · undo: /), 'ok a.md', 'ok proj (folder, 2 files: restore it from the ' + BIN + ')']);
    expect(r.out.filter((m) => m.method === 'elicitation/create')).toHaveLength(1);
    const row = (await r.rows()).reverse().find((x) => x.tool === 'delete')!;
    expect(row).toMatchObject({ items: 2, note: 'folders: restore from the ' + BIN + '' });
  });
});

describe('batch move keeps the folder structure (below the common parent)', () => {
  it('where each item goes: kept below the common parent; flat; one parent = as a flat move', async () => {
    const { batchDestinations } = await import('../../../src/mcp/tools/write');
    expect(batchDestinations(['notes/a/x.md', 'notes/b/y.md'], 'archive', false, false)).toEqual(['archive/a/x.md', 'archive/b/y.md']);
    expect(batchDestinations(['notes/a/x.md', 'notes/a/deep/er/y.md', 'notes/b.md'], 'archive/', false, false)).toEqual(['archive/a/x.md', 'archive/a/deep/er/y.md', 'archive/b.md']);
    expect(batchDestinations(['n/x.md', 'n/y.md'], 'a', false, false)).toEqual(['a/x.md', 'a/y.md']);
    expect(batchDestinations(['n/a/x.md', 'n/b/x.md'], 'a', true, false)).toEqual(['a/x.md', 'a/x.md']); // flat: the second clashes
    expect(batchDestinations(['Notes/a/x.md', 'notes/b/y.md'], 'z', false, true)).toEqual(['z/a/x.md', 'z/b/y.md']); // Windows: case-insensitive parent
    expect(batchDestinations(['x.md', 'sub/y.md'], 'z', false, false)).toEqual(['z/x.md', 'z/sub/y.md']);
  });

  it('nested items keep their subfolders (made as needed, existing ones reused); a clash is refused, the rest go; one Revert', async () => {
    const r = await rig({ files: { 'notes/a/x.md': 'x\n', 'notes/a/deep/z.md': 'z\n', 'notes/b/y.md': 'y\n', 'notes/b/clash.md': 'mine\n', 'archive/b/clash.md': 'theirs\n', 'archive/b/keep.md': 'keep\n' } });
    const t = (await r.call('move', { paths: ['notes/a/x.md', 'notes/a/deep/z.md', 'notes/b/y.md', 'notes/b/clash.md'], to_folder: 'archive' })).text.split('\n');
    expect(t).toEqual([
      expect.stringMatching(/^Moved 3 of 4 items into archive · undo: [a-f0-9]{8}$/),
      expect.stringMatching(/^ok notes\/a\/x\.md → archive\/a\/x\.md/),
      expect.stringMatching(/^ok notes\/a\/deep\/z\.md → archive\/a\/deep\/z\.md/),
      expect.stringMatching(/^ok notes\/b\/y\.md → archive\/b\/y\.md/),
      'EEXIST notes/b/clash.md: Already exists: archive/b/clash.md',
    ]);
    expect([r.get('archive/a/deep/z.md'), r.get('archive/b/y.md'), r.get('archive/b/keep.md'), r.get('archive/b/clash.md'), r.get('notes/b/clash.md')]).toEqual(['z\n', 'y\n', 'keep\n', 'theirs\n', 'mine\n']);
    const row = (await r.rows()).reverse().find((x) => x.tool === 'move')!;
    await r.revert(row.journal!);
    expect([r.get('notes/a/x.md'), r.get('notes/a/deep/z.md'), r.get('notes/b/y.md'), r.get('archive/b/y.md')]).toEqual(['x\n', 'z\n', 'y\n', null]);
  });

  it('flat: everything directly in to_folder (name clashes refused per item)', async () => {
    const r = await rig({ files: { 'n/a/x.md': 'a\n', 'n/b/x.md': 'b\n', 'n/c/y.md': 'c\n' } });
    const t = (await r.call('move', { paths: ['n/a/x.md', 'n/b/x.md', 'n/c/y.md'], to_folder: 'flat', flat: true })).text.split('\n');
    expect(t.slice(1)).toEqual([expect.stringMatching(/^ok n\/a\/x\.md → flat\/x\.md/), 'EEXIST n/b/x.md: Already exists: flat/x.md', expect.stringMatching(/^ok n\/c\/y\.md → flat\/y\.md/)]);
  });

  it('to_paths: a new path per item; exclusive with to_folder / flat; the lengths must match', async () => {
    const r = await rig({ files: { 'a.md': 'a\n', 'b.md': 'b\n' } });
    expect((await r.call('move', { paths: ['a.md', 'b.md'], to_paths: ['x/one.md'] })).text).toBe('EINVAL: to_paths must name one new path per item (2), not 1');
    expect((await r.call('move', { paths: ['a.md'], to_paths: ['x.md'], to_folder: 'x' })).text).toMatch(/^EINVAL: to_paths replaces to_folder and flat/);
    expect((await r.call('move', { paths: ['a.md'], to_paths: ['x.md'], flat: true })).text).toMatch(/^EINVAL: to_paths replaces to_folder and flat/);
    const t = (await r.call('move', { paths: ['a.md', 'b.md'], to_paths: ['x/one.md', 'y/z/two.md'] })).text.split('\n');
    expect(t[0]).toMatch(/^Moved 2 of 2 items · undo: /);
    expect([r.get('x/one.md'), r.get('y/z/two.md')]).toEqual(['a\n', 'b\n']);
  });

  it('a folder into an existing folder of that name is refused clearly (folders are not merged); hidden destinations too', async () => {
    const r = await rig({ files: { 'src/proj/a.md': 'a\n', 'archive/proj/old.md': 'old\n', 'src/other/b.md': 'b\n' } });
    const t = (await r.call('move', { paths: ['src/proj', 'src/other'], to_folder: 'archive' })).text.split('\n');
    expect(t[1]).toBe('EEXIST src/proj: archive/proj exists: folders are not merged. Move what src/proj holds instead (paths: src/proj/…).');
    expect(t[2]).toBe('ok src/other → archive/other');
    expect(r.get('archive/proj/old.md')).toBe('old\n');
    expect((await r.call('move', { paths: ['src/proj/a.md'], to_folder: '.hidden' })).text).toMatch(/EACCES src\/proj\/a\.md: Cannot change \.hidden\/a\.md/);
  });
});
