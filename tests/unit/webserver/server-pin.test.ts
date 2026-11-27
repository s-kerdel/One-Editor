// Browser-mode server hardening (audit 2026-11-27): every server cli.ts starts is pinned to its folders
// (H2), no page grants git trust (H1), settings writes are an allowlist (L2), plus the small items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, fromLoopback, WEB_SETTINGS, type RunningServer } from '../../../src/server/server';
import { SECTIONS, SETTINGS } from '../../../src/renderer/app/settings-registry';

const TMP = fileURLToPath(new URL('../../../.tmp/webserver/unit', import.meta.url));
let tmp: string;
let a: string; // first CLI folder
let b: string; // second CLI folder
let outside: string;
let renderer: string;
const servers: RunningServer[] = [];

function req(srv: RunningServer, pathname: string, o: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request({ host: o.host ?? '127.0.0.1', port: srv.port, path: pathname, method: o.method ?? 'GET', headers: o.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.setTimeout(4000, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (o.body) r.write(o.body);
    r.end();
  });
}
async function call(srv: RunningServer, method: string, args: unknown[], host?: string): Promise<any> {
  const r = await req(srv, `/api/rpc/${method}`, { method: 'POST', host, headers: { 'content-type': 'application/json', 'x-sec-edit-token': srv.token }, body: JSON.stringify({ args }) });
  return JSON.parse(r.body);
}
async function serve({ cfg, ...o }: Partial<Parameters<typeof startServer>[0]> & { cfg: string }) {
  const s = await startServer({ root: a, port: 0, rendererDir: renderer, configDir: path.join(tmp, cfg), ...o });
  servers.push(s);
  return s;
}

beforeAll(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(TMP, 'pin-'));
  a = path.join(tmp, 'a');
  b = path.join(tmp, 'b');
  outside = path.join(tmp, 'outside');
  renderer = path.join(tmp, 'renderer');
  for (const d of [path.join(a, 'sub'), b, outside, renderer]) await fsp.mkdir(d, { recursive: true });
  await fsp.writeFile(path.join(a, 'sub', 'x.md'), '# x\n');
  await fsp.writeFile(path.join(a, 'img.png'), 'png');
  await fsp.writeFile(path.join(outside, 'secret.md'), 'outside');
  await fsp.writeFile(path.join(renderer, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
  if (process.platform !== 'win32') await fsp.symlink(outside, path.join(a, 'link-out'));
});
afterAll(async () => {
  for (const s of servers) await s.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('H2: a pinned server opens its CLI folders and folders inside them, nothing else', () => {
  let srv: RunningServer;
  beforeAll(async () => {
    // App data inside the first folder (the home folder on Windows holds AppData): never a folder to open.
    srv = await serve({ roots: [a, b], pinRoot: true, cfg: '', configDir: path.join(a, 'appdata') });
    await call(srv, 'getSettings', []); // creates the app data folder
  });

  it('switches into a subfolder, back, and to the other CLI folder; lists the CLI folders as recent', async () => {
    expect((await call(srv, 'openWorkspace', [path.join(a, 'sub')])).result.root).toBe(path.join(a, 'sub'));
    expect((await call(srv, 'openWorkspace', [a])).result.root).toBe(a);
    expect((await call(srv, 'openWorkspace', [b])).result.root).toBe(b);
    expect((await call(srv, 'openWorkspace', [a])).result.root).toBe(a);
    expect((await call(srv, 'recentWorkspaces', [])).result).toEqual([a, b]);
    expect((await call(srv, 'bootstrap', [])).result.recent).toEqual([a, b]);
  });

  it('refuses a page-named folder outside, a link leading out, One’s data folder; a missing one is ENOENT', async () => {
    for (const p of [tmp, outside, os.homedir(), '/', path.join(a, '..', 'outside'), 'relative/x', '', 42]) {
      expect((await call(srv, 'openWorkspace', [p])).error?.code, String(p)).toBe('EACCES');
    }
    if (process.platform !== 'win32') expect((await call(srv, 'openWorkspace', [path.join(a, 'link-out')])).error.code).toBe('EACCES');
    expect((await call(srv, 'openWorkspace', [path.join(a, 'appdata')])).error.code).toBe('EACCES');
    expect((await call(srv, 'openWorkspace', [path.join(a, 'missing')])).error.code).toBe('ENOENT');
    expect((await call(srv, 'getWorkspace', [])).result.root).toBe(a);
  });

  it('resolvePath answers for the open folder only', async () => {
    expect((await call(srv, 'resolvePath', [path.join(outside, 'secret.md')])).result).toBeNull();
    expect((await call(srv, 'resolvePath', [path.join(a, 'sub', 'x.md')])).result).toMatchObject({ rel: 'sub/x.md', kind: 'file' });
  });

  it('one folder: the switcher lists nothing else (subfolders stay reachable)', async () => {
    const one = await serve({ pinRoot: true, cfg: 'cfg-one' });
    expect((await call(one, 'recentWorkspaces', [])).result).toEqual([]);
    expect((await call(one, 'openWorkspace', [path.join(a, 'sub')])).ok).toBe(true);
    expect((await call(one, 'openWorkspace', [b])).error.code).toBe('EACCES');
  });
});

describe('H1: no HTTP server grants git trust', () => {
  it('trust is ENOTSUP, pinned or not; nothing is written; untrust still works', async () => {
    for (const [cfg, pinRoot] of [['cfg-trust-pinned', true], ['cfg-trust-open', false]] as const) {
      const srv = await serve({ pinRoot, cfg });
      const r = await call(srv, 'git', ['trust']);
      expect(r.error?.code, cfg).toBe('ENOTSUP');
      const file = path.join(tmp, cfg, 'git-trust.json');
      const trusted = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).trusted : [];
      expect(trusted).toEqual([]);
      expect((await call(srv, 'git', ['untrust'])).ok).toBe(true);
    }
  });
});

describe('L2: a pinned server writes only the settings the browser build shows', () => {
  it('drops desktop-only and privacy keys, keeps the rest', async () => {
    const srv = await serve({ pinRoot: true, cfg: 'cfg-settings' });
    const refused: Record<string, unknown> = {
      'claude.follow': true,
      'opencode.follow': true,
      'updates.check': true,
      'preview.remoteImages': 'always',
      'terminal.runPressesEnter': true,
      'webserver.access': 'lan',
      'mcp.maxResults': 5,
      zoom: 2,
      windowFrame: 'native',
      'made.up': 1,
    };
    const r = await call(srv, 'saveSettings', [{ theme: 'light', 'git.treeColors': false, ...refused }]);
    expect(r.result).toMatchObject({ theme: 'light', 'git.treeColors': false });
    const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'cfg-settings', 'settings.json'), 'utf8'));
    expect(disk).toMatchObject({ theme: 'light', 'git.treeColors': false });
    for (const [k, v] of Object.entries(refused)) {
      expect(disk, k).not.toHaveProperty([k]);
      expect(r.result[k], k).not.toEqual(v);
    }
  });

  it('caps one value and the whole change', async () => {
    const srv = await serve({ pinRoot: true, cfg: 'cfg-settings-cap' });
    expect((await call(srv, 'saveSettings', [{ excludeGlobs: ['x'.repeat(70_000)] }])).error.code).toBe('ETOOBIG');
    expect((await call(srv, 'saveSettings', [{ theme: 'light', pad: 'x'.repeat(300_000) }])).error.code).toBe('ETOOBIG');
    expect((await call(srv, 'saveSettings', [{ excludeGlobs: ['node_modules', 'dist'] }])).result.excludeGlobs).toEqual(['node_modules', 'dist']);
  });

  it('the allowlist is the registry’s browser rows minus preview.remoteImages (a new setting must be added)', () => {
    const desktopSections = new Set(SECTIONS.filter((s) => s.desktopOnly).map((s) => s.id));
    const browser = SETTINGS.filter((d) => !d.desktopOnly && !desktopSections.has(d.section)).map((d) => d.key);
    const desktop = SETTINGS.filter((d) => d.desktopOnly || desktopSections.has(d.section)).map((d) => d.key);
    expect([...WEB_SETTINGS].sort()).toEqual(browser.filter((k) => k !== 'preview.remoteImages').sort());
    expect(desktop.filter((k) => WEB_SETTINGS.has(k))).toEqual([]);
    expect(desktop).toEqual(expect.arrayContaining(['claude.follow', 'opencode.follow', 'updates.check', 'terminal.runPressesEnter', 'webserver.access']));
  });
});

describe('shared vs local', () => {
  it('a local pinned server keeps the OS version; a shared one (the default for pinned) does not', async () => {
    const local = await serve({ pinRoot: true, shared: false, cfg: 'cfg-local' });
    expect((await call(local, 'osVersion', [])).result.platform).toBe(process.platform);
    const shared = await serve({ pinRoot: true, cfg: 'cfg-shared' });
    expect((await call(shared, 'osVersion', [])).error.code).toBe('ENOTSUP');
  });
});

describe('small items', () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await serve({ pinRoot: true, cfg: 'cfg-small', token: 'a'.repeat(36) });
  });

  it('a non-ASCII token or capability of the same length is 403, not a crash (byte lengths)', async () => {
    const rpc = await req(srv, '/api/rpc/getWorkspace', { method: 'POST', headers: { 'x-sec-edit-token': 'é'.repeat(36) }, body: '{"args":[]}' });
    expect(rpc.status).toBe(403);
    const file = await req(srv, `/api/file?path=img.png&m=${encodeURIComponent('é'.repeat(32))}`);
    expect(file.status).toBe(403);
  });

  it('/api/file is never stored; the app page sends no referrer and prefetches no DNS', async () => {
    const f = await req(srv, srv.mediaPath('img.png'));
    expect(f.status).toBe(200);
    expect(f.headers['cache-control']).toBe('no-store');
    const page = await req(srv, '/');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['x-dns-prefetch-control']).toBe('off');
  });

  it('a launch code reports when it is spent (its redirect file can go)', async () => {
    let used = 0;
    const code = new URL(srv.launchUrl(() => used++)).searchParams.get('launch');
    const r = await req(srv, '/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(JSON.parse(r.body).token).toBe(srv.token);
    expect(used).toBe(1);
  });

  it('loopback addresses', () => {
    for (const ok of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) expect(fromLoopback(ok), ok).toBe(true);
    for (const no of ['192.168.1.20', '::ffff:10.0.0.2', 'fe80::1', '1127.0.0.1', '', undefined]) expect(fromLoopback(no), String(no)).toBe(false);
  });

  // Needs an address of this machine that is not loopback (none in some sandboxes).
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  it.skipIf(!lan)('reveal in file manager: from this computer yes, from a client on the network no', async () => {
    const revealed: string[] = [];
    // A stub instead of the platform's file manager (nothing opens on this machine).
    const onLan = await serve({ pinRoot: true, host: '0.0.0.0', cfg: 'cfg-lan', hooks: { revealInFolder: (abs: string) => void revealed.push(abs) } });
    expect((await call(onLan, 'revealInFolder', ['img.png'], lan)).error.code).toBe('ENOTSUP');
    expect(revealed).toEqual([]);
    expect((await call(onLan, 'revealInFolder', ['img.png'], '127.0.0.1')).ok).toBe(true);
    expect(revealed).toEqual([path.join(a, 'img.png')]);
  });
});
