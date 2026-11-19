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
