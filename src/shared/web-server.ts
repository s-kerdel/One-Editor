// "Start web server" from the desktop app (browser mode for the open folder). The server runs as a
// separate child process (dist/server/cli.mjs, the same one "Start web server.cmd" runs); main owns
// it, the renderer talks to main over these webserver:* channels only. Desktop only.
export const WEB_SERVER_CHANNELS = {
  status: 'webserver:status',
  start: 'webserver:start',
  stop: 'webserver:stop',
  open: 'webserver:open',
  /** main → renderer: a new WebServerStatus. */
  changed: 'webserver:changed',
} as const;

/** `local` = 127.0.0.1 only; `lan` = every interface (0.0.0.0), opt-in. */
export type WebServerAccess = 'local' | 'lan';

export interface WebServerOptions {
  /** null = automatic: 4317, else the next free one. */
  port: number | null;
  access: WebServerAccess;
}

export const WEB_SERVER_PORTS = { min: 1024, max: 65535, auto: 4317 } as const;

export interface WebServerUrl {
  kind: 'local' | 'lan';
  /** Address without the access token, for display. */
  origin: string;
  /** Full link including ?token= (copy / open use this one). */
  url: string;
}

export interface WebServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error';
  /** Folder served (absolute). */
  root: string | null;
  access: WebServerAccess | null;
  port: number | null;
  /** Local first, then one per LAN address. */
  urls: WebServerUrl[];
  /** Why the last start failed / why the server died. Never contains the token. */
  error: string | null;
  /** Why it stopped without being asked to (e.g. another folder was opened). */
  notice: string | null;
  /** The folder's usual port (tried first) was taken: the browser sees a new origin, its state starts empty. */
  portBusy: number | null;
}

export type WebServerReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export const STOPPED: WebServerStatus = { state: 'stopped', root: null, access: null, port: null, urls: [], error: null, notice: null, portBusy: null };

/** Validates start options from the renderer / settings; null = refused. */
export function parseWebServerOptions(raw: unknown): WebServerOptions | null {
  if (!raw || typeof raw !== 'object') return null;
  const { port, access } = raw as Record<string, unknown>;
  if (access !== 'local' && access !== 'lan') return null;
  if (port === null || port === undefined) return { port: null, access };
  if (typeof port !== 'number' || !Number.isInteger(port) || port < WEB_SERVER_PORTS.min || port > WEB_SERVER_PORTS.max) return null;
  return { port, access };
}

/** Settings → options (anything invalid falls back to the safe default: automatic port, this computer only). */
export function optionsFromSettings(s: Record<string, unknown>): WebServerOptions {
  return parseWebServerOptions({ port: s['webserver.port'] ?? null, access: s['webserver.access'] ?? 'local' }) ?? { port: null, access: 'local' };
}

/** The child's handshake over the Node IPC channel (`cli.mjs --ipc`). */
/** `launch`: a one-time link (answer to { type: 'launch' }) — "Open" hands it to the browser instead of the token. */
export type ChildMessage = { type: 'ready'; port: number; token: string; busy?: number } | { type: 'error'; code: string; message: string } | { type: 'launch'; url: string };

export function parseChildMessage(m: unknown): ChildMessage | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.type === 'ready') {
    const { port, token } = o;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof token !== 'string' || !/^[a-f0-9]{16,128}$/.test(token)) return null;
    const busy = o.busy;
    return typeof busy === 'number' && Number.isInteger(busy) && busy > 0 && busy <= 65535 && busy !== port ? { type: 'ready', port, token, busy } : { type: 'ready', port, token };
  }
  if (o.type === 'launch' && typeof o.url === 'string' && /^http:\/\/[^\s/?#]+\/\?launch=[a-f0-9]{32}$/.test(o.url)) return { type: 'launch', url: o.url };
  if (o.type === 'error' && typeof o.message === 'string') {
    return { type: 'error', code: typeof o.code === 'string' ? o.code.slice(0, 40) : 'EIO', message: o.message.slice(0, 500) };
  }
  return null;
}
