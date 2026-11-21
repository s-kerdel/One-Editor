// Sandboxed preload: exposes a minimal, typed bridge. No Node APIs leak into the page.
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import { terminalBridge } from './terminal-bridge';
import { vaultBridge } from './vault-bridge';
import { webServerBridge } from './web-server-bridge';
import { updateCheckBridge } from './update-check-bridge';
import { mcpBridge } from './mcp-bridge';

const CHANNELS = new Set(['fs:events', 'app:openRequest', 'app:closeRequest', 'git:changed', 'settings:changed', 'app:navigate']);
// The frame main created this window with (webPreferences.additionalArguments): the renderer styles
// by what the window really has, not by the setting (which may have changed until a restart).
const frame = process.argv.includes('--sec-edit-frame=integrated') ? 'integrated' : 'native';
// Per-launch secret for app://sec-edit/__index/ (the search workers fetch text pages with it).
const indexToken = process.argv.find((a) => a.startsWith('--sec-edit-index-token='))?.slice('--sec-edit-index-token='.length) ?? '';

contextBridge.exposeInMainWorld('secEditBridge', {
  os: process.platform,
  frame,
  indexToken,
  invoke: (method: string, args: unknown[]) => ipcRenderer.invoke(`rpc:${method}`, ...args),
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!CHANNELS.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const fn = (_e: unknown, payload: unknown) => {
      // Tell main a live handler is dealing with the close (it may show "Save changes?" for a while).
      if (channel === 'app:closeRequest') ipcRenderer.send('app:closeAck');
      cb(payload);
    };
    ipcRenderer.on(channel, fn);
    return () => ipcRenderer.removeListener(channel, fn);
  },
  getPathForFile: (file: File) => {
    try {
      const abs = webUtils.getPathForFile(file) || null;
      // Dropped on the window by the user: tell main directly (from here, not through the page), so
      // opening it — or its folder — is allowed. A path the page merely claims is never vouched for.
      if (abs) ipcRenderer.send('app:vouchPath', abs);
      return abs;
    } catch {
      return null;
    }
  },
  setZoom: (factor: number) => webFrame.setZoomFactor(Math.min(3, Math.max(0.5, factor))),
  toggleDevTools: () => ipcRenderer.invoke('app:toggleDevTools'),
  ready: (timeOrigin: number, marks: Record<string, number>) => ipcRenderer.send('app:ready', { timeOrigin, marks }),
  approveClose: (ok: boolean) => ipcRenderer.send('app:closeApproved', ok),
  // Validated again in main (shape, #rrggbb colours, height range).
  setTitleBarOverlay: (o: { color: string; symbolColor: string; height: number }) =>
    ipcRenderer.send('app:titleBarOverlay', { color: String(o?.color), symbolColor: String(o?.symbolColor), height: Number(o?.height) }),
  // Zen mode: hold / give back full screen (main/zen-fullscreen.ts restores the state from before).
  zenFullScreen: (on: boolean) => ipcRenderer.send('app:zenFullScreen', on === true),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  gpuStatus: () => ipcRenderer.invoke('app:gpuStatus'),
  // Integrated terminal (term:* channels, validated in main/terminal.ts).
  terminal: terminalBridge(ipcRenderer),
  // Secrets vault for {{variables}} (vault:* channels, validated in main/vault.ts).
  vault: vaultBridge(ipcRenderer),
  // "Start web server" (webserver:* channels, validated in main/web-server.ts).
  webServer: webServerBridge(ipcRenderer),
  // Opt-in "Security updates" check (updates:* channels, validated in main/update-check.ts).
  updates: updateCheckBridge(ipcRenderer),
  // Settings → MCP server (mcp:* channels, validated in main/mcp.ts).
  mcp: mcpBridge(ipcRenderer),
});
