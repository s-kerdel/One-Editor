// "Security updates" part of the sandboxed preload bridge (`secEditBridge.updates`). Imports nothing but
// constants; coerces argument types only — main (src/main/update-check.ts) validates and decides.
import { UPDATE_CHECK_CHANNELS as CH } from '../shared/update-check';

interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
  removeListener(channel: string, fn: (e: unknown, payload: unknown) => void): unknown;
}

export function updateCheckBridge(ipc: IpcRendererLike) {
  return {
    /** The cached result: no request. */
    status: () => ipc.invoke(CH.status),
    /** force = "Check now"; otherwise main checks only when the last one is a week old. Refused while switched off. */
    check: (force?: boolean) => ipc.invoke(CH.check, force === true),
    onChange: (cb: (status: unknown) => void) => {
      const fn = (_e: unknown, payload: unknown) => cb(payload);
      ipc.on(CH.changed, fn);
      return () => void ipc.removeListener(CH.changed, fn);
    },
  };
}

export type UpdateCheckBridge = ReturnType<typeof updateCheckBridge>;
