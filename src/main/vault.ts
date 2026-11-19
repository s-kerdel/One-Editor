// Secrets vault (main process): `vault.json` in the user-data folder maps key → safeStorage ciphertext
// (base64). Values never leave this process except to the trusted app window that asks for one, and
// are never logged. Every IPC argument is validated here (the preload only coerces types).
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson, writeJson } from '../backend/service';
import { VAULT_CHANNELS as CH, VAULT_LIMITS, isVaultKey, isVaultValue, type VaultReply, type VaultStatus } from '../shared/vault';

export interface VaultCrypto {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
  /** Linux only (safeStorage.getSelectedStorageBackend). */
  backend?(): string;
}

interface VaultFile {
  version: 1;
  entries: Record<string, string>;
}

class VaultError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class VaultService {
  private data: VaultFile | null = null;
  private loading: Promise<VaultFile> | null = null;

  constructor(
    private readonly file: string,
    private readonly crypto: VaultCrypto,
  ) {}

  status(): VaultStatus {
    let available = false;
    try {
      available = this.crypto.isAvailable();
    } catch {}
    const backend = this.crypto.backend?.();
    return available ? { available, backend } : { available, backend, reason: 'The operating system’s secure storage is not available' };
  }

  private async load(): Promise<VaultFile> {
    if (this.data) return this.data;
    this.loading ??= readJson<VaultFile | null>(this.file, null).then((d) => {
      const entries = d && typeof d === 'object' && d.entries && typeof d.entries === 'object' ? d.entries : {};
      // Only well-formed rows survive a hand-edited / truncated file.
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(entries)) if (isVaultKey(k) && typeof v === 'string') clean[k] = v;
      return (this.data = { version: 1, entries: clean });
    });
    return this.loading;
  }

  private ensure() {
    if (!this.status().available) throw new VaultError('ENOTSUP', 'Secure storage is not available on this system');
  }

  async has(keys: unknown): Promise<string[]> {
    if (!Array.isArray(keys) || keys.length > VAULT_LIMITS.maxBatch) throw new VaultError('EINVAL', 'Invalid key list');
    const d = await this.load();
    return keys.filter((k): k is string => isVaultKey(k) && k in d.entries);
  }

  async get(key: unknown): Promise<string | null> {
    if (!isVaultKey(key)) throw new VaultError('EINVAL', 'Invalid key');
    this.ensure();
    const c = (await this.load()).entries[key];
    if (c === undefined) return null;
    try {
      return this.crypto.decrypt(Buffer.from(c, 'base64'));
    } catch {
      // Encrypted by another user / machine (copied profile): unreadable, treat as unset.
      throw new VaultError('EIO', 'This secret can’t be decrypted on this computer — set it again');
    }
  }

  async set(key: unknown, value: unknown): Promise<void> {
    if (!isVaultKey(key) || !isVaultValue(value)) throw new VaultError('EINVAL', 'Invalid key or value');
    this.ensure();
    const d = await this.load();
    if (!(key in d.entries) && Object.keys(d.entries).length >= VAULT_LIMITS.maxEntries) throw new VaultError('ENOSPC', 'The vault is full');
    d.entries[key] = this.crypto.encrypt(value).toString('base64');
    await this.save();
  }

  async remove(key: unknown): Promise<void> {
    if (!isVaultKey(key)) throw new VaultError('EINVAL', 'Invalid key');
    const d = await this.load();
    if (!(key in d.entries)) return;
    delete d.entries[key];
    await this.save();
  }

  private async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await writeJson(this.file, this.data);
  }
}

interface IpcLike {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void;
}

const reply = async <T>(fn: () => Promise<T> | T): Promise<VaultReply<T>> => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    // Messages are ours (no values in them); unexpected errors get a generic one.
    return err instanceof VaultError ? { ok: false, error: { code: err.code, message: err.message } } : { ok: false, error: { code: 'EIO', message: 'Vault error' } };
  }
};

export function registerVaultIpc(ipc: IpcLike, svc: VaultService, o: { isTrusted: (e: unknown) => boolean }): void {
  const denied: VaultReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
  const guard = (fn: (...a: unknown[]) => Promise<unknown> | unknown) => (e: unknown, ...a: unknown[]) => (o.isTrusted(e) ? reply(() => fn(...a)) : denied);
  ipc.handle(CH.status, guard(() => svc.status()));
  ipc.handle(CH.has, guard((keys) => svc.has(keys)));
  ipc.handle(CH.get, guard((key) => svc.get(key)));
  ipc.handle(CH.set, guard((key, value) => svc.set(key, value)));
  ipc.handle(CH.remove, guard((key) => svc.remove(key)));
}
