// Picks the backend transport at runtime: Electron preload bridge, else the local HTTP server.
import type { BackendApi, FsEvent, RpcMethod } from '@shared/api';
import { RPC_METHODS, isExternalUrl } from '@shared/api';

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
};

function build(kind: 'electron' | 'web', os: string, call: (m: RpcMethod, args: unknown[]) => Promise<unknown>, extra: Partial<BackendApi>): BackendApi {
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
      approveClose: (ok) => bridge.approveClose(ok),
      getPathForFile: (f) => bridge.getPathForFile(f),
      setZoom: (z) => bridge.setZoom(z),
      toggleDevTools: () => bridge.toggleDevTools(),
      notifyReady: (marks) => bridge.ready(performance.timeOrigin, marks),
      frame: bridge.frame === 'integrated' ? 'integrated' : 'native',
      setTitleBarOverlay: bridge.setTitleBarOverlay && ((o) => bridge.setTitleBarOverlay!(o)),
      relaunch: bridge.relaunch && (async () => void (await bridge.relaunch!())),
    },
  );
}

export function webToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="sec-edit-token"]')?.content ?? new URLSearchParams(location.search).get('token') ?? '';
}

function webBackend(): BackendApi {
  const token = webToken();
  const base = new URL('./api/', location.href).toString();
  const listeners = new Set<(e: FsEvent[]) => void>();
  let es: EventSource | null = null;
  const ensureEvents = () => {
    if (es) return;
    es = new EventSource(`${base}events?token=${encodeURIComponent(token)}`);
    es.onmessage = (ev) => {
      const events = JSON.parse(ev.data) as FsEvent[];
      listeners.forEach((l) => l(events));
    };
  };
  // Strip the token from the address bar (it is kept in a meta tag + HttpOnly cookie).
  if (location.search.includes('token=')) history.replaceState(null, '', location.pathname + location.hash);
  const ua = navigator.userAgent;
  // BackendApi.os is the backend's platform (WSL: Linux server, Windows browser); the UA is only a fallback.
  const serverOs = document.querySelector<HTMLMetaElement>('meta[name="sec-edit-os"]')?.content;
  return build(
    'web',
    serverOs || (/Windows/i.test(ua) ? 'win32' : /Mac/i.test(ua) ? 'darwin' : 'linux'),
    async (m, args) => {
      const body = JSON.stringify({ args });
      const res = await fetch(`${base}rpc/${m}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sec-edit-token': token },
        body,
        // Session/settings saves are flushed on page unload: keepalive lets them finish after a reload.
        keepalive: (m === 'saveSession' || m === 'saveSettings') && body.length < 60_000,
      });
      if (res.status === 403) throw new RpcError('EACCES', 'Access token rejected — reopen the URL printed by `sec-edit serve`');
      const r = await res.json();
      if (!r.ok) throw new RpcError(r.error.code, r.error.message);
      return r.result;
    },
    {
      onFsEvents: (cb) => {
        listeners.add(cb);
        ensureEvents();
        return () => listeners.delete(cb);
      },
      onOpenRequest: () => () => {},
      // The browser opens links itself; no round-trip through the server.
      openExternal: async (url: string) => {
        if (isExternalUrl(url)) window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
  );
}

/** URL for a workspace file (images in preview). `rootAbs` is unused now but kept for API compatibility. */
export function fileUrl(backend: BackendApi, _rootAbs: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (backend.kind === 'electron') return `app://sec-edit/__ws/${clean.split('/').map(encodeURIComponent).join('/')}`;
  return `./api/file?path=${encodeURIComponent(clean)}&token=${encodeURIComponent(webToken())}`;
}

export async function connectBackend(): Promise<BackendApi> {
  const bridge = (window as unknown as { secEditBridge?: Bridge }).secEditBridge;
  return bridge ? electronBackend(bridge) : webBackend();
}
