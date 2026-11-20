// Shared vault keys (`vault:<key>` in variables.md) work across folders by design — and a folder that
// came from someone else can name any of them. The first time a folder uses one it did not save, main
// asks the user (natively: the page cannot answer), remembers "allow" in the vault file, and sends
// nothing on "deny".
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultService, sharedKeyMessage, type VaultSharedKeyRequest } from '../../../src/main/vault';

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
