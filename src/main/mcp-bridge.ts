// MCP part of the sandboxed preload bridge (`secEditBridge.mcp`). Imports nothing but constants;
// coerces argument types only — main (src/main/mcp.ts) validates and decides (native dialogs included).
// There is no way to pass a folder path: sharing folders (one or several) always goes through main's folder dialog.
import { MCP_CHANNELS as CH } from '../shared/mcp';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
}

export function mcpBridge(ipc: IpcRendererLike) {
  return {
    status: () => ipc.invoke(CH.status),
    setEnabled: (on: boolean, client?: string) => ipc.invoke(CH.setEnabled, on === true, String(client ?? '')),
    addFolder: () => ipc.invoke(CH.addFolder), // no arguments: main's dialog picks, main's confirm decides
    removeFolder: (id: string) => ipc.invoke(CH.removeFolder, String(id)),
    setMode: (id: string, mode: string) => ipc.invoke(CH.setMode, String(id), String(mode)),
    activity: () => ipc.invoke(CH.activity),
    revert: (group: string) => ipc.invoke(CH.revert, String(group)),
    setAllowCode: (id: string, on: boolean) => ipc.invoke(CH.setAllowCode, String(id), on === true),
    setUndo: (o: { on?: boolean; days?: number }) => ipc.invoke(CH.setUndo, { ...(o?.on === undefined ? {} : { on: o.on === true }), ...(o?.days === undefined ? {} : { days: Number(o.days) }) }),
    // Tokens: the page names them and picks the client; main shows the dialog and writes the clipboard.
    createToken: (name: string, client: string) => ipc.invoke(CH.createToken, String(name), String(client)),
    regenerateToken: (id: string, client: string) => ipc.invoke(CH.regenerateToken, String(id), String(client)),
    revokeToken: (id: string) => ipc.invoke(CH.revokeToken, String(id)),
    copySetup: (id: string, client: string) => ipc.invoke(CH.copySetup, String(id), String(client)),
    onChange: (cb: (status: unknown) => void) => {
      const fn = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(CH.changed, fn);
      return () => void ipc.removeListener(CH.changed, fn);
    },
  };
}

export type McpBridge = ReturnType<typeof mcpBridge>;
