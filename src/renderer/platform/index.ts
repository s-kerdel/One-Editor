// Picks the backend transport at runtime: Electron preload bridge, else the local HTTP server.
import type { BackendApi, FsEvent, GpuStatus, RpcMethod } from '@shared/api';
import { RPC_METHODS, isExternalUrl } from '@shared/api';
import { hmacSha256Hex } from './hmac';

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
  gpuStatus?(): Promise<unknown>;
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
      onNavCommand: (cb) => bridge.on('app:navigate', (d) => cb(d as 'back' | 'forward')),
      approveClose: (ok) => bridge.approveClose(ok),
      getPathForFile: (f) => bridge.getPathForFile(f),
      setZoom: (z) => bridge.setZoom(z),
      toggleDevTools: () => bridge.toggleDevTools(),
      notifyReady: (marks) => bridge.ready(performance.timeOrigin, marks),
      frame: bridge.frame === 'integrated' ? 'integrated' : 'native',
      setTitleBarOverlay: bridge.setTitleBarOverlay && ((o) => bridge.setTitleBarOverlay!(o)),
      relaunch: bridge.relaunch && (async () => void (await bridge.relaunch!())),
      // Older main processes have no handler: invoke rejects → null (the dialog still shows the renderer's view).
      gpuStatus: bridge.gpuStatus && (() => bridge.gpuStatus!().then((r) => (r as GpuStatus | null) ?? null, () => null)),
    },
  );
}

// ---- browser mode: access token + media capability ------------------------------------------------
// The session token (full access) lives in this tab's sessionStorage — per origin, i.e. per port — and
// travels in a header only. Never a cookie (cookies ignore ports: every server on 127.0.0.1 would receive
// it) and never in a URL the page shows. Media URLs (<img>, PDF bytes) and the event stream carry an
// HMAC of what they address under a separate media key instead: a copied image URL opens that one file.
const TOKEN_KEY = 'sec-edit-token';
let token: string | null = null;
let mediaKey = '';
const macs = new Map<string, string>();
let onMediaKey: (() => void) | null = null;

const tabStore = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

function keepToken(t: string) {
  token = t;
  try {
    tabStore()?.setItem(TOKEN_KEY, t);
  } catch {}
}

export function webToken(): string {
  if (token === null) {
    const q = new URLSearchParams(location.search).get('token');
    if (q) keepToken(q);
    else token = tabStore()?.getItem(TOKEN_KEY) ?? '';
  }
  return token ?? '';
}

function setMediaKey(k: string) {
  if (k === mediaKey) return;
  mediaKey = k;
  macs.clear();
  onMediaKey?.();
}

/** Capability for one media path (or the event stream): HMAC-SHA256 under the media key, 128 bits. */
function mediaMac(subject: string): string {
  let m = macs.get(subject);
  if (m === undefined) {
    if (macs.size > 4000) macs.clear();
    macs.set(subject, (m = mediaKey ? hmacSha256Hex(mediaKey, subject).slice(0, 32) : ''));
  }
  return m;
}

/** Browser mode: URL of the server's event stream (`query` e.g. 'git=1'), authorised by its own capability. */
export function eventsUrl(query = ''): string {
  return new URL(`./api/events?${query ? `${query}&` : ''}ev=${mediaMac('\u0000events')}`, location.href).toString();
}

const NO_TOKEN = 'No access key: open the full link printed by `sec-edit serve` (…?token=…)';

function webBackend(): BackendApi {
  const tok = webToken();
  const base = new URL('./api/', location.href).toString();
  const listeners = new Set<(e: FsEvent[]) => void>();
  let es: EventSource | null = null;
  let wantEvents = false;
  const ensureEvents = () => {
    wantEvents = true;
    if (es || !mediaKey) return; // the stream's capability arrives with bootstrap()
    // Also a global: lazy modules add named-event listeners (`settings`, app/settings-sync.ts) without startup code.
    es = (window as unknown as { __secEditEvents: EventSource }).__secEditEvents = new EventSource(eventsUrl());
    es.onmessage = (ev) => {
      const events = JSON.parse(ev.data) as FsEvent[];
      listeners.forEach((l) => l(events));
    };
  };
  onMediaKey = () => wantEvents && ensureEvents();
  // The token / one-time launch code must not stay in the address bar (history, shared screenshots).
  if (/[?&](token|launch)=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
  const ua = navigator.userAgent;
  // BackendApi.os is the backend's platform (WSL: Linux server, Windows browser); the UA is only a fallback.
  const serverOs = document.querySelector<HTMLMetaElement>('meta[name="sec-edit-os"]')?.content;
  return build(
    'web',
    serverOs || (/Windows/i.test(ua) ? 'win32' : /Mac/i.test(ua) ? 'darwin' : 'linux'),
    async (m, args) => {
      if (!tok) throw new RpcError('EACCES', NO_TOKEN);
      const body = JSON.stringify({ args });
      const res = await fetch(`${base}rpc/${m}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sec-edit-token': tok },
        body,
        // Session/settings saves are flushed on page unload: keepalive lets them finish after a reload.
        keepalive: (m === 'saveSession' || m === 'saveSettings') && body.length < 60_000,
      });
      if (res.status === 403) throw new RpcError('EACCES', 'Access key rejected: reopen the link printed by `sec-edit serve`');
      const r = await res.json();
      if (!r.ok) throw new RpcError(r.error.code, r.error.message);
      if (m === 'bootstrap' && r.result && typeof r.result.mediaKey === 'string') {
        setMediaKey(r.result.mediaKey);
        delete r.result.mediaKey;
      }
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

/** URL for a workspace file (images in preview). Browser mode: its capability names `rootAbs` + the path
 *  (server: mediaSubject), so a URL kept from another folder opens nothing. */
export function fileUrl(backend: BackendApi, rootAbs: string, rel: string): string {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (backend.kind === 'electron') return `app://sec-edit/__ws/${clean.split('/').map(encodeURIComponent).join('/')}`;
  return `./api/file?path=${encodeURIComponent(clean)}&m=${mediaMac(`${rootAbs}\u0000${clean}`)}`;
}

/** `--open` hands the browser a one-time launch code (a command line is visible to other processes),
 *  exchanged here for the token before anything else runs. */
async function redeemLaunchCode(): Promise<void> {
  const code = new URLSearchParams(location.search).get('launch');
  if (!code || new URLSearchParams(location.search).get('token')) return;
  try {
    const res = await fetch(new URL('./api/launch', location.href), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const r = res.ok ? await res.json() : null;
    if (typeof r?.token === 'string') keepToken(r.token);
  } catch {}
}

export async function connectBackend(): Promise<BackendApi> {
  const bridge = (window as unknown as { secEditBridge?: Bridge }).secEditBridge;
  if (bridge) return electronBackend(bridge);
  await redeemLaunchCode();
  return webBackend();
}
