import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { WebServerService, buildUrls, childEnv, errorLine, lanAddresses, redact, registerWebServerIpc, type ChildLike } from '../../../src/main/web-server';
import { webServerBridge } from '../../../src/main/web-server-bridge';
import { WEB_SERVER_CHANNELS as CH, optionsFromSettings, parseChildMessage, parseWebServerOptions, type WebServerStatus } from '../../../src/shared/web-server';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234';

class FakeChild extends EventEmitter {
  pid = 4242;
  connected = true;
  stderr = new EventEmitter();
  sent: unknown[] = [];
  kills: Array<string | undefined> = [];
  port = 4317;
  send(m: unknown) {
    this.sent.push(m);
    // Like cli.ts: a one-time launch link for "Open".
    if ((m as { type?: string })?.type === 'launch') queueMicrotask(() => this.emit('message', { type: 'launch', url: `http://127.0.0.1:${this.port}/?launch=${'c'.repeat(32)}` }));
    return true;
  }
  kill(sig?: string) {
    this.kills.push(sig);
    return true;
  }
  ready(port = 4317) {
    this.port = port;
    this.emit('message', { type: 'ready', port, token: TOKEN });
  }
  exit(code: number | null = 0, signal: string | null = null) {
    this.connected = false;
    this.emit('exit', code, signal);
  }
}

function setup(o: { root?: string | null; lan?: string[] } = {}) {
  const children: FakeChild[] = [];
  const spawned: string[][] = [];
  const events: WebServerStatus[] = [];
  const opened: string[] = [];
  let root: string | null = o.root === undefined ? '/home/me/notes' : o.root;
  const svc = new WebServerService({
    getRoot: () => root,
    spawn: (args) => {
      spawned.push(args);
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildLike;
    },
    lanAddresses: () => o.lan ?? ['192.168.1.20'],
    openExternal: (url) => void opened.push(url),
    onChange: (s) => events.push(s),
    startTimeoutMs: 1000,
    stopTimeoutMs: 500,
  });
  return { svc, children, spawned, events, opened, setRoot: (r: string | null) => (root = r) };
}

afterEach(() => vi.useRealTimers());

describe('options and handshake validation', () => {
  it('accepts an automatic or a sane port and local / lan only', () => {
    expect(parseWebServerOptions({ port: null, access: 'local' })).toEqual({ port: null, access: 'local' });
    expect(parseWebServerOptions({ access: 'lan' })).toEqual({ port: null, access: 'lan' });
    expect(parseWebServerOptions({ port: 8080, access: 'lan' })).toEqual({ port: 8080, access: 'lan' });
    for (const bad of [null, 'x', {}, { access: 'public' }, { port: 80, access: 'local' }, { port: 70000, access: 'local' }, { port: 4317.5, access: 'local' }, { port: '4317', access: 'local' }, { port: NaN, access: 'local' }]) {
      expect(parseWebServerOptions(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads settings and falls back to the safe default', () => {
    expect(optionsFromSettings({})).toEqual({ port: null, access: 'local' });
    expect(optionsFromSettings({ 'webserver.port': 5000, 'webserver.access': 'lan' })).toEqual({ port: 5000, access: 'lan' });
    expect(optionsFromSettings({ 'webserver.port': 22, 'webserver.access': 'lan' })).toEqual({ port: null, access: 'local' });
  });

  it('parses the child handshake strictly', () => {
    expect(parseChildMessage({ type: 'ready', port: 4317, token: TOKEN })).toEqual({ type: 'ready', port: 4317, token: TOKEN });
    expect(parseChildMessage({ type: 'ready', port: 4318, token: TOKEN, busy: 4317 })).toEqual({ type: 'ready', port: 4318, token: TOKEN, busy: 4317 });
    expect(parseChildMessage({ type: 'ready', port: 4318, token: TOKEN, busy: 'x' })).toEqual({ type: 'ready', port: 4318, token: TOKEN });
    expect(parseChildMessage({ type: 'ready', port: 4317, token: 'short' })).toBeNull();
    expect(parseChildMessage({ type: 'ready', port: 4317, token: `${TOKEN}"><script>` })).toBeNull();
    expect(parseChildMessage({ type: 'ready', port: 0, token: TOKEN })).toBeNull();
    expect(parseChildMessage({ type: 'error', code: 'EADDRINUSE', message: 'Port 4317 is in use' })).toEqual({ type: 'error', code: 'EADDRINUSE', message: 'Port 4317 is in use' });
    const launch = `http://127.0.0.1:4317/?launch=${'a'.repeat(32)}`;
    expect(parseChildMessage({ type: 'launch', url: launch })).toEqual({ type: 'launch', url: launch });
    for (const url of ['https://evil.example/?launch=' + 'a'.repeat(32), `${launch}&x=1`, 'http://127.0.0.1:4317/?token=' + 'a'.repeat(32)]) expect(parseChildMessage({ type: 'launch', url })).toBeNull();
    expect(parseChildMessage({ type: 'error' })).toBeNull();
    expect(parseChildMessage('ready')).toBeNull();
    expect(parseChildMessage(null)).toBeNull();
  });
});

describe('helpers', () => {
  it('lists reachable IPv4 addresses only', () => {
    const ifaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [
        { address: '192.168.1.20', family: 'IPv4', internal: false },
        { address: 'fe80::1', family: 'IPv6', internal: false },
      ],
      wlan0: [{ address: '10.0.0.5', family: 4, internal: false }],
      apipa: [{ address: '169.254.10.1', family: 'IPv4', internal: false }],
    } as never;
    expect(lanAddresses(ifaces)).toEqual(['10.0.0.5', '192.168.1.20']);
  });

  it('builds links with the token, shown addresses without', () => {
    const u = buildUrls(4317, TOKEN, ['192.168.1.20']);
    expect(u).toEqual([
      { kind: 'local', origin: 'http://127.0.0.1:4317/', url: `http://127.0.0.1:4317/?token=${TOKEN}` },
      { kind: 'lan', origin: 'http://192.168.1.20:4317/', url: `http://192.168.1.20:4317/?token=${TOKEN}` },
    ]);
  });

  it('gives the child an allowlisted environment', () => {
    const env = childEnv({ PATH: '/usr/bin', HOME: '/home/me', LANG: 'en_US.UTF-8', GIT_CEILING_DIRECTORIES: '/x', NODE_OPTIONS: '--require evil.js', ELECTRON_ENABLE_LOGGING: '1', AWS_SECRET_ACCESS_KEY: 'k', GITHUB_TOKEN: 't', SystemRoot: 'C:\\Windows', Path: 'C:\\bin' }, '/cfg');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me', LANG: 'en_US.UTF-8', GIT_CEILING_DIRECTORIES: '/x', SystemRoot: 'C:\\Windows', Path: 'C:\\bin', ELECTRON_RUN_AS_NODE: '1', SEC_EDIT_CONFIG_DIR: '/cfg' });
  });

  it('never shows a token from the child’s stderr', () => {
    expect(redact(`open http://127.0.0.1:4317/?token=${TOKEN} now`)).toBe('open http://127.0.0.1:4317/?token=… now');
    expect(redact(`key ${TOKEN}`)).toBe('key …');
    const crash = `file:///x/cli.mjs:3\n  throw e\n  ^\n\nError: EACCES: permission denied, scandir '/root'\n    at Object.readdir (node:fs:1)\n    at x\n\nNode.js v22.1.0\n`;
    expect(errorLine(crash)).toBe("Error: EACCES: permission denied, scandir '/root'");
    expect(errorLine('')).toBe('');
  });
});

describe('WebServerService', () => {
  it('starts the child with the folder and options, then reports the links', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    expect(t.svc.status().state).toBe('starting');
    expect(t.spawned[0]).toEqual(['/home/me/notes', '--host', '127.0.0.1', '--ipc']);
    t.children[0].ready(4318);
    const s = await p;
    expect(s).toMatchObject({ state: 'running', root: '/home/me/notes', access: 'local', port: 4318, error: null, portBusy: null });
    expect(s.urls).toEqual([{ kind: 'local', origin: 'http://127.0.0.1:4318/', url: `http://127.0.0.1:4318/?token=${TOKEN}` }]);
    expect(t.events.map((e) => e.state)).toEqual(['starting', 'running']);
    expect(t.svc.pid).toBe(4242);
  });

  it('reports when the folder’s usual port was busy', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].emit('message', { type: 'ready', port: 4318, token: TOKEN, busy: 4317 });
    expect(await p).toMatchObject({ state: 'running', port: 4318, portBusy: 4317 });
    t.children[0].exit(0);
    expect(t.svc.status().portBusy).toBeNull();
  });

  it('LAN: binds every interface and lists one link per address', async () => {
    const t = setup({ lan: ['10.0.0.5', '192.168.1.20'] });
    const p = t.svc.start({ port: 5000, access: 'lan' });
    expect(t.spawned[0]).toEqual(['/home/me/notes', '--host', '0.0.0.0', '--ipc', '--port', '5000']);
    t.children[0].ready(5000);
    expect((await p).urls.map((u) => u.origin)).toEqual(['http://127.0.0.1:5000/', 'http://10.0.0.5:5000/', 'http://192.168.1.20:5000/']);
  });

  it('refuses bad options, a second server and having no folder', async () => {
    const t = setup();
    await expect(t.svc.start({ port: 1, access: 'local' })).rejects.toMatchObject({ code: 'EINVAL' });
    const p = t.svc.start({ port: null, access: 'local' });
    await expect(t.svc.start({ port: null, access: 'local' })).rejects.toMatchObject({ code: 'EBUSY' });
    t.children[0].ready();
    await p;
    await expect(t.svc.start({ port: null, access: 'local' })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(t.spawned).toHaveLength(1);
    const none = setup({ root: null });
    await expect(none.svc.start({ port: null, access: 'local' })).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('a port in use: the child’s own message becomes the error', async () => {
    const t = setup();
    const p = t.svc.start({ port: 4317, access: 'local' });
    t.children[0].emit('message', { type: 'error', code: 'EADDRINUSE', message: 'Port 4317 is in use' });
    t.children[0].exit(1);
    await expect(p).rejects.toMatchObject({ code: 'EADDRINUSE', message: 'Port 4317 is in use' });
    expect(t.svc.status()).toMatchObject({ state: 'error', error: 'Port 4317 is in use', urls: [] });
    // Another start is allowed after a failure.
    const again = t.svc.start({ port: null, access: 'local' });
    t.children[1].ready();
    expect((await again).state).toBe('running');
  });

  it('a child that dies shows its error (token redacted) and can be dismissed', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].ready();
    await p;
    t.children[0].stderr.emit('data', Buffer.from(`Error: boom at http://127.0.0.1:4317/?token=${TOKEN}\n    at x\n`));
    t.children[0].exit(null, 'SIGKILL');
    const s = t.svc.status();
    expect(s.state).toBe('error');
    expect(s.error).toContain('stopped unexpectedly (signal SIGKILL)');
    expect(s.error).not.toContain(TOKEN);
    expect(s.urls).toEqual([]);
    expect((await t.svc.stop()).state).toBe('stopped');
  });

  it('stop: asks the child over IPC, kills it if it does not go', async () => {
    vi.useFakeTimers();
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].ready();
    await p;
    const stopped = t.svc.stop();
    expect(t.children[0].sent).toEqual([{ type: 'stop' }]);
    expect(t.children[0].kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(t.children[0].kills).toEqual(['SIGKILL']);
    t.children[0].exit(null, 'SIGKILL');
    expect(await stopped).toMatchObject({ state: 'stopped', error: null, notice: null });
  });

  it('stop while starting terminates the child; the start resolves stopped', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    const s = t.svc.stop();
    expect(t.children[0].sent).toEqual([]);
    expect(t.children[0].kills).toEqual([undefined]);
    t.children[0].exit(null, 'SIGTERM');
    expect((await s).state).toBe('stopped');
    expect((await p).state).toBe('stopped');
  });

  it('opening another folder stops it, with a notice; the same folder keeps it', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].ready();
    await p;
    t.svc.workspaceChanged();
    expect(t.children[0].sent).toEqual([]);
    t.setRoot('/home/me/other');
    t.svc.workspaceChanged();
    expect(t.children[0].sent).toEqual([{ type: 'stop' }]);
    t.children[0].exit(0);
    expect(t.svc.status()).toMatchObject({ state: 'stopped', notice: 'Opening another folder stopped the web server.' });
  });

  it('several windows: serves the caller’s folder; another folder is refused while it runs, naming the one served', async () => {
    const t = setup({ root: null }); // getRoot() is not what start uses when the caller's folder is given
    const p = t.svc.start({ port: null, access: 'local' }, '/home/me/a');
    expect(t.spawned[0][0]).toBe('/home/me/a');
    const refused = { code: 'EBUSY', message: 'The web server is already serving /home/me/a — stop it first' };
    await expect(t.svc.start({ port: null, access: 'local' }, '/home/me/b')).rejects.toMatchObject(refused); // while starting
    t.children[0].ready();
    expect(await p).toMatchObject({ state: 'running', root: '/home/me/a' });
    await expect(t.svc.start({ port: null, access: 'local' }, '/home/me/b')).rejects.toMatchObject(refused);
    await expect(t.svc.start({ port: null, access: 'local' }, null)).rejects.toMatchObject(refused); // a window without a folder
    await expect(t.svc.start({ port: null, access: 'local' }, '/home/me/a')).rejects.toMatchObject({ code: 'EBUSY', message: 'A web server is already running — stop it first' });
    expect(t.spawned).toHaveLength(1);
    expect(t.children[0].sent).toEqual([]);
    // Stopped (from any window): another folder may start it.
    const stopped = t.svc.stop();
    t.children[0].exit(0);
    await stopped;
    const q = t.svc.start({ port: null, access: 'local' }, '/home/me/b');
    t.children[1].ready();
    expect(await q).toMatchObject({ state: 'running', root: '/home/me/b' });
    await expect(setup().svc.start({ port: null, access: 'local' }, null)).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('rootsChanged: stops only when no window has its folder open any more, with a notice', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' }, '/home/me/a');
    t.children[0].ready();
    await p;
    t.svc.rootsChanged(['/home/me/b', '/home/me/a']);
    t.svc.rootsChanged(['/home/me/a']);
    expect(t.children[0].sent).toEqual([]);
    t.svc.rootsChanged(['/home/me/b', '/home/me/A']); // exact: a case twin is another folder on a case-sensitive disk
    expect(t.children[0].sent).toEqual([{ type: 'stop' }]);
    t.children[0].exit(0);
    expect(t.svc.status()).toMatchObject({ state: 'stopped', root: null, notice: 'Closing its folder stopped the web server.' });
    t.svc.rootsChanged([]); // nothing running: nothing happens
    expect(t.svc.status().notice).toBe('Closing its folder stopped the web server.');
    // While still starting: the child is terminated.
    const s = t.svc.start({ port: null, access: 'local' }, '/home/me/a');
    t.svc.rootsChanged([]);
    expect(t.children[1].kills).toEqual([undefined]);
    t.children[1].exit(null, 'SIGTERM');
    expect(await s).toMatchObject({ state: 'stopped', notice: 'Closing its folder stopped the web server.' });
  });

  it('dispose (quit) kills the child; its exit is not an error', async () => {
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].ready();
    await p;
    t.svc.dispose();
    expect(t.children[0].kills).toEqual([undefined]);
    t.children[0].exit(null, 'SIGTERM');
    expect(t.svc.status().state).toBe('stopped');
  });

  it('a start that never answers times out and kills the child', async () => {
    vi.useFakeTimers();
    const t = setup();
    const p = t.svc.start({ port: null, access: 'local' });
    const caught = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.children[0].kills).toEqual(['SIGKILL']);
    t.children[0].exit(null, 'SIGKILL');
    expect(await caught).toMatchObject({ message: 'The web server did not start within 1 s' });
  });

  it('opens only links of the running server', async () => {
    const t = setup();
    await expect(t.svc.open('http://127.0.0.1:4317/')).rejects.toMatchObject({ code: 'EACCES' });
    const p = t.svc.start({ port: null, access: 'local' });
    t.children[0].ready();
    const s = await p;
    await t.svc.open(s.urls[0].url);
    for (const bad of ['https://evil.example/', 'file:///etc/passwd', `http://127.0.0.1:4317/?token=${TOKEN}&x=1`, 42]) await expect(t.svc.open(bad)).rejects.toMatchObject({ code: 'EACCES' });
    // The browser gets a one-time launch link from the child, never the token on its command line.
    expect(t.opened).toEqual([`http://127.0.0.1:4317/?launch=${'c'.repeat(32)}`]);
    expect(t.children[0].sent).toContainEqual({ type: 'launch' });
  });
});

describe('IPC', () => {
  it('answers trusted senders only and validates in main', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const t = setup();
    registerWebServerIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, t.svc, { isTrusted: (e) => (e as { ok: boolean }).ok });
    expect([...handlers.keys()].sort()).toEqual([CH.open, CH.start, CH.status, CH.stop].sort());
    const call = (ch: string, trusted: boolean, ...a: unknown[]) => handlers.get(ch)!({ ok: trusted }, ...a);
    expect(await call(CH.start, false, { port: null, access: 'local' })).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    expect(await call(CH.status, false)).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    expect(t.spawned).toHaveLength(0);
    expect(await call(CH.start, true, { port: 'x', access: 'everyone' })).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
    expect(await call(CH.status, true)).toMatchObject({ ok: true, result: { state: 'stopped' } });
    const started = call(CH.start, true, { port: null, access: 'local' });
    t.children[0].ready();
    expect(await started).toMatchObject({ ok: true, result: { state: 'running', port: 4317 } });
    expect(await call(CH.open, true, 'https://evil.example/')).toMatchObject({ ok: false, error: { code: 'EACCES' } });
  });

  it('rootOf: start serves the calling window’s folder; status / stop are the same for every window', async () => {
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const t = setup({ root: '/never/this' });
    const roots: Record<number, string | null> = { 1: '/home/me/a', 2: '/home/me/b', 3: null };
    registerWebServerIpc({ handle: (ch, fn) => void handlers.set(ch, fn) }, t.svc, { isTrusted: () => true, rootOf: (e) => roots[(e as { id: number }).id] ?? null });
    const call = (win: number, ch: string, ...a: unknown[]) => handlers.get(ch)!({ id: win }, ...a);
    expect(await call(3, CH.start, { port: null, access: 'local' })).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } });
    const started = call(1, CH.start, { port: null, access: 'local' });
    t.children[0].ready();
    expect(await started).toMatchObject({ ok: true, result: { state: 'running', root: '/home/me/a' } });
    expect(t.spawned[0][0]).toBe('/home/me/a');
    expect(await call(2, CH.start, { port: null, access: 'local' })).toMatchObject({ ok: false, error: { code: 'EBUSY', message: expect.stringContaining('/home/me/a') } });
    expect(await call(2, CH.status)).toMatchObject({ ok: true, result: { state: 'running', root: '/home/me/a' } });
    const stopped = call(2, CH.stop);
    t.children[0].exit(0);
    expect(await stopped).toMatchObject({ ok: true, result: { state: 'stopped' } });
  });

  it('the preload bridge coerces argument types and subscribes to one fixed channel', async () => {
    const sent: unknown[][] = [];
    const listeners: string[] = [];
    const b = webServerBridge({ invoke: async (...a: unknown[]) => void sent.push(a), on: (ch) => void listeners.push(ch), removeListener: () => {} });
    await b.start({ port: '5000' as never, access: { x: 1 } as never });
    await b.start(undefined as never);
    await b.open(7 as never);
    const off = b.onChange(() => {});
    off();
    expect(sent).toEqual([
      [CH.start, { port: 5000, access: '[object Object]' }],
      [CH.start, { port: null, access: 'undefined' }],
      [CH.open, '7'],
    ]);
    expect(listeners).toEqual([CH.changed]);
  });
});
