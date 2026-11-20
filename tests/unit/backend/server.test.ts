// The browser-mode server over real HTTP: token auth, DNS-rebinding guard, RPC, SSE, file serving.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cspForOrigin, mediaMac, mediaSubject, startServer, type RunningServer } from '../../../src/server/server';

let tmp: string;
let srv: RunningServer;

function req(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: pathname, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

const rpc = (method: string, args: unknown[], token: string | null = srv.token) =>
  req(`/api/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-sec-edit-token': token } : {}) }, body: JSON.stringify({ args }) });

beforeAll(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-srv-'));
  const root = path.join(tmp, 'ws');
  const renderer = path.join(tmp, 'renderer');
  await fsp.mkdir(path.join(root, 'img'), { recursive: true });
  await fsp.mkdir(path.join(renderer, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(root, 'note.md'), '# Hi\r\n');
  await fsp.writeFile(path.join(root, 'img', 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await fsp.writeFile(
    path.join(renderer, 'index.html'),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src app://sec-edit/assets/ app://sec-edit/theme-boot.js 'wasm-unsafe-eval'"><title>t</title></head><body></body></html>`,
  );
  await fsp.writeFile(path.join(renderer, 'assets', 'app.js'), 'console.log(1)');
  srv = await startServer({ root, port: 0, rendererDir: renderer, configDir: path.join(tmp, 'cfg'), workspaceOptions: { debounceMs: 20 } });
});
afterAll(async () => {
  await srv.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('server', () => {
  it('url carries the token; index.html is a static shell: no token in it, no cookie', async () => {
    expect(srv.url).toContain(`?token=${srv.token}`);
    for (const r of [await req('/'), await req(`/?token=${srv.token}`)]) {
      expect(r.status).toBe(200);
      expect(r.body).not.toContain(srv.token);
      // Cookies ignore ports: every server on 127.0.0.1 would receive it.
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });

  it("the page's CSP runs the build's scripts only, on this origin (never a workspace file)", async () => {
    const page = await req('/');
    expect(page.body).toContain(`script-src http://127.0.0.1:${srv.port}/assets/ http://127.0.0.1:${srv.port}/theme-boot.js 'wasm-unsafe-eval'`);
    expect(page.body).not.toContain('app://');
    // A Host that is not a plain host[:port] (LAN binds accept any) never lands in the policy.
    expect(cspForOrigin("script-src app://sec-edit/assets/ app://sec-edit/theme-boot.js", "x.example/ 'unsafe-inline' a")).toBe("script-src 'self' 'self'");
  });

  it('serves static assets without a token, 404s missing assets', async () => {
    expect((await req('/assets/app.js')).body).toBe('console.log(1)');
    expect((await req('/assets/missing.js')).status).toBe(404);
    const up = await req('/../../etc/passwd');
    expect(up.body).not.toMatch(/root:/); // the app shell (SPA fallback) or a refusal, never the file
    expect((await req('/..%2f..%2fpackage.json')).status).toBe(403);
  });

  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const r = await req(`/?token=${srv.token}`, { headers: { host: 'evil.example:80' } });
    expect(r.status).toBe(421);
  });

  it('RPC needs the header token — a cookie alone is not enough (CSRF)', async () => {
    expect((await rpc('getWorkspace', [], null)).status).toBe(403);
    expect((await rpc('getWorkspace', [], 'wrong')).status).toBe(403);
    const cookieOnly = await req('/api/rpc/getWorkspace', { method: 'POST', headers: { cookie: `sec_edit_token=${srv.token}` }, body: '{"args":[]}' });
    expect(cookieOnly.status).toBe(403);
    const ok = JSON.parse((await rpc('readFile', ['note.md'])).body);
    expect(ok).toMatchObject({ ok: true, result: { content: '# Hi\n', eol: 'crlf' } });
  });

  it('maps backend errors to codes', async () => {
    const r = JSON.parse((await rpc('readFile', ['nope.md'])).body);
    expect(r).toMatchObject({ ok: false, error: { code: 'ENOENT' } });
    const bad = JSON.parse((await rpc('readFile', ['../../outside'])).body);
    expect(bad.ok).toBe(false);
  });

  it('serves workspace files sandboxed (no script execution on our origin)', async () => {
    const r = await req(srv.mediaPath('img/evil.svg'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('image/svg+xml');
    expect(r.headers['content-security-policy']).toContain('sandbox');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect((await req('/api/file?path=img/evil.svg')).status).toBe(403);
  });

  it('media URLs carry a per-file capability, never the token', async () => {
    // The token in a URL no longer opens anything (it used to: <img> URLs leaked it).
    expect((await req(`/api/file?path=note.md&token=${srv.token}`)).status).toBe(403);
    // A capability opens exactly the file it was made for.
    const root = path.join(tmp, 'ws');
    const m = mediaMac(srv.mediaKey, mediaSubject(root, 'img/evil.svg'));
    expect((await req(`/api/file?path=img%2Fevil.svg&m=${mediaMac(srv.mediaKey, 'img/evil.svg')}`)).status).toBe(403); // no folder in it
    expect((await req(`/api/file?path=note.md&m=${m}`)).status).toBe(403);
    expect((await req(`/api/file?path=img%2Fevil.svg&m=${m}`)).status).toBe(200);
    // The header token still works (the app's own fetches may use it).
    expect((await req('/api/file?path=note.md', { headers: { 'x-sec-edit-token': srv.token } })).status).toBe(200);
    // bootstrap() hands the key to the renderer (it signs media URLs itself).
    expect(JSON.parse((await rpc('bootstrap', [])).body).result.mediaKey).toBe(srv.mediaKey);
  });

  it('every other /api endpoint takes the token from the header only', async () => {
    expect((await req(`/api/index/page?token=${srv.token}`)).status).toBe(403);
    expect((await req('/api/index/page', { headers: { 'x-sec-edit-token': srv.token } })).status).toBe(200);
    expect((await req(`/api/events?token=${srv.token}`)).status).toBe(403);
  });

  it('--open links carry a one-time launch code that is exchanged for the token once', async () => {
    const link = new URL(srv.launchUrl());
    expect(link.search).not.toContain(srv.token);
    const code = link.searchParams.get('launch')!;
    const redeem = () => req('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    const first = await redeem();
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body).token).toBe(srv.token);
    expect((await redeem()).status).toBe(403);
    expect((await req('/api/launch', { method: 'POST', body: '{"code":"guess"}' })).status).toBe(403);
  });

  it('streams external file changes over SSE', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const r = http.get({ host: '127.0.0.1', port: srv.port, path: `/api/events?ev=${mediaMac(srv.mediaKey, '\u0000events')}` }, (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('data:')) {
            r.destroy();
            resolve(buf);
          }
        });
      });
      r.on('error', reject);
      setTimeout(() => void fsp.writeFile(path.join(tmp, 'ws', 'external.md'), 'x'), 150);
      setTimeout(() => reject(new Error('no SSE event')), 5000);
    });
    expect(got).toContain('"path":"external.md"');
    expect(got).toContain('"type":"add"');
  });
});
