// Shared vault keys (`vault:<key>` in variables.md) work across folders by design — and a folder that
// came from someone else can name any of them. The first time a folder uses one it did not save, main
// asks the user (natively: the page cannot answer), remembers "allow" in the vault file, and sends
// nothing on "deny".
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultService, registerVaultIpc, sharedKeyMessage, type VaultSharedKeyRequest } from '../../../src/main/vault';
import { VAULT_CHANNELS } from '../../../src/shared/vault';

const dir = path.resolve(__dirname, '../../../.tmp/sec-desktop/unit-vault-shared');
fs.mkdirSync(dir, { recursive: true });
afterAll(() => fsp.rm(dir, { recursive: true, force: true }));
const crypto = { isAvailable: () => true, encrypt: (s: string) => Buffer.from(`enc:${s}`, 'utf8'), decrypt: (b: Buffer) => b.toString('utf8').slice(4) };

function vault(name: string, answer: boolean | ((q: VaultSharedKeyRequest) => Promise<boolean>) = false) {
  const state = { root: '/home/me/work' as string | null, asked: [] as VaultSharedKeyRequest[], answer };
  const file = path.join(dir, `${name}.json`);
  const make = () =>
    new VaultService(file, crypto, {
      root: () => state.root,
      os: 'linux',
      confirmSharedKey: async (q) => {
        state.asked.push(q);
        return typeof state.answer === 'function' ? state.answer(q) : state.answer;
      },
    });
  return { v: make(), state, file, reopen: make };
}
const denied = { code: 'EACCES' };

describe('shared vault keys across folders', () => {
  it('the folder that saved a key uses it without a question', async () => {
    const { v, state } = vault('own');
    await v.set('prod-db', 'hunter2');
    expect(await v.get('prod-db')).toBe('hunter2');
    await v.set('prod-db', 'hunter3');
    expect(state.asked).toEqual([]);
  });

  it('another folder: asked once, natively; deny sends nothing and is not asked again this session', async () => {
    const { v, state, file } = vault('deny', false);
    await v.set('prod-db', 'hunter2');
    state.root = '/home/me/Downloads/cloned-repo';
    await expect(v.get('prod-db')).rejects.toMatchObject(denied);
    await expect(v.get('prod-db')).rejects.toMatchObject(denied);
    await expect(v.set('prod-db', 'overwritten')).rejects.toMatchObject(denied);
    await expect(v.remove('prod-db')).rejects.toMatchObject(denied);
    expect(state.asked).toEqual([{ key: 'prod-db', root: '/home/me/Downloads/cloned-repo', owner: '/home/me/work', action: 'read' }]);
    expect(await v.has(['prod-db'])).toEqual(['prod-db']); // "is set" shows masked; the value never left
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants ?? {}).toEqual({});
    state.root = '/home/me/work';
    expect(await v.get('prod-db')).toBe('hunter2'); // untouched
  });

  it('allow: the value is served and the grant is remembered in the vault file, per folder and key', async () => {
    const { v, state, file, reopen } = vault('allow', true);
    await v.set('prod-db', 'hunter2');
    await v.set('other-key', 'x');
    state.root = '/home/me/projects/site';
    expect(await v.get('prod-db')).toBe('hunter2');
    expect(await v.get('prod-db')).toBe('hunter2');
    expect(state.asked).toHaveLength(1);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(disk.owners).toEqual({ 'prod-db': '/home/me/work', 'other-key': '/home/me/work' });
    expect(disk.grants).toEqual({ '/home/me/projects/site': ['prod-db'] });
    expect(JSON.stringify(disk)).not.toContain('hunter2');
    // After a restart the grant still holds; another key and another folder ask again.
    const again = reopen();
    state.answer = false;
    expect(await again.get('prod-db')).toBe('hunter2');
    await expect(again.get('other-key')).rejects.toMatchObject(denied);
    state.root = '/home/me/projects/site2';
    await expect(again.get('prod-db')).rejects.toMatchObject(denied);
    expect(state.asked.map((q) => `${q.root}:${q.key}`)).toEqual(['/home/me/projects/site:prod-db', '/home/me/projects/site:other-key', '/home/me/projects/site2:prod-db']);
  });

  it('several calls while the question is open share one dialog', async () => {
    let release!: (ok: boolean) => void;
    const { v, state } = vault('single', () => new Promise<boolean>((r) => (release = r)));
    await v.set('api-token', 't');
    state.root = '/elsewhere';
    const calls = [v.get('api-token'), v.get('api-token'), v.get('api-token')];
    await new Promise((r) => setTimeout(r, 20));
    expect(state.asked).toHaveLength(1);
    release(true);
    expect(await Promise.all(calls)).toEqual(['t', 't', 't']);
  });

  it('keys from before owners were recorded count as someone else’s; a removed key forgets owner and grants', async () => {
    const file = path.join(dir, 'legacy.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { 'old-key': Buffer.from('enc:legacy').toString('base64') } }));
    const asked: VaultSharedKeyRequest[] = [];
    const v = new VaultService(file, crypto, { root: () => '/home/me/work', os: 'linux', confirmSharedKey: async (q) => (asked.push(q), true) });
    expect(await v.get('old-key')).toBe('legacy');
    expect(asked).toEqual([{ key: 'old-key', root: '/home/me/work', owner: null, action: 'read' }]);
    await v.remove('old-key');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ entries: {}, grants: { '/home/me/work': [] } });
    await v.set('old-key', 'fresh'); // new again: this folder's own
    expect(await v.get('old-key')).toBe('fresh');
    expect(asked).toHaveLength(1);
  });

  it('no dialog available, a failing dialog or no folder open: refused', async () => {
    const file = path.join(dir, 'nodialog.json');
    let root: string | null = '/a';
    const plain = new VaultService(file, crypto, { root: () => root, os: 'linux' });
    await plain.set('k', 'v');
    root = '/b';
    await expect(plain.get('k')).rejects.toMatchObject(denied);
    const broken = new VaultService(file, crypto, { root: () => root, os: 'linux', confirmSharedKey: async () => Promise.reject(new Error('no window')) });
    await expect(broken.get('k')).rejects.toMatchObject(denied);
    root = null;
    await expect(new VaultService(file, crypto, { root: () => root, os: 'linux', confirmSharedKey: async () => true }).get('k')).rejects.toMatchObject(denied);
  });

  it('folder-scoped keys never ask (they are tied to the open folder already)', async () => {
    const { v, state } = vault('scoped', true);
    await v.set('/home/me/work::prod/db_pass', 's');
    expect(await v.get('/home/me/work::prod/db_pass')).toBe('s');
    state.root = '/home/me/other';
    await expect(v.get('/home/me/work::prod/db_pass')).rejects.toMatchObject(denied);
    expect(state.asked).toEqual([]);
  });

  it('the dialog text names the key and where it came from, on one line each, shortened', () => {
    const m = sharedKeyMessage({ key: 'prod-db', root: '/home/me/Downloads/cloned-repo', owner: '/home/me/work/lab', action: 'read' });
    expect(m.message).toBe('This folder wants to use the secret “prod-db” (saved from “lab”). Allow?');
    expect(m.detail).toContain('Folder: /home/me/Downloads/cloned-repo');
    expect(sharedKeyMessage({ key: 'k', root: 'C:\\x', owner: 'c:/users/me/notes/', action: 'change' }).message).toBe('This folder wants to change the secret “k” (saved from “notes”). Allow?');
    const odd = sharedKeyMessage({ key: `a${' '.repeat(40)}b${'x'.repeat(300)}`, root: '/r', owner: null, action: 'read' });
    expect(odd.message).toContain('saved earlier, from another folder');
    expect(odd.message.length).toBeLessThan(200);
    expect(odd.message).not.toMatch(/\s{2,}/);
  });
});

describe('several windows: one vault, scoped by the calling window', () => {
  it('folder A cannot read folder B’s key; shared keys keep their rules per folder; an unknown window is refused', async () => {
    const file = path.join(dir, 'windows.json');
    const roots = new Map<number, string | null>([[1, '/home/me/a'], [2, '/home/me/b'], [3, null]]);
    const asked: VaultSharedKeyRequest[] = [];
    const scopeOf = (e: unknown) => {
      const id = (e as { id: number }).id;
      if (!roots.has(id)) return null; // not a window of ours
      return { root: () => roots.get(id) ?? null, os: 'linux', confirmSharedKey: async (q: VaultSharedKeyRequest) => (asked.push(q), id === 2 ? false : true) };
    };
    // The constructor's scope is some other folder: the caller's must win on every call.
    const v = new VaultService(file, crypto, { root: () => '/somewhere/else', os: 'linux' });
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    registerVaultIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, v, { isTrusted: () => true, scopeOf });
    const call = (win: number, ch: string, ...a: unknown[]) => handlers.get(ch)!({ id: win }, ...a) as Promise<{ ok: boolean; result?: unknown; error?: { code: string } }>;
    const no = { ok: false, error: { code: 'EACCES' } };

    expect(await call(1, VAULT_CHANNELS.set, '/home/me/a::db', 'secret-a')).toEqual({ ok: true, result: undefined });
    expect(await call(2, VAULT_CHANNELS.set, '/home/me/b::db', 'secret-b')).toEqual({ ok: true, result: undefined });
    expect(await call(1, VAULT_CHANNELS.get, '/home/me/a::db')).toEqual({ ok: true, result: 'secret-a' });
    expect(await call(2, VAULT_CHANNELS.get, '/home/me/a::db')).toMatchObject(no);
    expect(await call(1, VAULT_CHANNELS.get, '/home/me/b::db')).toMatchObject(no);
    expect(await call(2, VAULT_CHANNELS.set, '/home/me/a::db', 'overwrite')).toMatchObject(no);
    expect(await call(2, VAULT_CHANNELS.remove, '/home/me/a::db')).toMatchObject(no);
    expect(await call(2, VAULT_CHANNELS.has, ['/home/me/a::db', '/home/me/b::db'])).toEqual({ ok: true, result: ['/home/me/b::db'] });
    expect(await call(3, VAULT_CHANNELS.has, ['/home/me/a::db'])).toEqual({ ok: true, result: [] }); // no folder: no folder keys

    // A shared key belongs to the window that saved it; another asks in ITS dialog (deny there, allow elsewhere).
    expect(await call(1, VAULT_CHANNELS.set, 'api', 'shared-v')).toEqual({ ok: true, result: undefined });
    expect(await call(1, VAULT_CHANNELS.get, 'api')).toEqual({ ok: true, result: 'shared-v' });
    expect(asked).toEqual([]);
    expect(await call(2, VAULT_CHANNELS.get, 'api')).toMatchObject(no);
    expect(await call(2, VAULT_CHANNELS.get, 'api')).toMatchObject(no); // denied for this session, not asked again
    expect(asked).toEqual([{ key: 'api', root: '/home/me/b', owner: '/home/me/a', action: 'read' }]);
    expect(await call(3, VAULT_CHANNELS.get, 'api')).toMatchObject(no); // a window without a folder
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).owners).toEqual({ api: '/home/me/a' });

    // The window opens another folder: the scope follows it on the next call.
    roots.set(1, '/home/me/c');
    expect(await call(1, VAULT_CHANNELS.get, '/home/me/a::db')).toMatchObject(no);
    expect(await call(1, VAULT_CHANNELS.get, 'api')).toEqual({ ok: true, result: 'shared-v' }); // c allowed in its dialog
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).grants).toEqual({ '/home/me/c': ['api'] });

    // Not a window of ours: every key call is refused (status stays harmless).
    for (const [ch, ...a] of [[VAULT_CHANNELS.get, 'api'], [VAULT_CHANNELS.has, ['api']], [VAULT_CHANNELS.set, 'api', 'x'], [VAULT_CHANNELS.remove, 'api']] as const) expect(await call(9, ch, ...a)).toMatchObject(no);
    expect(await call(9, VAULT_CHANNELS.status)).toMatchObject({ ok: true, result: { available: true } });
    expect(await call(1, VAULT_CHANNELS.get, 'api')).toEqual({ ok: true, result: 'shared-v' });
  });

  it('without scopeOf: the constructor’s scope, as before', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const v = new VaultService(path.join(dir, 'one-window.json'), crypto, { root: () => '/home/me/a', os: 'linux' });
    registerVaultIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, v, { isTrusted: () => true });
    expect(await handlers.get(VAULT_CHANNELS.set)!({}, '/home/me/a::k', 'v')).toEqual({ ok: true, result: undefined });
    expect(await handlers.get(VAULT_CHANNELS.get)!({}, '/home/me/b::k')).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    // A per-call scope on the service itself wins over the constructor's.
    await expect(v.get('/home/me/a::k', { root: () => '/home/me/b', os: 'linux' })).rejects.toMatchObject({ code: 'EACCES' });
    expect(await v.get('/home/me/a::k')).toBe('v');
  });
});
