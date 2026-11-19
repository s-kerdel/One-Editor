// Terminal part of the sandboxed preload bridge (exposed as `secEditBridge.terminal`).
// Imports nothing but constants: the preload runs sandboxed. Arguments are coerced here and
// validated again in main (src/main/terminal.ts).
import { TERMINAL_CHANNELS as CH } from '../shared/terminal';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
}

export function terminalBridge(ipc: IpcRendererLike) {
  const listen = (channel: string) => (cb: (payload: unknown) => void) => {
    const fn = (_e: unknown, payload: unknown) => cb(payload);
    ipc.on(channel, fn);
    return () => void ipc.removeListener(channel, fn);
  };
  return {
    shells: (refresh?: boolean, prefer?: string, withClaude?: boolean) => ipc.invoke(CH.shells, refresh === true, typeof prefer === 'string' ? prefer : undefined, withClaude === true),
    spawn: (req: unknown) => ipc.invoke(CH.spawn, req && typeof req === 'object' ? { ...(req as object) } : undefined),
    kill: (id: number) => ipc.invoke(CH.kill, Number(id)),
    write: (id: number, data: string) => ipc.send(CH.write, Number(id), String(data)),
    resize: (id: number, cols: number, rows: number) => ipc.send(CH.resize, Number(id), Number(cols), Number(rows)),
    ack: (id: number, chars: number) => ipc.send(CH.ack, Number(id), Number(chars)),
    onData: listen(CH.data),
    onExit: listen(CH.exit),
  };
}

export type TerminalBridge = ReturnType<typeof terminalBridge>;
