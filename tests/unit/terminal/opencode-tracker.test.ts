// opencode tracker end to end against a fake loopback server that replays the recording: handshake,
// SSE, diff, auth, loopback rule, resync after a dropped stream.
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter, getEventListeners } from 'node:events';
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
});
