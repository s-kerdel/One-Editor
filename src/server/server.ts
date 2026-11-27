// Local HTTP backend: serves the built renderer and exposes the BackendService over JSON RPC + SSE.
// Used for "browser mode" (handy from WSL / remote boxes) and by the E2E test-suite.
//
// Security model (it can read/write any folder you open, so it must not be reachable by web pages):
//  - binds to 127.0.0.1 and rejects foreign Host headers (DNS-rebinding);
//  - the token (full access) travels in the x-sec-edit-token header only: never a cookie (cookies ignore
//    ports, so every server on 127.0.0.1 would receive it; no cookie also means no CSRF), never a URL the
//    page shows. index.html is a static shell: the renderer keeps the token in sessionStorage;
//  - media GETs (<img>, PDF bytes) carry `m` = HMAC(mediaKey, root + path), the event stream `ev`: a leaked
//    image URL opens that one file of that folder, read-only (links leading outside are refused);
//  - `pinRoot` (every server cli.ts starts): the page opens only the folders the server was started for and
//    folders inside them, and writes only the settings the browser build shows (WEB_SETTINGS);
//  - `shared` (desktop "Start web server", any non-loopback bind): nothing about the machine either;
//  - the page never grants git trust (desktop only), a LAN client never opens a file manager here;
//  - `--open` hands the browser a one-time launch code in a 0600 file (launch-file.ts), never a command line;
//  - workspace files are served sandboxed, so an HTML/SVG file in a note folder cannot script our origin.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { MAX_BINARY_BYTES, RPC_METHODS, type FsEvent } from '../shared/api';
import { isTerminalMethod } from '../shared/terminal';
import { PDF_WORKER_CSP, isPdfWorkerAsset } from '../shared/pdf';
import { BackendService, type ServiceHooks } from '../backend/service';
import { BackendFailure, type WorkspaceOptions } from '../backend/workspace';
import { isInsideDir } from '../backend/pathsafe';
import { defaultCacheDir } from '../backend/appdata';

export interface ServerOptions {
  root?: string; // folder to open
  port?: number; // 0 = random
  host?: string;
  rendererDir: string; // built renderer (vite build output)
  configDir?: string;
  token?: string;
  /** Serve `roots` (and folders inside them) only, write only WEB_SETTINGS (see PINNED). */
  pinRoot?: boolean;
  /** Pinned: the folders the page may open, besides folders inside them (default: `root`). The CLI's own arguments only, never a path from a page. */
  roots?: string[];
  /** Others may hold the link (desktop "Start web server", a LAN bind): no process list, no OS version either. Default: `pinRoot`. */
  shared?: boolean;
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
  /** Key of the media capabilities (`m` on /api/file, `ev` on /api/events); handed out by bootstrap(). */
  mediaKey: string;
  /** `/api/file?…` path for a workspace file, with its capability (tests, tools). */
  mediaPath(rel: string): string;
  /** Link with a one-time launch code instead of the token (valid 2 minutes, once). `used`: called when the code is redeemed. */
  launchUrl(used?: () => void): string;
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
  saveSettings: { bytes: 256 * 1024, message: 'Settings change too large' },
};
const DEFAULT_LIMIT = { bytes: MAX_BODY, message: 'Request too large' };
/** Need Electron (hidden print window, native dialogs): refused before the (possibly huge) body is read. */
const DESKTOP_ONLY = new Set(['exportPdf', 'showExportedFile']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/**
 * The settings a pinned server's page may write (settings.json is shared with the desktop app): what the
 * browser build shows (settings-registry.ts without desktop-only rows). Left out on purpose: desktop-only
 * keys (terminal.*, claude.follow, opencode.follow, webserver.*, mcp.*, updates.check, zoom, windowFrame,
 * export.pdfPageNumbers) and preview.remoteImages (a page must not turn on remote images for every folder).
 * A new browser setting adds its key here (tests/unit/webserver/server-pin.test.ts checks the registry).
 */
export const WEB_SETTINGS: ReadonlySet<string> = new Set([
  'theme', 'accentColor', 'sidebarStyle', 'sidebar.panels', 'tree.folderColors', 'tree.folderColor', 'cornerStyle', 'uiDensity',
  'fontSize', 'editorFont', 'editorLineHeight', 'contentWidth', 'nav.buttons', 'zen.fullScreen', 'zen.keepStatusBar', 'zen.keepTerminal',
  'viewMode', 'formatToolbar', 'markdownLineNumbers', 'wordWrap', 'spellcheck', 'editor.focusMode', 'editor.typewriter', 'editor.smartPaste',
  'compare.enabled', 'editor.trimPaste.markdown', 'editor.trimPaste.code', 'editor.trimOnSave.markdown', 'editor.trimOnSave.code',
  'editor.trimOnSave.keepMarkdownBreaks', 'autosave', 'autosaveDelayMs', 'showHiddenFiles', 'excludeGlobs', 'files.associations', 'confirmDelete',
  'git.enabled', 'git.changeBars', 'git.treeColors', 'git.wslRouting', 'git.refreshIndex',
  'search.indexing', 'search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB', 'search.workers',
  'formatOnSave', 'format.printWidth', 'format.tabWidth', 'format.useTabs', 'format.singleQuote', 'format.phpVersion', 'format.sqlKeywordCase',
  'links.updateOnRename', 'links.hoverPreview', 'daily.folder', 'daily.format', 'daily.template', 'templates.folder', 'templates.dateFormat',
  'templates.timeFormat', 'attachments.location', 'attachments.folder', 'preview.lineBreaks', 'export.pdfPageSize', 'export.pdfMargins',
  'variables.showValues', 'variables.fileName', 'variables.dangerEnvs', 'variables.resolveOnExport',
]);
/** One setting's value as JSON, at most (the biggest real ones, folder colours or associations, stay far below). */
const MAX_SETTING_CHARS = 64 * 1024;
export const LAUNCH_TTL_MS = 120_000;
const EVENTS_SUBJECT = '\u0000events';

function safeEqual(a: string | undefined | null, b: string) {
  if (!a) return false;
  // Byte lengths: "é" is one character but two bytes (timingSafeEqual throws on a length mismatch).
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** The request comes from this computer (127.0.0.0/8, ::1, IPv4-mapped): not from a LAN client. */
export const fromLoopback = (addr: string | undefined) => !!addr && (addr === '::1' || /^(::ffff:)?127\./i.test(addr));

/** What a media capability names: a file of one folder (a URL kept from another folder opens nothing). */
export const mediaSubject = (root: string, rel: string) => `${root}\u0000${rel}`;

/** Same construction as the renderer's (platform/hmac.ts): HMAC-SHA256, first 128 bits as hex. */
export function mediaMac(key: string, subject: string): string {
  return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(subject, 'utf8').digest('hex').slice(0, 32);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const token = opts.token ?? crypto.randomBytes(18).toString('hex');
  const mediaKey = crypto.randomBytes(32).toString('hex');
  const launchCodes = new Map<string, { until: number; used?: () => void }>();
  // Browser clients keep their own per-folder session (open tabs, tree, layout): see ServiceHooks.sessionKind.
  const service = new BackendService(opts.configDir, { sessionKind: 'web', ...opts.hooks }, opts.workspaceOptions ?? {});
  if (opts.root) await service.openWorkspace(opts.root);
  const rendererDir = path.resolve(opts.rendererDir);
  const sseClients = new Set<http.ServerResponse>();
  /** `/api/events?git=1`: the lazy git chunk's own stream (no fs events on it). */
  const gitClients = new Set<http.ServerResponse>();
  const allowed = new Set<string>(RPC_METHODS);
  const host = opts.host ?? '127.0.0.1';
  const loopbackOnly = LOOPBACK.has(host);
  const pinned = !!opts.pinRoot;
  const shared = opts.shared ?? pinned;
  const roots = [...new Set((opts.roots ?? (opts.root ? [opts.root] : [])).map((r) => path.resolve(r)))];
  /** Several folders were given: the switcher lists them (one folder: nothing else to switch to). */
  const listed = () => (roots.length > 1 ? [...roots] : []);
  const foldCase = process.platform !== 'linux';
  /** Lexically inside a folder of `roots`: decided without touching the disk (a \\host\share path is never looked at). */
  const underRoots = (abs: string) => roots.some((r) => isInsideDir(abs, r, path, foldCase));
  /** Where `abs` really is (links resolved, the file system's own spelling): inside `roots` and not One's own data. */
  const whereIs = async (abs: string): Promise<'in' | 'out' | 'missing'> => {
    const real = await fsp.realpath(abs).catch(() => null);
    if (!real) return 'missing';
    const [realRoots, data] = await Promise.all([
      Promise.all(roots.map((r) => fsp.realpath(r).catch(() => null))),
      Promise.all([service.configDir, defaultCacheDir(service.configDir)].map((d) => fsp.realpath(d).catch(() => null))),
    ]);
    if (!realRoots.some((r) => r && isInsideDir(real, r, path, false))) return 'out';
    return data.some((d) => d && isInsideDir(real, d, path, false)) ? 'out' : 'in';
  };
  const notServed = () => new BackendFailure('EACCES', 'This web server only serves the folders it was started for');
  const pagePath = (p: unknown) => (typeof p === 'string' && p && !p.includes('\0') ? path.resolve(p) : '');
  const headerToken = (req: http.IncomingMessage) => {
    const t = req.headers['x-sec-edit-token'];
    return safeEqual(typeof t === 'string' ? t : null, token);
  };
  /** Pinned servers: the folders they were started for (and folders inside them), never one the page names. */
  const PINNED: Record<string, (args: unknown[]) => Promise<unknown>> = {
    async openWorkspace([p]) {
      const want = pagePath(p);
      if (!want || !underRoots(want)) throw notServed();
      const where = await whereIs(want);
      if (where === 'missing') throw new BackendFailure('ENOENT', `Not a folder: ${want}`);
      if (where === 'out') throw notServed();
      const before = service.workspace?.root ?? null;
      const info = await service.openWorkspace(want);
      // A link renamed into its place between the check and the open: back to the folder it came from.
      if ((await whereIs(service.workspace?.root ?? want)) !== 'in') {
        await service.openWorkspace(before ?? roots[0]).catch(() => {});
        throw notServed();
      }
      return info;
    },
    async resolvePath([p]) {
      const abs = pagePath(p);
      if (!abs || !underRoots(abs)) return null;
      const r = await service.resolvePath(abs);
      return r && r.rel !== null ? r : null;
    },
    recentWorkspaces: async () => listed(),
    forgetRecent: async () => listed(),
    async saveSettings([patch]) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch && typeof patch === 'object' ? patch : {})) {
        if (!WEB_SETTINGS.has(k)) continue; // desktop-only and privacy keys: dropped, the rest still saves
        if ((JSON.stringify(v) ?? '').length > MAX_SETTING_CHARS) throw new BackendFailure('ETOOBIG', `The value of ${k} is too large`);
        clean[k] = v;
      }
      return service.saveSettings(clean);
    },
    async bootstrap() {
      return { ...(await service.bootstrap()), recent: listed() };
    },
  };
  /** Shared servers: everything else about the machine stays out too. */
  const SHARED: Record<string, (args: unknown[]) => Promise<unknown>> = {
    async processes() {
      throw new BackendFailure('ENOTSUP', 'Not available from a shared web server');
    },
    // The OS build number / distro says more about this machine than the platform name the page already has.
    async osVersion() {
      throw new BackendFailure('ENOTSUP', 'Not available from a shared web server');
    },
  };

  service.onFsEvents((events: FsEvent[]) => {
    const payload = `data: ${JSON.stringify(events)}\n\n`;
    for (const res of sseClients) res.write(payload);
  });
  service.onGitChanged((e) => gitClients.forEach((r) => r.write(`event: git\ndata: ${JSON.stringify(e)}\n\n`)));
  // settings.json changed by another process (the desktop app): a named event, so fs-event handlers never see it.
  service.onExternalSettings((patch) => sseClients.forEach((r) => r.write(`event: settings\ndata: ${JSON.stringify(patch)}\n\n`)));
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
        // One-time launch code (`--open`) → the token. 128-bit single-use codes: guessing is hopeless.
        if (url.pathname === '/api/launch' && req.method === 'POST') {
          const body = await readBody(req, { bytes: 1024, message: 'Request too large' });
          let c = '';
          try {
            c = String(JSON.parse(body)?.code ?? '');
          } catch {}
          const entry = launchCodes.get(c);
          launchCodes.delete(c);
          const ok = entry !== undefined && entry.until > Date.now();
          try {
            entry?.used?.(); // spent: its redirect file goes (cli.ts)
          } catch {}
          res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(ok ? { token } : { error: 'expired' }));
          return;
        }
        const capability =
          url.pathname === '/api/file'
            ? safeEqual(url.searchParams.get('m'), mediaMac(mediaKey, mediaSubject(service.workspace?.root ?? '', url.searchParams.get('path') ?? '')))
            : url.pathname === '/api/events'
              ? safeEqual(url.searchParams.get('ev'), mediaMac(mediaKey, EVENTS_SUBJECT))
              : false;
        if (!capability && !headerToken(req)) {
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
          // real(): a link inside the folder must not lead outside it (a clone or archive can ship one).
          // Errors say nothing about the absolute path (a media capability is not the token).
          const abs = await ws.real(url.searchParams.get('path') || '').catch((err) => {
            throw new BackendFailure(err?.code === 'OUTSIDE_WORKSPACE' ? 'OUTSIDE_WORKSPACE' : 'ENOENT', 'Not found');
          });
          // Regular files only (a FIFO would hang the request forever), streamed (a 2 GB video must not be buffered).
          const st = await fsp.stat(abs).catch(() => null);
          if (!st?.isFile()) throw new BackendFailure('ENOENT', 'Not found');
          res.writeHead(200, {
            'content-type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'content-length': String(st.size),
            'cache-control': 'no-store',
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
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
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
        // Reveal opens a file manager on this computer's screen: never for a client on the network.
        if (m && m[1] === 'revealInFolder' && !fromLoopback(req.socket.remoteAddress)) {
          req.resume();
          throw new BackendFailure('ENOTSUP', 'Reveal in file manager works only on the computer that runs One');
        }
        if (m && req.method === 'POST' && DESKTOP_ONLY.has(m[1])) {
          req.resume(); // discard the body
          throw new BackendFailure('ENOTSUP', 'PDF export needs the desktop app. In the browser use Print and pick "Save as PDF"');
        }
        if (m && req.method === 'POST' && allowed.has(m[1])) {
          const body = await readBody(req, BODY_LIMITS[m[1]] ?? DEFAULT_LIMIT);
          const parsed = body ? JSON.parse(body) : null;
          const args: unknown = parsed?.args ?? [];
          if (!Array.isArray(args)) throw new BackendFailure('EINVAL', 'args must be an array');
          // Trust lets the folder's own .git/config run programs: only the desktop app's own dialog grants it.
          if (m[1] === 'git' && args[0] === 'trust') throw new BackendFailure('ENOTSUP', 'Trust this folder for git in the desktop app (Source control panel): a browser page cannot grant it');
          const pin = (shared ? SHARED[m[1]] : undefined) ?? (pinned ? PINNED[m[1]] : undefined);
          let result = pin ? await pin(args) : await (service as any)[m[1]](...args);
          // The renderer signs media URLs with this (platform/web.ts): it arrives with the first round-trip.
          if (m[1] === 'bootstrap' && result && typeof result === 'object') result = { ...result, mediaKey };
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, result: result ?? null }));
          return;
        }
        res.writeHead(404).end('not found');
        return;
      }
      await serveStatic(rendererDir, url, req.headers.host, res);
    } catch (err: any) {
      const code = err instanceof BackendFailure ? err.code : err?.code || 'EIO';
      const status = url.pathname.startsWith('/api/rpc') ? 200 : code === 'ENOENT' ? 404 : code === 'OUTSIDE_WORKSPACE' ? 403 : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
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
    mediaKey,
    mediaPath: (rel) => `/api/file?path=${encodeURIComponent(rel)}&m=${mediaMac(mediaKey, mediaSubject(service.workspace?.root ?? '', rel))}`,
    launchUrl(used) {
      const now = Date.now();
      for (const [c, e] of launchCodes) if (e.until <= now) launchCodes.delete(c);
      const code = crypto.randomBytes(16).toString('hex');
      launchCodes.set(code, { until: now + LAUNCH_TTL_MS, used });
      return `${origin}?launch=${code}`;
    },
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

/** The page's CSP lists the app's script paths for app://sec-edit (index.html): here they are this origin's.
 *  Only the build's assets run — never a workspace file served from /api/file, whatever a note manages. */
export function cspForOrigin(html: string, host: string | undefined): string {
  const ok = !!host && /^([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(host);
  return html.replace(/app:\/\/sec-edit\/(assets\/|theme-boot\.js)/g, (_m, p: string) => (ok ? `http://${host}/${p}` : "'self'"));
}

/** Browser mode's own renderer chunk (the HTTP transport: token, launch code, SSE, media capability). The
 *  desktop app never loads it; this server's index.html runs it (see withBrowserChunks). Found in Vite's
 *  build manifest by source path, never a file-name guess; no manifest (older build) → the entry imports it. */
export const BROWSER_CHUNK = 'platform/web.ts';
const chunkCache = new Map<string, { stamp: string; files: string[] }>();

/** The transport chunk's file first, then the chunks it imports that index.html does not list yet. */
export async function browserChunks(dir: string, html: string): Promise<string[]> {
  const file = path.join(dir, '.vite', 'manifest.json');
  let stamp: string;
  let manifest: Record<string, { file?: unknown; imports?: unknown }>;
  try {
    const st = await fsp.stat(file);
    stamp = `${st.mtimeMs}:${st.size}`;
    const hit = chunkCache.get(dir);
    if (hit?.stamp === stamp) return hit.files;
    manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return [];
  }
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = (key: string) => {
    const c = manifest[key];
    if (seen.has(key) || typeof c?.file !== 'string' || !/^assets\/[\w.-]+\.js$/.test(c.file)) return;
    seen.add(key);
    if (html.includes(`"./${c.file}"`)) return; // already on the startup path, its imports too
    files.push(c.file);
    if (Array.isArray(c.imports)) c.imports.forEach((k) => typeof k === 'string' && visit(k));
  };
  visit(BROWSER_CHUNK);
  chunkCache.set(dir, { stamp, files });
  return files;
}

/** The transport becomes a module script right before the entry: it downloads in parallel with it and,
 *  as module scripts run in document order, has installed itself before main.tsx asks for a backend (no
 *  import() hop in front of the bootstrap round trip). Chunks it needs that index.html does not list yet
 *  are modulepreloaded after the entry's own. */
function withBrowserChunks(html: string, files: string[]): string {
  if (!files.length) return html;
  const [chunk, ...deps] = files;
  const insert = (s: string, at: number, tags: string) => (at >= 0 ? s.slice(0, at) + tags + s.slice(at) : s);
  const entry = html.indexOf('<script type="module"');
  let out = insert(html, entry >= 0 ? entry : html.indexOf('</head>'), `<script type="module" crossorigin src="./${chunk}"></script>`);
  if (deps.length) {
    const last = out.lastIndexOf('<link rel="modulepreload"');
    out = insert(out, last >= 0 ? out.indexOf('>', last) + 1 : out.indexOf('</head>'), deps.map((f) => `<link rel="modulepreload" crossorigin href="./${f}">`).join(''));
  }
  return out;
}

async function serveStatic(dir: string, url: URL, host: string | undefined, res: http.ServerResponse) {
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  let file = path.resolve(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  // Build metadata (.vite/manifest.json) is for the server, not the page.
  if (path.relative(dir, file).split(path.sep)[0].toLowerCase() === '.vite') {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
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
    // A static shell: no token in it (the renderer brings its own from the link / sessionStorage).
    // sec-edit-os: the *server's* platform (Linux under WSL while the browser runs on Windows) — the UI uses
    // it for path separators and "Trash" vs "Recycle Bin", which are about the backend's file system.
    const raw = data.toString('utf8');
    const html = withBrowserChunks(cspForOrigin(raw, host), await browserChunks(dir, raw)).replace('<head>', `<head><meta name="sec-edit-os" content="${process.platform}">`);
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-dns-prefetch-control': 'off', // link hosts in a note are not looked up ahead
      // Any page on http://127.0.0.1:<other port> is "same-site": it must not frame the app (clickjacking).
      // frame-ancestors can't be set from the <meta> CSP.
      'content-security-policy': "frame-ancestors 'none'",
      'x-frame-options': 'DENY',
    });
    res.end(html);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'max-age=31536000, immutable',
    ...(isPdfWorkerAsset(rel) ? { 'content-security-policy': PDF_WORKER_CSP } : {}),
  });
  res.end(data);
}
