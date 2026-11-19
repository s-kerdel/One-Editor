// Vault part of the sandboxed preload bridge (`secEditBridge.vault`). Coerces argument types only;
// main (src/main/vault.ts) validates everything again.
import { VAULT_CHANNELS as CH } from '../shared/vault';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

export function vaultBridge(ipc: IpcRendererLike) {
  return {
    status: () => ipc.invoke(CH.status),
    has: (keys: string[]) => ipc.invoke(CH.has, Array.isArray(keys) ? keys.map(String) : []),
    get: (key: string) => ipc.invoke(CH.get, String(key)),
    set: (key: string, value: string) => ipc.invoke(CH.set, String(key), String(value)),
    remove: (key: string) => ipc.invoke(CH.remove, String(key)),
  };
}

export type VaultBridge = ReturnType<typeof vaultBridge>;
