// Integrated terminal, main-process side: owns the PTYs (node-pty; ConPTY on Windows).
//  - per-window ownership: only the webContents that spawned a terminal may talk to it;
//  - output is coalesced (~16 ms / 64 K chars per flush) so a chatty process costs one IPC message
//    per frame, and flow-controlled by renderer acks (pause the PTY while xterm.js catches up);
//  - every argument is validated (shell by id only — never a path —, cwd inside the workspace,
//    cols/rows ranges, write size, terminal counts);
//  - no orphans: killing a terminal signals its whole process group (Unix) / tree (Windows), with
//    a hard kill fallback; window close/reload, folder switch and app quit kill what they own.
// node-pty is loaded lazily on first use: zero cost at app launch.
import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { execFile, spawn as spawnChild } from 'node:child_process';
import { BackendFailure } from '../backend/errors';
import { isInsideDir, resolveInside } from '../backend/pathsafe';
import {
  TERMINAL_ACK_HIGH,
  TERMINAL_ACK_LOW,
  TERMINAL_CHANNELS as CH,
  TERMINAL_FLUSH_CHARS,
  TERMINAL_FLUSH_MS,
  TERMINAL_LIMITS,
  type ClaudeInfo,
  type ShellInfo,
  type ShellList,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalLimits,
  type TerminalReply,
  type TerminalSpawnResult,
} from '../shared/terminal';
import { claudeHint, claudeInstall, detectClaude, detectShells, pathFor, pickDefaultShell, planClaude, planSpawn, windowsBuildOf, type DetectEnv } from './terminal-shells';

// ---------------------------------------------------------------- node-pty surface we use

export interface Disposable {
  dispose(): void;
}
export interface PtyLike {
  readonly pid: number;
  onData(cb: (data: string) => void): Disposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): Disposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  pause(): void;
  resume(): void;
}
export interface PtyModuleLike {
  spawn(file: string, args: string[] | string, opts: Record<string, unknown>): PtyLike;
}

/**
 * Packaged builds load node-pty from app.asar.unpacked by its real path: its Windows ConPTY output
 * worker and console-list agent are started from __dirname-relative paths that must be real files
 * (node-pty only rewrites `node_modules.asar`, not `app.asar`). Needs `external: ['node-pty']` in esbuild.
 */
export function loadNodePty(o: { packaged: boolean; resourcesPath?: string; require?: (id: string) => unknown }): PtyModuleLike {
  const req = o.require ?? require;
  if (o.packaged && o.resourcesPath) return req(path.join(o.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty')) as PtyModuleLike;
  return req('node-pty') as PtyModuleLike;
}

/** Real OS access for shell detection. */
export function nodeDetectEnv(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): DetectEnv {
  return {
    platform,
    env,
    exists: (p) => fsp.access(p).then(
      () => true,
      () => false,
    ),
    readdir: (p) => fsp.readdir(p),
    run: (file, args, timeoutMs) =>
      new Promise((resolve) => {
        execFile(file, args, { encoding: 'buffer', timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null) : 0;
          resolve({ code, stdout: stdout ?? new Uint8Array() });
        });
      }),
  };
}

// ---------------------------------------------------------------- environment

// The app's own configuration (test hooks, dev server, Electron/Chromium switches, npm script context)
// must not leak into the user's shell. ELECTRON_RUN_AS_NODE in particular would turn every Electron
// app started from the terminal into a bare Node.
const STRIP_ENV = /^(SEC_EDIT_|ELECTRON_|VITE_|CHROME_|npm_|INIT_CWD$|ORIGINAL_XDG_CURRENT_DESKTOP$)/;

export function buildTerminalEnv(base: Record<string, string | undefined>, o: { platform: string; appVersion?: string; extra?: Record<string, string> }): Record<string, string> {
  const win = o.platform === 'win32';
  const strip = win ? new RegExp(STRIP_ENV.source, 'i') : STRIP_ENV;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && !strip.test(k)) out[k] = v;
  const set = (k: string, v: string) => {
    // Windows env names are case-insensitive: never leave both "Term" and "TERM" in the block.
    if (win) for (const x of Object.keys(out)) if (x !== k && x.toLowerCase() === k.toLowerCase()) delete out[x];
    out[k] = v;
  };
  // Electron overrides XDG_CURRENT_DESKTOP on some Linux desktops and keeps the user's value here.
  if (base.ORIGINAL_XDG_CURRENT_DESKTOP) set('XDG_CURRENT_DESKTOP', base.ORIGINAL_XDG_CURRENT_DESKTOP);
  set('TERM', 'xterm-256color');
  set('COLORTERM', 'truecolor');
  set('TERM_PROGRAM', 'sec-edit');
  if (o.appVersion) set('TERM_PROGRAM_VERSION', o.appVersion);
  // Apps started from Finder get no locale: UTF-8 tools then print '?' for every non-ASCII char.
  if (o.platform === 'darwin' && !out.LANG) set('LANG', 'en_US.UTF-8');
  for (const [k, v] of Object.entries(o.extra ?? {})) set(k, v);
  return out;
}

// ---------------------------------------------------------------- validation

const fail = (code: string, message: string) => new BackendFailure(code, message);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const SHELL_ID = /^[\w.:-]{1,80}$/;

export interface ParsedSpawn {
  shellId?: string;
  preset?: 'claude';
  prefer?: string;
  cwd: string;
  cols: number;
  rows: number;
}

export function parseSpawnRequest(raw: unknown, l: TerminalLimits = TERMINAL_LIMITS): ParsedSpawn {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw fail('EINVAL', 'Bad terminal request');
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.shellId !== undefined && (typeof r.shellId !== 'string' || !SHELL_ID.test(r.shellId))) throw fail('EINVAL', 'Bad shell id');
  if (r.cwd !== undefined && (typeof r.cwd !== 'string' || r.cwd.length > 4096 || r.cwd.includes('\0'))) throw fail('EINVAL', 'Bad folder');
  if (r.preset !== undefined && r.preset !== 'claude') throw fail('EINVAL', 'Bad preset');
  if (r.prefer !== undefined && (typeof r.prefer !== 'string' || !(r.prefer === '' || SHELL_ID.test(r.prefer)))) throw fail('EINVAL', 'Bad shell id');
  const dim = (v: unknown, def: number, min: number, max: number, what: string) => {
    if (v === undefined) return def;
    if (!isInt(v) || v < min || v > max) throw fail('EINVAL', `Bad terminal ${what}`);
    return v;
  };
  return {
    shellId: r.shellId as string | undefined,
    preset: r.preset as 'claude' | undefined,
    prefer: (r.prefer as string | undefined) || undefined,
    cwd: (r.cwd as string | undefined) ?? '',
    cols: dim(r.cols, 80, l.minCols, l.maxCols, 'width'),
    rows: dim(r.rows, 24, l.minRows, l.maxRows, 'height'),
  };
}

export interface CwdFs {
  stat(p: string): Promise<{ isDirectory(): boolean }>;
  realpath(p: string): Promise<string>;
}

/** Workspace-relative folder → absolute, refusing anything that is not a folder inside the workspace
 *  (also through symlinks: a link inside the workspace pointing at C:\ is outside). */
const realRoots = new Map<string, Promise<string | null>>();
/** Workspace root's realpath, once per root (and per fs, so tests with fakes stay isolated). */
function realRootOf(root: string, fsx: CwdFs): Promise<string | null> {
  if (fsx !== fsp) return fsx.realpath(root).catch(() => null);
  let p = realRoots.get(root);
  if (!p) {
    p = fsp.realpath(root).catch(() => null);
    if (realRoots.size > 16) realRoots.clear();
    realRoots.set(root, p);
  }
  return p;
}

export async function resolveTerminalCwd(root: string, rel: string, o: { platform: string; fs?: CwdFs }): Promise<{ abs: string; rel: string }> {
  const P = pathFor(o.platform);
  const win = o.platform === 'win32';
  const fold = o.platform !== 'linux';
  const fsx = o.fs ?? fsp;
  // resolveInside clamps '..' at the root; for a start folder say "no" instead of silently using the root.
  if (/^([\\/]|[a-z]:)/i.test(rel)) throw fail('EINVAL', 'The folder must be workspace-relative');
  let depth = 0;
  for (const seg of rel.split(/[\\/]+/)) {
    if (seg === '..') depth--;
    else if (seg && seg !== '.') depth++;
    if (depth < 0) throw fail('OUTSIDE_WORKSPACE', 'Folder is outside the workspace');
  }
  const abs = rel ? resolveInside(root, rel, P, win) : P.resolve(root);
  // The workspace root itself was validated when the folder was opened: no file-system round trip on the
  // usual path (the first stat + realpaths queued ~20 ms behind other start-up I/O on libuv's pool).
  if (abs === P.resolve(root)) return { abs, rel: '' };
  const st = await fsx.stat(abs).catch(() => null);
  if (!st || !st.isDirectory()) throw fail('ENOENT', `Not a folder: ${rel || '.'}`);
  // realpath may be unsupported on some network shares: the lexical check above still holds then.
  const [realRoot, real] = await Promise.all([realRootOf(root, fsx), fsx.realpath(abs).catch(() => null)]);
  if (realRoot && real && !isInsideDir(real, realRoot, P, fold)) throw fail('OUTSIDE_WORKSPACE', 'Folder is outside the workspace');
  const back = P.relative(P.resolve(root), abs);
  return { abs, rel: back.split(P.sep).filter(Boolean).join('/') };
}

// ---------------------------------------------------------------- service

interface Term {
  id: number;
  owner: number;
  root: string;
  pty: PtyLike;
  shell: ShellInfo;
  pending: string;
  unacked: number;
  paused: boolean;
  killing: boolean;
  exited: boolean;
  timers: NodeJS.Timeout[];
  subs: Disposable[];
}

export type TerminalSink = (owner: number, channel: typeof CH.data | typeof CH.exit, payload: TerminalDataEvent[] | TerminalExitEvent) => void;

export interface TerminalServiceOptions {
  /** Loads node-pty (called on the first spawn only). */
  loadPty: () => PtyModuleLike;
  getWorkspaceRoot: () => string | null;
  platform?: string;
  env?: Record<string, string | undefined>;
  appVersion?: string;
  /** Shell detection (default: the real machine). Cached until listShells(true). */
  detect?: () => Promise<ShellInfo[]>;
  /** Claude Code detection, natively or inside a WSL distro (default: the real machine). */
  detectClaude?: (wsl: { exe: string; distro: string } | null) => Promise<ClaudeInfo>;
  limits?: Partial<TerminalLimits>;
  flushMs?: number;
  flushChars?: number;
  ackHigh?: number;
  ackLow?: number;
  /** Grace period between the polite kill (SIGHUP / ConPTY close) and the hard one. */
  killGraceMs?: number;
  /** Windows: bundled conpty.dll + OpenConsole.exe instead of the inbox ConPTY. */
  useConptyDll?: boolean;
  windowsBuild?: number;
  fs?: CwdFs;
  /** Unix: signal a whole process group (default process.kill(-pgid)). */
  signalGroup?: (pgid: number, signal: NodeJS.Signals) => void;
  /** Windows: kill a process tree, outliving this process (default: detached `taskkill /T /F`). */
  treeKill?: (pid: number) => void;
}

export class TerminalService {
  private readonly o: TerminalServiceOptions;
  private readonly limits: TerminalLimits;
  private readonly platform: string;
  private readonly terms = new Map<number, Term>();
  private readonly reserved = new Map<number, number>(); // owner → spawns in flight
  private readonly dirty = new Set<Term>();
  private readonly sinks = new Set<TerminalSink>();
  private flushTimer: NodeJS.Timeout | null = null;
  private shellsP: Promise<ShellInfo[]> | null = null;
  private readonly claudeP = new Map<string, Promise<ClaudeInfo>>(); // by WSL distro ('' = native)
  private ptyMod: PtyModuleLike | null = null;
  private nextId = 1;
  private disposed = false;

  constructor(o: TerminalServiceOptions) {
    this.o = o;
    this.platform = o.platform ?? process.platform;
    this.limits = { ...TERMINAL_LIMITS, ...o.limits };
  }

  /** Output events (data batches, exits). Returns an unsubscribe function. */
  onOutput(sink: TerminalSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  count(owner?: number): number {
    if (owner === undefined) return this.terms.size;
    let n = 0;
    for (const t of this.terms.values()) if (t.owner === owner) n++;
    return n;
  }

  /** Live terminal pids (tests / diagnostics). */
  pids(): number[] {
    return [...this.terms.values()].map((t) => t.pty.pid);
  }

  /** Detected shells (cached; detection runs once, e.g. prefetched on idle, then node-pty is preloaded too). */
  private detected(refresh = false): Promise<ShellInfo[]> {
    if (refresh || !this.shellsP) {
      // E2E only (needs SEC_EDIT_TEST too): show a fixed profile list, e.g. Windows profiles in screenshots on Linux.
      const injected = process.env.SEC_EDIT_TEST ? process.env.SEC_EDIT_TEST_SHELLS : undefined;
      const detect = this.o.detect ?? (injected ? async () => JSON.parse(injected) as ShellInfo[] : () => detectShells(nodeDetectEnv(this.o.env ?? process.env, this.platform)));
      this.claudeP.clear();
      const p = detect();
      this.shellsP = p.catch((err) => {
        this.shellsP = null; // retry next time
        throw err;
      });
      // The first spawn should not pay for loading the native module either.
      void p.then(() => setTimeout(() => !this.disposed && this.tryLoadPty(), 0)).catch(() => {});
    }
    return this.shellsP;
  }

  /**
   * Shells on this machine (+ whether Claude Code is there when `withClaude`: that lookup may start a WSL
   * distro, so nothing on the open path waits for it). `prefer` = the renderer's default-shell setting:
   * when that (or the automatic default) is a WSL distro, Claude is looked up inside it.
   */
  async listShells(refresh = false, prefer?: unknown, withClaude = false): Promise<ShellList> {
    const shells = await this.detected(refresh);
    const win = this.platform === 'win32';
    const defaultId = pickDefaultShell(shells, { platform: this.platform, root: this.o.getWorkspaceRoot() });
    const preferred = shells.find((s) => s.id === prefer) ?? shells.find((s) => s.id === defaultId);
    return {
      shells,
      defaultId,
      claude: withClaude ? await this.claude(win && preferred?.kind === 'wsl' ? preferred : null) : undefined,
      platform: this.platform,
      windowsBuild: this.windowsBuild(),
    };
  }

  private windowsBuild() {
    return this.platform === 'win32' ? (this.o.windowsBuild ?? windowsBuildOf(os.release())) : undefined;
  }

  private tryLoadPty() {
    try {
      this.loadPty();
    } catch {} // reported by the first spawn
  }

  private claude(wslShell: ShellInfo | null): Promise<ClaudeInfo> {
    const key = wslShell?.id ?? '';
    let p = this.claudeP.get(key);
    if (!p) {
      const wsl = wslShell ? { exe: wslShell.path, distro: wslShell.id.slice(4) } : null;
      const detect = this.o.detectClaude ?? ((w) => detectClaude(nodeDetectEnv(this.o.env ?? process.env, this.platform), { wsl: w }));
      p = detect(wsl).catch(() => ({ available: false, hint: claudeHint(this.platform, !!wsl), install: claudeInstall(this.platform, !!wsl) }));
      this.claudeP.set(key, p);
    }
    return p;
  }

  async spawn(owner: number, raw: unknown): Promise<TerminalSpawnResult> {
    if (this.disposed) throw fail('EIO', 'Shutting down');
    const req = parseSpawnRequest(raw, this.limits);
    const root = this.o.getWorkspaceRoot();
    if (!root) throw fail('NO_WORKSPACE', 'Open a folder to use the terminal');
    this.reserve(owner); // counts against the caps while we await detection / the folder check
    try {
      const list = await this.listShells(false, req.shellId ?? req.prefer, req.preset === 'claude');
      const shellId = req.shellId ?? (req.prefer && list.shells.some((s) => s.id === req.prefer) ? req.prefer : list.defaultId);
      let shell = list.shells.find((s) => s.id === shellId);
      if (!shell && !(req.preset && !req.shellId)) throw fail('EINVAL', shellId ? `Unknown shell: ${shellId}` : 'No shell found on this computer');
      const claude = req.preset === 'claude' ? list.claude : null;
      if (claude && !claude.available) throw fail('ENOENT', claude.hint ?? 'Claude Code is not installed');
      const cwd = await resolveTerminalCwd(root, req.cwd, { platform: this.platform, fs: this.o.fs });
      // The folder may have changed while we awaited: never start a shell in the previous one.
      if (this.o.getWorkspaceRoot() !== root) throw fail('NO_WORKSPACE', 'The folder changed');
      if (this.disposed) throw fail('EIO', 'Shutting down');
      const env = this.o.env ?? process.env;
      let plan;
      if (claude) {
        plan = planClaude(claude, cwd.abs, { platform: this.platform, env, wslExe: claude.via === 'wsl' ? shell?.path : undefined });
        shell = { id: 'claude', name: 'Claude Code', kind: 'claude', path: claude.path ?? plan.file, args: [], detail: claude.via === 'wsl' ? `AI assistant · in ${claude.distro} (WSL)` : 'AI assistant in this folder' };
      } else plan = planSpawn(shell!, cwd.abs, { platform: this.platform, env });
      const pty = this.loadPty().spawn(plan.file, plan.args, {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: plan.cwd,
        env: buildTerminalEnv(env, { platform: this.platform, appVersion: this.o.appVersion, extra: plan.env }),
        useConpty: true,
        useConptyDll: !!this.o.useConptyDll,
      });
      const t: Term = { id: this.nextId++, owner, root, pty, shell: shell!, pending: '', unacked: 0, paused: false, killing: false, exited: false, timers: [], subs: [] };
      this.terms.set(t.id, t);
      t.subs.push(
        pty.onData((d) => this.onData(t, d)),
        pty.onExit((e) => this.finish(t, e)),
      );
      return { id: t.id, pid: pty.pid, shell: shell!, cwd: cwd.rel, windowsBuild: this.windowsBuild() };
    } finally {
      this.release(owner);
    }
  }

  write(owner: number, id: unknown, data: unknown): boolean {
    const t = this.own(owner, id);
    if (!t || t.killing || typeof data !== 'string' || !data || data.length > this.limits.maxWriteChars) return false;
    try {
      t.pty.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(owner: number, id: unknown, cols: unknown, rows: unknown): boolean {
    const t = this.own(owner, id);
    const l = this.limits;
    if (!t || t.killing || !isInt(cols) || !isInt(rows) || cols < l.minCols || cols > l.maxCols || rows < l.minRows || rows > l.maxRows) return false;
    try {
      t.pty.resize(cols, rows);
      return true;
    } catch {
      return false; // ConPTY throws once the process has exited
    }
  }

  /** The renderer has parsed `chars` more characters of output. */
  ack(owner: number, id: unknown, chars: unknown): void {
    const t = this.own(owner, id);
    if (!t || !isInt(chars) || chars <= 0) return;
    t.unacked = Math.max(0, t.unacked - chars);
    if (t.paused && t.unacked < (this.o.ackLow ?? TERMINAL_ACK_LOW)) {
      t.paused = false;
      try {
        t.pty.resume();
      } catch {}
    }
  }

  kill(owner: number, id: unknown): boolean {
    const t = this.own(owner, id);
    if (!t) return false;
    this.terminate(t, false);
    return true;
  }

  /** Window closed / reloaded / crashed. */
  killOwner(owner: number): void {
    for (const t of [...this.terms.values()]) if (t.owner === owner) this.terminate(t, false);
  }

  /** Another folder was opened: shells started in the previous one go. */
  setWorkspace(root: string | null): void {
    for (const t of [...this.terms.values()]) if (t.root !== root) this.terminate(t, false);
  }

  /** App quit: kill everything now (the tree kill on Windows outlives us). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of [...this.terms.values()]) this.terminate(t, true);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  // ---- internals

  private loadPty(): PtyModuleLike {
    if (this.ptyMod) return this.ptyMod;
    try {
      return (this.ptyMod = this.o.loadPty());
    } catch (err) {
      throw fail('EIO', `Terminal support failed to load: ${(err as Error)?.message ?? err}`);
    }
  }

  private own(owner: number, id: unknown): Term | null {
    if (!isInt(id)) return null;
    const t = this.terms.get(id);
    return t && t.owner === owner && !t.exited ? t : null;
  }

  private reserve(owner: number) {
    const mine = this.count(owner) + (this.reserved.get(owner) ?? 0);
    let all = this.terms.size;
    for (const n of this.reserved.values()) all += n;
    if (mine >= this.limits.maxPerOwner || all >= this.limits.maxTotal) throw fail('ELIMIT', `Too many terminals (max ${Math.min(this.limits.maxPerOwner, this.limits.maxTotal)})`);
    this.reserved.set(owner, (this.reserved.get(owner) ?? 0) + 1);
  }

  private release(owner: number) {
    const n = (this.reserved.get(owner) ?? 1) - 1;
    if (n > 0) this.reserved.set(owner, n);
    else this.reserved.delete(owner);
  }

  private onData(t: Term, d: string) {
    if (t.exited) return;
    t.pending += d;
    if (t.pending.length >= (this.o.flushChars ?? TERMINAL_FLUSH_CHARS)) return this.flushOwner(t.owner);
    this.dirty.add(t);
    this.flushTimer ??= setTimeout(() => this.flushAll(), this.o.flushMs ?? TERMINAL_FLUSH_MS);
  }

  private flushAll() {
    this.flushTimer = null;
    const owners = new Set([...this.dirty].map((t) => t.owner));
    for (const o of owners) this.flushOwner(o);
  }

  /** One message per window with everything pending (keeps cross-terminal order). */
  private flushOwner(owner: number) {
    const batch: TerminalDataEvent[] = [];
    for (const t of [...this.dirty, ...this.terms.values()]) {
      if (t.owner !== owner || !t.pending) continue;
      batch.push({ id: t.id, data: t.pending });
      t.unacked += t.pending.length;
      t.pending = '';
      this.dirty.delete(t);
      if (!t.paused && !t.exited && t.unacked > (this.o.ackHigh ?? TERMINAL_ACK_HIGH)) {
        t.paused = true;
        try {
          t.pty.pause();
        } catch {}
      }
    }
    if (batch.length) this.emit(owner, CH.data, batch);
  }

  private emit(owner: number, channel: typeof CH.data | typeof CH.exit, payload: TerminalDataEvent[] | TerminalExitEvent) {
    for (const s of this.sinks) {
      try {
        s(owner, channel, payload);
      } catch (err) {
        console.error('[terminal] sink failed', err);
      }
    }
  }

  private finish(t: Term, e: { exitCode: number; signal?: number }) {
    if (t.exited) return;
    this.flushOwner(t.owner); // output first, then the exit
    t.exited = true;
    t.timers.forEach(clearTimeout);
    t.subs.forEach((s) => {
      try {
        s.dispose();
      } catch {}
    });
    this.terms.delete(t.id);
    this.dirty.delete(t);
    const exit: TerminalExitEvent = { id: t.id, exitCode: isInt(e?.exitCode) ? e.exitCode : -1 };
    if (e?.signal) exit.signal = e.signal;
    this.emit(t.owner, CH.exit, exit);
  }

  private signalGroup(pid: number, sig: NodeJS.Signals) {
    try {
      (this.o.signalGroup ?? ((g, s) => process.kill(-g, s)))(pid, sig);
    } catch {} // ESRCH: already gone
  }

  private treeKill(pid: number) {
    try {
      (this.o.treeKill ?? defaultTreeKill)(pid);
    } catch {}
  }

  private terminate(t: Term, quitting: boolean) {
    if (t.exited) return;
    if (t.killing && !quitting) return;
    t.killing = true;
    const win = this.platform === 'win32';
    const pid = t.pty.pid;
    if (win) {
      // At quit node-pty's own cleanup (an async console-process-list agent) would die with us.
      if (quitting) this.treeKill(pid);
      try {
        t.pty.kill();
      } catch {}
    } else {
      // node-pty makes the shell a session + process-group leader: the group holds its jobs.
      this.signalGroup(pid, 'SIGHUP');
      try {
        t.pty.kill('SIGHUP');
      } catch {}
    }
    if (quitting) return;
    const grace = this.o.killGraceMs ?? 2000;
    const hard = setTimeout(() => {
      if (t.exited) return;
      if (win) this.treeKill(pid);
      else {
        this.signalGroup(pid, 'SIGKILL');
        try {
          t.pty.kill('SIGKILL');
        } catch {}
      }
      // Some ConPTY failures never report an exit: don't keep a zombie entry (and its slot) forever.
      const last = setTimeout(() => this.finish(t, { exitCode: -1 }), 1000);
      last.unref?.();
      t.timers.push(last);
    }, grace);
    hard.unref?.();
    t.timers.push(hard);
  }
}

function defaultTreeKill(pid: number) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const child = spawnChild(path.win32.join(sysRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { windowsHide: true, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

// ---------------------------------------------------------------- IPC

/** The parts of Electron's ipcMain / WebContents we use (fakes in tests). */
export interface IpcMainLike {
  handle(channel: string, fn: (e: IpcEventLike, ...args: unknown[]) => unknown): void;
  on(channel: string, fn: (e: IpcEventLike, ...args: unknown[]) => void): void;
}
export interface SenderLike {
  readonly id: number;
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  once(event: string, fn: (...args: unknown[]) => void): unknown;
}
export interface IpcEventLike {
  sender: SenderLike;
}

const reply = async <T>(fn: () => Promise<T> | T): Promise<TerminalReply<T>> => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    const code = err instanceof BackendFailure ? err.code : (err as { code?: string })?.code || 'EIO';
    return { ok: false, error: { code: String(code), message: String((err as Error)?.message ?? err) } };
  }
};

/**
 * Registers the `term:*` channels. `isTrusted` is main.ts's trustedSender (our own UI in the main frame);
 * anything else gets EACCES / is ignored. A window's terminals die with its page (close, reload, crash).
 */
export function registerTerminalIpc(ipc: IpcMainLike, svc: TerminalService, o: { isTrusted: (e: IpcEventLike) => boolean }): () => void {
  const senders = new Map<number, SenderLike>();
  const track = (s: SenderLike) => {
    if (senders.has(s.id)) return;
    senders.set(s.id, s);
    const gone = () => svc.killOwner(s.id);
    s.once('destroyed', () => {
      gone();
      senders.delete(s.id);
    });
    s.on('render-process-gone', gone);
    s.on('did-navigate', gone); // reload: the new page knows nothing about the old shells
  };
  const off = svc.onOutput((owner, channel, payload) => {
    const s = senders.get(owner);
    if (s && !s.isDestroyed()) s.send(channel, payload);
  });
  const denied: TerminalReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };

  ipc.handle(CH.shells, (e, refresh, prefer, withClaude) => (o.isTrusted(e) ? reply(() => svc.listShells(refresh === true, typeof prefer === 'string' && SHELL_ID.test(prefer) ? prefer : undefined, withClaude === true)) : denied));
  ipc.handle(CH.spawn, (e, req) => {
    if (!o.isTrusted(e)) return denied;
    track(e.sender);
    return reply(() => svc.spawn(e.sender.id, req));
  });
  ipc.handle(CH.kill, (e, id) => (o.isTrusted(e) ? reply(() => svc.kill(e.sender.id, id)) : denied));
  ipc.on(CH.write, (e, id, data) => void (o.isTrusted(e) && svc.write(e.sender.id, id, data)));
  ipc.on(CH.resize, (e, id, cols, rows) => void (o.isTrusted(e) && svc.resize(e.sender.id, id, cols, rows)));
  ipc.on(CH.ack, (e, id, chars) => void (o.isTrusted(e) && svc.ack(e.sender.id, id, chars)));
  return off;
}
