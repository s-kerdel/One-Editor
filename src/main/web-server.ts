// "Start web server" (main process): runs browser mode for the open folder as a separate child process
// — dist/server/cli.mjs in a utilityProcess (web-server-child.ts), the same server "Start web server.cmd" runs.
//  - One server at a time for the whole app, never started on its own; it serves the folder of the window that
//    started it and stops on quit, when that window opens another folder or when no window has it open any more.
//  - Handshake over the child's message port (`--ipc`): port + token arrive as data, never parsed from a log line.
//  - The child exits by itself when this process goes away (Chromium ends a utility process without its parent).
//  - The token never reaches a log; the child gets an allowlisted environment only.
// No electron import: main.ts injects spawn / openExternal (unit-testable).
import path from 'node:path';
import type os from 'node:os';
import { STOPPED, WEB_SERVER_CHANNELS as CH, parseChildMessage, parseWebServerOptions, type WebServerOptions, type WebServerReply, type WebServerStatus, type WebServerUrl } from '../shared/web-server';

export interface ChildLike {
  readonly pid?: number;
  readonly connected?: boolean;
  stderr?: { on(ev: 'data', fn: (d: unknown) => void): unknown } | null;
  send?(m: unknown): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(ev: 'message', fn: (m: unknown) => void): unknown;
  on(ev: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(ev: 'error', fn: (err: Error) => void): unknown;
}

export interface WebServerDeps {
  /** The open folder (absolute), or null. Used when start() / registerWebServerIpc get no folder of the caller. */
  getRoot(): string | null;
  /** Starts cli.mjs with these arguments (see spawnCli). */
  spawn(args: string[]): ChildLike;
  /** IPv4 addresses other devices can reach (LAN mode lists one link per address). */
  lanAddresses(): string[];
  openExternal(url: string): Promise<unknown> | unknown;
  /** "Open": hands the browser the child's redirect file (its path only: no command line holds the launch code). */
  openFile?(file: string): Promise<unknown> | unknown;
  /** Where the child writes its redirect files (`<SEC_EDIT_CONFIG_DIR>/launch`): "Open" opens nothing else. */
  launchDir?: string;
  /**
   * LAN access (other devices reach the folder): the user's OK in a native dialog the page cannot answer. Absent or
   * false = not started. Local-only starts never ask.
   */
  confirmLan?(q: { root: string; port: number | null }): Promise<boolean>;
  onChange(s: WebServerStatus): void;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
  log?(msg: string): void;
}

export class WebServerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Removes anything that looks like an access token (the child's stderr is shown to the user). */
export function redact(text: string): string {
  return text.replace(/token=[^\s&"']+/gi, 'token=…').replace(/\b[a-f0-9]{32,}\b/gi, '…');
}

/** The line of a crash report worth showing ("Error: listen EACCES …"), not the stack. */
export function errorLine(stderr: string): string {
  const lines = redact(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^Node\.js v/.test(l) && !/^\^+$/.test(l));
  const err = [...lines].reverse().find((l) => /^(\w*Error|Error)\b.*:/.test(l));
  return (err ?? lines[lines.length - 1] ?? '').slice(0, 300);
}

/** IPv4, not loopback, not link-local (169.254.x: no DHCP, unreachable from other devices). */
export function lanAddresses(ifaces: ReturnType<typeof os.networkInterfaces>): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal && !a.address.startsWith('169.254.')) out.add(a.address);
    }
  }
  return [...out].sort();
}

// Only what the server (and the git it runs) needs: no NODE_OPTIONS, ELECTRON_*, tokens or keys of other tools.
const KEEP_ENV =
  /^(PATH|PATHEXT|HOME|USER|USERNAME|LOGNAME|LANG|LANGUAGE|LC_\w+|TZ|TMPDIR|TEMP|TMP|XDG_\w+|SSH_AUTH_SOCK|GIT_\w+|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|COMMONPROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH|USERDOMAIN|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|WSL_DISTRO_NAME|WSLENV|WSL_INTEROP|HTTPS?_PROXY|NO_PROXY|SEC_EDIT_RENDERER_DIR|SEC_EDIT_TRASH_DIR|SEC_EDIT_WATCH)$/i;

/** Environment for the child: the allowlist + the desktop app's settings folder. */
export function childEnv(env: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && KEEP_ENV.test(k)) out[k] = v;
  // Same settings, recent folders and index cache as the desktop app (what "Start web server.cmd" uses too).
  out.SEC_EDIT_CONFIG_DIR = configDir;
  return out;
}

/** Electron's UtilityProcess, as far as the child needs it (structural: no electron import here). */
export interface UtilityLike {
  readonly pid?: number;
  readonly stderr?: { on(ev: 'data', fn: (d: unknown) => void): unknown } | null;
  postMessage(m: unknown): void;
  kill(): boolean;
  on(ev: 'spawn', fn: () => void): unknown;
  on(ev: 'exit', fn: (code: number) => void): unknown;
  on(ev: 'message', fn: (m: unknown) => void): unknown;
}

// POSIX: a utility process ended by a signal reports the signal's number as its code (cli.ts itself exits 0 or 1).
const SIGNAL_CODES: Record<number, NodeJS.Signals> = { 2: 'SIGINT', 6: 'SIGABRT', 9: 'SIGKILL', 11: 'SIGSEGV', 15: 'SIGTERM' };

/** A utilityProcess child as the service sees one (Node's ChildProcess shape). `win`: exit codes are only codes there. */
export function childOfUtility(u: UtilityLike, win: boolean): ChildLike {
  let alive = true;
  u.on('exit', () => void (alive = false));
  return {
    get pid() {
      return u.pid;
    },
    get connected() {
      return alive;
    },
    stderr: u.stderr ?? null,
    send(m) {
      if (!alive) return false;
      u.postMessage(m);
      return true;
    },
    kill: () => u.kill(),
    on(ev: string, fn: (...a: never[]) => void) {
      if (ev === 'exit') u.on('exit', (code) => (fn as (c: number | null, s: NodeJS.Signals | null) => void)(...((!win && SIGNAL_CODES[code] ? [null, SIGNAL_CODES[code]] : [code, null]) as [number | null, NodeJS.Signals | null])));
      else if (ev === 'message') u.on('message', fn as (m: unknown) => void);
      return this;
    },
  } as ChildLike;
}

// Exact: folding case could keep serving a different folder on a case-sensitive disk (a needless stop is harmless).
const sameRoot = (a: string | null, b: string | null) => !!a && a === b;

export class WebServerService {
  private s: WebServerStatus = { ...STOPPED };
  private child: ChildLike | null = null;
  /** Set when we asked the child to go: its exit is then not an error. */
  private stopNotice: string | null | undefined = undefined;
  private stopping: Promise<WebServerStatus> | null = null;

  constructor(private readonly deps: WebServerDeps) {}

  status(): WebServerStatus {
    return { ...this.s, urls: this.s.urls.map((u) => ({ ...u })) };
  }

  /** pid of the running child (tests: no orphan after quit). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private set(s: WebServerStatus) {
    this.s = s;
    this.deps.onChange(this.status());
  }

  /** After openWorkspace: a server for the previous folder is stopped (serving a folder the window left is surprising). */
  workspaceChanged() {
    if (this.child && !sameRoot(this.deps.getRoot(), this.s.root)) void this.stop('Opening another folder stopped the web server.');
  }

  /** Several windows: the folders open in any of them now. A server whose folder none has open any more stops. */
  rootsChanged(openRoots: string[], notice = 'Closing its folder stopped the web server.') {
    if (this.child && !openRoots.some((r) => sameRoot(r, this.s.root))) void this.stop(notice);
  }

  /** One server for the app: another window's folder is not silently swapped in. */
  private busy(root: string | null): WebServerError | null {
    if (this.confirming) return new WebServerError('EBUSY', 'A web server start is waiting for your answer');
    if (!this.child && !this.stopping) return null;
    const other = this.s.root && !sameRoot(root, this.s.root) ? this.s.root : null;
    return new WebServerError('EBUSY', other ? `The web server is already serving ${other}. Stop it first` : 'A web server is already running. Stop it first');
  }

  /** The native LAN question is on screen: no second start meanwhile. */
  private confirming = false;

  /** `root`: the calling window's folder (null: it has none); omitted = deps.getRoot(). */
  start(raw: unknown, root: string | null = this.deps.getRoot()): Promise<WebServerStatus> {
    const o = parseWebServerOptions(raw);
    if (!o) return Promise.reject(new WebServerError('EINVAL', 'Invalid web server options'));
    const busy = this.busy(root);
    if (busy) return Promise.reject(busy);
    if (!root) return Promise.reject(new WebServerError('NO_WORKSPACE', 'Open a folder first'));
    if (o.access !== 'lan') return this.launch(o, root);
    // Other devices could read and change this folder: main asks itself (a taken-over page could start it otherwise).
    this.confirming = true;
    const asked = Promise.resolve()
      .then(() => this.deps.confirmLan?.({ root, port: o.port }) ?? false)
      .then((ok) => ok === true, () => false)
      .finally(() => (this.confirming = false));
    return asked.then((ok) => {
      if (!ok) throw new WebServerError('ECANCELED', 'Not started: sharing this folder on the network was not confirmed');
      const again = this.busy(root);
      if (again) throw again;
      return this.launch(o, root);
    });
  }

  private launch(o: WebServerOptions, root: string): Promise<WebServerStatus> {
    const args = [root, '--host', o.access === 'lan' ? '0.0.0.0' : '127.0.0.1', '--ipc'];
    if (o.port !== null) args.push('--port', String(o.port));
    const base = { ...STOPPED, root, access: o.access, port: o.port };
    this.stopNotice = undefined;
    this.set({ ...base, state: 'starting' });
    let child: ChildLike;
    try {
      child = this.deps.spawn(args);
    } catch (err) {
      const error = `Could not start the web server: ${redact(String((err as Error)?.message ?? err))}`;
      this.set({ ...base, state: 'error', error });
      return Promise.reject(new WebServerError('EIO', error));
    }
    this.child = child;
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr = (stderr + String(d)).slice(-8000)));
    return new Promise((resolve, reject) => {
      let settled = false;
      let reported: string | null = null; // the child's own error message (sent just before it exits)
      let code = 'EIO';
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timeoutMs = this.deps.startTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        reported = `The web server did not start within ${Math.round(timeoutMs / 1000)} s`;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('message', (raw) => {
        const m = parseChildMessage(raw);
        if (!m || this.child !== child) return;
        if (m.type === 'launch') {
          this.launchWaiter?.('file' in m ? m.file : null);
          this.launchWaiter = null;
        } else if (m.type === 'error') {
          reported = redact(m.message);
          code = m.code;
        } else
          settle(() => {
            const urls = buildUrls(m.port, m.token, o.access === 'lan' ? this.deps.lanAddresses() : []);
            this.set({ ...base, state: 'running', port: m.port, urls, portBusy: m.busy ?? null });
            this.deps.log?.(`[sec-edit] web server running on port ${m.port} (${o.access})`);
            resolve(this.status());
          });
      });
      child.on('error', (err) => {
        // Spawn failure (no exit event follows on some platforms).
        reported ??= `Could not start the web server: ${redact(err.message)}`;
        if (this.child === child && !child.pid) this.exited(child, base, reported, null, null, stderr);
        settle(() => reject(new WebServerError('EIO', reported!)));
      });
      child.on('exit', (exitCode, signal) => {
        clearTimeout(timer);
        if (this.child !== child) return;
        const error = this.exited(child, base, reported, exitCode, signal, stderr);
        settle(() => (error ? reject(new WebServerError(code, error)) : resolve(this.status())));
      });
    });
  }

  /** Records the child's end; returns the error shown to the user, or null after a requested stop. */
  private exited(child: ChildLike, base: WebServerStatus, reported: string | null, code: number | null, signal: NodeJS.Signals | null, stderr: string): string | null {
    if (this.child !== child) return null;
    this.child = null;
    const asked = this.stopNotice !== undefined;
    const notice = this.stopNotice ?? null;
    this.stopNotice = undefined;
    if (asked) {
      this.set({ ...STOPPED, notice });
      return null;
    }
    const why = code !== null ? `exit code ${code}` : `signal ${signal}`;
    const error = reported ?? `The web server stopped unexpectedly (${why})${errorLine(stderr) ? `: ${errorLine(stderr)}` : ''}`;
    this.deps.log?.(`[sec-edit] web server ended (${why})`);
    this.set({ ...base, state: 'error', error });
    return error;
  }

  /** Stops the server (graceful over IPC, killed after a grace period). Stopped already: clears an error. */
  stop(notice: string | null = null): Promise<WebServerStatus> {
    const child = this.child;
    if (!child) {
      if (this.s.state === 'error' || this.s.notice) this.set({ ...STOPPED });
      return Promise.resolve(this.status());
    }
    if (this.stopping) return this.stopping;
    this.stopNotice = notice;
    this.stopping = new Promise<WebServerStatus>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), this.deps.stopTimeoutMs ?? 4000);
      child.on('exit', () => {
        clearTimeout(kill);
        this.stopping = null;
        resolve(this.status());
      });
      // Before the handshake it has no 'stop' handler yet: terminate it.
      let sent = false;
      if (this.s.state === 'running' && child.connected) {
        try {
          sent = !!child.send?.({ type: 'stop' });
        } catch {}
      }
      if (!sent) child.kill();
    });
    return this.stopping;
  }

  /** App quit (synchronous): ends the child now. It also exits on its own once our IPC channel closes. */
  dispose() {
    const child = this.child;
    if (!child) return;
    this.stopNotice ??= null;
    try {
      child.kill();
    } catch {}
  }

  /**
   * "Open in browser": only for a link of the running server, and never with its token. Every row (LAN ones too: this
   * computer reaches the server on 127.0.0.1) opens the child's 0600 redirect file holding a one-time launch code, so
   * no command line (visible to other processes and users) ever holds the key or the code. No answer = an error,
   * never the token link instead.
   */
  async open(url: unknown): Promise<void> {
    if (typeof url !== 'string' || this.s.state !== 'running' || !this.s.urls.some((u) => u.url === url)) throw new WebServerError('EACCES', 'Not a link of the running web server');
    const file = await this.launchFile();
    if (!file) throw new WebServerError('EIO', 'The web server did not hand over a link to open. Use Copy link instead');
    await this.deps.openFile!(file);
  }

  private launchWaiter: ((file: string | null) => void) | null = null;
  /** The child's redirect file (in launchDir), or null (no answer, an error, or a path that is not its own). */
  private launchFile(): Promise<string | null> {
    const child = this.child;
    const dir = this.deps.launchDir;
    if (!child?.connected || !child.send || !dir || !this.deps.openFile) return Promise.resolve(null);
    return new Promise((resolve) => {
      const done = (f: string | null) => {
        clearTimeout(timer);
        this.launchWaiter = null;
        resolve(f && path.resolve(path.dirname(f)) === path.resolve(dir) && /^open-[0-9a-f]{16}\.html$/.test(path.basename(f)) ? f : null);
      };
      const timer = setTimeout(() => done(null), 3000);
      this.launchWaiter = done;
      try {
        if (!child.send!({ type: 'launch', file: true })) done(null);
      } catch {
        done(null);
      }
    });
  }
}

export function buildUrls(port: number, token: string, lan: string[]): WebServerUrl[] {
  const mk = (kind: WebServerUrl['kind'], host: string): WebServerUrl => {
    const origin = `http://${host}:${port}/`;
    return { kind, origin, url: `${origin}?token=${token}` };
  };
  return [mk('local', '127.0.0.1'), ...lan.map((a) => mk('lan', a))];
}

interface IpcLike {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void;
}

const reply = async <T>(fn: () => Promise<T> | T): Promise<WebServerReply<T>> => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return err instanceof WebServerError ? { ok: false, error: { code: err.code, message: err.message } } : { ok: false, error: { code: 'EIO', message: 'Web server error' } };
  }
};

/**
 * webserver:* handlers. The preload only coerces types; everything is validated here (and in the service).
 * `rootOf` (several windows): the calling window's folder, which start serves; without it deps.getRoot().
 */
export function registerWebServerIpc(ipc: IpcLike, svc: WebServerService, o: { isTrusted: (e: unknown) => boolean; rootOf?: (e: unknown) => string | null }): void {
  const denied: WebServerReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
  const guard = (fn: (...a: unknown[]) => Promise<unknown> | unknown) => (e: unknown, ...a: unknown[]) => (o.isTrusted(e) ? reply(() => fn(...a)) : denied);
  ipc.handle(CH.status, guard(() => svc.status()));
  ipc.handle(CH.start, (e, opts) => (o.isTrusted(e) ? reply(() => (o.rootOf ? svc.start(opts, o.rootOf(e)) : svc.start(opts))) : denied));
  ipc.handle(CH.stop, guard(() => svc.stop()));
  ipc.handle(CH.open, guard((url) => svc.open(url)));
}
