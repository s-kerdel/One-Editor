// Web server part of the sandboxed preload bridge (`secEditBridge.webServer`). Imports nothing but
// constants; coerces argument types only — main (src/main/web-server.ts) validates everything again.
import { WEB_SERVER_CHANNELS as CH } from '../shared/web-server';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
}

export function webServerBridge(ipc: IpcRendererLike) {
  return {
    status: () => ipc.invoke(CH.status),
    start: (opts: { port: number | null; access: string }) =>
      ipc.invoke(CH.start, { port: opts?.port === null || opts?.port === undefined ? null : Number(opts.port), access: String(opts?.access) }),
    stop: () => ipc.invoke(CH.stop),
    open: (url: string) => ipc.invoke(CH.open, String(url)),
    onChange: (cb: (status: unknown) => void) => {
      const fn = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(CH.changed, fn);
      return () => void ipc.removeListener(CH.changed, fn);
    },
  };
}

export type WebServerBridge = ReturnType<typeof webServerBridge>;
