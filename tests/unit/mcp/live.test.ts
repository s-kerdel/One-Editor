// "MCP active": a running stdio server's live file (src/mcp/live.ts) and main's session list from those files
// (McpService.scanSessions / refreshSessions). The file holds pid, the token's name, start and last call:
// never a path, text or a token; writes are throttled and atomic; crashed processes' files are cleaned up.
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { LiveFile } from '../../../src/mcp/live';
import { McpService, MAX_LIVE_FILES, pidAlive, type McpDeps } from '../../../src/main/mcp';
import { execFileSync } from 'node:child_process';
import { MCP_IDLE_MS, MCP_LIVE_DIR, parseLiveFile, type McpStatus } from '../../../src/shared/mcp';

const BASE = path.resolve(__dirname, '../../../.tmp/mcp/unit', `live-${crypto.randomBytes(4).toString('hex')}`);
afterAll(() => fs.rmSync(BASE, { recursive: true, force: true }));
let n = 0;
const fresh = () => {
  const d = path.join(BASE, String(++n));
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

describe('the live file (stdio server side)', () => {
  it('holds only pid, the app, start and last call; throttled writes keep the latest call; removed on stop', async () => {
    let now = 1_000_000;
    const dir = path.join(fresh(), MCP_LIVE_DIR);
    const live = new LiveFile(dir, { pid: 4242, client: 'LM\u0007 Studio' }, () => now, 100);
    live.start();
    expect(path.basename(live.file)).toMatch(/^4242-[a-f0-9]{8}\.json$/);
    expect(read(live.file)).toEqual({ v: 1, pid: 4242, client: 'LM Studio', started: 1_000_000, lastCall: null });
    // Within the throttle: no write yet, then one trailing write with the newest time.
    now += 10;
    live.touch();
    now += 10;
    live.touch();
    expect(read(live.file).lastCall).toBeNull();
    await new Promise((r) => setTimeout(r, 160));
    expect(read(live.file).lastCall).toBe(1_000_020);
    // After the throttle: written at once.
    now += 500;
    live.touch();
    expect(read(live.file).lastCall).toBe(1_000_520);
    expect(Object.keys(read(live.file)).sort()).toEqual(['client', 'lastCall', 'pid', 'started', 'v']);
    expect(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp'))).toEqual([]); // atomic: no temp files left
    live.stop();
    expect(fs.existsSync(live.file)).toBe(false);
    live.touch(); // after stop: nothing comes back
    await new Promise((r) => setTimeout(r, 150));
    expect(fs.existsSync(live.file)).toBe(false);
  });

  it('an app data folder that cannot be written: every step is skipped silently', () => {
    const blocker = path.join(fresh(), 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const live = new LiveFile(path.join(blocker, MCP_LIVE_DIR), { client: 'x' });
    expect(() => {
      live.start();
      live.touch();
      live.stop();
    }).not.toThrow();
  });
});

describe('sessions (main)', () => {
  function service(alive: Set<number>, now: () => number) {
    const configDir = fresh();
    const changes: McpStatus[] = [];
    const deps: McpDeps = {
      configDir,
      homedir: path.join(configDir, 'home'),
      platform: 'linux',
      launch: () => null,
      confirmEnable: async () => false,
      confirmWrite: async () => false,
      pickFolders: async () => [],
      confirmFolders: async () => false,
      realpath: (p) => fsp.realpath(p),
      isDirectory: async () => false,
      randomId: () => crypto.randomBytes(8).toString('hex'),
      onChange: (s) => void changes.push(s),
      isAlive: (pid) => alive.has(pid),
      now,
    };
    const dir = path.join(configDir, MCP_LIVE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const put = (pid: number, data: Record<string, unknown>, name = `${pid}-${crypto.randomBytes(4).toString('hex')}.json`) => {
      fs.writeFileSync(path.join(dir, name), JSON.stringify({ v: 1, pid, ...data }));
      return path.join(dir, name);
    };
    return { svc: new McpService(deps), changes, dir, put };
  }

  it('only small regular files are read: a FIFO, a link and a huge file under a live name are skipped, never waited on (review round 7)', async () => {
    const now = 10_000_000;
    const t = service(new Set([21, 22, 23, 24]), () => now);
    const good = t.put(21, { client: 'LM Studio', started: now - 1000, lastCall: null });
    // A FIFO with a live name: reading it would block forever.
    if (process.platform !== 'win32') execFileSync('mkfifo', [path.join(t.dir, '22-aaaaaaaa.json')]);
    // A link to a valid live file: not followed (and the target is left alone).
    fs.symlinkSync(good, path.join(t.dir, '23-bbbbbbbb.json'));
    // A huge "live" file: not read whole.
    fs.writeFileSync(path.join(t.dir, '24-cccccccc.json'), JSON.stringify({ v: 1, pid: 24, client: 'big', started: now, lastCall: null }) + ' '.repeat(50_000));
    const t0 = Date.now();
    const s = await t.svc.scanSessions();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.map((x) => x.client)).toEqual(['LM Studio']);
    expect(fs.existsSync(good)).toBe(true);
  });

  it('at most MAX_LIVE_FILES files per scan, and kicks during a scan do not pile up', async () => {
    const now = 10_000_000;
    const alive = new Set<number>();
    const t = service(alive, () => now);
    for (let i = 0; i < MAX_LIVE_FILES + 20; i++) {
      alive.add(1000 + i);
      t.put(1000 + i, { client: `app${i}`, started: now - i, lastCall: null });
    }
    expect((await t.svc.scanSessions()).length).toBe(MAX_LIVE_FILES);
    await Promise.all([t.svc.refreshSessions(), t.svc.refreshSessions(), t.svc.refreshSessions()]);
    expect(t.changes.length).toBe(1); // one changed list → one event, not one per kick
  });

  it("live processes are sessions (two for one app = two); a gone process's file is removed; idle after 2 minutes", async () => {
    const now = 10_000_000;
    const t = service(new Set([11, 12, 13]), () => now);
    t.put(11, { client: 'LM Studio', started: now - 1000, lastCall: now - 500 });
    t.put(12, { client: 'LM Studio', started: now - 2000, lastCall: null });
    t.put(13, { client: 'Codex', started: now - MCP_IDLE_MS - 5000, lastCall: now - MCP_IDLE_MS - 1 });
    const dead = t.put(99, { client: 'Old', started: now - 99_000, lastCall: null });
    t.put(14, { client: 'x' }, '14-zzzz.json'); // not ours: left alone
    fs.writeFileSync(path.join(t.dir, '15-0123abcd.json'), '{ half'); // half-written: skipped, kept
    const s = await t.svc.scanSessions();
    expect(s).toEqual([
      { client: 'Codex', started: now - MCP_IDLE_MS - 5000, lastCall: now - MCP_IDLE_MS - 1, idle: true },
      { client: 'LM Studio', started: now - 2000, lastCall: null, idle: false },
      { client: 'LM Studio', started: now - 1000, lastCall: now - 500, idle: false },
    ]);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(path.join(t.dir, '15-0123abcd.json'))).toBe(true);
  });

  it('a file whose name and pid disagree is not trusted; old temp files go', async () => {
    const now = 20_000_000;
    const t = service(new Set([21]), () => now);
    t.put(21, { client: 'A', started: now, lastCall: null }, '22-0123abcd.json');
    const tmp = path.join(t.dir, '21-0123abcd.json.abc123.tmp');
    fs.writeFileSync(tmp, '{}');
    fs.utimesSync(tmp, new Date(now - 120_000), new Date(now - 120_000));
    expect(await t.svc.scanSessions()).toEqual([]);
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('refreshSessions: the status carries sessions; an event only when the list changed', async () => {
    let now = 30_000_000;
    const alive = new Set([31]);
    const t = service(alive, () => now);
    const f = t.put(31, { client: 'Claude', started: now, lastCall: null });
    await t.svc.refreshSessions();
    expect(t.changes).toHaveLength(1);
    expect(t.changes[0].sessions).toEqual([{ client: 'Claude', started: now, lastCall: null, idle: false }]);
    await t.svc.refreshSessions();
    expect(t.changes).toHaveLength(1); // nothing new
    expect((await t.svc.status()).sessions).toHaveLength(1);
    now += MCP_IDLE_MS + 1; // time alone: idle
    await t.svc.refreshSessions();
    expect(t.changes.at(-1)!.sessions[0].idle).toBe(true);
    alive.delete(31); // the process ended without removing its file (a crash)
    await t.svc.refreshSessions();
    expect(t.changes.at(-1)!.sessions).toEqual([]);
    expect(fs.existsSync(f)).toBe(false);
  });

  it('the watcher sees a new file without waiting for the poll', async () => {
    const t = service(new Set([process.pid]), () => Date.now());
    const stop = t.svc.watchSessions(60_000);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const live = new LiveFile(t.dir, { client: 'Watched' });
      live.start();
      await expect.poll(() => t.changes.at(-1)?.sessions.map((x) => x.client), { timeout: 5000 }).toEqual(['Watched']);
      live.stop();
      await expect.poll(() => t.changes.at(-1)?.sessions.length, { timeout: 5000 }).toBe(0);
    } finally {
      stop();
    }
  });

  it('pidAlive: this process runs, an unused pid does not; parseLiveFile checks every field', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30)).toBe(false);
    expect(parseLiveFile(JSON.stringify({ v: 1, pid: 5, client: 'A', started: 1, lastCall: null }))).toEqual({ v: 1, pid: 5, client: 'A', started: 1, lastCall: null });
    for (const bad of ['x', '{}', JSON.stringify({ v: 2, pid: 5, client: 'A', started: 1, lastCall: null }), JSON.stringify({ v: 1, pid: -1, client: 'A', started: 1, lastCall: null }), JSON.stringify({ v: 1, pid: 5, client: 'A', started: 1, lastCall: 'soon' })]) {
      expect(parseLiveFile(bad), bad).toBeNull();
    }
  });
});
