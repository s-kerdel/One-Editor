// Local HTTP backend: serves the built renderer and exposes the BackendService over JSON RPC + SSE.
// Used for "browser mode" (handy from WSL / remote boxes) and by the E2E test-suite.
//
// Security model (it can read/write any folder you open, so it must not be reachable by web pages):
//  - binds to 127.0.0.1 and rejects foreign Host headers (DNS-rebinding);
//  - index.html (which embeds the token) is only served with ?token= or the HttpOnly cookie it sets;
//  - every /api call needs the token: RPC via the x-sec-edit-token header only (no cookie → no CSRF),
//    GET endpoints (events, files for <img>) via ?token=;
//  - workspace files are served sandboxed, so an HTML/SVG file in a note folder cannot script our origin.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_BINARY_BYTES, RPC_METHODS, type FsEvent } from '../shared/api';
import { isTerminalMethod } from '../shared/terminal';
import { BackendService, type ServiceHooks } from '../backend/service';
import { BackendFailure, type WorkspaceOptions } from '../backend/workspace';

export interface ServerOptions {
  root?: string; // folder to open
  port?: number; // 0 = random
  host?: string;
  rendererDir: string; // built renderer (vite build output)
  configDir?: string;
  token?: string;
  hooks?: ServiceHooks;
  workspaceOptions?: Pick<WorkspaceOptions, 'watchMode' | 'debounceMs' | 'pollMs'>;
}

export interface RunningServer {
  /** Full URL including the access token query (open this in a browser). */
  url: string;
  /** URL without the token. */
  origin: string;
  port: number;
  token: string;
  service: BackendService;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

const MAX_BODY = 96 * 1024 * 1024; // a 48 MB text file (MAX_OPEN_BYTES) plus JSON escaping
/** Per-method body caps. writeBinary carries base64 (4/3 of the bytes) plus the JSON framing. */
const BODY_LIMITS: Record<string, { bytes: number; message: string }> = {
  writeBinary: { bytes: Math.ceil(MAX_BINARY_BYTES / 3) * 4 + 64 * 1024, message: `File is too large (the limit is ${MAX_BINARY_BYTES / 1048576} MB)` },
};
const DEFAULT_LIMIT = { bytes: MAX_BODY, message: 'Request too large' };
/** Need Electron (hidden print window, native dialogs): refused before the (possibly huge) body is read. */
const DESKTOP_ONLY = new Set(['exportPdf', 'showExportedFile']);
const COOKIE = 'sec_edit_token';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function safeEqual(a: string | undefined | null, b: string) {
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieToken(req: http.IncomingMessage): string | null {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]+)`).exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? crypto.randomBytes(18).toString('hex');
  const service = new BackendService(opts.configDir, opts.hooks ?? {}, opts.workspaceOptions ?? {});
  if (opts.root) await service.openWorkspace(opts.root);
  const rendererDir = path.resolve(opts.rendererDir);
  const sseClients = new Set<http.ServerResponse>();
  /** `/api/events?git=1`: the lazy git chunk's own stream (no fs events on it). */
  const gitClients = new Set<http.ServerResponse>();
  const allowed = new Set<string>(RPC_METHODS);
  const host = opts.host ?? '127.0.0.1';
  const loopbackOnly = LOOPBACK.has(host);

  service.onFsEvents((events: FsEvent[]) => {
    const payload = `data: ${JSON.stringify(events)}\n\n`;
    for (const res of sseClients) res.write(payload);
  });
  service.onGitChanged((e) => gitClients.forEach((r) => r.write(`event: git\ndata: ${JSON.stringify(e)}\n\n`)));
  const ping = setInterval(() => [...sseClients, ...gitClients].forEach((r) => r.write(': ping\n\n')), 25000);
  ping.unref();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (loopbackOnly) {
        const h = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
        if (!LOOPBACK.has(h)) {
          res.writeHead(421, { 'content-type': 'text/plain' }).end('misdirected request');
          return;
        }
      }
      if (url.pathname.startsWith('/api/')) {
        const isRpc = url.pathname.startsWith('/api/rpc/');
        const presented = isRpc ? req.headers['x-sec-edit-token'] : url.searchParams.get('token') ?? req.headers['x-sec-edit-token'];
        if (!safeEqual(typeof presented === 'string' ? presented : null, token)) {
          res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
          return;
        }
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write(': ok\n\n');
          const set = url.searchParams.get('git') === '1' ? gitClients : sseClients;
          set.add(res);
          req.on('close', () => set.delete(res));
          return;
        }
        // Workspace files (images etc.) for the preview: /api/file?path=rel
        if (url.pathname === '/api/file' && req.method === 'GET') {
          const ws = service.workspace;
          if (!ws) throw new BackendFailure('NO_WORKSPACE', 'No folder open');
          const abs = ws.abs(url.searchParams.get('path') || '');
          // Regular files only (a FIFO would hang the request forever), streamed (a 2 GB video must not be buffered).
          const st = await fsp.stat(abs);
          if (!st.isFile()) throw new BackendFailure('ENOENT', 'Not a file');
          res.writeHead(200, {
            'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'content-length': String(st.size),
            'cache-control': 'no-cache',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            // Other local origins must not even embed workspace files (only our own preview may).
            'cross-origin-resource-policy': 'same-origin',
          });
          await new Promise<void>((resolve) => {
            const stream = fs.createReadStream(abs);
            stream.on('error', () => res.destroy());
            res.on('close', () => {
              stream.destroy();
              resolve();
            });
            stream.pipe(res);
          });
          return;
        }
        // Text pages for the search workers (fetched by them directly, never through the UI thread).
        if (url.pathname === '/api/index/page' && req.method === 'GET') {
          const body = await service.indexPageRaw(url.searchParams.get('cursor'), Number(url.searchParams.get('maxBytes')) || undefined);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
          return;
        }
        if (url.pathname === '/api/index/files' && req.method === 'POST') {
          const body = await service.indexFilesRaw(JSON.parse((await readBody(req, DEFAULT_LIMIT)) || 'null'));
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
          return;
        }
        const m = /^\/api\/rpc\/(\w+)$/.exec(url.pathname);
        // Browser mode never exposes a shell, whatever the method name looks like.
        if (m && isTerminalMethod(m[1])) {
          req.resume();
          throw new BackendFailure('ENOTSUP', 'The terminal needs the desktop app');
        }
        if (m && req.method === 'POST' && DESKTOP_ONLY.has(m[1])) {
          req.resume(); // discard the body
          throw new BackendFailure('ENOTSUP', 'PDF export needs the desktop app — in the browser use Print and pick "Save as PDF"');
        }
        if (m && req.method === 'POST' && allowed.has(m[1])) {
          const body = await readBody(req, BODY_LIMITS[m[1]] ?? DEFAULT_LIMIT);
          const parsed = body ? JSON.parse(body) : null;
          const args: unknown = parsed?.args ?? [];
          if (!Array.isArray(args)) throw new BackendFailure('EINVAL', 'args must be an array');
          const result = await (service as any)[m[1]](...args);
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result: result ?? null }));
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      await serveStatic(rendererDir, url, token, req, res);
    } catch (err: any) {
      const code = err instanceof BackendFailure ? err.code : err?.code || 'EIO';
      if (!res.headersSent) res.writeHead(url.pathname.startsWith('/api/rpc') ? 200 : code === 'ENOENT' ? 404 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code, message: String(err?.message || err) } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const addr = server.address() as import('node:net').AddressInfo;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const origin = `http://${displayHost}:${addr.port}/`;
  return {
    url: `${origin}?token=${token}`,
    origin,
    port: addr.port,
    token,
    service,
    async close() {
      clearInterval(ping);
      for (const r of [...sseClients, ...gitClients]) r.end();
      service.dispose();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function readBody(req: http.IncomingMessage, limit: { bytes: number; message: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const declared = Number(req.headers['content-length']);
    let over = Number.isFinite(declared) && declared > limit.bytes;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (!over && size > limit.bytes) over = true;
      if (over) {
        chunks.length = 0;
        // Keep draining (discarding) so the client gets the error reply instead of a reset connection,
        // but never forever.
        if (size > limit.bytes * 2 + MAX_BODY) req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => (over ? reject(new BackendFailure('ETOOBIG', limit.message)) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
    // Aborted / destroyed mid-body: settle instead of hanging (a no-op after 'end').
    req.on('close', () => reject(new BackendFailure(over ? 'ETOOBIG' : 'EIO', over ? limit.message : 'Request aborted')));
  });
}

async function serveStatic(dir: string, url: URL, token: string, req: http.IncomingMessage, res: http.ServerResponse) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let data: Buffer;
  try {
    data = await fsp.readFile(file);
  } catch {
    // SPA fallback only for page-like URLs; a missing asset must 404 (otherwise JS gets HTML).
    if (path.extname(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    file = path.join(dir, 'index.html');
    rel = 'index.html';
    data = await fsp.readFile(file);
  }
  const ext = path.extname(file).toLowerCase();
  if (rel === 'index.html') {
    const fromQuery = url.searchParams.get('token');
    const ok = safeEqual(fromQuery, token) || safeEqual(cookieToken(req), token);
    if (!ok) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>sec-edit</title><body style="font:15px system-ui;padding:3rem;background:#1b1d22;color:#d7dae0">' +
        '<h2>Access token required</h2><p>Open the full URL printed by <code>sec-edit serve</code> (it ends with <code>?token=…</code>).</p></body>');
      return;
    }
    // sec-edit-os: the *server's* platform (Linux under WSL while the browser runs on Windows) — the UI uses
    // it for path separators and "Trash" vs "Recycle Bin", which are about the backend's file system.
    const html = data
      .toString('utf8')
      .replace('<head>', `<head><meta name="sec-edit-token" content="${token}"><meta name="sec-edit-os" content="${process.platform}">`);
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      'referrer-policy': 'no-referrer',
      // Cookies ignore ports: any page on http://127.0.0.1:<other port> is "same-site" and would get a
      // logged-in frame of the app (clickjacking). frame-ancestors can't be set from the <meta> CSP.
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'max-age=31536000, immutable' });
  res.end(data);
}
