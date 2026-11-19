// The real server CLI in `--ipc` mode (what the desktop app's "Start web server" runs): the handshake
// arrives as data, nothing with the token is printed, 'stop' and a vanished parent both end it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, fork, type ChildProcess } from 'node:child_process';
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

function start(args: string[]) {
  const out: string[] = [];
  const child = fork(cli, [ws, '--ipc', ...args], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH ?? '', HOME: dir, TMPDIR: path.join(dir, 'tmp'), SEC_EDIT_CONFIG_DIR: path.join(dir, 'config'), SEC_EDIT_RENDERER_DIR: renderer },
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
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(`${base}api/rpc/getWorkspace`, { method: 'POST', body: '{}' })).status).toBe(403);
    const page = await fetch(`${base}?token=${m.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(`<meta name="sec-edit-token" content="${m.token}">`);
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
