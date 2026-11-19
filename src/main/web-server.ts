// "Start web server" (main process): runs browser mode for the open folder as a separate child process
// — dist/server/cli.mjs under ELECTRON_RUN_AS_NODE, the same server "Start web server.cmd" runs.
//  - One server at a time, never started on its own; stopped on quit and when another folder is opened.
//  - Handshake over the Node IPC channel (`--ipc`): port + token arrive as data, never parsed from a log line.
//  - The child exits by itself when this process goes away (IPC disconnect): no orphan, even after a crash.
//  - The token never reaches a log; the child gets an allowlisted environment only.
// No electron import: main.ts injects spawn / openExternal (unit-testable).
import { spawn as nodeSpawn } from 'node:child_process';
import type os from 'node:os';
import { STOPPED, WEB_SERVER_CHANNELS as CH, parseChildMessage, parseWebServerOptions, type WebServerReply, type WebServerStatus, type WebServerUrl } from '../shared/web-server';

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
  /** The open folder (absolute), or null. */
  getRoot(): string | null;
  /** Starts cli.mjs with these arguments (see spawnCli). */
  spawn(args: string[]): ChildLike;
  /** IPv4 addresses other devices can reach (LAN mode lists one link per address). */
  lanAddresses(): string[];
  openExternal(url: string): Promise<unknown> | unknown;
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

/** Environment for the child: the allowlist + Node mode + the desktop app's settings folder. */
export function childEnv(env: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && KEEP_ENV.test(k)) out[k] = v;
  out.ELECTRON_RUN_AS_NODE = '1';
  // Same settings, recent folders and index cache as the desktop app (what "Start web server.cmd" uses too).
  out.SEC_EDIT_CONFIG_DIR = configDir;
  return out;
}

/** The real child: `<exe> cli.mjs <args>` in Node mode; stdout (which prints the URL + token) is discarded. */
export function spawnCli(execPath: string, cli: string, args: string[], env: Record<string, string>): ChildLike {
  return nodeSpawn(execPath, [cli, ...args], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env, windowsHide: true });
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

  start(raw: unknown): Promise<WebServerStatus> {
    const o = parseWebServerOptions(raw);
    if (!o) return Promise.reject(new WebServerError('EINVAL', 'Invalid web server options'));
    if (this.child || this.stopping) return Promise.reject(new WebServerError('EBUSY', 'A web server is already running — stop it first'));
    const root = this.deps.getRoot();
    if (!root) return Promise.reject(new WebServerError('NO_WORKSPACE', 'Open a folder first'));
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
        if (m.type === 'error') {
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

  /** "Open in browser": only a link of the running server. */
  async open(url: unknown): Promise<void> {
    if (typeof url !== 'string' || this.s.state !== 'running' || !this.s.urls.some((u) => u.url === url)) throw new WebServerError('EACCES', 'Not a link of the running web server');
    await this.deps.openExternal(url);
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

/** webserver:* handlers. The preload only coerces types; everything is validated here (and in the service). */
export function registerWebServerIpc(ipc: IpcLike, svc: WebServerService, o: { isTrusted: (e: unknown) => boolean }): void {
  const denied: WebServerReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
  const guard = (fn: (...a: unknown[]) => Promise<unknown> | unknown) => (e: unknown, ...a: unknown[]) => (o.isTrusted(e) ? reply(() => fn(...a)) : denied);
  ipc.handle(CH.status, guard(() => svc.status()));
  ipc.handle(CH.start, guard((opts) => svc.start(opts)));
  ipc.handle(CH.stop, guard(() => svc.stop()));
  ipc.handle(CH.open, guard((url) => svc.open(url)));
}
