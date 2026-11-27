// term:* IPC: trusted senders only, per-window routing, terminals die with their page; preload bridge shape.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { registerTerminalIpc, TerminalService, type IpcEventLike, type PtyLike, type PtyModuleLike, type SenderLike } from '../../../src/main/terminal';
import { terminalBridge } from '../../../src/main/terminal-bridge';
import { TERMINAL_CHANNELS as CH, type ShellInfo } from '../../../src/shared/terminal';

class FakePty implements PtyLike {
  static last: FakePty | null = null;
  static nextPid = 1000;
  pid = FakePty.nextPid++;
  ev = new EventEmitter();
  written: string[] = [];
  killed: Array<string | undefined> = [];
  size: [number, number] = [0, 0];
  constructor(
    public file: string,
    public args: string[],
    public opts: Record<string, unknown>,
  ) {
    FakePty.last = this;
  }
  onData(cb: (d: string) => void) {
    this.ev.on('data', cb);
    return { dispose: () => this.ev.off('data', cb) };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.ev.on('exit', cb);
    return { dispose: () => this.ev.off('exit', cb) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(c: number, r: number) {
    this.size = [c, r];
  }
  kill(sig?: string) {
    this.killed.push(sig);
    queueMicrotask(() => this.ev.emit('exit', { exitCode: 0, signal: 1 }));
  }
  pause() {}
  resume() {}
}
const fakePty: PtyModuleLike = { spawn: (f, a, o) => new FakePty(f, a as string[], o) };
const SHELLS: ShellInfo[] = [{ id: 'bash', name: 'bash', kind: 'bash', path: '/bin/bash', args: [] }];

class FakeSender extends EventEmitter implements SenderLike {
  sent: Array<[string, unknown]> = [];
  destroyed = false;
  constructor(public id: number) {
    super();
  }
  send(ch: string, p: unknown) {
    this.sent.push([ch, p]);
  }
  isDestroyed() {
    return this.destroyed;
  }
}

function setup() {
  const handlers = new Map<string, (e: IpcEventLike, ...a: unknown[]) => unknown>();
  const listeners = new Map<string, (e: IpcEventLike, ...a: unknown[]) => void>();
  const ipc = { handle: (ch: string, fn: (e: IpcEventLike, ...a: unknown[]) => unknown) => void handlers.set(ch, fn), on: (ch: string, fn: (e: IpcEventLike, ...a: unknown[]) => void) => void listeners.set(ch, fn) };
  const svc = new TerminalService({ loadPty: () => fakePty, getWorkspaceRoot: () => process.cwd(), detect: async () => SHELLS, platform: 'linux', flushMs: 1, signalGroup: () => {} });
  const trusted = new Set<number>([1, 2]);
  registerTerminalIpc(ipc, svc, { isTrusted: (e) => trusted.has(e.sender.id) });
  const invoke = (ch: string, s: FakeSender, ...a: unknown[]) => handlers.get(ch)!({ sender: s }, ...a) as Promise<any>;
  const send = (ch: string, s: FakeSender, ...a: unknown[]) => listeners.get(ch)!({ sender: s }, ...a);
  return { svc, handlers, listeners, invoke, send };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('registerTerminalIpc', () => {
  it('registers every channel', () => {
    const { handlers, listeners } = setup();
    expect([...handlers.keys()].sort()).toEqual([CH.kill, CH.shells, CH.spawn].sort());
    expect([...listeners.keys()].sort()).toEqual([CH.ack, CH.resize, CH.write].sort());
  });

  it('refuses untrusted senders on every channel', async () => {
    const { invoke, send, svc } = setup();
    const evil = new FakeSender(66);
    for (const ch of [CH.shells, CH.spawn, CH.kill]) expect(await invoke(ch, evil, {})).toMatchObject({ ok: false, error: { code: 'EACCES' } });
    const a = new FakeSender(1);
    const t = (await invoke(CH.spawn, a, { shellId: 'bash' })).result;
    send(CH.write, evil, t.id, 'rm -rf ~\r');
    send(CH.resize, evil, t.id, 100, 40);
    expect(FakePty.last!.written).toEqual([]);
    expect(FakePty.last!.size).toEqual([0, 0]);
    expect(svc.count()).toBe(1);
  });

  it('routes output to the owning window only; input from another window is dropped', async () => {
    const { invoke, send } = setup();
    const a = new FakeSender(1);
    const b = new FakeSender(2);
    const r = await invoke(CH.spawn, a, { shellId: 'bash', cols: 100, rows: 30 });
    expect(r).toMatchObject({ ok: true, result: { shell: { id: 'bash' } } });
    const p = FakePty.last!;
    expect(p.opts).toMatchObject({ cols: 100, rows: 30, name: 'xterm-256color' });
    p.ev.emit('data', 'hi');
    await tick();
    expect(a.sent).toEqual([[CH.data, [{ id: r.result.id, data: 'hi' }]]]);
    expect(b.sent).toEqual([]);
    send(CH.write, a, r.result.id, 'ls\r');
    send(CH.write, b, r.result.id, 'evil\r');
    expect(p.written).toEqual(['ls\r']);
    expect(await invoke(CH.kill, b, r.result.id)).toEqual({ ok: true, result: false });
    expect(await invoke(CH.kill, a, r.result.id)).toEqual({ ok: true, result: true });
    await tick();
    expect(a.sent.at(-1)).toEqual([CH.exit, { id: r.result.id, exitCode: 0, signal: 1 }]);
  });

  it('errors come back as { ok: false, code } (never throw across IPC)', async () => {
    const { invoke } = setup();
    expect(await invoke(CH.spawn, new FakeSender(1), { shellId: '../../bin/sh' })).toMatchObject({ ok: false, error: { code: 'EINVAL' } });
    expect(await invoke(CH.spawn, new FakeSender(1), { shellId: 'bash', cwd: '../..' })).toMatchObject({ ok: false, error: { code: 'OUTSIDE_WORKSPACE' } });
  });

  it('a window that closes, reloads or crashes takes its terminals with it', async () => {
    for (const ev of ['destroyed', 'did-navigate', 'render-process-gone']) {
      const { invoke, svc } = setup();
      const a = new FakeSender(1);
      const b = new FakeSender(2);
      await invoke(CH.spawn, a, { shellId: 'bash' });
      await invoke(CH.spawn, b, { shellId: 'bash' });
      a.emit(ev);
      await tick();
      expect(svc.count(1), ev).toBe(0);
      expect(svc.count(2), ev).toBe(1);
    }
  });

  it('several windows: spawn and the default shell use the calling window’s folder (owner = sender id)', async () => {
    const handlers = new Map<string, (e: IpcEventLike, ...a: unknown[]) => unknown>();
    const wsl: ShellInfo = { id: 'wsl:Ubuntu', name: 'Ubuntu (WSL)', kind: 'wsl', path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] };
    const roots: Record<number, string | null> = { 1: '\\\\wsl.localhost\\Ubuntu\\home\\me', 2: 'C:\\notes', 3: null };
    const svc = new TerminalService({ loadPty: () => fakePty, getWorkspaceRoot: (owner) => roots[owner] ?? null, detect: async () => [{ ...SHELLS[0], id: 'pwsh', kind: 'pwsh' }, wsl], platform: 'win32', windowsBuild: 22631, treeKill: () => {} });
    registerTerminalIpc({ handle: (ch, fn) => void handlers.set(ch, fn), on: () => {} }, svc, { isTrusted: () => true });
    const invoke = (ch: string, s: number, ...a: unknown[]) => handlers.get(ch)!({ sender: new FakeSender(s) }, ...a) as Promise<any>;
    expect((await invoke(CH.shells, 1)).result.defaultId).toBe('wsl:Ubuntu');
    expect((await invoke(CH.shells, 2)).result.defaultId).toBe('pwsh');
    expect((await invoke(CH.shells, 3)).result.defaultId).toBe('pwsh'); // no folder
    expect(await invoke(CH.spawn, 3, {})).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } });
    expect(await invoke(CH.spawn, 2, {})).toMatchObject({ ok: true, result: { shell: { id: 'pwsh' } } });
    expect(FakePty.last?.opts.cwd).toBe('C:\\notes');
    svc.dispose();
  });

  it('never sends to a destroyed window', async () => {
    const { invoke } = setup();
    const a = new FakeSender(1);
    await invoke(CH.spawn, a, { shellId: 'bash' });
    a.destroyed = true;
    FakePty.last!.ev.emit('data', 'late');
    await tick();
    expect(a.sent).toEqual([]);
  });
});

describe('preload terminal bridge', () => {
  it('maps calls onto term:* channels and coerces arguments', async () => {
    const calls: unknown[][] = [];
    const ev = new EventEmitter();
    const ipc = {
      invoke: async (...a: unknown[]) => (calls.push(['invoke', ...a]), { ok: true }),
      send: (...a: unknown[]) => void calls.push(['send', ...a]),
      on: (ch: string, fn: (...a: unknown[]) => void) => ev.on(ch, fn),
      removeListener: (ch: string, fn: (...a: unknown[]) => void) => ev.off(ch, fn),
    };
    const br = terminalBridge(ipc);
    await br.shells();
    await br.spawn({ shellId: 'bash' });
    await br.spawn('bad' as unknown);
    await br.kill('3' as unknown as number);
    br.write(1, 'x');
    br.resize(1, 80, 24);
    br.ack(1, 5);
    expect(calls).toEqual([
      ['invoke', CH.shells, false, undefined, false],
      ['invoke', CH.spawn, { shellId: 'bash' }],
      ['invoke', CH.spawn, undefined],
      ['invoke', CH.kill, 3],
      ['send', CH.write, 1, 'x'],
      ['send', CH.resize, 1, 80, 24],
      ['send', CH.ack, 1, 5],
    ]);
    const got: unknown[] = [];
    const off = br.onData((p) => got.push(p));
    ev.emit(CH.data, {}, [{ id: 1, data: 'a' }]);
    off();
    ev.emit(CH.data, {}, [{ id: 1, data: 'b' }]);
    expect(got).toEqual([[{ id: 1, data: 'a' }]]);
  });
});
