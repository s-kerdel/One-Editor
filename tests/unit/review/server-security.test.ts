// Browser-mode server, adversarial: framing, traversal, special files, malformed input, token handling.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../../../src/server/server';

const TMP = fileURLToPath(new URL('../../../.tmp/review/unit', import.meta.url));
let tmp: string;
let root: string;
let srv: RunningServer;

function req(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string; timeout?: number } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: srv.port, path: pathname, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(opts.timeout ?? 4000, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}
const file = (rel: string) => req(srv.mediaPath(rel));
const rpc = (method: string, body: string) => req(`/api/rpc/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': srv.token }, body });

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(TMP, 'srv-'));
  root = path.join(tmp, 'ws');
  const renderer = path.join(tmp, 'renderer');
  await fsp.mkdir(path.join(root, 'img'), { recursive: true });
  await fsp.mkdir(renderer, { recursive: true });
  await fsp.writeFile(path.join(tmp, 'secret.txt'), 'outside');
  await fsp.writeFile(path.join(root, 'img', 'a b#1.png'), 'png');
  await fsp.writeFile(path.join(renderer, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(root, 'pipe.png')]);
  srv = await startServer({ root, port: 0, rendererDir: renderer, configDir: path.join(tmp, 'cfg') });
});
afterAll(async () => {
  try {
    fs.closeSync(fs.openSync(path.join(root, 'pipe.png'), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK));
  } catch {}
  await srv.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('server hardening', () => {
  it('index.html cannot be framed by another local page (clickjacking the app)', async () => {
    const r = await req(`/?token=${srv.token}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-security-policy'])).toMatch(/frame-ancestors 'none'/);
    expect(r.headers['x-frame-options']).toBe('DENY');
    // The UI must know the *server's* platform (WSL: linux), not guess it from the browser.
    expect(r.body).toContain(`<meta name="sec-edit-os" content="${process.platform}">`);
  });

  it('/api/file stays inside the workspace for every encoding of ..', async () => {
    for (const p of ['../secret.txt', '..%2Fsecret.txt', '..\\secret.txt', '/../secret.txt', 'img/../../secret.txt']) {
      const r = await req(`/api/file?path=${p.includes('%') ? p : encodeURIComponent(p)}`, { headers: { 'x-sec-edit-token': srv.token } });
      expect(r.body, p).not.toBe('outside');
    }
    expect((await file('img/a b#1.png')).body).toBe('png');
  });

  it('/api/file refuses folders and special files instead of hanging', async () => {
    expect((await file('img')).status).toBeGreaterThanOrEqual(400);
    if (process.platform !== 'win32') expect((await file('pipe.png')).status).toBeGreaterThanOrEqual(400);
  });

  it('/api/file is only embeddable by our own origin', async () => {
    const r = await file('img/a b#1.png');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(String(r.headers['content-security-policy'])).toMatch(/sandbox/);
  });

  it('no cookie carries access (cookies ignore ports): none is set, none is accepted', async () => {
    const ok = await req(`/?token=${srv.token}`);
    expect(ok.headers['set-cookie']).toBeUndefined();
    expect((await req('/api/file?path=img%2Fa%20b%231.png', { headers: { cookie: `sec_edit_token=${srv.token}` } })).status).toBe(403);
  });

  it('/api/file refuses a link that leads outside the folder, without naming paths', async () => {
    if (process.platform === 'win32') return; // symlinks need privileges there
    await fsp.symlink(path.join(tmp, 'secret.txt'), path.join(root, 'img', 'out.png')).catch(() => {});
    const r = await file('img/out.png');
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('outside');
    expect(r.body).not.toContain(tmp);
    const missing = await file('img/none.png');
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain(root);
  });

  it('malformed RPC bodies are errors, never crashes', async () => {
    for (const body of ['{', '{"args": 5}', '{"args": {"length": 3}}', '{"args": [{"__proto__": {"x": 1}}]}', 'null']) {
      const r = await rpc('readFile', body);
      expect(r.status, body).toBe(200);
      expect(JSON.parse(r.body).ok, body).toBe(false);
    }
    // Server still alive.
    expect(JSON.parse((await rpc('getWorkspace', '{"args":[]}')).body).ok).toBe(true);
  });

  it('error replies do not echo the absolute workspace path', async () => {
    const r = JSON.parse((await rpc('readFile', JSON.stringify({ args: ['nope/missing.md'] }))).body);
    expect(r.ok).toBe(false);
    expect(r.error.message).not.toContain(root);
  });

  it('rejects rebinding Host headers and requests without a Host', async () => {
    expect((await req('/', { headers: { host: 'attacker.example:4317' } })).status).toBe(421);
    expect((await req(`/api/rpc/getWorkspace`, { method: 'POST', headers: { host: '127.0.0.1.attacker.example', 'x-sec-edit-token': srv.token } })).status).toBe(421);
  });
});

describe('pinned server (desktop "Start web server", LAN)', () => {
  let pinned: RunningServer;
  const call = (method: string, args: unknown[]) =>
    new Promise<any>((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: pinned.port, path: `/api/rpc/${method}`, method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': pinned.token } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      });
      r.on('error', reject);
      r.end(JSON.stringify({ args }));
    });
  beforeAll(async () => {
    pinned = await startServer({ root, port: 0, rendererDir: path.join(tmp, 'renderer'), configDir: path.join(tmp, 'cfg-pinned'), pinRoot: true });
    await pinned.service.saveSettings({ 'terminal.runPressesEnter': false });
  });
  afterAll(() => pinned.close());

  it('serves its folder only: no other folder, no recent list, no process list', async () => {
    expect((await call('openWorkspace', [tmp])).error.code).toBe('EACCES');
    expect((await call('openWorkspace', [root])).ok).toBe(true); // re-opening its own folder is fine
    expect(await call('resolvePath', [path.join(tmp, 'secret.txt')])).toMatchObject({ ok: true, result: null });
    expect((await call('resolvePath', [path.join(root, 'img')])).result).toMatchObject({ rel: 'img' });
    expect((await call('recentWorkspaces', [])).result).toEqual([]);
    expect((await call('bootstrap', [])).result.recent).toEqual([]);
    expect((await call('processes', [{ op: 'snapshot' }])).error.code).toBe('ENOTSUP');
    expect((await call('getWorkspace', [])).result.root).toBe(root);
  });

  it('cannot change the desktop-only settings it shares with the app', async () => {
    const r = await call('saveSettings', [{ 'terminal.runPressesEnter': true, 'webserver.access': 'lan', theme: 'light' }]);
    expect(r.result.theme).toBe('light');
    expect(r.result['terminal.runPressesEnter']).toBe(false);
    expect(r.result['webserver.access']).toBeUndefined();
  });
});
