// Folder delete and move (`delete`, `move`): a folder delete takes everything (hidden items too) to the
// Recycle Bin after the user's OK, asked through MCP itself: legacy elicitation (a request to the client),
// 2026-07-28 input_required (MRTR), or two steps with a one-time code. No OS dialog anywhere. Folder moves
// take hidden items along and keep every entry's visibility. Trash: a fake one (never the real bin).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_SETTINGS, type Settings } from '../../../src/shared/api';
import { OneMcpServer } from '../../../src/mcp/server';
import { WriteQuota } from '../../../src/mcp/writes';
import { CONFIRM_TTL_MS, ConfirmCodes, folderSummary, shownName, shownPath } from '../../../src/mcp/confirm';
import { trashTimeout, windowsTrashCall } from '../../../src/backend/trash';
import { parseActivityLine } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit');
let tmp: string;
const cleanup: Array<() => unknown> = [];
beforeAll(() => {
  tmp = path.join(BASE, `folder-delete-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
});
afterAll(async () => {
  for (const c of cleanup) await c();
  fs.rmSync(tmp, { recursive: true, force: true });
});
let n = 0;
const put = (root: string, rel: string, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
/** A shared folder with a folder to delete: visible notes, a .git folder, a .env, a key file. */
function fixture() {
  const root = path.join(tmp, `ws${++n}`);
  put(root, 'proj/a.md', '# A\n');
  put(root, 'proj/sub/b.md', '# B\n');
  put(root, 'proj/.git/config', '[core]\n');
  put(root, 'proj/.env', 'TOKEN=1\n');
  put(root, 'proj/id_rsa', 'key\n');
  put(root, 'keep.md', 'keep\n');
  return root;
}

interface Rig {
  root: string;
  s: OneMcpServer;
  trashed: string[];
  out: any[];
  rpc(method: string, params?: Record<string, unknown>): Promise<any>;
  call(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>): Promise<any>;
}
async function rig(o: { era: 'legacy' | 'modern'; elicit: boolean; timeoutMs?: number; codes?: ConfirmCodes; settings?: Partial<Settings>; quota?: WriteQuota; trash?: (root: string, p: string) => Promise<void> }): Promise<Rig> {
  const root = fixture();
  const trashed: string[] = [];
  const s = new OneMcpServer({
    configDir: path.join(tmp, 'cfg'),
    settings: { ...DEFAULT_SETTINGS, ...o.settings } as Settings,
    transport: 'stdio',
    win: false,
    writes: true,
    trash: async (p) => {
      trashed.push(path.relative(root, p));
      if (o.trash) return o.trash(root, p);
      fs.rmSync(p, { recursive: true, force: true });
    },
    quota: o.quota ?? new WriteQuota({ session: 10_000, perMinute: 10_000 }),
    elicitTimeoutMs: o.timeoutMs,
    confirmCodes: o.codes,
  });
  cleanup.push(() => s.dispose());
  s.applyConfig({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'notes', path: root, mode: 'write' }] });
  const out: any[] = [];
  s.protocol.attach((m) => out.push(m));
  const caps = o.elicit ? { elicitation: {} } : {};
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'unit' }, 'io.modelcontextprotocol/clientCapabilities': caps };
  let id = 1;
  const rpc = (method: string, params: Record<string, unknown> = {}) => s.protocol.handle({ jsonrpc: '2.0', id: id++, method, params: o.era === 'modern' ? { ...params, _meta: meta } : params }) as Promise<any>;
  if (o.era === 'legacy') await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: caps, clientInfo: { name: 'unit' } });
  const call = (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args, ...extra });
  return { root, s, trashed, out, rpc, call };
}
const text = (r: any) => r.result?.content?.[0]?.text as string;
const exists = (r: Rig, rel: string) => fs.existsSync(path.join(r.root, rel));
/** Answers our next elicitation/create (legacy) once it was sent. */
async function answer(r: Rig, reply: Record<string, unknown> | null) {
  for (let i = 0; i < 200 && !r.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((res) => setTimeout(res, 5));
  const req = r.out.find((m) => m.method === 'elicitation/create');
  expect(req).toBeTruthy();
  r.out.splice(r.out.indexOf(req), 1);
  if (reply) await r.s.protocol.handle({ jsonrpc: '2.0', id: req.id, result: reply });
  return req;
}

describe('the summary the user sees (sanitized)', () => {
  it('counts files and folders, names a few hidden items, says where it goes', () => {
    // Windows, by the user's choice: no Windows prompt, and the question says what a bin that is off or too small does.
    expect(folderSummary('proj', { files: 37, folders: 4, hidden: ['.env', '.git', 'id_rsa'], hiddenCount: 3, bytes: 12.4 * 1024 * 1024, fingerprint: '' }, 'win32')).toBe('Delete folder "proj" and everything in it? 37 files, 4 folders, 12 MB (including hidden items such as .env, .git, id_rsa). It goes to the Recycle Bin; if the bin is off or too small for it, it is deleted permanently.');
    expect(folderSummary('x', { files: 1, folders: 0, hidden: [], hiddenCount: 0, bytes: 2048, fingerprint: '' }, 'darwin')).toBe('Delete folder "x" and everything in it? 1 file, 0 folders, 2 kB. It goes to the Trash.');
    expect(folderSummary('x', { files: 9, folders: 1, hidden: ['.a', '.b', '.c'], hiddenCount: 7, bytes: 3.2 * 1024 ** 3, fingerprint: '' }, 'linux')).toBe('Delete folder "x" and everything in it? 9 files, 1 folder, 3.2 GB (including hidden items such as .a, .b, .c, …). It goes to the Recycle Bin.');
  });

  it('control, bidi, zero-width and other invisible characters show as one visible mark; quotes cannot close the path; long names are cut', () => {
    const bidi = String.fromCharCode(0x202e, 0x2066, 0x200b, 0x200f, 0xfeff, 0x2028);
    expect(shownName(`evil${bidi}\n\t${String.fromCharCode(7)}name`, 40)).toBe('evil\uFFFD \uFFFDname');
    // Review round 6: soft hyphen, tag characters and other default-ignorables used to vanish, so a look-alike of
    // a real folder read exactly like it. Now each hidden run is visible.
    expect(shownName('photos' + String.fromCodePoint(0xe0041, 0xe0042), 40)).toBe('photos\uFFFD');
    expect(shownName('x\u00adhidden', 40)).toBe('x\uFFFDhidden');
    for (const cp of [0x034f, 0x180b, 0x1d173, 0x3164, 0xfe0f]) expect(shownName(`a${String.fromCodePoint(cp)}b`, 40)).toBe('a\uFFFDb');
    expect(shownName('Notes 2026 é', 40)).toBe('Notes 2026 é');
    expect(shownName('a"b“c”d', 40)).toBe("a'b'c'd");
    expect(Array.from(shownName('x'.repeat(500), 24))).toHaveLength(24);
    const spoof = 'x" and nothing in it? 0 files. It is safe to press Delete. "';
    const s = folderSummary(spoof, { files: 3, folders: 0, hidden: [], hiddenCount: 0, bytes: 10, fingerprint: '' }, 'win32');
    expect(s.match(/"/g)).toHaveLength(2); // exactly the two quotes of the template
    expect(Array.from(shownPath(`${'deep/'.repeat(60)}end`)).length).toBeLessThanOrEqual(120);
    expect(shownPath(`${'deep/'.repeat(60)}end`)).toMatch(/^…\/.*\/end$/);
  });
});

describe('two steps (a client without elicitation)', () => {
  it('a trash call that fails half-way says what is left, not "nothing was deleted" (review round 6)', async () => {
    // The fake bin moves one file, then fails (like a Windows trash call killed or cancelled mid-way).
    const r = await rig({ era: 'legacy', elicit: false, trash: async (root) => { fs.rmSync(path.join(root, 'proj/a.md')); throw new Error('killed'); } });
    const code = /confirm: (\S+)$/.exec(text(await r.call('delete', { path: 'proj' })))![1];
    const b = await r.call('delete', { path: 'proj', confirm: code });
    expect(b.result.isError).toBe(true);
    expect(text(b)).toMatch(/^EPARTIAL: Partly deleted: 1 item of 7 went to the Recycle Bin; 6 items are still in proj\.$/);
    expect(exists(r, 'proj/sub/b.md')).toBe(true);
  });

  it('a trash call that fails before touching anything still says nothing was deleted', async () => {
    const r = await rig({ era: 'legacy', elicit: false, trash: async () => { throw new Error('no bin'); } });
    const code = /confirm: (\S+)$/.exec(text(await r.call('delete', { path: 'proj' })))![1];
    const b = await r.call('delete', { path: 'proj', confirm: code });
    expect(text(b)).toMatch(/Nothing was deleted/);
    expect(exists(r, 'proj/a.md')).toBe(true);
  });

  it('first call: a summary and a code, nothing deleted, no quota used; second call with the code: all of it to the bin', async () => {
    const quota = new WriteQuota({ session: 1, perMinute: 10 });
    const r = await rig({ era: 'legacy', elicit: false, quota });
    const a = text(await r.call('delete', { path: 'proj' }));
    expect(a).toMatch(/^Delete folder "proj" and everything in it\? 5 files, 2 folders, 27 B \(including hidden items such as \.env, \.git, id_rsa\)\. It goes to the Recycle Bin\. .* · confirm: ([0-9A-Z]{4}-[0-9A-Z]{4})$/);
    expect(exists(r, 'proj/.git/config')).toBe(true);
    const code = /confirm: (\S+)$/.exec(a)![1];
    const b = await r.call('delete', { path: 'proj', confirm: code });
    expect(b.result.isError).toBeFalsy();
    expect(text(b)).toMatch(/^Deleted folder proj \(5 files, 2 folders, 27 B\) to the Recycle Bin: restore it from there/);
    expect(r.trashed).toEqual(['proj']); // one trash call for the folder
    expect(exists(r, 'proj')).toBe(false);
    expect(exists(r, 'keep.md')).toBe(true);
    // Used once: the same code again is refused (with a fresh summary and code); the quota (1) was spent once.
    put(r.root, 'proj/c.md');
    const again = await r.call('delete', { path: 'proj', confirm: code });
    expect(text(again)).toMatch(/^EQUOTA|^ECONFIRM/);
  });

  it('a reused, wrong-folder, expired or invented code, or a folder changed since: refused, a new summary + code', async () => {
    let now = 1_000_000;
    const r = await rig({ era: 'legacy', elicit: false, codes: new ConfirmCodes(() => now) });
    put(r.root, 'other/x.md');
    const ask = async (p: string) => /confirm: (\S+)$/.exec(text(await r.call('delete', { path: p })))![1];
    // wrong folder
    const c1 = await ask('proj');
    let t = text(await r.call('delete', { path: 'other', confirm: c1 }));
    expect(t).toMatch(/^ECONFIRM: Not deleted: that confirm code is for something else\. Delete folder "other" .* · confirm: \S+$/);
    // expired
    now += CONFIRM_TTL_MS + 1;
    t = text(await r.call('delete', { path: 'proj', confirm: c1 }));
    expect(t).toMatch(/^ECONFIRM: Not deleted: that confirm code expired/);
    // invented
    expect(text(await r.call('delete', { path: 'proj', confirm: 'AAAA-BBBB' }))).toMatch(/^ECONFIRM: Not deleted: that confirm code is not valid/);
    // changed since the summary (then the code is spent)
    const c2 = await ask('proj');
    put(r.root, 'proj/new.md');
    expect(text(await r.call('delete', { path: 'proj', confirm: c2 }))).toMatch(/^ECONFIRM: Not deleted: the folder changed since the summary/);
    expect(text(await r.call('delete', { path: 'proj', confirm: c2 }))).toMatch(/^ECONFIRM: Not deleted: that confirm code was used already/);
    expect(r.trashed).toEqual([]);
    expect(exists(r, 'proj/.git/config')).toBe(true);
  });

  it('a single file delete is unchanged: no question, an undo copy, the bin', async () => {
    const r = await rig({ era: 'legacy', elicit: false });
    const t = text(await r.call('delete', { path: 'keep.md' }));
    expect(t).toMatch(/^Deleted keep\.md \(Recycle Bin\) · undo: [a-f0-9]{8}$/);
    expect(r.trashed).toEqual(['keep.md']);
  });
});

describe('elicitation, legacy era (a request to the client, matched by id)', () => {
  const cases: Array<[string, Record<string, unknown> | null, RegExp, boolean]> = [
    ['accept, confirm=true', { action: 'accept', content: { confirm: true } }, /^Deleted folder proj/, true],
    ['accept, confirm=false', { action: 'accept', content: { confirm: false } }, /^ECANCELED: Not deleted: the user declined$/, false],
    ['decline', { action: 'decline' }, /^ECANCELED: Not deleted: the user declined$/, false],
    ['cancel', { action: 'cancel' }, /^ECANCELED: Not deleted: the user did not answer$/, false],
  ];
  for (const [label, reply, want, deleted] of cases) {
    it(label, async () => {
      const r = await rig({ era: 'legacy', elicit: true });
      const pending = r.call('delete', { path: 'proj' });
      const req = await answer(r, reply);
      expect(req.params.message).toBe('Delete folder "proj" and everything in it? 5 files, 2 folders, 27 B (including hidden items such as .env, .git, id_rsa). It goes to the Recycle Bin.');
      expect(req.params.mode).toBe('form');
      expect(req.params.requestedSchema).toMatchObject({ type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] });
      expect(text(await pending)).toMatch(want);
      expect(exists(r, 'proj')).toBe(!deleted);
    });
  }

  it('no answer in time: nothing deleted, the request is cancelled', async () => {
    const r = await rig({ era: 'legacy', elicit: true, timeoutMs: 80 });
    const pending = r.call('delete', { path: 'proj' });
    const req = await answer(r, null);
    expect(text(await pending)).toBe('ECANCELED: Not deleted: the user did not answer');
    expect(r.out).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: req.id, reason: 'No answer in time' } });
    expect(exists(r, 'proj')).toBe(true);
    // A late answer changes nothing.
    await r.s.protocol.handle({ jsonrpc: '2.0', id: req.id, result: { action: 'accept', content: { confirm: true } } });
    expect(exists(r, 'proj')).toBe(true);
  });

  it('the folder changed while the user was asked: not deleted', async () => {
    const r = await rig({ era: 'legacy', elicit: true });
    const pending = r.call('delete', { path: 'proj' });
    for (let i = 0; i < 200 && !r.out.some((m) => m.method === 'elicitation/create'); i++) await new Promise((res) => setTimeout(res, 5));
    put(r.root, 'proj/planted.md');
    await answer(r, { action: 'accept', content: { confirm: true } });
    expect(text(await pending)).toMatch(/^EXTERNAL_CHANGE: Not deleted: the folder changed while the user was asked/);
    expect(exists(r, 'proj/planted.md')).toBe(true);
  });

  it('an older client (2025-03-26) cannot be asked: two steps', async () => {
    const r = await rig({ era: 'legacy', elicit: false });
    await r.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: { elicitation: {} }, clientInfo: { name: 'old' } });
    expect(text(await r.call('delete', { path: 'proj' }))).toMatch(/· confirm: \S+$/);
    expect(r.out.some((m) => m.method === 'elicitation/create')).toBe(false);
  });
});

describe('elicitation, 2026-07-28 (Multi Round-Trip Requests)', () => {
  it('input_required with the question; the retry with accept deletes; the state is single-use', async () => {
    const r = await rig({ era: 'modern', elicit: true });
    const first = await r.call('delete', { path: 'proj' });
    expect(first.result.resultType).toBe('input_required');
    expect(first.result.inputRequests.confirm).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: expect.stringMatching(/^Delete folder "proj"/), requestedSchema: { required: ['confirm'] } } });
    const state = first.result.requestState as string;
    expect(exists(r, 'proj')).toBe(true);
    const second = await r.call('delete', { path: 'proj' }, { requestState: state, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
    expect(second.result.resultType).toBe('complete');
    expect(text(second)).toMatch(/^Deleted folder proj/);
    put(r.root, 'proj/x.md');
    const replay = await r.call('delete', { path: 'proj' }, { requestState: state, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
    expect(replay.result?.resultType).toBe('input_required'); // the folder differs now: asked again, never deleted on the old answer
    expect(exists(r, 'proj/x.md')).toBe(true);
  });

  it('decline → not deleted; a tampered state → Invalid Params; an expired one → "did not answer"', async () => {
    const r = await rig({ era: 'modern', elicit: true, timeoutMs: 60 });
    const first = await r.call('delete', { path: 'proj' });
    const state = first.result.requestState as string;
    const bad = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
    const t = await r.call('delete', { path: 'proj' }, { requestState: bad, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
    expect(t.error).toMatchObject({ code: -32602 });
    await new Promise((res) => setTimeout(res, 120));
    const late = await r.call('delete', { path: 'proj' }, { requestState: state, inputResponses: { confirm: { action: 'accept', content: { confirm: true } } } });
    expect(text(late)).toBe('ECANCELED: Not deleted: the user did not answer');
    const f2 = await r.call('delete', { path: 'proj' });
    const no = await r.call('delete', { path: 'proj' }, { requestState: f2.result.requestState, inputResponses: { confirm: { action: 'decline' } } });
    expect(text(no)).toBe('ECANCELED: Not deleted: the user declined');
    expect(exists(r, 'proj/.git/config')).toBe(true);
  });

  it('a modern client without elicitation gets the two steps (no input_required)', async () => {
    const r = await rig({ era: 'modern', elicit: false });
    const a = await r.call('delete', { path: 'proj' });
    expect(a.result.resultType).toBe('complete');
    expect(text(a)).toMatch(/· confirm: \S+$/);
  });
});

describe('activity rows and the bin', () => {
  it('"delete (folder)" with "restore from the Recycle Bin", no undo group', async () => {
    const r = await rig({ era: 'legacy', elicit: false });
    const code = /confirm: (\S+)$/.exec(text(await r.call('delete', { path: 'proj' })))![1];
    await r.call('delete', { path: 'proj', confirm: code });
    await r.s.audit.flush();
    const rows = fs.readFileSync(path.join(tmp, 'cfg', 'mcp-audit.jsonl'), 'utf8').trim().split('\n').map((l) => parseActivityLine(l)!).filter((x) => x.tool === 'delete (folder)');
    expect(rows.at(-2)).toMatchObject({ ok: false, code: 'ASKED', note: 'waiting for the user', journal: null });
    expect(rows.at(-1)).toMatchObject({ ok: true, note: 'restore from the Recycle Bin', journal: null, path: 'proj' });
  });

  it('Windows: one constant script; the path and "ask before deleting for good" come only through the environment', () => {
    const a = windowsTrashCall('C:\\Users\\u\\notes\\proj"; Remove-Item C:\\ -Recurse; "');
    const b = windowsTrashCall('C:\\other', { noPermanent: true });
    expect(a.file).toMatch(/powershell\.exe$/i);
    expect(a.args).toEqual(b.args); // the command line never changes
    expect(a.args.join(' ')).not.toContain('notes');
    expect(a.env).toEqual({ SEC_EDIT_TRASH_PATH: 'C:\\Users\\u\\notes\\proj"; Remove-Item C:\\ -Recurse; "' });
    expect(b.env).toEqual({ SEC_EDIT_TRASH_PATH: 'C:\\other' }); // folders too: no dialog mode (the user's choice)
    expect(a.args.at(-1)).not.toMatch(/AllDialogs|SEC_EDIT_TRASH_UI/);
    expect(a.args.at(-1)).toContain('$env:SEC_EDIT_TRASH_PATH');
    // Review round 6: a junction swapped in between the checks and PowerShell acting on the path is refused.
    expect(a.args.at(-1)).toMatch(/ReparsePoint\) \{ exit 4 \}/);
  });

  it('a whole folder may take long (big folder, or Windows asking before a permanent delete): no 20 s kill', () => {
    expect(trashTimeout()).toBe(20_000);
    expect(trashTimeout({ noPermanent: true })).toBe(15 * 60_000);
  });

  it('no OS dialog code: the question goes through MCP only', () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    const src = path.resolve(__dirname, '../../../src');
    for (const f of [...walk(path.join(src, 'mcp')), path.join(src, 'backend/trash.ts')]) {
      const t = fs.readFileSync(f, 'utf8');
      expect(/MessageBox|Windows\.Forms|display dialog|zenity|kdialog/.test(t), f).toBe(false);
    }
  });
});

describe('folder moves take hidden items along, every entry keeps its visibility', () => {
  it('dot files and key files move and stay hidden by name; nothing of them is read', async () => {
    const r = await rig({ era: 'legacy', elicit: false });
    const t = text(await r.call('move', { from: 'proj', to: 'archive/proj' }));
    expect(t).toMatch(/^Moved proj → archive\/proj/);
    for (const p of ['.git/config', '.env', 'id_rsa', 'sub/b.md']) expect(exists(r, `archive/proj/${p}`), p).toBe(true);
    expect((await r.call('read_file', { path: 'archive/proj/.env' })).result.isError).toBe(true);
  });

  it('a link inside is refused; so is a hidden / excluded destination', async () => {
    const r = await rig({ era: 'legacy', elicit: false, settings: { excludeGlobs: ['node_modules', 'docs/private'] } });
    fs.symlinkSync(path.join(r.root, 'keep.md'), path.join(r.root, 'proj/sub/link.md'));
    expect(text(await r.call('move', { from: 'proj', to: 'moved' }))).toMatch(/^EACCES: Cannot move proj: it holds links or special files/);
    fs.rmSync(path.join(r.root, 'proj/sub/link.md'));
    expect(text(await r.call('move', { from: 'proj', to: 'docs/private' }))).toBe('EACCES: Cannot change docs/private');
    expect(text(await r.call('move', { from: 'proj', to: '.hidden/proj' }))).toBe('EACCES: Cannot change .hidden/proj');
    expect(exists(r, 'proj/a.md')).toBe(true);
  });

  it('content under a rooted exclude may not leave it (it would become visible); visible content may not land in one', async () => {
    const r = await rig({ era: 'legacy', elicit: false, settings: { excludeGlobs: ['node_modules', 'docs/private'] } });
    put(r.root, 'docs/private/secret.md', 'top secret\n');
    put(r.root, 'docs/readme.md', '# R\n');
    expect(text(await r.call('move', { from: 'docs', to: 'old-docs' }))).toBe('EACCES: Cannot move docs to old-docs: items your exclusions hide there would become visible. Move it in One instead.');
    put(r.root, 'src/private/p.md', 'p\n');
    expect(text(await r.call('move', { from: 'src', to: 'docs' }))).toMatch(/^EEXIST|^EACCES: Cannot move src to docs$/);
    fs.rmSync(path.join(r.root, 'docs'), { recursive: true });
    expect(text(await r.call('move', { from: 'src', to: 'docs' }))).toBe('EACCES: Cannot move src to docs');
    expect(exists(r, 'src/private/p.md')).toBe(true);
  });
});
