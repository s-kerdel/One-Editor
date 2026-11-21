// Main's side (src/main/mcp.ts): mcp.json is written only here; widening steps need the native dialog's OK;
// refused folders; the mcp:* IPC guard; the activity tail.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { McpService, folderProblem, mcpLaunch, registerMcpIpc, type McpDeps } from '../../../src/main/mcp';
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
  const answers = { enable: true, write: true, pick: notes as string | null, code: true, undoOff: true, token: true, keyring: true, copy: true };
  const changes: unknown[] = [];
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
    pickFolder: async () => (asked.push('pick'), answers.pick),
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
  return { svc, answers, changes, asked, clip, file, configDir, home, notes, dir };
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
