// Picks the backend transport at runtime: Electron preload bridge, else the local HTTP server.
// The browser-mode transport is the lazy chunk ./web: the desktop app never loads it.
import type { BackendApi, FsEvent, GpuStatus, RpcMethod } from '@shared/api';
import { RPC_METHODS } from '@shared/api';

export class RpcError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

type Bridge = {
  os: string;
  frame?: 'integrated' | 'native';
  invoke(method: string, args: unknown[]): Promise<{ ok: boolean; result?: unknown; error?: { code: string; message: string } }>;
  on(channel: string, cb: (payload: unknown) => void): () => void;
  getPathForFile(file: File): string | null;
  setZoom(factor: number): void;
  toggleDevTools(): Promise<void>;
  ready(timeOrigin: number, marks: Record<string, number>): void;
  approveClose(ok: boolean): void;
  setTitleBarOverlay?(o: { color: string; symbolColor: string; height: number }): void;
  relaunch?(): Promise<unknown>;
  zenFullScreen?(on: boolean): void;
  gpuStatus?(): Promise<unknown>;
  wsKey?: string;
  newWindow?(): Promise<unknown>;
  openFolderWindow?(abs: string): Promise<unknown>;
};

/** Shared with ./web. */
export function build(kind: 'electron' | 'web', os: string, call: (m: RpcMethod, args: unknown[]) => Promise<unknown>, extra: Partial<BackendApi>): BackendApi {
  const api: Record<string, unknown> = { kind, os };
  for (const m of RPC_METHODS) api[m] = (...args: unknown[]) => call(m, args);
  Object.assign(api, extra);
  return api as unknown as BackendApi;
}

function electronBackend(bridge: Bridge): BackendApi {
  return build(
    'electron',
    bridge.os,
    async (m, args) => {
      const r = await bridge.invoke(m, args);
      if (!r.ok) throw new RpcError(r.error!.code, r.error!.message);
      return r.result;
    },
    {
      onFsEvents: (cb) => bridge.on('fs:events', (p) => cb(p as FsEvent[])),
      onOpenRequest: (cb) => bridge.on('app:openRequest', (p) => cb(p as string[])),
      onCloseRequest: (cb) => bridge.on('app:closeRequest', () => cb()),
      onNavCommand: (cb) => bridge.on('app:navigate', (d) => cb(d as 'back' | 'forward')),
      onFullScreen: (cb) => bridge.on('app:fullScreen', (p) => cb(p === true)),
      approveClose: (ok) => bridge.approveClose(ok),
      getPathForFile: (f) => bridge.getPathForFile(f),
      setZoom: (z) => bridge.setZoom(z),
      toggleDevTools: () => bridge.toggleDevTools(),
      notifyReady: (marks) => bridge.ready(performance.timeOrigin, marks),
      frame: bridge.frame === 'integrated' ? 'integrated' : 'native',
      setTitleBarOverlay: bridge.setTitleBarOverlay && ((o) => bridge.setTitleBarOverlay!(o)),
      relaunch: bridge.relaunch && (async () => void (await bridge.relaunch!())),
      zenFullScreen: bridge.zenFullScreen && ((on) => bridge.zenFullScreen!(on)),
      // Older main processes have no handler: invoke rejects → null (the dialog still shows the renderer's view).
      gpuStatus: bridge.gpuStatus && (() => bridge.gpuStatus!().then((r) => (r as GpuStatus | null) ?? null, () => null)),
      // Multiple windows: main passes the key together with the app:newWindow / app:openFolderWindow handlers.
      // No key = a main without them: one window, folders open in place, as before.
      ...(bridge.wsKey
        ? {
            wsKey: bridge.wsKey,
            newWindow: bridge.newWindow && (async () => void (await bridge.newWindow!())),
            openFolderWindow: bridge.openFolderWindow && ((abs: string) => bridge.openFolderWindow!(abs) as Promise<'here' | 'focused' | 'new'>),
          }
        : {}),
    },
  );
}

// Browser mode lives in ./web (its own chunk). These stay sync: fileUrl() runs while rendering, and
// connectBackend() has ./web before anything renders (main.tsx awaits it first).
type WebTransport = { connectWeb(): Promise<BackendApi>; webToken(): string; eventsUrl(query?: string): string; mediaUrl(rootAbs: string, clean: string): string };
let web: WebTransport | null = null;

/** Called by ./web as it evaluates. The server runs it as a module script before the entry, so at boot it
 *  is usually here already: no import() hop in front of the bootstrap round trip. */
export function installWeb(w: WebTransport) {
  web = w;
}

/** Browser mode: the session token (the search worker's own fetches). '' on the desktop. */
export const webToken = (): string => web?.webToken() ?? '';

/** Browser mode: URL of the server's event stream (`query` e.g. 'git=1'), authorised by its own capability. */
export const eventsUrl = (query = ''): string => web?.eventsUrl(query) ?? '';

/** URL for a workspace file (images in preview). Browser mode: its capability names `rootAbs` + the path
 *  (server: mediaSubject), so a URL kept from another folder opens nothing. Desktop with several windows:
 *  the window's key picks its folder (main/protocol.ts). */
export function fileUrl(backend: BackendApi, rootAbs: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (backend.kind === 'electron') {
    const parts = clean.split('/').map(encodeURIComponent).join('/');
    return backend.wsKey ? `app://sec-edit/__ws/${encodeURIComponent(backend.wsKey)}/${parts}` : `app://sec-edit/__ws/${parts}`;
  }
  return web?.mediaUrl(rootAbs, clean) ?? '';
}

export async function connectBackend(): Promise<BackendApi> {
  const bridge = (window as unknown as { secEditBridge?: Bridge }).secEditBridge;
  if (bridge) return electronBackend(bridge);
  // Never on the desktop. Not run yet (Vite dev server, an older server): load it now; it installs itself.
  if (!web) await import('./web');
  return web!.connectWeb();
}
