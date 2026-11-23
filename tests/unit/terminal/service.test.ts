// TerminalService against the REAL node-pty (Linux build): spawn, I/O, resize, kill, exit codes,
// caps, cwd rules, environment hygiene, batching, flow control and "no orphans".
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TerminalService, type PtyModuleLike } from '../../../src/main/terminal';
import type { ShellInfo, TerminalDataEvent, TerminalExitEvent } from '../../../src/shared/terminal';

const require = createRequire(import.meta.url);
const pty = require('node-pty') as PtyModuleLike;
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';
const sh = (id: string, args: string[]): ShellInfo => ({ id, name: id, kind: 'bash', path: BASH, args });
const SHELLS: ShellInfo[] = [
  sh('bash', ['--norc', '--noprofile']),
  sh('hello', ['-lc', 'echo hello']),
  sh('exit3', ['-c', 'exit 3']),
  sh('pwd', ['--norc', '--noprofile', '-c', 'pwd']),
  sh('env', ['--norc', '--noprofile', '-c', 'echo "T=$TERM C=$COLORTERM P=$TERM_PROGRAM S=${SEC_EDIT_SECRET:-none} E=${ELECTRON_RUN_AS_NODE:-none} N=${npm_config_token:-none} K=${KEEP_ME:-none}"']),
  sh('child', ['--norc', '--noprofile', '-c', 'sleep 300 & echo CHILD=$!; wait']),
  sh('flood', ['--norc', '--noprofile', '-c', "head -c 1000000 /dev/zero | tr '\\0' x; echo; echo DONE"]),
  sh('big', ['--norc', '--noprofile', '-c', "head -c 300000 /dev/zero | tr '\\0' y"]),
];

const tmpRoot = path.resolve(__dirname, '../../../.tmp/terminal');
let ws: string;
let outside: string;
const services: TerminalService[] = [];

beforeAll(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  ws = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'ws-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'out-')));
  fs.mkdirSync(path.join(ws, 'sub dir'));
  fs.writeFileSync(path.join(ws, 'file.txt'), 'x');
  fs.symlinkSync(outside, path.join(ws, 'escape'));
});
afterAll(() => {
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose());
});

interface Rig {
  svc: TerminalService;
  out: Map<number, string>;
  batches: TerminalDataEvent[][];
  exits: TerminalExitEvent[];
  waitFor(id: number, re: RegExp, ms?: number): Promise<string>;
  waitExit(id: number, ms?: number): Promise<TerminalExitEvent>;
}

function rig(opts: Partial<ConstructorParameters<typeof TerminalService>[0]> & { autoAck?: boolean } = {}): Rig {
  let root: string | null = ws;
  const svc = new TerminalService({
    loadPty: () => pty,
    getWorkspaceRoot: () => root,
    detect: async () => SHELLS,
    platform: 'linux',
    env: { ...process.env, SEC_EDIT_SECRET: 'leak', ELECTRON_RUN_AS_NODE: '1', npm_config_token: 'tok', KEEP_ME: 'kept' },
    appVersion: '9.9.9',
    killGraceMs: 500,
    ...opts,
  });
  services.push(svc);
  const out = new Map<number, string>();
  const batches: TerminalDataEvent[][] = [];
  const exits: TerminalExitEvent[] = [];
  const waiters = new Set<() => void>();
  svc.onOutput((_owner, ch, payload) => {
    if (ch === 'term:data') {
      batches.push(payload as TerminalDataEvent[]);
      for (const e of payload as TerminalDataEvent[]) {
        out.set(e.id, (out.get(e.id) ?? '') + e.data);
        if (opts.autoAck) queueMicrotask(() => svc.ack(_owner, e.id, e.data.length)); // what xterm's write callback does
      }
    } else exits.push(payload as TerminalExitEvent);
    waiters.forEach((w) => w());
  });
  const until = <T>(check: () => T | undefined, ms: number, what: string) =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => (waiters.delete(w), reject(new Error(`timeout: ${what}`))), ms);
      const w = () => {
        const v = check();
        if (v === undefined) return;
        clearTimeout(t);
        waiters.delete(w);
        resolve(v);
      };
      waiters.add(w);
      w();
    });
  Object.assign(svc, { setRoot: (r: string | null) => (root = r) });
  return {
    svc,
    out,
    batches,
    exits,
    waitFor: (id, re, ms = 8000) => until(() => (re.test(out.get(id) ?? '') ? out.get(id)! : undefined), ms, `${re} in ${JSON.stringify(out.get(id))}`),
    waitExit: (id, ms = 8000) => until(() => exits.find((e) => e.id === id), ms, `exit of ${id}`),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitDead = async (pid: number, ms = 4000) => {
  const t0 = Date.now();
  while (alive(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50));
  return !alive(pid);
};

describe('TerminalService (real node-pty)', () => {
  it("spawns bash -lc 'echo hello' and reports output + exit code 0", async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'hello' });
    expect(t).toMatchObject({ shell: { id: 'hello' }, cwd: '' });
    expect(t.pid).toBeGreaterThan(0);
    await r.waitFor(t.id, /hello/);
    expect((await r.waitExit(t.id)).exitCode).toBe(0);
    expect(r.svc.count()).toBe(0);
  });

  it('writes input and reads the answer; exit code of `exit 7`', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'bash' });
    expect(r.svc.write(1, t.id, 'echo $((6*7))\r')).toBe(true);
    await r.waitFor(t.id, /\b42\b/);
    r.svc.write(1, t.id, 'exit 7\r');
    expect((await r.waitExit(t.id)).exitCode).toBe(7);
  });

  it('reports non-zero exit codes', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'exit3' });
    expect((await r.waitExit(t.id)).exitCode).toBe(3);
  });

  it('resizes the PTY (stty size sees it)', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'bash', cols: 90, rows: 20 });
    expect(r.svc.resize(1, t.id, 123, 37)).toBe(true);
    r.svc.write(1, t.id, 'stty size\r');
    await r.waitFor(t.id, /37 123/);
    // Out of range / wrong types are refused.
    for (const [c, rows] of [[1, 10], [1001, 10], [80, 0], [80, 501], [80.5, 10], ['80', 10]] as const) expect(r.svc.resize(1, t.id, c, rows)).toBe(false);
  });

  it('kill() ends the shell and frees the slot', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'bash' });
    expect(r.svc.count(1)).toBe(1);
    expect(r.svc.kill(1, t.id)).toBe(true);
    await r.waitExit(t.id);
    expect(r.svc.count()).toBe(0);
    expect(await waitDead(t.pid)).toBe(true);
    expect(r.svc.write(1, t.id, 'x')).toBe(false);
  });

  it('leaves no orphans: background children of a killed shell die too', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'child' });
    const child = Number(/CHILD=(\d+)/.exec(await r.waitFor(t.id, /CHILD=\d+/))![1]);
    expect(alive(child)).toBe(true);
    r.svc.kill(1, t.id);
    await r.waitExit(t.id);
    expect(await waitDead(child), `pid ${child} survived`).toBe(true);
  });

  it('leaves no orphans: jobs of an interactive shell die with it', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'bash' });
    r.svc.write(1, t.id, 'sleep 300 & echo JOB=$!\r');
    const job = Number(/JOB=(\d+)/.exec(await r.waitFor(t.id, /JOB=\d+/))![1]);
    r.svc.kill(1, t.id);
    await r.waitExit(t.id);
    expect(await waitDead(job), `pid ${job} survived`).toBe(true);
  });

  it('dispose() (app quit) kills every terminal of every window', async () => {
    const r = rig();
    const a = await r.svc.spawn(1, { shellId: 'bash' });
    const b = await r.svc.spawn(2, { shellId: 'child' });
    const child = Number(/CHILD=(\d+)/.exec(await r.waitFor(b.id, /CHILD=\d+/))![1]);
    r.svc.dispose();
    expect(await waitDead(a.pid)).toBe(true);
    expect(await waitDead(b.pid)).toBe(true);
    expect(await waitDead(child)).toBe(true);
    await expect(r.svc.spawn(1, { shellId: 'bash' })).rejects.toMatchObject({ code: 'EIO' });
  });

  it('killOwner() (window closed) and setWorkspace() (folder switch) kill only what they should', async () => {
    const r = rig();
    const a = await r.svc.spawn(1, { shellId: 'bash' });
    const b = await r.svc.spawn(2, { shellId: 'bash' });
    r.svc.killOwner(1);
    await r.waitExit(a.id);
    expect(r.svc.count(2)).toBe(1);
    r.svc.setWorkspace(ws); // same folder: nothing happens
    expect(r.svc.count(2)).toBe(1);
    r.svc.setWorkspace(outside);
    await r.waitExit(b.id);
    expect(r.svc.count()).toBe(0);
  });

  it('only the owning window may write / resize / kill', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'bash' });
    expect(r.svc.write(2, t.id, 'exit\r')).toBe(false);
    expect(r.svc.resize(2, t.id, 100, 30)).toBe(false);
    expect(r.svc.kill(2, t.id)).toBe(false);
    expect(r.svc.count(1)).toBe(1);
    for (const bad of ['1', null, 1.5, NaN, {}]) expect(r.svc.write(1, bad, 'x')).toBe(false);
  });

  it('caps terminals per window and in total (also for concurrent spawns)', async () => {
    const r = rig({ limits: { maxPerOwner: 2, maxTotal: 3 } });
    const results = await Promise.allSettled([1, 2, 3].map(() => r.svc.spawn(1, { shellId: 'bash' })));
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((x) => x.status === 'rejected')).toMatchObject({ reason: { code: 'ELIMIT' } });
    await r.svc.spawn(2, { shellId: 'bash' });
    await expect(r.svc.spawn(3, { shellId: 'bash' })).rejects.toMatchObject({ code: 'ELIMIT' });
  });

  it('caps the size of one write', async () => {
    const r = rig({ limits: { maxWriteChars: 16 } });
    const t = await r.svc.spawn(1, { shellId: 'bash' });
    expect(r.svc.write(1, t.id, 'x'.repeat(17))).toBe(false);
    expect(r.svc.write(1, t.id, '')).toBe(false);
    expect(r.svc.write(1, t.id, 42)).toBe(false);
    expect(r.svc.write(1, t.id, 'echo ok\r')).toBe(true);
  });

  it('starts in the workspace or a folder inside it — nowhere else', async () => {
    const r = rig();
    const root = await r.svc.spawn(1, { shellId: 'pwd' });
    await r.waitFor(root.id, new RegExp(ws.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const sub = await r.svc.spawn(1, { shellId: 'pwd', cwd: 'sub dir' });
    expect(sub.cwd).toBe('sub dir');
    await r.waitFor(sub.id, /sub dir/);
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: '../' })).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: 'sub dir/../..' })).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: outside })).rejects.toMatchObject({ code: 'EINVAL' }); // absolute
    expect((await r.svc.spawn(1, { shellId: 'pwd', cwd: 'sub dir/..' })).cwd).toBe('');
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: 'escape' })).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' }); // symlink out
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: 'missing' })).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(r.svc.spawn(1, { shellId: 'pwd', cwd: 'file.txt' })).rejects.toMatchObject({ code: 'ENOENT' });
    (r.svc as unknown as { setRoot(x: null): void }).setRoot(null);
    await expect(r.svc.spawn(1, { shellId: 'pwd' })).rejects.toMatchObject({ code: 'NO_WORKSPACE' });
  });

  it('validates the request shape and the shell id (no paths, no unknown ids)', async () => {
    const r = rig();
    for (const bad of ['bash', [], { shellId: '/bin/sh' }, { shellId: 'x'.repeat(81) }, { shellId: 5 }, { cols: 0 }, { cols: 80.5 }, { rows: 9999 }, { cwd: 3 }, { cwd: 'a\0b' }]) {
      await expect(r.svc.spawn(1, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'EINVAL' });
    }
    await expect(r.svc.spawn(1, { shellId: 'nope' })).rejects.toMatchObject({ code: 'EINVAL' });
    expect(r.svc.count()).toBe(0);
  });

  it('environment: TERM/COLORTERM set, app secrets and npm context stripped, the rest inherited', async () => {
    const r = rig();
    const t = await r.svc.spawn(1, { shellId: 'env' });
    const out = await r.waitFor(t.id, /K=\w+/);
    expect(out).toContain('T=xterm-256color C=truecolor P=sec-edit S=none E=none N=none K=kept');
  });

  it('big output arrives complete, in bounded batches', async () => {
    const r = rig({ autoAck: true });
    const t = await r.svc.spawn(1, { shellId: 'big' });
    await r.waitExit(t.id);
    expect(r.out.get(t.id)!.replace(/[^y]/g, '').length).toBe(300000);
    const mine = r.batches.flat().filter((e) => e.id === t.id);
    expect(Math.max(...mine.map((e) => e.data.length))).toBeLessThanOrEqual(128 * 1024); // flush-early at 64 K + one read
  });

  it('coalesces many small PTY reads into one message per frame, flushing early at 64 K', async () => {
    let emit: (d: string) => void = () => {};
    const fake: PtyModuleLike = {
      spawn: () => ({
        pid: 424242,
        onData: (cb) => ((emit = cb), { dispose() {} }),
        onExit: () => ({ dispose() {} }),
        write() {},
        resize() {},
        kill() {},
        pause() {},
        resume() {},
      }),
    };
    const r = rig({ loadPty: () => fake, signalGroup: () => {} });
    const a = await r.svc.spawn(1, { shellId: 'bash' });
    for (let i = 0; i < 1000; i++) emit('x'.repeat(100)); // 100 000 chars in 1000 reads
    expect(r.batches.map((b) => b.map((e) => e.data.length))).toEqual([[65600]]); // early flush, no waiting
    await new Promise((res) => setTimeout(res, 40));
    expect(r.batches.map((b) => b.map((e) => [e.id, e.data.length]))).toEqual([[[a.id, 65600]], [[a.id, 34400]]]);
    emit('a');
    emit('b');
    await new Promise((res) => setTimeout(res, 40));
    expect(r.batches.at(-1)).toEqual([{ id: a.id, data: 'ab' }]);
  });

  it('flow control: pauses the PTY until the renderer acks, then finishes', async () => {
    const r = rig({ ackHigh: 20000, ackLow: 5000 });
    const t = await r.svc.spawn(1, { shellId: 'flood' });
    await r.waitFor(t.id, /x{20000}/);
    await new Promise((res) => setTimeout(res, 400));
    const stalled = (r.out.get(t.id) ?? '').length;
    expect(stalled).toBeLessThan(600000); // paused well before the 1 MB is through
    let acked = 0;
    const pump = setInterval(() => {
      const n = (r.out.get(t.id) ?? '').length;
      if (n > acked) r.svc.ack(1, t.id, n - acked), (acked = n);
    }, 10);
    try {
      await r.waitFor(t.id, /DONE/, 15000);
    } finally {
      clearInterval(pump);
    }
    expect((r.out.get(t.id) ?? '').replace(/[^x]/g, '').length).toBe(1000000);
  });

  it('caches shell detection; listShells(true) re-detects', async () => {
    let calls = 0;
    const r = rig({ detect: async () => (calls++, SHELLS) });
    const a = await r.svc.listShells();
    await r.svc.listShells();
    expect(calls).toBe(1);
    expect(a).toMatchObject({ defaultId: 'bash', platform: 'linux' });
    await r.svc.listShells(true);
    expect(calls).toBe(2);
  });

  it('a node-pty load failure is a clean EIO, not a crash', async () => {
    const r = rig({
      loadPty: () => {
        throw new Error('pty.node: wrong ELF class');
      },
    });
    await expect(r.svc.spawn(1, { shellId: 'bash' })).rejects.toMatchObject({ code: 'EIO', message: expect.stringContaining('wrong ELF') });
    expect(r.svc.count()).toBe(0);
  });

  it('Claude preset: starts the detected `claude` in the workspace (real PTY, stub CLI); refuses when missing', async () => {
    const bin = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "CLAUDE STUB in $(pwd) args=$#"\n', { mode: 0o755 });
    try {
      const r = rig({ env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: bin } });
      expect((await r.svc.listShells()).claude).toBeUndefined(); // not looked up unless asked
      const list = await r.svc.listShells(false, undefined, true);
      expect(list.claude).toEqual({ available: true, via: 'native', path: path.join(bin, 'claude') });
      const t = await r.svc.spawn(1, { preset: 'claude', cwd: 'sub dir' });
      expect(t.shell).toMatchObject({ id: 'claude', kind: 'claude', name: 'Claude Code' });
      await r.waitFor(t.id, /CLAUDE STUB in .*sub dir args=0/);
      expect((await r.waitExit(t.id)).exitCode).toBe(0);

      const none = rig({ detectClaude: async () => ({ available: false, hint: 'install it' }) });
      await expect(none.svc.spawn(1, { preset: 'claude' })).rejects.toMatchObject({ code: 'ENOENT', message: 'install it' });
      await expect(none.svc.spawn(1, { preset: 'gpt' })).rejects.toMatchObject({ code: 'EINVAL' });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('opencode preset: private server first, the TUI attaches with the password in ITS env only; refuses when missing', async () => {
    const bin = fs.mkdtempSync(path.join(tmpRoot, 'bin-'));
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "OC STUB args=$* pw=${OPENCODE_PASSWORD:-none}"\n', { mode: 0o755 });
    try {
      const { EventEmitter } = await import('node:events');
      const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, kill: () => ((child as any).killed = true) });
      let started = 0;
      const follow = { dir: path.join(bin, 'f'), foldCase: () => false, inside: async () => true };
      const r = rig({
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: bin },
        follow,
        opencodeSpawn: () => {
          started++;
          queueMicrotask(() => child.stdout.emit('data', Buffer.from('server listening on http://127.0.0.1:9\nserver password secret-pass-12345\n')));
          return child as never;
        },
      });
      expect((await r.svc.listShells()).opencode).toBeUndefined(); // not looked up unless asked
      expect((await r.svc.listShells(false, undefined, true)).opencode).toEqual({ available: true, path: path.join(bin, 'opencode') });
      const t = await r.svc.spawn(1, { preset: 'opencode', follow: true });
      expect(t.shell).toMatchObject({ id: 'opencode', kind: 'opencode' });
      await r.waitFor(t.id, /OC STUB args=--server http:\/\/127\.0\.0\.1:9 pw=secret-pass-12345/);
      expect(started).toBe(1);
      await r.waitExit(t.id);
      expect(child.killed).toBe(true); // the terminal ended: its server goes with it
      // Follow off (the setting): plain opencode, no server, no password.
      const t2 = await r.svc.spawn(1, { preset: 'opencode' });
      await r.waitFor(t2.id, /OC STUB args= pw=none/);
      expect(started).toBe(1);

      const none = rig({ detectOpencode: async () => ({ available: false, hint: 'get opencode' }) });
      await expect(none.svc.spawn(1, { preset: 'opencode' })).rejects.toMatchObject({ code: 'ENOENT', message: 'get opencode' });
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('Claude lookup follows the preferred shell (WSL distro → inside it) and is cached per distro', async () => {
    const calls: Array<string | null> = [];
    const wsl: ShellInfo = { id: 'wsl:Ubuntu', name: 'Ubuntu (WSL)', kind: 'wsl', path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] };
    const r = rig({ platform: 'win32', windowsBuild: 22631, detect: async () => [{ ...SHELLS[0], id: 'pwsh', kind: 'pwsh' }, wsl], detectClaude: async (w) => (calls.push(w?.distro ?? null), { available: !!w, via: w ? 'wsl' : undefined }) });
    expect((await r.svc.listShells(false, undefined, true)).claude).toEqual({ available: false, via: undefined });
    expect((await r.svc.listShells(false, 'wsl:Ubuntu', true)).claude).toMatchObject({ available: true, via: 'wsl' });
    await r.svc.listShells(false, 'wsl:Ubuntu', true);
    await r.svc.listShells(false, 'wsl:Ubuntu'); // without withClaude: no lookup at all (it can start the distro)
    expect(calls).toEqual([null, 'Ubuntu']);
    await r.svc.listShells(true, undefined, true);
    expect(calls).toEqual([null, 'Ubuntu', null]);
  });
});

