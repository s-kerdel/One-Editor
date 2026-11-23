// What the terminal UI needs from the host. The desktop implementation talks to the preload bridge
// (`secEditBridge.terminal`, see src/main/terminal-bridge.ts); the browser build gets an unavailable
// backend (no shell over HTTP, ever). Tests drive the UI with a fake.
import { RpcError } from '../platform';
import { TERMINAL_LIMITS, type ShellList, type TerminalDataEvent, type TerminalExitEvent, type TerminalChangesEvent, type TerminalFollowEvent, type TerminalReply, type TerminalSpawnRequest, type TerminalSpawnResult } from '@shared/terminal';

export interface TerminalBackend {
  /** false → the panel only explains why (browser build). */
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** `prefer` = the default-shell setting (Claude is looked up inside a preferred WSL distro). */
  listShells(refresh?: boolean, prefer?: string, withClaude?: boolean): Promise<ShellList>;
  spawn(req: TerminalSpawnRequest): Promise<TerminalSpawnResult>;
  /** Keystrokes / pastes (fire-and-forget; split into IPC-sized chunks here). */
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  /** xterm.js has parsed `chars` more characters (flow control). */
  ack(id: number, chars: number): void;
  kill(id: number): Promise<void>;
  onData(cb: (e: TerminalDataEvent) => void): () => void;
  onExit(cb: (e: TerminalExitEvent) => void): () => void;
  /** An agent terminal (Claude Code, Opencode) edited a file / ended its turn (optional: older preloads, fakes). */
  onFollow?(cb: (e: TerminalFollowEvent) => void): () => void;
  /** An agent terminal's change list moved (optional like onFollow). */
  onChanges?(cb: (e: TerminalChangesEvent) => void): () => void;
}

/** Shape of `secEditBridge.terminal` (src/main/terminal-bridge.ts). */
export interface TerminalBridgeLike {
  shells(refresh?: boolean, prefer?: string, withClaude?: boolean): Promise<unknown>;
  spawn(req: unknown): Promise<unknown>;
  kill(id: number): Promise<unknown>;
  write(id: number, data: string): void;
  resize(id: number, cols: number, rows: number): void;
  ack(id: number, chars: number): void;
  onData(cb: (payload: unknown) => void): () => void;
  onExit(cb: (payload: unknown) => void): () => void;
  onFollow?(cb: (payload: unknown) => void): () => void;
  onChanges?(cb: (payload: unknown) => void): () => void;
}

const unwrap = async <T>(p: Promise<unknown>): Promise<T> => {
  const r = (await p) as TerminalReply<T> | undefined;
  if (!r || typeof r !== 'object') throw new RpcError('EIO', 'No reply from the terminal host');
  if (!r.ok) throw new RpcError(r.error.code, r.error.message);
  return r.result;
};

/** Bigger writes than this are split (main refuses > TERMINAL_LIMITS.maxWriteChars per message). */
export const WRITE_CHUNK = Math.floor(TERMINAL_LIMITS.maxWriteChars / 2);

export function splitForWrite(data: string, max = WRITE_CHUNK): string[] {
  if (data.length <= max) return [data];
  const out: string[] = [];
  for (let i = 0; i < data.length; ) {
    let end = Math.min(data.length, i + max);
    // Never split a surrogate pair: half an emoji per message would arrive as two U+FFFD.
    const c = data.charCodeAt(end - 1);
    if (end < data.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}

export function bridgeTerminalBackend(b: TerminalBridgeLike): TerminalBackend {
  return {
    available: true,
    listShells: (refresh, prefer, withClaude) => unwrap<ShellList>(b.shells(refresh, prefer, withClaude)),
    spawn: (req) => unwrap<TerminalSpawnResult>(b.spawn(req)),
    kill: async (id) => void (await unwrap<boolean>(b.kill(id))),
    write: (id, data) => splitForWrite(data).forEach((part) => b.write(id, part)),
    resize: (id, cols, rows) => b.resize(id, cols, rows),
    ack: (id, chars) => b.ack(id, chars),
    onData: (cb) =>
      b.onData((p) => {
        if (Array.isArray(p)) for (const e of p as TerminalDataEvent[]) cb(e);
      }),
    onExit: (cb) => b.onExit((p) => cb(p as TerminalExitEvent)),
    onFollow: (cb) => b.onFollow?.((p) => cb(p as TerminalFollowEvent)) ?? (() => {}),
    onChanges: (cb) => b.onChanges?.((p) => cb(p as TerminalChangesEvent)) ?? (() => {}),
  };
}

export function unavailableTerminalBackend(reason: string): TerminalBackend {
  const no = () => Promise.reject(new RpcError('ENOTSUP', reason));
  return {
    available: false,
    unavailableReason: reason,
    listShells: no,
    spawn: no,
    kill: no,
    write: () => {},
    resize: () => {},
    ack: () => {},
    onData: () => () => {},
    onExit: () => () => {},
  };
}

export const DESKTOP_ONLY_REASON = 'The terminal is available in the desktop app only.';

export function connectTerminalBackend(w: unknown = globalThis): TerminalBackend {
  const bridge = (w as { secEditBridge?: { terminal?: TerminalBridgeLike } }).secEditBridge?.terminal;
  return bridge ? bridgeTerminalBackend(bridge) : unavailableTerminalBackend(DESKTOP_ONLY_REASON);
}
