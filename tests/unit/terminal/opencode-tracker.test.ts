// opencode tracker end to end against a fake loopback server that replays the recording: handshake,
// SSE, diff, auth, loopback rule, resync after a dropped stream.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter, getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { OPENCODE_WSL_SERVE } from '../../../src/main/terminal-shells';
import { OpencodeTracker, parseHandshake } from '../../../src/main/terminal-opencode';
import type { TerminalChangesEvent, TerminalFollowEvent } from '../../../src/shared/terminal';

const rec = fs.readFileSync(path.join(__dirname, '../../fixtures/opencode/session-2.3.2.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const events = rec.filter((r) => r.kind === 'event').map((r) => r.event);
const lastDiff = [...rec].reverse().find((r) => r.kind === 'diff');
const SID = lastDiff.session as string;
const PASS = 'test-password-123';
const AUTH = 'Basic ' + Buffer.from('opencode:' + PASS).toString('base64');

let servers: http.Server[] = [];
afterEach(() => {
  servers.forEach((s) => s.closeAllConnections?.() ?? s.close());
  servers.forEach((s) => s.close());
  servers = [];
});

async function fake(opts: { streams?: Array<(res: http.ServerResponse) => void> } = {}) {
  const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
  let n = 0;
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.headers.authorization !== AUTH) return void res.writeHead(401).end();
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      (opts.streams?.[n++] ?? ((r) => events.forEach((e) => r.write(`data: ${JSON.stringify(e)}\n\n`))))(res);
      return;
    }
    if (u.pathname === '/api/session') return void res.writeHead(200).end(JSON.stringify({ data: [{ id: SID }] }));
    if (u.pathname === `/api/session/${SID}/message`) return void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'msg_a' }, { id: 'msg_b' }] }));
    if (u.pathname === `/api/session/${SID}/diff`) return void res.writeHead(200).end(JSON.stringify(lastDiff.body));
    res.writeHead(404).end();
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, seen };
}

const until = async (f: () => boolean, ms = 3000) => {
  for (const t0 = Date.now(); !f(); ) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function rig(inside: (rel: string) => boolean = () => true, o: { backoffMs?: number[] } = {}) {
  const follow: TerminalFollowEvent[] = [];
  const changes: TerminalChangesEvent[] = [];
  const tr = new OpencodeTracker({ inside: async (r) => inside(r), emitFollow: (_i, e) => follow.push(e), emitChanges: (_i, e) => changes.push(e), ...o });
  return { tr, follow, changes };
}
const send = (res: http.ServerResponse, list: unknown[]) => list.forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
const ours = { root: '/ws', platform: 'linux', foldCase: false };

describe('handshake', () => {
  it('reads address + password in any chunking; refuses anything not literal loopback', () => {
    expect(parseHandshake('opencode server listening on http://127.0.0.1:4096\nserver password abcdef123456\n')).toEqual({ url: 'http://127.0.0.1:4096', password: 'abcdef123456' });
    expect(parseHandshake('server password abcdef123456\nserver listening on http://127.0.0.1:1')).not.toBeNull();
    expect(parseHandshake('server listening on http://localhost:4096\nserver password abcdef123456')).toBeNull();
    expect(parseHandshake('server listening on http://127.0.0.1.evil.com:4096\nserver password abcdef123456')).toBeNull();
    expect(parseHandshake('server listening on http://127.0.0.1:4096')).toBeNull();
    expect(parseHandshake('server listening on http://127.0.0.1:4096\nserver password short')).toBeNull();
  });
});

describe('tracker', () => {
  it('turns the recording into follow events and the exact change list; only GETs, always authenticated', async () => {
    const f = await fake();
    const { tr, follow, changes } = rig();
    tr.attach(1, { url: f.url, password: PASS }, ours);
    await until(() => changes.at(-1)?.files.length === 7 && changes.at(-1)!.files.every((x) => x.exact));
    const last = changes.at(-1)!;
    expect(Object.fromEntries(last.files.map((x) => [x.path, [x.additions, x.deletions]]))['src/a.ts']).toEqual([1, 1]);
    expect(last.agent).toBe('opencode');
    expect(follow.every((e) => e.agent === 'opencode' && e.id === 1)).toBe(true); // the UI names the agent from this
    expect(last.files.every((x) => x.turn >= 1 && x.turn <= last.turns)).toBe(true);
    expect(follow.map((e) => e.kind)).toContain('edit');
    expect(follow.some((e) => e.kind === 'stop')).toBe(true);
    expect(f.seen.every((s) => s.method === 'GET' && s.auth === AUTH)).toBe(true);
    const stream = f.seen.find((s) => s.url.startsWith('/api/event'))!;
    expect(stream.url).toContain('types=session.tool.success');
    expect(f.seen.some((s) => s.url.includes('/diff?from=msg_a&to=msg_b&context=0'))).toBe(true);
    tr.dispose();
  });

  it('never shows a path the workspace refuses (symlink out of the folder)', async () => {
    const f = await fake();
    const { tr, follow } = rig((rel) => rel !== 'src/a.ts');
    tr.attach(1, { url: f.url, password: PASS }, ours);
    await until(() => follow.some((e) => e.kind === 'stop'));
    expect(follow.some((e) => e.path === 'src/a.ts')).toBe(false);
    tr.dispose();
  });

  it('reconnects after the stream drops and reads the state again (nothing is replayed)', async () => {
    // The first stream only says "a session started here" and drops; everything else must come from the resync.
    const f = await fake({ streams: [(res) => (send(res, events.slice(0, 1)), setTimeout(() => res.end(), 50)), (res) => res.write(': open\n\n')] });
    const { tr, changes } = rig(undefined, { backoffMs: [50] });
    tr.attach(1, { url: f.url, password: PASS }, ours);
    await until(() => changes.some((c) => c.files.length === 7), 5000);
    await until(() => f.seen.filter((s) => s.url.startsWith('/api/event')).length >= 2, 5000);
    tr.dispose();
  });

  it('the folder\'s earlier sessions are history, not this terminal\'s changes — until one is resumed', async () => {
    // opencode keeps a folder's sessions: the list has one from an earlier run. Nothing of it may show at the start.
    let stream: http.ServerResponse | null = null;
    const f = await fake({ streams: [(res) => (res.write(': open\n\n'), (stream = res))] });
    const { tr, changes, follow } = rig();
    tr.attach(1, { url: f.url, password: PASS }, ours);
    await until(() => !!stream && f.seen.some((s) => s.url.startsWith('/api/session?')));
    await new Promise((r) => setTimeout(r, 250));
    expect(changes).toEqual([]);
    expect(f.seen.some((s) => s.url.includes('/diff') || s.url.includes('/message'))).toBe(false);
    // The user resumes that session in this terminal: its first event makes it ours.
    send(stream!, events.slice(1));
    await until(() => changes.at(-1)?.files.length === 7 && changes.at(-1)!.files.every((x) => x.exact));
    expect(follow.some((e) => e.kind === 'prompt')).toBe(true);
    tr.dispose();
  });

  it('a stream that opens and ends at once backs off instead of looping (and leaves no listeners behind)', async () => {
    const f = await fake({ streams: Array.from({ length: 50 }, () => (res: http.ServerResponse) => res.end()) });
    const { tr } = rig(undefined, { backoffMs: [40, 400] });
    tr.attach(1, { url: f.url, password: PASS }, ours);
    await new Promise((r) => setTimeout(r, 700));
    const connects = f.seen.filter((s) => s.url.startsWith('/api/event')).length;
    expect(connects).toBeGreaterThanOrEqual(2);
    expect(connects).toBeLessThanOrEqual(4); // 0, +40 ms, then every 400 ms — without the back-off: one every 40 ms
    const signal = (tr as unknown as { tracks: Map<number, { ac: AbortController }> }).tracks.get(1)!.ac.signal;
    expect(getEventListeners(signal, 'abort').length).toBeLessThanOrEqual(3); // not one per reconnect
    tr.dispose();
    expect(tr.count()).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('a folder opened through a link: opencode reports the real folder, the changes still arrive', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-link-'));
    const real = fs.realpathSync(fs.mkdtempSync(path.join(base, 'real-')));
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    const sid = 'ses_linked';
    const ev = (type: string, data: object) => ({ type, location: { directory: real }, data: { sessionID: sid, ...data } });
    const f = await fake({
      streams: [
        (res) =>
          send(res, [
            ev('session.created', {}),
            ev('session.inbox.enqueued', { inboxID: 'm1', item: { type: 'user' } }),
            ev('session.tool.called', { id: 'c1', input: { path: path.join(real, 'src/a.ts'), content: 'x' } }),
            ev('session.tool.success', { id: 'c1', metadata: {} }),
          ]),
      ],
    });
    const { tr, changes, follow } = rig();
    tr.attach(1, { url: f.url, password: PASS }, { root: link, realRoot: real, platform: process.platform, foldCase: false });
    await until(() => follow.some((e) => e.kind === 'write'));
    expect(follow.find((e) => e.kind === 'write')).toEqual({ id: 1, agent: 'opencode', kind: 'write', path: 'src/a.ts' });
    await until(() => changes.at(-1)?.files.length === 1);
    expect(changes.at(-1)!.files[0]).toMatchObject({ path: 'src/a.ts', turn: 1 });
    expect(f.seen.find((s) => s.url.startsWith('/api/session?'))!.url).toContain(encodeURIComponent(real)); // asked by the name opencode knows
    tr.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('a wrong password, a non-loopback address and close() track nothing', async () => {
    const f = await fake();
    const a = rig();
    a.tr.attach(1, { url: f.url, password: 'wrong-password' }, ours);
    a.tr.attach(2, { url: 'http://localhost:1', password: PASS }, ours);
    await new Promise((r) => setTimeout(r, 200));
    expect(a.changes).toEqual([]);
    expect(f.seen.every((s) => s.auth !== AUTH)).toBe(true);
    a.tr.dispose();
    const b = rig();
    b.tr.attach(3, { url: f.url, password: PASS }, ours);
    b.tr.close(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.changes.length).toBeLessThanOrEqual(1);
  });

  it.skipIf(process.platform === 'win32')('close() ends the server AND what it started (its process group): no orphans', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-group-'));
    const bin = path.join(dir, 'opencode');
    // Stands in for `opencode serve`: starts a child (an agent's shell command), says the handshake, stays.
    fs.writeFileSync(bin, '#!/bin/sh\nsleep 300 &\necho $! > "$STUB_DIR/child.pid"\necho $$ > "$STUB_DIR/server.pid"\necho "server listening on http://127.0.0.1:9"\necho "server password secret-pass-12345"\nwait\n', { mode: 0o755 });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const { tr } = rig(undefined, { backoffMs: [5000] });
    let pids: number[] = [];
    try {
      const server = await tr.open(1, { bin, root: dir, platform: process.platform, foldCase: false, env: { PATH: process.env.PATH, STUB_DIR: dir } });
      expect(server).toEqual({ url: 'http://127.0.0.1:9', password: 'secret-pass-12345' });
      pids = ['server.pid', 'child.pid'].map((f) => Number(fs.readFileSync(path.join(dir, f), 'utf8')));
      expect(pids.every((p) => p > 1 && alive(p))).toBe(true);
      tr.close(1);
      await until(() => pids.every((p) => !alive(p)), 4000);
      expect(tr.count()).toBe(0);
    } finally {
      for (const p of pids) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {}
      }
      tr.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('open(): starts the server with no password in its environment, kills it on close', async () => {
    const f = await fake();
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => ((child as any).killed = true), killed: false });
    let envSeen: NodeJS.ProcessEnv = {};
    const { tr } = (() => {
      const r = rig();
      return { tr: new OpencodeTracker({ inside: async () => true, emitFollow: () => {}, emitChanges: () => {}, spawnServer: (_b, _c, env) => ((envSeen = env), child as never) }) };
    })();
    const p = tr.open(1, { bin: 'opencode', root: '/ws', platform: 'linux', foldCase: false, env: { PATH: '/bin', OPENCODE_PASSWORD: 'leak', OPENCODE_SERVER_PASSWORD: 'leak2' } });
    child.stdout.emit('data', Buffer.from(`server listening on ${f.url}\nserver password ${PASS}\n`));
    expect(await p).toEqual({ url: f.url, password: PASS });
    expect(envSeen.PATH).toBe('/bin');
    expect(envSeen.OPENCODE_PASSWORD).toBeUndefined();
    expect(envSeen.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    tr.close(1);
    expect(child.killed).toBe(true);
  });

  // ---- inside WSL (One on Windows, opencode in a distro) ----
  const wslPlan = { file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'], linuxRoot: '/ws' };
  const winFolder = { bin: '/usr/bin/opencode', root: '\\\\wsl.localhost\\Ubuntu\\ws', platform: 'win32', foldCase: false, env: {} };
  const fakeChild = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: Object.assign(new EventEmitter(), { end: () => void (child.ended = true) }), ended: false, killed: false, kill: () => (child.killed = true), exitCode: null, signalCode: null });
    return child;
  };

  it('WSL: tracks the folder by its Linux name once the server answers; the TUI keeps the server\'s own address', async () => {
    const f = await fake();
    const child = fakeChild();
    const follow: TerminalFollowEvent[] = [];
    const changes: TerminalChangesEvent[] = [];
    let planSeen: unknown;
    const tr = new OpencodeTracker({ inside: async () => true, emitFollow: (_i, e) => follow.push(e), emitChanges: (_i, e) => changes.push(e), spawnServer: (_b, _c, _e, wsl) => ((planSeen = wsl), child as never) });
    const p = tr.open(1, { ...winFolder, wsl: wslPlan });
    child.stdout.emit('data', Buffer.from(`rc noise\none-cwd /ws\nserver listening on ${f.url}\nserver password ${PASS}\n`));
    expect(await p).toEqual({ url: f.url, password: PASS });
    expect(planSeen).toBe(wslPlan);
    // The proof request came first, authenticated, for the Linux folder.
    expect(f.seen[0]).toEqual({ method: 'GET', url: '/api/session?directory=%2Fws&limit=1', auth: AUTH });
    // Linux paths from the recording (/ws/…) land in the Windows-named folder as workspace-relative paths.
    await until(() => follow.some((e) => e.kind === 'stop') && changes.length > 0);
    const paths = follow.filter((e) => e.path).map((e) => e.path!);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((x) => !x.startsWith('/') && !x.includes('\\'))).toBe(true);
    expect(f.seen.every((r) => r.method === 'GET' && r.auth === AUTH)).toBe(true);
    // Ended by closing stdin (the script in the distro ends the server), not by killing wsl.exe first.
    tr.close(1);
    expect(child.ended).toBe(true);
    expect(child.killed).toBe(false);
    child.emit('exit', 0);
  });

  it('WSL: a slow server start gets its own wait once the distro script answered; a script that never answers is "answer"', async () => {
    const f = await fake();
    // Short waits (real: 15 s / 40 s): which deadline applies after which line.
    const slow = fakeChild();
    const whyA: string[] = [];
    const a = new OpencodeTracker({ inside: async () => true, emitFollow: () => {}, emitChanges: () => {}, spawnServer: () => slow as never, handshakeMs: 150, wslHandshakeMs: 1500 });
    const p = a.open(1, { ...winFolder, wsl: wslPlan }, (w) => void whyA.push(w));
    slow.stdout.emit('data', Buffer.from('rc noise\none-cwd /ws\n')); // the script is up
    setTimeout(() => slow.stdout.emit('data', Buffer.from(`server listening on ${f.url}\nserver password ${PASS}\n`)), 400); // serve needs longer there
    expect(await p).toEqual({ url: f.url, password: PASS }); // the native 15 s deadline alone would have given up here
    expect(whyA).toEqual([]);
    a.dispose();

    // Without that line only the short wait runs: a start that never reports itself is written off, quickly.
    const dead = fakeChild();
    const whyB: string[] = [];
    const b = new OpencodeTracker({ inside: async () => true, emitFollow: () => {}, emitChanges: () => {}, spawnServer: () => dead as never, handshakeMs: 150, wslHandshakeMs: 1500 });
    const q = b.open(2, { ...winFolder, wsl: wslPlan }, (w) => void whyB.push(w));
    setTimeout(() => dead.stdout.emit('data', Buffer.from(`server listening on ${f.url}\nserver password ${PASS}\n`)), 400);
    expect(await q).toBeNull();
    expect(whyB).toEqual(['answer']);
    expect(dead.ended).toBe(true); // the half-started server is ended, not left in the distro
    dead.emit('exit', 0);
    b.dispose();
  });

  it('WSL: falls back to the IPv6 loopback when 127.0.0.1 is not forwarded; unreachable = no tracking, server ended', async () => {
    const f = await fake();
    const port = new URL(f.url).port;
    const asked: string[] = [];
    // Stands in for WSL forwarding that only listens on [::1]: 127.0.0.1 is refused, [::1] reaches the server.
    const v6only: typeof fetch = (input, init) => {
      const u = String(input);
      asked.push(u);
      return u.startsWith('http://[::1]:') ? fetch(u.replace('[::1]', '127.0.0.1'), init) : Promise.reject(new Error('ECONNREFUSED'));
    };
    const child = fakeChild();
    const changes: TerminalChangesEvent[] = [];
    const tr = new OpencodeTracker({ inside: async () => true, emitFollow: () => {}, emitChanges: (_i, e) => changes.push(e), spawnServer: () => child as never, fetch: v6only });
    const p = tr.open(1, { ...winFolder, wsl: wslPlan });
    child.stdout.emit('data', Buffer.from(`server listening on ${f.url}\nserver password ${PASS}\n`));
    expect(await p).toEqual({ url: f.url, password: PASS }); // the TUI (inside the distro) still gets 127.0.0.1
    expect(asked.slice(0, 2)).toEqual([`http://127.0.0.1:${port}/api/session?directory=%2Fws&limit=1`, `http://[::1]:${port}/api/session?directory=%2Fws&limit=1`]);
    await until(() => changes.length > 0);
    expect(asked.slice(2).every((u) => u.startsWith(`http://[::1]:${port}/`))).toBe(true);
    tr.dispose();

    const dead = fakeChild();
    const why: string[] = [];
    const none = new OpencodeTracker({ inside: async () => true, emitFollow: () => {}, emitChanges: () => {}, spawnServer: () => dead as never, fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    const q = none.open(2, { ...winFolder, wsl: wslPlan }, (w) => void why.push(w));
    dead.stdout.emit('data', Buffer.from(`server listening on ${f.url}\nserver password ${PASS}\n`));
    expect(await q).toBeNull();
    expect(none.count()).toBe(0);
    expect(why).toEqual(['reach']); // it answered there: only the reach from Windows failed (a different toast)
    expect(dead.ended).toBe(true);
    dead.emit('exit', 0);
  });

  it.skipIf(process.platform === 'win32')('WSL serve script (real bash): reports the link-free folder; closing stdin ends the server AND what it started', async () => {
    const f = await fake();
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wsl-')));
    const link = dir + '-link';
    fs.symlinkSync(dir, link);
    const bin = path.join(dir, 'opencode');
    // Stands in for `opencode serve`: checks its arguments + environment, starts a child, says the handshake, stays.
    fs.writeFileSync(bin, `#!/bin/sh\n[ "$*" = "serve --hostname 127.0.0.1 --port 0" ] || exit 9\n[ -z "$OPENCODE_PASSWORD$OPENCODE_SERVER_PASSWORD" ] || exit 8\nsleep 300 &\necho $! > child.pid\necho $$ > server.pid\necho "server listening on ${f.url}"\necho "server password ${PASS}"\nwait\n`, { mode: 0o755 });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const seenDirs: string[] = [];
    const tr = new OpencodeTracker({
      inside: async () => true,
      emitFollow: () => {},
      emitChanges: () => {},
      backoffMs: [5000],
      // wsl.exe … -e bash -lic SCRIPT <folder> <path>, minus wsl.exe and the user's rc files.
      spawnServer: (b, _c, env) => spawn('bash', ['-c', OPENCODE_WSL_SERVE, link, b], { env: { ...env, OPENCODE_PASSWORD: 'leak', OPENCODE_SERVER_PASSWORD: 'leak2' }, stdio: ['pipe', 'pipe', 'pipe'] }),
      fetch: (input, init) => (seenDirs.push(new URL(String(input)).searchParams.get('directory') ?? ''), fetch(input, init)),
    });
    let pids: number[] = [];
    try {
      expect(await tr.open(1, { ...winFolder, bin, env: { PATH: process.env.PATH }, wsl: { ...wslPlan, linuxRoot: link } })).toEqual({ url: f.url, password: PASS });
      expect(seenDirs[0]).toBe(dir); // `pwd -P`: the name opencode itself uses, not the link
      pids = ['server.pid', 'child.pid'].map((n) => Number(fs.readFileSync(path.join(dir, n), 'utf8')));
      expect(pids.every((x) => x > 1 && alive(x))).toBe(true);
      tr.close(1); // only closes stdin
      await until(() => pids.every((x) => !alive(x)), 4000);
    } finally {
      for (const x of pids) {
        try {
          process.kill(x, 'SIGKILL');
        } catch {}
      }
      tr.dispose();
      fs.rmSync(link, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
