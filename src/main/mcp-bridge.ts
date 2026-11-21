// MCP part of the sandboxed preload bridge (`secEditBridge.mcp`). Imports nothing but constants;
// coerces argument types only — main (src/main/mcp.ts) validates and decides (native dialogs included).
// There is no way to pass a folder path: sharing one always goes through main's folder dialog.
import { MCP_CHANNELS as CH } from '../shared/mcp';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
}

export function mcpBridge(ipc: IpcRendererLike) {
  return {
    status: () => ipc.invoke(CH.status),
    setEnabled: (on: boolean) => ipc.invoke(CH.setEnabled, on === true),
    addFolder: () => ipc.invoke(CH.addFolder),
    removeFolder: (id: string) => ipc.invoke(CH.removeFolder, String(id)),
    setMode: (id: string, mode: string) => ipc.invoke(CH.setMode, String(id), String(mode)),
    activity: () => ipc.invoke(CH.activity),
    revert: (group: string) => ipc.invoke(CH.revert, String(group)),
    onChange: (cb: (status: unknown) => void) => {
      const fn = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(CH.changed, fn);
      return () => void ipc.removeListener(CH.changed, fn);
    },
  };
}

export type McpBridge = ReturnType<typeof mcpBridge>;
