// Main's side (src/main/mcp.ts): mcp.json is written only here; widening steps need the native dialog's OK;
// refused folders; the mcp:* IPC guard; the activity tail.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { McpService, folderChoice, folderProblem, foldersConfirm, mcpLaunch, registerMcpIpc, type FolderBatch, type FolderChoice, type McpDeps } from '../../../src/main/mcp';
import { MCP_CHANNELS, MCP_WRITES_ENABLED, TOKEN_ENV } from '../../../src/shared/mcp';
import { hashToken, matchToken } from '../../../src/mcp/tokens';
import { OneMcpServer } from '../../../src/mcp/server';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit', `service-${crypto.randomBytes(4).toString('hex')}`);
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true }));

let n = 0;
function setup(o: Partial<McpDeps> = {}) {
  const dir = path.join(BASE, String(++n));
  const configDir = path.join(dir, 'appdata');
  const home = path.join(dir, 'home');
  const notes = path.join(home, 'notes');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(notes, { recursive: true });
  const answers = { enable: true, write: true, pick: notes as string | string[] | null, folders: true as boolean | FolderChoice, code: true, undoOff: true, token: true, keyring: true, copy: true };
  const changes: unknown[] = [];
  const batches: FolderBatch[] = [];
  const asked: string[] = [];
  const clip: string[] = [];
  let id = 0;
  const svc = new McpService({
    configDir,
    homedir: home,
    platform: 'linux',
    launch: () => ({ command: '/x/one', args: ['/x/cli.mjs', '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } }),
    confirmEnable: async () => (asked.push('enable'), answers.enable),
    confirmWrite: async () => (asked.push('write'), answers.write),
    pickFolders: async () => (asked.push('pick'), answers.pick === null ? [] : [answers.pick].flat()),
    // true = "Add read-only", false = Cancel, or the choice itself.
    confirmFolders: async (q) => (asked.push('folders'), batches.push(q), answers.folders === true ? { mode: 'read', allowCode: false } : answers.folders || null),
    realpath: (p) => fsp.realpath(p),
    isDirectory: (p) => fsp.stat(p).then((s) => s.isDirectory(), () => false),
    randomId: () => (++id).toString(16).padStart(16, '0'),
    onChange: (s) => changes.push(s),
    confirmAllowCode: async () => (asked.push('code'), answers.code),
    confirmUndoOff: async () => (asked.push('undoOff'), answers.undoOff),
    confirmToken: async (q) => (asked.push(`token:${q.kind}`), answers.token),
    // A stand-in keyring: reversible, but never the plain token on disk.
    tokenCrypto: { available: () => answers.keyring, encrypt: (x) => Buffer.from(`enc:${[...x].reverse().join('')}`), decrypt: (b) => [...b.toString().slice(4)].reverse().join('') },
    writeClipboard: (x) => void clip.push(x),
    readClipboard: () => clip.at(-1) ?? '',
    confirmCopy: async () => (asked.push('copy'), answers.copy),
    clipboardClearMs: 60_000,
    ...o,
  });
  const file = () => JSON.parse(fs.readFileSync(path.join(configDir, 'mcp.json'), 'utf8'));
  return { svc, answers, changes, asked, batches, clip, file, configDir, home, notes, dir };
}

describe('McpService', () => {
  it('is off by default; turning on asks first (a "no" changes nothing); turning off does not ask', async () => {
    const t = setup();
    expect((await t.svc.status()).enabled).toBe(false);
    t.answers.enable = false;
    expect((await t.svc.setEnabled(true)).enabled).toBe(false);
    expect(fs.existsSync(path.join(t.configDir, 'mcp.json'))).toBe(false);
    t.answers.enable = true;
    expect((await t.svc.setEnabled(true)).enabled).toBe(true);
    expect(t.file().enabled).toBe(true);
    expect(t.asked).toEqual(['enable', 'enable']); // the first token is made in the same confirmed step
    expect((await t.svc.setEnabled(false)).enabled).toBe(false);
    expect(t.asked).toHaveLength(2);
    await expect(t.svc.setEnabled('yes')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('shares a folder only through the dialog, read-only, with an alias; refuses duplicates', async () => {
    const t = setup();
    const s = await t.svc.addFolder();
    expect(s.folders).toEqual([expect.objectContaining({ alias: 'notes', path: fs.realpathSync(t.notes), mode: 'read' })]);
    expect(t.file().folders[0].mode).toBe('read');
    await expect(t.svc.addFolder()).rejects.toMatchObject({ code: 'EEXIST' });
    t.answers.pick = null; // cancelled
    expect((await t.svc.addFolder()).folders).toHaveLength(1);
    expect(t.changes.length).toBe(1);
  });

  it('refuses the home folder itself, a drive root, and anything around the app data folder', async () => {
    const t = setup();
    for (const pick of [t.home, '/', t.configDir, path.dirname(t.configDir)]) {
      t.answers.pick = pick;
      await expect(t.svc.addFolder(), pick).rejects.toMatchObject({ code: 'EACCES' });
    }
    fs.mkdirSync(path.join(t.configDir, 'inner'), { recursive: true });
    t.answers.pick = path.join(t.configDir, 'inner');
    await expect(t.svc.addFolder()).rejects.toMatchObject({ code: 'EACCES' });
    t.answers.pick = path.join(t.dir, 'nope');
    await expect(t.svc.addFolder()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes switched off (MCP_WRITES_ENABLED = false): Read-write is refused without a dialog', async () => {
    expect((await setup().svc.status()).writes).toBe(MCP_WRITES_ENABLED);
    const t = setup({ writesEnabled: false });
    const id = (await t.svc.addFolder()).folders[0].id;
    await expect(t.svc.setMode(id, 'write')).rejects.toMatchObject({ code: 'ENOTSUP' });
    expect(t.asked.filter((a) => a === 'write')).toEqual([]);
    expect(t.file().folders[0].mode).toBe('read');
  });

  it('allowing writes asks first; back to read-only and removing do not', async () => {
    const t = setup({ writesEnabled: true });
    const id = (await t.svc.addFolder()).folders[0].id;
    t.answers.write = false;
    expect((await t.svc.setMode(id, 'write')).folders[0].mode).toBe('read');
    t.answers.write = true;
    expect((await t.svc.setMode(id, 'write')).folders[0].mode).toBe('write');
    expect(t.file().folders[0].mode).toBe('write');
    expect((await t.svc.setMode(id, 'read')).folders[0].mode).toBe('read');
    expect(t.asked.filter((a) => a === 'write')).toHaveLength(2);
    await expect(t.svc.setMode(id, 'admin')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(t.svc.setMode('nope', 'read')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await t.svc.removeFolder(id)).folders).toEqual([]);
    await expect(t.svc.removeFolder(id)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('activity: newest first, bad lines skipped, at most the limit', async () => {
    const t = setup();
    const lines = [JSON.stringify({ t: 1, tool: 'read_file', ok: true }), 'garbage', JSON.stringify({ t: 2, tool: 'search_text', ok: false, code: 'EINVAL' })];
    fs.writeFileSync(path.join(t.configDir, 'mcp-audit.jsonl'), `${lines.join('\n')}\n`);
    const rows = await t.svc.activity();
    expect(rows.map((r) => r.tool)).toEqual(['search_text', 'read_file']);
    expect(await t.svc.activity(1)).toHaveLength(1);
  });
});

describe('several folders at once (one dialog, one confirm)', () => {
  const mk = (...parts: string[]) => {
    const d = path.join(...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const aliasesOf = (folders: Array<{ alias: string; path: string }>) => Object.fromEntries(folders.map((f) => [f.path, f.alias]));

  it('one confirm lists the batch; all added read-only; aliases unique and independent of the click order', async () => {
    const t = setup();
    await t.svc.addFolder(); // "notes": one folder gets the one dialog too
    expect(t.asked).toEqual(['pick', 'folders']);
    const a = mk(t.home, 'a', 'notes');
    const b = mk(t.home, 'b', 'notes');
    const w = mk(t.home, 'Work Docs');
    t.answers.pick = [b, w, a];
    const s = await t.svc.addFolder();
    expect(t.asked).toEqual(['pick', 'folders', 'pick', 'folders']);
    expect(t.batches[1]).toEqual({ add: [{ alias: 'work-docs', path: w }, { alias: 'notes-2', path: a }, { alias: 'notes-3', path: b }], refused: [], writes: MCP_WRITES_ENABLED });
    expect(s.folders.map((f) => [f.alias, f.mode])).toEqual([['notes', 'read'], ['work-docs', 'read'], ['notes-2', 'read'], ['notes-3', 'read']]);
    expect(t.file().folders.map((f: { mode: string }) => f.mode)).toEqual(['read', 'read', 'read', 'read']);
    expect(new Set(s.folders.map((f) => f.id)).size).toBe(4);
    expect(t.changes).toHaveLength(2); // one write for the whole batch

    // The same three, picked in another order: the same aliases.
    const u = setup();
    await u.svc.addFolder();
    u.answers.pick = [mk(u.home, 'a', 'notes'), mk(u.home, 'Work Docs'), mk(u.home, 'b', 'notes')].reverse();
    const again = aliasesOf((await u.svc.addFolder()).folders.map((f) => ({ ...f, path: path.relative(u.home, f.path) })));
    expect(again).toEqual(aliasesOf(s.folders.map((f) => ({ ...f, path: path.relative(t.home, f.path) }))));
  });

  it('skips what is already shared and refuses what cannot be shared, a reason each; picked twice through a link = once', async () => {
    const t = setup();
    await t.svc.addFolder();
    const x = mk(t.home, 'x');
    fs.symlinkSync(x, path.join(t.home, 'link-to-x'));
    t.answers.pick = [t.notes, t.home, t.configDir, path.join(t.dir, 'nope'), x, path.join(t.home, 'link-to-x')];
    const s = await t.svc.addFolder();
    const q = t.batches[1];
    expect(q.add).toEqual([{ alias: 'x', path: x }]);
    const why = Object.fromEntries(q.refused.map((r) => [r.path, r.why]));
    expect(Object.keys(why)).toHaveLength(5);
    expect(why[t.notes]).toBe('Already shared as “notes”');
    expect(why[t.home]).toMatch(/home folder/);
    expect(why[t.configDir]).toMatch(/own data/);
    expect(why[path.join(t.dir, 'nope')]).toBe('Not a folder');
    expect(why[x]).toBe('The same folder as “x”'); // sorted: the link came first; both lead to x
    expect(s.folders.map((f) => f.alias)).toEqual(['notes', 'x']);
  });

  it('Cancel in the confirm adds nothing', async () => {
    const t = setup();
    t.answers.pick = [t.notes, mk(t.home, 'more')];
    t.answers.folders = false;
    expect((await t.svc.addFolder()).folders).toEqual([]);
    expect(t.batches[0].add.map((f) => f.alias)).toEqual(['more', 'notes']);
    expect(fs.existsSync(path.join(t.configDir, 'mcp.json'))).toBe(false);
    expect(t.changes).toEqual([]);
  });

  it('all refused: only the reasons (no Add button), nothing written', async () => {
    const t = setup();
    t.answers.pick = [t.home, '/'];
    expect((await t.svc.addFolder()).folders).toEqual([]);
    expect(t.batches).toEqual([{ add: [], refused: [{ path: '/', why: expect.stringMatching(/drive/) }, { path: t.home, why: expect.stringMatching(/home folder/) }], writes: MCP_WRITES_ENABLED }]);
    expect(fs.existsSync(path.join(t.configDir, 'mcp.json'))).toBe(false);
    const box = foldersConfirm(t.batches[0]);
    expect(box.buttons).toEqual(['OK']);
    expect(box.title).toBe('No folder added');
    expect(box.detail).toContain(`• ${t.home}: Your whole home folder cannot be shared`);
  });

  it('the folder limit: the rest of a batch is refused with the reason', async () => {
    const t = setup();
    const folders = Array.from({ length: 31 }, (_, i) => ({ id: `${i + 1}`.padStart(8, 'f'), alias: `f${i}`, path: `/x/f${i}`, mode: 'read' }));
    fs.writeFileSync(path.join(t.configDir, 'mcp.json'), JSON.stringify({ version: 1, enabled: false, folders }));
    t.answers.pick = [mk(t.home, 'one'), mk(t.home, 'two')];
    const s = await t.svc.addFolder();
    expect(s.folders).toHaveLength(32);
    expect(t.batches[0].add.map((f) => f.alias)).toEqual(['one']);
    expect(t.batches[0].refused).toEqual([{ path: path.join(t.home, 'two'), why: 'At most 32 folders can be shared' }]);
    await expect(t.svc.addFolder()).rejects.toMatchObject({ code: 'ELIMIT' }); // full: not even the dialog
    expect(t.asked.filter((a) => a === 'pick')).toHaveLength(1);
  });

  it('the confirm text: every folder to add with its alias, the refused apart with why; three buttons, Cancel the default', () => {
    const box = foldersConfirm({ add: [{ alias: 'notes', path: '/h/notes' }, { alias: 'notes-2', path: '/h/b/notes' }], refused: [{ path: '/h', why: 'Your whole home folder cannot be shared: pick a folder inside it.' }] });
    expect(box).toMatchObject({ type: 'question', title: 'Share 2 folders?', message: 'Share these 2 folders with MCP clients?', buttons: ['Add read-only', 'Add and allow changes', 'Cancel'], defaultId: 2, cancelId: 2, checkboxLabel: 'Also code and config files', checkboxChecked: false });
    expect(box.detail.split('\n\n')).toEqual([
      'Folders:\n• notes: /h/notes\n• notes-2: /h/b/notes',
      'Not added:\n• /h: Your whole home folder cannot be shared: pick a folder inside it.',
      expect.stringMatching(/^Read-only: AI apps you set up can search and read them\. Allow changes: /),
    ]);
    expect(foldersConfirm({ add: [{ alias: 'a', path: '/a' }], refused: [] })).toMatchObject({ title: 'Share this folder?', message: 'Share “a” with MCP clients?' });
    // A build that ships read-only: no "allow changes", no checkbox.
    const ro = foldersConfirm({ add: [{ alias: 'a', path: '/a' }], refused: [], writes: false });
    expect(ro).toMatchObject({ buttons: ['Add read-only', 'Cancel'], defaultId: 1, cancelId: 1 });
    expect(ro.checkboxLabel).toBeUndefined();
    const many = foldersConfirm({ add: [{ alias: 'a', path: '/a' }], refused: Array.from({ length: 14 }, (_, i) => ({ path: `/r${i}`, why: 'Not a folder' })) });
    expect(many.detail).toContain('• /r9: Not a folder\n…and 4 more');
    expect(many.detail).not.toContain('/r10');
  });

  it('a running server serves every folder of the batch (mcp.json passes its grant checks)', async () => {
    const t = setup();
    t.answers.pick = [t.notes, mk(t.home, 'b', 'notes'), mk(t.home, 'Work Docs')];
    await t.svc.addFolder();
    const server = new OneMcpServer({ configDir: t.configDir, settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, trash: async () => {} });
    try {
      expect(server.applyConfig(t.file())).toBe(true);
      await server.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lm' } } });
      const r = (await server.protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_folders', arguments: {} } })) as { result: { content: Array<{ text: string }> } };
      const rows = r.result.content[0].text.split('\n');
      expect(rows[0]).toBe('3 folders');
      expect(rows.slice(1).map((x) => x.split(' ')[0]).sort()).toEqual(['notes', 'notes-2', 'work-docs']);
    } finally {
      await server.dispose();
    }
  });
});

describe('Revert (main)', () => {
  it('undoes an MCP write while the folder is shared; marks the row; refuses bad ids and unshared folders', async () => {
    const trashed: string[] = [];
    const t = setup({ settings: async () => ({ ...DEFAULT_SETTINGS }), trash: async (p) => void trashed.push(p), writesEnabled: true });
    const id = (await t.svc.addFolder()).folders[0].id;
    await t.svc.setMode(id, 'write');
    fs.writeFileSync(path.join(t.notes, 'n.md'), 'old text\n');
    const server = new OneMcpServer({ configDir: t.configDir, settings: { ...DEFAULT_SETTINGS }, transport: 'stdio', win: false, trash: async () => {}, writes: true });
    server.applyConfig(JSON.parse(fs.readFileSync(path.join(t.configDir, 'mcp.json'), 'utf8')));
    await server.protocol.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lm' } } });
    await server.protocol.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'append_file', arguments: { path: 'n.md', content: 'ai text' } } });
    await server.dispose();
    expect(fs.readFileSync(path.join(t.notes, 'n.md'), 'utf8')).toBe('old text\nai text\n');
    const row = (await t.svc.activity()).find((r) => r.tool === 'append_file')!;
    expect(row.journal).toBeTruthy();
    expect(row.reverted).toBe(false);
    await t.svc.setMode(id, 'read'); // Revert is restorative: it works on a folder that is read-only again
    expect(await t.svc.revert(row.journal)).toEqual({ reverted: 1 });
    expect(fs.readFileSync(path.join(t.notes, 'n.md'), 'utf8')).toBe('old text\n');
    const rows = await t.svc.activity();
    expect(rows.find((r) => r.journal === row.journal)!.reverted).toBe(true);
    expect(rows[0]).toMatchObject({ tool: 'revert', client: 'One', ok: true });
    await expect(t.svc.revert(row.journal)).rejects.toMatchObject({ code: 'EALREADY' });
    await expect(t.svc.revert('../x')).rejects.toMatchObject({ code: 'EINVAL' });
    await t.svc.removeFolder(id);
    await expect(t.svc.revert(row.journal)).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('grants behind native dialogs (main-owned, mcp.json)', () => {
  it('code files per folder: allowing asks, a "no" changes nothing, back to notes only does not ask', async () => {
    const t = setup({ writesEnabled: true });
    const id = (await t.svc.addFolder()).folders[0].id;
    t.answers.code = false;
    expect((await t.svc.setAllowCode(id, true)).folders[0].allowCode).toBeFalsy();
    t.answers.code = true;
    expect((await t.svc.setAllowCode(id, true)).folders[0].allowCode).toBe(true);
    expect(t.file().folders[0].allowCode).toBe(true);
    expect((await t.svc.setAllowCode(id, false)).folders[0].allowCode).toBeFalsy();
    expect(t.asked.filter((a) => a === 'code')).toHaveLength(2);
    await expect(t.svc.setAllowCode(id, 'yes')).rejects.toMatchObject({ code: 'EINVAL' });
  });

  it('undo copies: switching off asks; on and the age do not; days are clamped', async () => {
    const t = setup();
    t.answers.undoOff = false;
    expect((await t.svc.setUndo({ on: false })).undo.on).toBe(true);
    t.answers.undoOff = true;
    expect((await t.svc.setUndo({ on: false })).undo.on).toBe(false);
    expect((await t.svc.setUndo({ on: true, days: 9999 })).undo).toEqual({ on: true, days: 365 });
    expect(t.file().undo).toEqual({ on: true, days: 365 });
    expect(t.asked.filter((a) => a === 'undoOff')).toHaveLength(2);
    await expect(t.svc.setUndo({ on: 'off' })).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

describe('access tokens (main)', () => {
  const rawIn = (snippet: string) => /one_[A-Za-z0-9_-]{43}/.exec(snippet)?.[0];

  it('turning on makes the first token; its setup goes to the clipboard; mcp.json and the page only see hashes / names', async () => {
    const t = setup();
    const st = await t.svc.setEnabled(true, 'codex');
    expect(t.clip).toHaveLength(1);
    const raw = rawIn(t.clip[0])!;
    expect(t.clip[0]).toContain(`env = { ELECTRON_RUN_AS_NODE = '1', ${TOKEN_ENV} = '${raw}' }`); // Codex TOML env table, never argv
    expect(t.clip[0]).toMatch(/^\[mcp_servers\.one\]/);
    expect(st.tokens).toEqual([{ id: expect.any(String), name: 'First app', hint: raw.slice(4, 8), created: expect.any(Number), lastUsed: null, copyable: true }]);
    const onDisk = fs.readFileSync(path.join(t.configDir, 'mcp.json'), 'utf8');
    expect(onDisk).not.toContain(raw);
    expect(t.file().tokens[0].sha256).toBe(hashToken(raw));
    expect(fs.readFileSync(path.join(t.configDir, 'mcp-tokens.json'), 'utf8')).not.toContain(raw);
    expect(JSON.stringify(st)).not.toContain(raw);
    expect(JSON.stringify(st)).not.toContain(hashToken(raw));
    expect(JSON.stringify(t.changes)).not.toContain(raw);
    // Turning off and on again keeps the token (no new one, no clipboard write).
    await t.svc.setEnabled(false);
    await t.svc.setEnabled(true);
    expect(t.clip).toHaveLength(1);
  });

  it('a token per app: create / copy again / regenerate / revoke, each asked first; a "no" changes nothing', async () => {
    const t = setup();
    await t.svc.setEnabled(true);
    t.answers.token = false;
    expect((await t.svc.createToken('Codex CLI', 'codex')).tokens).toHaveLength(1);
    t.answers.token = true;
    await expect(t.svc.createToken('   ', 'codex')).rejects.toMatchObject({ code: 'EINVAL' });
    const st = await t.svc.createToken('Claude Code', 'claude-code');
    const tok = st.tokens.find((x) => x.name === 'Claude Code')!;
    const raw = rawIn(t.clip.at(-1)!)!;
    expect(t.clip.at(-1)).toContain(`--env ${TOKEN_ENV}=`);
    t.answers.copy = false; // copying again asks first ("Copy setup with the access token?")
    const n = t.clip.length;
    await expect(t.svc.copySetup(tok.id, 'lmstudio')).rejects.toMatchObject({ code: 'ECANCELED' });
    expect(t.clip).toHaveLength(n);
    t.answers.copy = true;
    expect(await t.svc.copySetup(tok.id, 'lmstudio')).toEqual({ copied: true });
    expect(JSON.parse(t.clip.at(-1)!).mcpServers.one.env[TOKEN_ENV]).toBe(raw);
    const records = () => t.file().tokens;
    expect(matchToken(raw, records())?.name).toBe('Claude Code');
    await t.svc.regenerateToken(tok.id, 'lmstudio');
    const raw2 = rawIn(t.clip.at(-1)!)!;
    expect(raw2).not.toBe(raw);
    expect(matchToken(raw, records())).toBeNull();
    expect(matchToken(raw2, records())?.id).toBe(tok.id);
    await t.svc.revokeToken(tok.id);
    expect(matchToken(raw2, records())).toBeNull();
    expect(records().map((x: any) => x.name)).toEqual(['First app']);
    await expect(t.svc.copySetup(tok.id, 'lmstudio')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(t.asked.filter((a) => a.startsWith('token:'))).toEqual(['token:create', 'token:create', 'token:regenerate', 'token:revoke']);
  });

  it('the clipboard is cleared after the delay, unless something else was copied meanwhile', async () => {
    const t = setup({ clipboardClearMs: 60 });
    await t.svc.setEnabled(true);
    expect(/one_/.test(t.clip.at(-1)!)).toBe(true);
    await expect.poll(() => t.clip.at(-1), { timeout: 2000 }).toBe('');
    const id = (await t.svc.status()).tokens[0].id;
    await t.svc.copySetup(id, 'lmstudio');
    t.clip.push('something the user copied');
    await new Promise((r) => setTimeout(r, 150));
    expect(t.clip.at(-1)).toBe('something the user copied');
  });

  it('no keyring (Linux without one): copied once when made, never stored raw; Copy setup says to regenerate', async () => {
    const t = setup();
    t.answers.keyring = false;
    const st = await t.svc.setEnabled(true);
    expect(st.tokenStore).toBe('once');
    expect(st.tokens[0].copyable).toBe(false);
    expect(rawIn(t.clip[0])).toBeTruthy();
    await expect(t.svc.copySetup(st.tokens[0].id, 'lmstudio')).rejects.toMatchObject({ code: 'ENOKEY' });
    expect(fs.existsSync(path.join(t.configDir, 'mcp-tokens.json')) ? fs.readFileSync(path.join(t.configDir, 'mcp-tokens.json'), 'utf8') : '').not.toContain('one_');
  });

  it('"last used" comes from the activity log (the server records the token id)', async () => {
    const t = setup();
    const id = (await t.svc.setEnabled(true)).tokens[0].id;
    fs.writeFileSync(path.join(t.configDir, 'mcp-audit.jsonl'), `${JSON.stringify({ t: 5_000_000, client: 'First app', transport: 'stdio', tool: 'read_file', folder: 'notes', path: 'a.md', ok: true, code: null, ms: 1, bytes: 1, token: id })}\n`);
    expect((await t.svc.activity())[0]).toMatchObject({ client: 'First app', token: id });
    await expect.poll(async () => (await t.svc.status()).tokens[0].lastUsed).toBe(5_000_000);
  });
});

describe('folderProblem (pure, Windows rules as strings)', () => {
  it('drive roots, the home folder (any case on Windows), the app data folder', () => {
    const w = { configDir: 'C:\\Users\\me\\AppData\\Roaming\\sec-edit', homedir: 'C:\\Users\\me', foldCase: true, p: path.win32 };
    expect(folderProblem('C:\\', w)).toMatch(/drive/);
    expect(folderProblem('D:\\', w)).toMatch(/drive/);
    expect(folderProblem('\\\\server\\share\\', w)).toMatch(/drive/);
    expect(folderProblem('c:\\users\\ME', w)).toMatch(/home/);
    expect(folderProblem('C:\\Users\\me\\AppData', w)).toMatch(/own data/);
    expect(folderProblem('C:\\Users\\me\\AppData\\Roaming\\SEC-EDIT\\x', w)).toMatch(/own data/);
    expect(folderProblem('C:\\Users\\me\\Notes', w)).toBeNull();
  });
});

describe('mcpLaunch + IPC guard', () => {
  it('no cli.mjs → no launch; untrusted senders are refused on every channel', async () => {
    expect(mcpLaunch({ execPath: '/x/one', cli: '/x/cli.mjs', exists: () => false })).toBeNull();
    expect(mcpLaunch({ execPath: '/x/one', cli: '/x/cli.mjs', exists: () => true })).toEqual({ command: '/x/one', args: ['/x/cli.mjs', '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } });
    const t = setup();
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    registerMcpIpc({ handle: (c, fn) => void handlers.set(c, fn) }, t.svc, { isTrusted: (e) => e === 'trusted' });
    expect([...handlers.keys()].sort()).toEqual(Object.values(MCP_CHANNELS).filter((c) => c !== MCP_CHANNELS.changed).sort());
    for (const fn of handlers.values()) expect(await fn('evil', true)).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    expect(t.asked).toEqual([]);
    expect(await handlers.get(MCP_CHANNELS.setEnabled)!('trusted', true)).toMatchObject({ ok: true, result: { enabled: true } });
  });
});

describe('the one "Add folders…" dialog decides the mode for the whole step', () => {
  const mk = (...parts: string[]) => {
    const d = path.join(...parts);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  it('each button / checkbox combination → those modes in mcp.json; no further dialog', async () => {
    const box = foldersConfirm({ add: [{ alias: 'a', path: '/a' }], refused: [] });
    expect(folderChoice(box, { response: 0, checkboxChecked: true })).toEqual({ mode: 'read', allowCode: false }); // the box counts only with changes
    expect(folderChoice(box, { response: 1, checkboxChecked: false })).toEqual({ mode: 'write', allowCode: false });
    expect(folderChoice(box, { response: 1, checkboxChecked: true })).toEqual({ mode: 'write', allowCode: true });
    expect(folderChoice(box, { response: 2, checkboxChecked: true })).toBeNull();
    expect(folderChoice(foldersConfirm({ add: [], refused: [{ path: '/', why: 'x' }] }), { response: 0 })).toBeNull(); // the notice
    for (const [choice, mode, code] of [
      [{ mode: 'read', allowCode: true }, 'read', undefined],
      [{ mode: 'write', allowCode: false }, 'write', undefined],
      [{ mode: 'write', allowCode: true }, 'write', true],
    ] as const) {
      const t = setup({ writesEnabled: true });
      t.answers.folders = choice;
      t.answers.pick = [mk(t.home, 'one'), mk(t.home, 'two')];
      await t.svc.addFolder();
      expect(t.file().folders.map((f: any) => [f.alias, f.mode, f.allowCode])).toEqual([['one', mode, code], ['two', mode, code]]);
      expect(t.asked).toEqual(['pick', 'folders']); // no write / code dialog on top
    }
  });

  it('a single folder gets the one dialog too; Cancel adds nothing; a read-only build never writes "write"', async () => {
    const t = setup({ writesEnabled: true });
    t.answers.folders = false;
    expect((await t.svc.addFolder()).folders).toEqual([]);
    expect(t.asked).toEqual(['pick', 'folders']);
    expect(fs.existsSync(path.join(t.configDir, 'mcp.json'))).toBe(false);
    const ro = setup({ writesEnabled: false });
    ro.answers.folders = { mode: 'write', allowCode: true };
    await ro.svc.addFolder();
    expect(ro.batches[0].writes).toBe(false);
    expect(ro.file().folders.map((f: any) => [f.mode, f.allowCode])).toEqual([['read', undefined]]);
  });
});
