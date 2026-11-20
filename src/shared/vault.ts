// Secrets vault contract (desktop only). Values are encrypted with Electron safeStorage (DPAPI on
// Windows, Keychain on macOS, the Secret Service / kwallet on Linux) in the app's user-data folder —
// never in a note, never over HTTP. The browser build keeps typed secrets in memory for the session only.
export const VAULT_CHANNELS = {
  status: 'vault:status',
  has: 'vault:has',
  get: 'vault:get',
  set: 'vault:set',
  remove: 'vault:remove',
} as const;

export const VAULT_LIMITS = {
  maxKeyChars: 512,
  maxValueChars: 16_384,
  /** Keys per `has` call. */
  maxBatch: 512,
  maxEntries: 10_000,
} as const;

export interface VaultStatus {
  available: boolean;
  /** Linux: safeStorage backend ('basic_text' = no keyring, values are only obfuscated). */
  backend?: string;
  reason?: string;
}

export type VaultReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

/** Printable, bounded keys (they are names like "C:/work/lab::prod/db_pass", not secrets). */
export function isVaultKey(k: unknown): k is string {
  return typeof k === 'string' && k.length > 0 && k.length <= VAULT_LIMITS.maxKeyChars && !/[\u0000-\u001f\u007f]/.test(k);
}

export function isVaultValue(v: unknown): v is string {
  return typeof v === 'string' && v.length <= VAULT_LIMITS.maxValueChars;
}

/**
 * Default keys are scoped by the absolute folder of their variables.md: `<folder>::<env>/<target>.<name>`
 * (renderer: variables/store.ts `vaultScope`). Returns that folder, or null for a key without one — an
 * explicit `vault:<key>`, which is shared between folders by design.
 */
export function vaultKeyFolder(key: string): string | null {
  const i = key.lastIndexOf('::');
  if (i <= 0) return null;
  const scope = key.slice(0, i);
  return /^(\/|[a-z]:(\/|$))/i.test(scope) ? scope : null;
}

/** The scope the renderer derives from a workspace root (forward slashes, no trailing slash, folded off Linux). */
export function vaultRootScope(root: string, os: string): string {
  const abs = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return os === 'linux' ? abs : abs.toLowerCase();
}

/**
 * May the window that has `root` open use `key`? Folder-scoped keys only below that folder: a page that
 * was taken over (XSS in a note) must not read the secrets of every other folder on the machine.
 */
export function vaultKeyInScope(key: string, root: string | null, os: string): boolean {
  const folder = vaultKeyFolder(key);
  if (folder === null) return true;
  if (root === null) return false;
  if (folder.split('/').some((seg) => seg === '.' || seg === '..')) return false; // the renderer never writes these
  const base = vaultRootScope(root, os);
  return folder === base || folder.startsWith(base + '/');
}
