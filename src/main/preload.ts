// Sandboxed preload: exposes a minimal, typed bridge. No Node APIs leak into the page.
import { contextBridge, ipcRenderer, webFrame, webUtils } from 'electron';
import { terminalBridge } from './terminal-bridge';
import { vaultBridge } from './vault-bridge';

const CHANNELS = new Set(['fs:events', 'app:openRequest', 'app:closeRequest', 'git:changed']);
// The frame main created this window with (webPreferences.additionalArguments): the renderer styles
// by what the window really has, not by the setting (which may have changed until a restart).
const frame = process.argv.includes('--sec-edit-frame=integrated') ? 'integrated' : 'native';

contextBridge.exposeInMainWorld('secEditBridge', {
  os: process.platform,
  frame,
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
      return webUtils.getPathForFile(file) || null;
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
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  // Integrated terminal (term:* channels, validated in main/terminal.ts).
  terminal: terminalBridge(ipcRenderer),
  // Secrets vault for {{variables}} (vault:* channels, validated in main/vault.ts).
  vault: vaultBridge(ipcRenderer),
});
