// Secrets vault (main process): `vault.json` in the user-data folder maps key → safeStorage ciphertext
// (base64). Values never leave this process except to the trusted app window that asks for one, and
// are never logged. Every IPC argument is validated here (the preload only coerces types).
import path from 'node:path';
import fsp from 'node:fs/promises';
import { readJson, writeJson } from '../backend/service';
import { VAULT_CHANNELS as CH, VAULT_LIMITS, isVaultKey, vaultKeyFolder, vaultKeyInScope, vaultRootScope, isVaultValue, type VaultReply, type VaultStatus } from '../shared/vault';

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
  /** Shared keys (`vault:<key>`): the folder (scope) that saved each one. Absent for keys from before this existed. */
  owners?: Record<string, string>;
  /** Folder (scope) → shared keys of other folders the user allowed it to use. */
  grants?: Record<string, string[]>;
}

/** Asked (in a native dialog, by main) before a folder uses a shared key another folder saved. */
export interface VaultSharedKeyRequest {
  key: string;
  /** The folder that asks (absolute path as opened). */
  root: string;
  /** Scope of the folder that saved the key; null = unknown (saved before owners were recorded). */
  owner: string | null;
  action: 'read' | 'change';
}

export interface VaultScope {
  root: () => string | null;
  os?: string;
  /**
   * A shared key (`vault:<key>`, no folder in its name) is usable from any folder by design — and a note
   * or variables.md that came with a folder can name any of them. So the first time a folder touches one
   * it did not save itself, the user is asked here, outside the page (a taken-over page cannot answer).
   * Absent → such a use is refused.
   */
  confirmSharedKey?: (q: VaultSharedKeyRequest) => Promise<boolean>;
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
    /** The open folder (null: none) and platform: folder-scoped keys are only served below it. Omitted = no scoping (tests). */
    private readonly scope?: VaultScope,
  ) {}

  /** Questions on screen (one dialog per folder + key, however many calls wait) and this session's refusals. */
  private asking = new Map<string, Promise<boolean>>();
  private denied = new Set<string>();

  /**
   * Shared keys: free for the folder that saved them and for folders the user allowed; anyone else asks
   * once (the answer "allow" is kept in the vault file, "deny" for this session). Folder-scoped keys never
   * get here (check() already tied them to the open folder).
   */
  private async allowShared(key: string, action: 'read' | 'change'): Promise<void> {
    if (!this.scope || vaultKeyFolder(key) !== null) return;
    const d = await this.load();
    if (!Object.hasOwn(d.entries, key)) return; // nothing saved under it: nothing to protect (set() records the owner)
    const root = this.scope.root();
    const refuse = new VaultError('EACCES', 'This folder is not allowed to use that secret');
    if (root === null) throw refuse;
    const me = vaultRootScope(root, this.scope.os ?? process.platform);
    const owner = d.owners && Object.hasOwn(d.owners, key) ? d.owners[key] : null;
    if (owner === me || (d.grants && Object.hasOwn(d.grants, me) && d.grants[me].includes(key))) return;
    const id = `${me}\u0000${key}`;
    if (this.denied.has(id) || !this.scope.confirmSharedKey) throw refuse;
    let q = this.asking.get(id);
    if (!q) {
      q = this.scope.confirmSharedKey({ key, root, owner, action }).then((ok) => ok === true, () => false).finally(() => this.asking.delete(id));
      this.asking.set(id, q);
    }
    if (!(await q)) {
      this.denied.add(id);
      throw refuse;
    }
    const grants = (d.grants ??= {});
    const mine = Object.hasOwn(grants, me) ? grants[me] : (grants[me] = []);
    if (!mine.includes(key)) {
      mine.push(key);
      await this.save();
    }
  }

  private inScope(key: string): boolean {
    return !this.scope || vaultKeyInScope(key, this.scope.root(), this.scope.os ?? process.platform);
  }

  /** A well-formed key of another folder: refused the same way for get / set / remove. */
  private check(key: unknown): asserts key is string {
    if (!isVaultKey(key)) throw new VaultError('EINVAL', 'Invalid key');
    if (!this.inScope(key)) throw new VaultError('EACCES', 'This secret belongs to another folder');
  }

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
      const data: VaultFile = { version: 1, entries: clean };
      const raw = (d ?? {}) as { owners?: unknown; grants?: unknown };
      if (raw.owners && typeof raw.owners === 'object') {
        data.owners = {};
        for (const [k, v] of Object.entries(raw.owners)) if (isVaultKey(k) && typeof v === 'string' && Object.hasOwn(clean, k)) data.owners[k] = v;
      }
      if (raw.grants && typeof raw.grants === 'object') {
        data.grants = {};
        for (const [k, v] of Object.entries(raw.grants)) if (Array.isArray(v)) data.grants[k] = v.filter((x): x is string => isVaultKey(x) && Object.hasOwn(clean, x));
      }
      return (this.data = data);
    });
    return this.loading;
  }

  private ensure() {
    if (!this.status().available) throw new VaultError('ENOTSUP', 'Secure storage is not available on this system');
  }

  async has(keys: unknown): Promise<string[]> {
    if (!Array.isArray(keys) || keys.length > VAULT_LIMITS.maxBatch) throw new VaultError('EINVAL', 'Invalid key list');
    const d = await this.load();
    // Keys of other folders read as "not set": no way to probe what exists elsewhere.
    return keys.filter((k): k is string => isVaultKey(k) && this.inScope(k) && Object.hasOwn(d.entries, k));
  }

  async get(key: unknown): Promise<string | null> {
    this.check(key);
    this.ensure();
    const d = await this.load();
    if (!Object.hasOwn(d.entries, key)) return null;
    await this.allowShared(key, 'read');
    const c = d.entries[key];
    try {
      return this.crypto.decrypt(Buffer.from(c, 'base64'));
    } catch {
      // Encrypted by another user / machine (copied profile): unreadable, treat as unset.
      throw new VaultError('EIO', 'This secret can’t be decrypted on this computer — set it again');
    }
  }

  async set(key: unknown, value: unknown): Promise<void> {
    if (!isVaultKey(key) || !isVaultValue(value)) throw new VaultError('EINVAL', 'Invalid key or value');
    this.check(key);
    this.ensure();
    const d = await this.load();
    const isNew = !Object.hasOwn(d.entries, key);
    if (isNew && Object.keys(d.entries).length >= VAULT_LIMITS.maxEntries) throw new VaultError('ENOSPC', 'The vault is full');
    if (!isNew) await this.allowShared(key, 'change');
    else if (this.scope && vaultKeyFolder(key) === null) {
      // A new shared key belongs to the folder that saves it.
      const root = this.scope.root();
      if (root !== null) (d.owners ??= {})[key] = vaultRootScope(root, this.scope.os ?? process.platform);
    }
    d.entries[key] = this.crypto.encrypt(value).toString('base64');
    await this.save();
  }

  async remove(key: unknown): Promise<void> {
    this.check(key);
    const d = await this.load();
    if (!Object.hasOwn(d.entries, key)) return;
    await this.allowShared(key, 'change');
    delete d.entries[key];
    if (d.owners && Object.hasOwn(d.owners, key)) delete d.owners[key];
    for (const list of Object.values(d.grants ?? {})) if (list.includes(key)) list.splice(list.indexOf(key), 1);
    await this.save();
  }

  private async save() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await writeJson(this.file, this.data);
  }
}

/** Text of the "may this folder use that secret?" dialog. Names are data from files: shortened, one line. */
export function sharedKeyMessage(q: VaultSharedKeyRequest): { message: string; detail: string } {
  const one = (t: string, max: number) => {
    const line = t.replace(/\s+/g, ' ').trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  };
  const name = (p: string) => one(p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p, 60);
  const from = q.owner ? `saved from “${name(q.owner)}”` : 'saved earlier, from another folder';
  return {
    message: `This folder wants to ${q.action === 'read' ? 'use' : 'change'} the secret “${one(q.key, 80)}” (${from}). Allow?`,
    detail: `Folder: ${one(q.root, 200)}\n\nA note or variables.md in this folder refers to that secret by name. Allow it only if you trust this folder — the secret’s value becomes available to it. Your answer is remembered for this folder.`,
  };
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
