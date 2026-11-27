// The real server CLI in `--ipc` mode (what the desktop app's "Start web server" runs): the handshake
// arrives as data, nothing with the token is printed, 'stop' and a vanished parent both end it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseChildMessage } from '../../../src/shared/web-server';

const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, '.tmp/webserver/cli-ipc');
const cli = path.join(dir, 'dist/server/cli.mjs');
const ws = path.join(dir, 'ws');
const renderer = path.join(dir, 'renderer');
const kids: ChildProcess[] = [];

beforeAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(renderer, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.md'), '# a\n');
  fs.writeFileSync(path.join(renderer, 'index.html'), '<!doctype html><html><head><title>t</title></head><body>app</body></html>');
  execFileSync(process.execPath, [path.join(root, 'scripts/build-node.mjs'), '--outdir', path.join(dir, 'dist'), '--only', 'server'], { cwd: root, stdio: 'pipe' });
}, 60_000);
afterAll(() => {
  for (const k of kids) k.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (PATH = process.env.PATH ?? '') => ({ PATH, HOME: dir, TMPDIR: path.join(dir, 'tmp'), SEC_EDIT_CONFIG_DIR: path.join(dir, 'config'), SEC_EDIT_RENDERER_DIR: renderer });
const launchDir = () => path.join(dir, 'config', 'launch');
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const rpc = (base: string, token: string, method: string, args: unknown[]) =>
  fetch(`${base}api/rpc/${method}`, { method: 'POST', headers: { 'x-sec-edit-token': token }, body: JSON.stringify({ args }) }).then((r) => r.json() as Promise<any>);

function start(args: string[]) {
  const out: string[] = [];
  const child = fork(cli, [ws, '--ipc', ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: env(),
  });
  kids.push(child);
  child.stdout!.on('data', (d) => out.push(String(d)));
  child.stderr!.on('data', (d) => out.push(String(d)));
  const message = new Promise<unknown>((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (code) => reject(new Error(`exited ${code}: ${out.join('')}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, message, exited, out };
}

const freePort = () =>
  new Promise<net.Server>((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

describe('cli --ipc', () => {
  it('reports port + token as data, prints no link, serves only with the token, stops on request', async () => {
    const r = start(['--host', '127.0.0.1']);
    const m = parseChildMessage(await r.message);
    expect(m?.type).toBe('ready');
    if (m?.type !== 'ready') return;
    expect(m.port).toBeGreaterThanOrEqual(4317);
    const base = `http://127.0.0.1:${m.port}/`;
    // The page is a static shell (no token in it, no cookie); without the token no data comes back.
    const shell = await fetch(base);
    expect(shell.headers.get('set-cookie')).toBeNull();
    expect(await shell.text()).not.toContain(m.token);
    expect((await fetch(`${base}api/rpc/getWorkspace`, { method: 'POST', body: '{}' })).status).toBe(403);
    const ok = await fetch(`${base}api/rpc/getWorkspace`, { method: 'POST', headers: { 'x-sec-edit-token': m.token }, body: '{"args":[]}' });
    expect((await ok.json()).ok).toBe(true);
    // --ipc pins the server to its folder: the rest of the machine stays out.
    const other = await fetch(`${base}api/rpc/openWorkspace`, { method: 'POST', headers: { 'x-sec-edit-token': m.token }, body: JSON.stringify({ args: [dir] }) });
    expect((await other.json()).error.code).toBe('EACCES');
    // A one-time launch link for the parent's "Open in browser" (no token on a command line).
    r.child.send({ type: 'launch' });
    const launch = (await new Promise((res) => r.child.once('message', res))) as { type: string; url: string };
    expect(launch.type).toBe('launch');
    expect(launch.url).toMatch(/\?launch=[a-f0-9]{32}$/);
    expect(r.out.join('')).not.toContain(m.token);
    r.child.send({ type: 'stop' });
    expect(await r.exited).toBe(0);
    await expect(fetch(base)).rejects.toThrow();
  });

  it('a taken port comes back as an error message, then exit 1', async () => {
    const blocker = await freePort();
    const port = (blocker.address() as net.AddressInfo).port;
    const r = start(['--port', String(port)]);
    expect(parseChildMessage(await r.message)).toEqual({ type: 'error', code: 'EADDRINUSE', message: `Port ${port} is in use` });
    expect(await r.exited).toBe(1);
    blocker.close();
  });

  it('without --port the folder’s last port comes first; taken, it says so (browser state starts empty)', async () => {
    const a = start(['--host', '127.0.0.1']);
    const first = parseChildMessage(await a.message);
    if (first?.type !== 'ready') throw new Error('not ready');
    expect(first.busy).toBeUndefined();
    a.child.send({ type: 'stop' });
    await a.exited;
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'config/web-ports.json'), 'utf8')))).toEqual([first.port]);
    // Free again: the same port (same origin → same browser state).
    const b = start(['--host', '127.0.0.1']);
    expect(parseChildMessage(await b.message)).toMatchObject({ type: 'ready', port: first.port });
    b.child.send({ type: 'stop' });
    await b.exited;
    // Taken by someone else: the next free one, and the handshake names the busy port.
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(first.port, '127.0.0.1', () => r()));
    const c = start(['--host', '127.0.0.1']);
    const m = parseChildMessage(await c.message);
    expect(m).toMatchObject({ type: 'ready', busy: first.port });
    expect((m as { port: number }).port).not.toBe(first.port);
    c.child.send({ type: 'stop' });
    await c.exited;
    blocker.close();
  });

  it('exits when the parent goes away (IPC disconnect): no orphan server', async () => {
    const r = start(['--host', '127.0.0.1']);
    const m = parseChildMessage(await r.message);
    expect(m?.type).toBe('ready');
    r.child.disconnect();
    expect(await r.exited).toBe(0);
  });
});

describe('cli: every server is pinned; the browser gets a file, never the launch code', () => {
  it('--ipc { type: launch, file: true }: a 0600 redirect page in a 0700 folder of the app data, gone once spent or stopped', async () => {
    const r = start(['--host', '127.0.0.1']);
    const m = parseChildMessage(await r.message);
    if (m?.type !== 'ready') throw new Error('not ready');
    const base = `http://127.0.0.1:${m.port}/`;
    const ask = () => {
      r.child.send({ type: 'launch', file: true });
      return new Promise<any>((res) => r.child.once('message', res));
    };
    const first = await ask();
    expect(first).toEqual({ type: 'launch', file: expect.any(String) });
    expect(path.dirname(first.file)).toBe(launchDir());
    if (process.platform !== 'win32') {
      expect(mode(launchDir())).toBe(0o700);
      expect(mode(first.file)).toBe(0o600);
    }
    const html = fs.readFileSync(first.file, 'utf8');
    const code = /\?launch=([a-f0-9]{32})/.exec(html)?.[1];
    expect(html).toContain(`url=${base}?launch=${code}`);
    expect(html).not.toContain(m.token);
    const res = await fetch(`${base}api/launch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    expect(((await res.json()) as { token: string }).token).toBe(m.token);
    await expect.poll(() => fs.existsSync(first.file)).toBe(false);
    // Never opened: removed when the server stops.
    const second = await ask();
    expect(fs.existsSync(second.file)).toBe(true);
    r.child.send({ type: 'stop' });
    expect(await r.exited).toBe(0);
    expect(fs.existsSync(second.file)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('a plain local serve of two folders with --open: pinned to them; the opener gets a file path only', async () => {
    const ws2 = path.join(dir, 'ws2');
    fs.mkdirSync(ws2, { recursive: true });
    // Stand-ins for xdg-open / open: record what the browser would have been given.
    const bin = path.join(dir, 'fakebin');
    const log = path.join(dir, 'opened.txt');
    fs.mkdirSync(bin, { recursive: true });
    for (const name of ['xdg-open', 'open']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    const out: string[] = [];
    const child = spawn(process.execPath, [cli, ws, ws2, '--open', '--host', '127.0.0.1'], { stdio: ['ignore', 'pipe', 'pipe'], env: env(`${bin}${path.delimiter}${process.env.PATH ?? ''}`) });
    kids.push(child);
    child.stdout!.on('data', (d) => out.push(String(d)));
    child.stderr!.on('data', (d) => out.push(String(d)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    await expect.poll(() => /→ (http:\/\/\S+)/.test(out.join('')), { timeout: 15000 }).toBe(true);
    const link = new URL(/→ (http:\/\/\S+)/.exec(out.join(''))![1]);
    const base = `${link.origin}/`;
    const token = link.searchParams.get('token')!;

    await expect.poll(() => fs.existsSync(log), { timeout: 10000 }).toBe(true);
    const argv = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(argv).toHaveLength(1);
    expect(argv[0]).not.toMatch(/launch=|token=|^http/);
    expect(path.dirname(argv[0])).toBe(launchDir());
    expect(mode(argv[0])).toBe(0o600);
    expect(fs.readFileSync(argv[0], 'utf8')).toMatch(new RegExp(`url=${base.replace(/[.]/g, '\\.')}\\?launch=[a-f0-9]{32}`));

    // No --ipc, loopback only: still pinned. The other given folder and folders inside them only.
    expect((await rpc(base, token, 'openWorkspace', [dir])).error.code).toBe('EACCES');
    expect((await rpc(base, token, 'openWorkspace', [ws2])).result.root).toBe(ws2);
    expect((await rpc(base, token, 'recentWorkspaces', [])).result).toEqual([ws, ws2]);
    // Local: the OS version stays (only a shared server hides the machine).
    expect((await rpc(base, token, 'osVersion', [])).ok).toBe(true);

    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(fs.existsSync(argv[0])).toBe(false);
  });
});
