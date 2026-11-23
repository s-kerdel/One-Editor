// "AI changes" for Opencode terminals, main side. For an opencode terminal started by One, main starts a
// private `opencode serve` (loopback, random port, generated password) and the terminal's TUI attaches to it
// (`opencode --server <url>`). Main subscribes to that server's event stream (SSE) and asks it for the exact
// per-file diff, then tells the owning window (a) which workspace file changed (`term:follow`, the same events
// Claude follow sends) and (b) the whole change list (`term:changes`).
// Why a server of our own: opencode's built-in edit / write tools do not go through MCP, so only its own
// server sees every change (also shell-made ones) with turn boundaries and exact +/− counts.
// Trust: the address + password come from the child's stdout and stay in memory (never the renderer, a
// file, the log or the child's environment — a password in the server's env reaches the agent's shell
// commands). Main only issues GETs, to the literal 127.0.0.1, redirects are errors. Every path is checked
// against the open folder (lexical rule in the model, the workspace's real-path rule here).
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { TerminalChangesEvent, TerminalFollowEvent } from '../shared/terminal';
import { addSession, diffQuery, emptyState, isBusy, onDiff, onEvent, OPENCODE_EVENT_TYPES, OPENCODE_ID, worktreeOf, type OpencodeCtx, type OpencodeState } from './terminal-opencode-model';
import { ChangesSender, isObj } from './terminal-changes';
import { mapFollowPath } from './terminal-follow';
import { planOpencodeServe } from './terminal-shells';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/;
const HANDSHAKE_MS = 15_000;
/** One SSE event larger than this ends the stream (and reconnects with a resync). */
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_MS = 15_000;
const DIFF_DEBOUNCE_MS = 40;
const BACKOFF_MS = [1000, 2000, 5000, 10_000];
/** A stream that lived this long was a real connection: the next reconnect starts at the shortest wait again. */
const STABLE_MS = 10_000;
/** Sessions the folder already had when the terminal started (remembered so a resumed one can be picked up). */
const MAX_DORMANT = 500;

/** `server listening on http://127.0.0.1:PORT` + `server password XXXX` from the child's stdout (any order, any chunking). */
export function parseHandshake(text: string): { url: string; password: string } | null {
  const url = /server listening on (http:\/\/127\.0\.0\.1:\d{1,5})(?![\d.])/.exec(text)?.[1];
  const password = /server password (\S{8,200})/.exec(text)?.[1];
  return url && password && LOOPBACK.test(url) ? { url, password } : null;
}

export interface OpencodeServer {
  url: string;
  password: string;
}

export interface OpencodeOptions {
  /** The workspace's real-path rule for a relative path (`Workspace.real`): false = outside, ignore. */
  inside: (rel: string) => Promise<boolean>;
  emitFollow: (terminalId: number, e: TerminalFollowEvent) => void;
  emitChanges: (terminalId: number, e: TerminalChangesEvent) => void;
  /** Test hook: the server process (default: `opencode serve` in a process group of its own). */
  spawnServer?: (bin: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Windows: kill a process tree (the server may sit behind cmd.exe + node: killing the first process alone leaves it running). */
  treeKill?: (pid: number) => void;
  fetch?: typeof fetch;
  /** Test hook: reconnect waits. */
  backoffMs?: number[];
}

/** Where the tracked folder is: as One names it, and without links (opencode reports its own, link-free working folder). */
export interface OpencodeFolder {
  root: string;
  realRoot?: string | null;
  platform: string;
  foldCase: boolean;
}

/** How a server child is ended: its process group (ours, POSIX), its tree (Windows), or just it (an injected one). */
type KillHow = 'plain' | 'group' | 'tree';

interface SessionInfo {
  parent: string | null;
  base: string | null;
}

interface Track {
  id: number;
  st: OpencodeState;
  ctx: OpencodeCtx;
  /** The folder as opencode knows it (the session list is asked for by this name). */
  dir: string;
  folder: (dir: string) => boolean;
  server: OpencodeServer;
  child: ChildProcess | null;
  how: KillHow;
  ac: AbortController;
  closed: boolean;
  chain: Promise<void>;
  fetching: Map<string, { again: boolean }>;
  diffTimers: Map<string, NodeJS.Timeout>;
  sender: ChangesSender;
  /** The first session list was read. */
  synced: boolean;
  syncing: boolean;
  /** Sessions of earlier runs in this folder: not this terminal's work until one of them shows activity. */
  dormant: Map<string, SessionInfo>;
}

export class OpencodeTracker {
  private readonly tracks = new Map<number, Track>();
  constructor(private readonly o: OpencodeOptions) {}

  /**
   * Starts the private server for terminal `id` and begins tracking; null when it cannot start (the terminal then
   * runs plain opencode, without the change list). The password is in the result for the terminal's own environment only.
   */
  async open(id: number, a: OpencodeFolder & { bin: string; env: NodeJS.ProcessEnv }): Promise<OpencodeServer | null> {
    const env = { ...a.env };
    for (const k of Object.keys(env)) if (/^OPENCODE_(SERVER_)?PASSWORD$/i.test(k)) delete env[k];
    const win = a.platform === 'win32';
    let child: ChildProcess;
    try {
      if (this.o.spawnServer) child = this.o.spawnServer(a.bin, a.root, env);
      else {
        // POSIX: a process group of its own, so the commands the agent started go with the server.
        const plan = planOpencodeServe(a.bin, { platform: a.platform, env });
        child = nodeSpawn(plan.file, plan.args, { cwd: a.root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: plan.verbatim, detached: !win });
      }
    } catch {
      return null;
    }
    const how: KillHow = this.o.spawnServer ? 'plain' : win ? 'tree' : 'group';
    const server = await new Promise<OpencodeServer | null>((resolve) => {
      let out = '';
      let settled = false;
      const done = (v: OpencodeServer | null) => {
        if (settled) return;
        settled = true;
        out = '';
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => done(null), HANDSHAKE_MS);
      // Both pipes stay drained for the server's whole life (a full pipe would block it); never logged (paths, the password).
      child.stdout?.on('data', (c: Buffer) => {
        if (settled) return;
        out = (out + c.toString('utf8')).slice(-8192);
        const h = parseHandshake(out);
        if (h) done(h);
      });
      child.stderr?.on('data', () => {});
      child.on('error', () => done(null));
      child.on('exit', () => done(null));
    });
    if (!server) {
      this.kill(child, how);
      return null;
    }
    this.attach(id, server, a, child, how);
    return server;
  }

  /** Tracks an already running server (tests, or `open`). */
  attach(id: number, server: OpencodeServer, a: OpencodeFolder, child: ChildProcess | null = null, how: KillHow = 'plain'): void {
    if (!LOOPBACK.test(server.url)) {
      if (child) this.kill(child, how);
      return;
    }
    this.close(id);
    const win = a.platform === 'win32';
    const ctx: OpencodeCtx = { win, map: (abs) => mapFollowPath(abs, { root: a.root, realRoot: a.realRoot, platform: a.platform, foldCase: a.foldCase }) };
    const norm = (p: string) => (a.foldCase ? p.toLowerCase() : p).replace(/\\/g, '/').replace(/\/+$/, '');
    const names = [a.root, a.realRoot].filter((x): x is string => !!x).map(norm);
    const st = emptyState();
    const t: Track = {
      id,
      st,
      ctx,
      dir: a.realRoot || a.root,
      folder: (dir) => names.includes(norm(dir)),
      server,
      child,
      how,
      ac: new AbortController(),
      closed: false,
      chain: Promise.resolve(),
      fetching: new Map(),
      diffTimers: new Map(),
      sender: new ChangesSender(id, 'opencode', () => ({ busy: isBusy(st), turns: st.turns, files: st.files }), (e) => this.o.emitChanges(id, e)),
      synced: false,
      syncing: false,
      dormant: new Map(),
    };
    child?.on('exit', () => {
      if (!t.closed) this.close(id);
    });
    this.tracks.set(id, t);
    void this.run(t);
  }

  close(id: number): void {
    const t = this.tracks.get(id);
    if (!t) return;
    this.tracks.delete(id);
    t.closed = true;
    t.ac.abort();
    t.sender.close();
    t.diffTimers.forEach(clearTimeout);
    t.diffTimers.clear();
    if (t.child) this.kill(t.child, t.how);
  }

  dispose(): void {
    for (const id of [...this.tracks.keys()]) this.close(id);
  }

  /** Live trackers (tests / diagnostics). */
  count(): number {
    return this.tracks.size;
  }

  private kill(c: ChildProcess, how: KillHow) {
    if (how === 'tree' && c.pid) {
      try {
        this.o.treeKill?.(c.pid);
      } catch {}
    }
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (how === 'group' && c.pid) process.kill(-c.pid, sig);
        else c.kill(sig);
      } catch {} // ESRCH: already gone
    };
    signal('SIGTERM');
    if (c.exitCode !== null || c.signalCode !== null) return; // it had ended already: nothing left to wait for
    const hard = setTimeout(() => signal('SIGKILL'), 2000);
    hard.unref?.();
    c.once('exit', () => clearTimeout(hard));
  }

  // ---------------------------------------------------------------- http (GET only, loopback only)

  /**
   * A signal for ONE request: aborted with the tracker (and after `ms`, body included), unhooked again by `done()`.
   * The tracker's own long-lived signal is never handed to fetch: every request would leave a listener on it
   * until the garbage collector got to it — one per reconnect, for as long as the terminal lives.
   */
  private scope(t: Track, ms = 0): { signal: AbortSignal; done: () => void } {
    const ac = new AbortController();
    const abort = () => ac.abort();
    if (t.ac.signal.aborted) ac.abort();
    else t.ac.signal.addEventListener('abort', abort, { once: true });
    const timer = ms ? setTimeout(abort, ms) : null;
    timer?.unref?.();
    return {
      signal: ac.signal,
      done: () => {
        if (timer) clearTimeout(timer);
        t.ac.signal.removeEventListener('abort', abort);
      },
    };
  }

  private get(t: Track, path: string, accept: string, signal: AbortSignal): Promise<Response> {
    const f = this.o.fetch ?? fetch;
    return f(t.server.url + path, {
      method: 'GET',
      redirect: 'error',
      signal,
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + t.server.password).toString('base64'), accept },
    });
  }

  private async json(t: Track, path: string): Promise<unknown> {
    const sc = this.scope(t, REQUEST_MS);
    try {
      const r = await this.get(t, path, 'application/json', sc.signal).then((x) => x, () => null);
      if (!r) return null;
      if (!r.ok) {
        void r.body?.cancel().catch(() => {});
        return null;
      }
      const text = await readCapped(r, MAX_BODY_BYTES);
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    } finally {
      sc.done();
    }
  }

  // ---------------------------------------------------------------- stream + resync

  private async run(t: Track) {
    const waits = this.o.backoffMs ?? BACKOFF_MS;
    const q = OPENCODE_EVENT_TYPES.map((x) => 'types=' + encodeURIComponent(x)).join('&');
    for (let fails = 0; !t.closed; ) {
      const t0 = Date.now();
      let connected = false;
      const sc = this.scope(t);
      try {
        const r = await this.get(t, '/api/event?' + q, 'text/event-stream', sc.signal);
        if (!r.ok || !r.body) {
          void r.body?.cancel().catch(() => {}); // an unread body keeps its connection
          throw new Error('http');
        }
        connected = true;
        // Resync AFTER subscribing: nothing is replayed after a gap, so the state is read from the server again.
        void this.resync(t);
        await this.read(t, r.body);
      } catch {
        // dropped / refused: back off below
      } finally {
        sc.done();
      }
      if (t.closed) return;
      // Only a stream that really lived resets the wait: one that opens and ends at once (or is refused) backs off,
      // else it would be a request loop (each connect also re-reads the session list and every diff).
      fails = connected && Date.now() - t0 >= STABLE_MS ? 0 : fails + 1;
      await this.wait(t, waits[Math.min(Math.max(fails, 1), waits.length) - 1]);
    }
  }

  /** `ms`, or until the tracker closes. The abort listener goes with the timer (one per reconnect would pile up). */
  private wait(t: Track, ms: number): Promise<void> {
    return new Promise<void>((res) => {
      const done = () => {
        clearTimeout(timer);
        t.ac.signal.removeEventListener('abort', done);
        res();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      t.ac.signal.addEventListener('abort', done, { once: true });
    });
  }

  private async read(t: Track, body: ReadableStream<Uint8Array>) {
    const dec = new TextDecoder();
    let buf = '';
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || t.closed) return;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('\r')) buf = buf.replace(/\r\n/g, '\n'); // CRLF framing is valid SSE too
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n');
          if (data) this.enqueue(t, data);
        }
        if (buf.length > MAX_EVENT_BYTES) return; // one event this big is not a stream we understand: reconnect
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /** Events are applied one at a time, in order (the path check is async). */
  private enqueue(t: Track, data: string) {
    t.chain = t.chain.then(() => this.apply(t, data)).catch(() => {});
  }

  private async apply(t: Track, data: string) {
    let ev: unknown;
    try {
      ev = JSON.parse(data);
      if (typeof ev === 'string') ev = JSON.parse(ev);
    } catch {
      return;
    }
    if (t.closed) return;
    // A session of an earlier run shows activity: the user resumed it in this terminal, so it is ours from here on.
    const sid = isObj(ev) && isObj(ev.data) ? ev.data.sessionID : undefined;
    if (typeof sid === 'string' && t.dormant.has(sid) && isObj(ev) && ev.type !== 'session.created' && ev.type !== 'session.deleted') {
      addSession(t.st, sid, t.dormant.get(sid));
      t.dormant.delete(sid);
    }
    const r = onEvent(t.st, ev, t.ctx, t.folder);
    for (const f of r.follow) {
      if (t.closed) return;
      if (f.path && !(await this.o.inside(f.path).catch(() => false))) continue; // outside: never shown
      this.o.emitFollow(t.id, { id: t.id, agent: 'opencode', ...f });
    }
    for (const s of r.refresh) this.scheduleDiff(t, s);
    if (r.changed) t.sender.schedule();
  }

  /**
   * After a (re)connect: the folder's sessions, their prompts, then the exact diff of each. The sessions the folder
   * already had at the FIRST look are its history (opencode keeps them): they are remembered, not listed — a pile of
   * old changes is not what this terminal did. Sessions that appear later were made while the stream was down.
   */
  private async resync(t: Track) {
    if (t.syncing) return;
    t.syncing = true;
    try {
      const list = await this.json(t, `/api/session?directory=${encodeURIComponent(t.dir)}&limit=20`);
      const rows = isObj(list) && Array.isArray(list.data) ? (list.data as unknown[]).slice(0, 50) : null;
      if (!rows) return; // no answer: the next (re)connect asks again
      const first = !t.synced;
      t.synced = true;
      for (const row of rows) {
        if (t.closed) return;
        if (!isObj(row) || typeof row.id !== 'string' || !OPENCODE_ID.test(row.id)) continue;
        const id = row.id;
        if (!t.st.sessions.has(id)) {
          const dir = isObj(row.location) ? row.location.directory : row.directory;
          const info: SessionInfo = { parent: typeof row.parentID === 'string' ? row.parentID : null, base: worktreeOf(dir, row.subpath, t.ctx.win) };
          if (first || t.dormant.has(id)) {
            if (t.dormant.size < MAX_DORMANT) t.dormant.set(id, info);
            continue;
          }
          if (!addSession(t.st, id, info)) continue;
        }
        const msgs = await this.json(t, `/api/session/${id}/message?type=user&order=asc&limit=200`);
        const ids = (isObj(msgs) && Array.isArray(msgs.data) ? (msgs.data as unknown[]) : []).map((m) => (isObj(m) ? m.id : null)).filter((x): x is string => typeof x === 'string');
        const s = t.st.sessions.get(id);
        if (!s) continue; // deleted meanwhile
        if (ids.length) s.turnIds = ids.slice(-1000);
        this.scheduleDiff(t, id, 0);
      }
    } finally {
      t.syncing = false;
    }
  }

  private scheduleDiff(t: Track, session: string, ms = DIFF_DEBOUNCE_MS) {
    if (t.closed || t.diffTimers.has(session)) return;
    const timer = setTimeout(() => {
      t.diffTimers.delete(session);
      void this.fetchDiff(t, session);
    }, ms);
    timer.unref?.();
    t.diffTimers.set(session, timer);
  }

  /** Single flight per session: a request that arrives while one runs asks for one more round afterwards. */
  private async fetchDiff(t: Track, session: string) {
    const running = t.fetching.get(session);
    if (running) {
      running.again = true;
      return;
    }
    const slot = { again: false };
    t.fetching.set(session, slot);
    try {
      do {
        slot.again = false;
        const s = t.st.sessions.get(session);
        if (t.closed || !s) return;
        const body = await this.json(t, `/api/session/${session}/diff${diffQuery(s.turnIds)}`);
        if (t.closed || !t.st.sessions.has(session)) return;
        const r = onDiff(t.st, session, body, t.ctx);
        if (r?.changed) t.sender.schedule();
      } while (slot.again);
    } finally {
      t.fetching.delete(session);
    }
  }
}

/** Response text, or null when it is bigger than `max` (read incrementally: a hostile server cannot make us buffer more). */
async function readCapped(r: Response, max: number): Promise<string | null> {
  if (!r.body) return null;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let n = 0;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as { done: true; value: undefined });
    if (done) return out + dec.decode();
    n += value!.length;
    if (n > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    out += dec.decode(value, { stream: true });
  }
}
