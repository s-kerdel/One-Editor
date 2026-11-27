// One window's backend, as main sees it: the seam that lets each window's BackendService move into its own
// utilityProcess later without touching routing, IPC or the renderer. No electron import (unit-tested).
// Seam rules (keep them, or the move stops being a drop-in):
//  - main never touches a window's BackendService / Workspace directly: only through WindowBackend;
//  - everything crossing it is JSON-serialisable or a Uint8Array (no functions, class instances, handles);
//  - every call is async (rejects, never throws); the only sync members are cached values (root, foldsCase, booted)
//    and fire-and-forget notices (setWatchPaused, queueOpenRequest);
//  - window backends share no in-memory state (shared files in user data are merged under a file lock).
import { RPC_METHODS, type FsEvent, type RpcMethod, type Settings } from '../shared/api';
import type { BackendService } from '../backend/service';
import type { GitMonitorEvent } from '../backend/git-monitor';
import { BackendFailure } from '../backend/errors';

/** Event name → listener arguments. */
export interface WindowBackendEvents {
  fs: [events: FsEvent[]];
  git: [event: GitMonitorEvent];
  /** This backend's own settings saves (main: theme, background colour). */
  settings: [settings: Settings, patch: Partial<Settings>];
  /** settings.json changed by another writer (another window, browser mode): forward to this window. */
  externalSettings: [patch: Partial<Settings>];
}

export interface WindowBackend {
  /** Open folder (absolute) or null. Cached: current once an open (either kind) has settled, also a failed one. */
  readonly root: string | null;
  /** The open folder's case rule ("Note.md" = "note.md"); false with no folder. Cached like root. */
  readonly foldsCase: boolean;
  /** The renderer has called bootstrap(): open requests go to it from now on instead of queueOpenRequest. */
  readonly booted: boolean;
  /** One renderer RPC (RPC_METHODS); undefined results become null. Rejects with BackendFailure. */
  call(method: RpcMethod, args: unknown[]): Promise<unknown>;
  /** Main-initiated open (launch, routing). Rejects when it is not a folder. */
  openWorkspace(abs: string): Promise<void>;
  /** Absolute path the renderer gets from bootstrap() (only before booted). */
  queueOpenRequest(abs: string): void;
  recentWorkspaces(): Promise<string[]>;
  /** Workspace.real(): the real absolute path of a workspace-relative one; rejects with no folder or outside it. */
  real(rel: string): Promise<string>;
  /** Search index channel (app://…/__index/page): a TextPage as UTF-8 JSON. */
  indexPage(cursor: string | null, maxBytes?: number): Promise<Uint8Array>;
  /** Search index channel (app://…/__index/files): the request body as parsed JSON. */
  indexFiles(body: unknown): Promise<Uint8Array>;
  /** git numstat through the backend (trust gate included); null when it fails or is refused. */
  gitNumstat(): Promise<unknown>;
  /** Window hidden / minimised: the folder poller holds still. */
  setWatchPaused(on: boolean): void;
  /** Returns the unsubscribe. */
  on<K extends keyof WindowBackendEvents>(event: K, cb: (...args: WindowBackendEvents[K]) => void): () => void;
  /** Drops this backend's listeners and closes its folder; later calls reject. */
  dispose(): Promise<void>;
}

type Listener = (...args: never[]) => void;

/** Today's implementation: the window's BackendService in this (main) process. */
export function createInProcessBackend(service: BackendService): WindowBackend {
  // Compile-time check that the service answers every RPC method.
  const rpc: Record<RpcMethod, (...args: never[]) => unknown> = service;
  let root: string | null = null;
  let foldsCase = false;
  let booted = false;
  let disposed = false;
  const offs = new Set<() => void>();

  // Through the RPC surface, as a helper process would answer it.
  const sync = async () => {
    const info = await service.getWorkspace();
    root = info?.root ?? null;
    foldsCase = info ? !info.caseSensitive : false;
  };
  // A call still running when the window closed may have (re)created a folder, git monitor or watch: close again.
  const run = async <R>(fn: () => R | Promise<R>): Promise<R> => {
    if (disposed) throw new BackendFailure('EIO', 'This window is closed');
    try {
      return await fn();
    } finally {
      if (disposed) service.dispose();
    }
  };
  const opened = async <R>(fn: () => Promise<R>): Promise<R> => {
    try {
      return await fn();
    } finally {
      await sync();
    }
  };
  const subscribe: { [K in keyof WindowBackendEvents]: (cb: (...args: WindowBackendEvents[K]) => void) => () => void } = {
    fs: (cb) => service.onFsEvents(cb),
    git: (cb) => service.onGitChanged(cb),
    settings: (cb) => service.onSettingsChanged(cb),
    externalSettings: (cb) => service.onExternalSettings(cb),
  };

  return {
    get root() {
      return root;
    },
    get foldsCase() {
      return foldsCase;
    },
    get booted() {
      return booted;
    },
    call: (method, args) =>
      run(async () => {
        if (!(RPC_METHODS as readonly string[]).includes(method)) throw new BackendFailure('EINVAL', `Unknown method: ${String(method)}`);
        if (method === 'bootstrap') booted = true; // the service flips it at the start of bootstrap() too
        const fn = rpc[method] as (...a: unknown[]) => unknown;
        const result = method === 'openWorkspace' ? await opened(async () => fn.apply(service, args)) : await fn.apply(service, args);
        return result ?? null;
      }),
    openWorkspace: (abs) => run(() => opened(async () => void (await service.openWorkspace(abs)))),
    queueOpenRequest(abs) {
      if (!disposed) service.openRequests.push(abs);
    },
    recentWorkspaces: () => run(() => service.recentWorkspaces()),
    real: (rel) =>
      run(() => {
        if (!service.workspace) throw new BackendFailure('NO_WORKSPACE', 'No folder is open');
        return service.workspace.real(rel);
      }),
    indexPage: (cursor, maxBytes) => run(() => service.indexPageRaw(cursor, maxBytes)),
    indexFiles: (body) => run(() => service.indexFilesRaw(body)),
    gitNumstat: () => run(() => service.git('numstat')).catch(() => null),
    setWatchPaused(on) {
      if (!disposed) service.workspace?.setWatchPaused(on);
    },
    on(event, cb) {
      if (disposed) return () => {};
      const off = (subscribe[event] as (cb: Listener) => () => void)(cb as unknown as Listener);
      const drop = () => {
        off();
        offs.delete(drop);
      };
      offs.add(drop);
      return drop;
    },
    dispose: async () => {
      disposed = true;
      for (const drop of [...offs]) drop();
      service.dispose();
    },
  };
}
