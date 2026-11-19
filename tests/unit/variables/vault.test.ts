import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VaultService, registerVaultIpc } from '../../../src/main/vault';
import { vaultBridge } from '../../../src/main/vault-bridge';
import { VAULT_CHANNELS } from '../../../src/shared/vault';

const dir = path.resolve(__dirname, '../../../.tmp/vars/unit-vault');
fs.mkdirSync(dir, { recursive: true });
afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

// Reversible "encryption" that visibly changes the bytes (the real one is Electron safeStorage).
const fake = (available = true) => ({
  isAvailable: () => available,
  encrypt: (s: string) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x5a)),
  decrypt: (b: Buffer) => Buffer.from([...b].map((x) => x ^ 0x5a)).toString('utf8'),
});

describe('vault service', () => {
  it('stores only ciphertext on disk and reads it back', async () => {
    const file = path.join(dir, 'a.json');
    const v = new VaultService(file, fake());
    await v.set('C:/work/lab::db_pass', 'hunter2-SECRET');
    expect(await v.get('C:/work/lab::db_pass')).toBe('hunter2-SECRET');
    const raw = await fsp.readFile(file, 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).toContain('C:/work/lab::db_pass');
    // A fresh instance (next launch) reads the same file.
    const again = new VaultService(file, fake());
    expect(await again.has(['C:/work/lab::db_pass', 'nope'])).toEqual(['C:/work/lab::db_pass']);
    await again.remove('C:/work/lab::db_pass');
    expect(await again.get('C:/work/lab::db_pass')).toBeNull();
  });

  it('validates keys / values and refuses without secure storage', async () => {
    const v = new VaultService(path.join(dir, 'b.json'), fake());
    await expect(v.set('', 'x')).rejects.toThrow(/Invalid/);
    await expect(v.set('a\nb', 'x')).rejects.toThrow(/Invalid/);
    await expect(v.set('k', 'x'.repeat(20_000))).rejects.toThrow(/Invalid/);
    await expect(v.get(42)).rejects.toThrow(/Invalid/);
    await expect(v.has('nope')).rejects.toThrow(/Invalid/);
    const off = new VaultService(path.join(dir, 'c.json'), fake(false));
    expect(off.status()).toMatchObject({ available: false });
    await expect(off.set('k', 'v')).rejects.toMatchObject({ code: 'ENOTSUP' });
  });

  it('survives a corrupt file', async () => {
    const file = path.join(dir, 'd.json');
    await fsp.writeFile(file, '{"entries": {"ok": "AAAA", "bad\\u0001": 5}');
    expect(await new VaultService(file, fake()).has(['ok'])).toEqual([]);
    await fsp.writeFile(file, JSON.stringify({ version: 1, entries: { ok: 'AAAA', 'bad\u0001': 'x', n: 5 } }));
    expect(await new VaultService(file, fake()).has(['ok', 'n'])).toEqual(['ok']);
  });
});

describe('vault IPC', () => {
  it('answers trusted senders only, with no secret in error messages', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const svc = new VaultService(path.join(dir, 'ipc.json'), fake());
    registerVaultIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, svc, { isTrusted: (e) => (e as { ok: boolean }).ok });
    expect([...handlers.keys()].sort()).toEqual(Object.values(VAULT_CHANNELS).sort());
    const call = (ch: string, trusted: boolean, ...a: unknown[]) => handlers.get(ch)!({ ok: trusted }, ...a);
    expect(await call(VAULT_CHANNELS.set, false, 'k', 'v')).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    expect(await call(VAULT_CHANNELS.set, true, 'k', 'top-secret')).toEqual({ ok: true, result: undefined });
    expect(await call(VAULT_CHANNELS.get, true, 'k')).toEqual({ ok: true, result: 'top-secret' });
    const bad = (await call(VAULT_CHANNELS.set, true, 'k\n', 'top-secret')) as { error: { message: string } };
    expect(bad.error.message).not.toContain('top-secret');
    // The preload bridge coerces argument types.
    const sent: unknown[][] = [];
    const b = vaultBridge({ invoke: async (...a: unknown[]) => void sent.push(a) });
    await b.set(5 as never, { x: 1 } as never);
    await b.has('x' as never);
    expect(sent).toEqual([[VAULT_CHANNELS.set, '5', '[object Object]'], [VAULT_CHANNELS.has, []]]);
  });
});
