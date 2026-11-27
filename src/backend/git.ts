// Read-only git service (tier 1): status, branch, file content at HEAD, diff, and a cheap `.git` watcher.
// Runs the user's own `git` executable, so their config, SSH keys and credential manager apply.
//
// Safety rules (nothing here may mutate a repository or run repository-supplied programs):
//  - only read commands; GIT_OPTIONAL_LOCKS=0 so `status` never rewrites the index (→ no index hooks).
//    One exception, opt-out (`git.refreshIndex`): refreshIndex() re-records file timestamps in the index
//    (`update-index --refresh`, hooks off, never while index.lock exists, never killed);
//  - `core.fsmonitor` is forced off and every configured filter driver is neutralised (all config scopes,
//    worktree config and includes; only canonical Git LFS stays): a downloaded folder with a hostile
//    `.git/config` must not get code execution by being opened. A driver name `-c` cannot address (`=`) means
//    no git; an included config file or (onbranch include) HEAD that changed since means a new discovery;
//  - `diff` runs with --no-ext-diff --no-textconv;
//  - git is resolved to an absolute path ourselves: Windows' search order would otherwise run a `git.exe`
//    sitting in the (untrusted) workspace folder;
//  - every renderer-supplied path goes through the workspace containment rules (pathsafe.resolveInside);
//  - timeouts + output caps on every call; no terminal prompts.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  GIT_REV_RE,
  GIT_TIMEOUT_TEXT,
  type GitActionResult,
  type GitBranch,
  type GitBranchDetails,
  type GitBranchList,
  type GitRemoteBranchPage,
  type GitCommitFiles,
  type GitJobError,
  type GitJobTag,
  type GitLogPage,
  type GitEntry,
  type GitFileState,
  type GitHeadFile,
  type GitNumstatRow,
  type GitRepoState,
  type GitStatus,
  type GitStatusResult,
  type GitUnavailable,
  type GitFileHunks,
  type GitHunkPick,
  type GitWholeFileReason,
} from '../shared/git';
import { DETAIL_FORMAT, LOCAL_BRANCH_FORMAT, LOG_FORMAT, TRACE2_ENV, gitMessage, isAuthError, parseDetails, parseLocalBranches, parseLog, parseNameStatus, parseRemoteRefs, splitTrace2, terminalCommand } from './git-ops';
import { gitSubcommand, logGitActivity } from './git-activity';
import { parseNumstat } from './git-numstat';
import { buildPatch, composeBlocks, hunksForPicks, parseFileRecord, parseZeroDiff, type Block, type ParsedZeroDiff } from './git-hunks';
import { WslGit, parseNetUse, parseWslPath, resolveMappedDrive, toUncPath, type WslPath } from './git-wsl';

let netUse: Promise<Map<string, string>> | null = null;
/** Drive letters mapped to network shares (`net use`), once per process. */
function mappedDrives(): Promise<Map<string, string>> {
  netUse ??= run(winSystemExe('net.exe'), ['use'], { cwd: undefined, env: process.env, timeoutMs: 5000, maxBytes: 256 * 1024, quiet: true }).then(
    (r) => (r.code === 0 ? parseNetUse(r.stdout.toString('utf8')) : new Map()),
    () => new Map(),
  );
  return netUse;
}
import { normalize } from '../shared/paths';
import { BackendFailure } from './errors';
import { isInsideDir, resolveInside } from './pathsafe';
import { decode, toLf } from './textcodec';
import { winSystemExe } from './winsys';

type PlatformPath = typeof path.posix;

/** Blobs above this are not diffed in the renderer. */
export const GIT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
export const GIT_MAX_ENTRIES = 50_000;
const MIN_VERSION: [number, number] = [2, 18]; // porcelain v2, --absolute-git-dir, --ignored=matching
const T_QUICK = 5_000;
/**
 * The first git processes for a folder (`--version`, `rev-parse`, the filter config): they pay what a
 * first launch can cost (macOS: the `/usr/bin/git` shim, a folder-permission prompt that holds file
 * access until it is answered, a security scan of the binary; Windows: Defender), and their outcome is
 * remembered for the folder. Only the git UI waits on them, so they get more time than the small
 * commands that follow; a miss is not final (GitMonitor looks again on Retry / window focus).
 */
const T_DISCOVER = 15_000;
const T_STATUS = 20_000;
const T_READ = 10_000;
/** Status output is parsed in slices this big when it arrives all at once. */
const FEED_SLICE = 256 * 1024;
/** Background lists (branches / history / commit files): generous, but visible when exceeded. */
const T_LOW = 20_000;
/** Background git processes at a time: a slow `git log` can never fan out over status / diffs. */
const LOW_CONCURRENCY = 1;
/** Branch rows at most (most recently committed first). */
export const BRANCH_CAP = 5000;
/** Negative discovery results (not a repo yet) are re-checked after this. */
const NEGATIVE_TTL_MS = 3_000;

// ---- locating git ---------------------------------------------------------------------------

/** Case-insensitive env lookup (Windows env objects copied out of process.env lose that property). */
function envGet(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const k = Object.keys(env).find((n) => n.toUpperCase() === key.toUpperCase());
  return k ? env[k] : undefined;
}

/**
 * Absolute candidate paths for the git executable, in preference order. Pure (tested with win32 rules
 * on Linux). Relative PATH entries are skipped: they would resolve against the workspace folder.
 */
export function gitCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const win = platform === 'win32';
  const p: PlatformPath = win ? path.win32 : path.posix;
  const out: string[] = [];
  const add = (f: string | null | undefined) => {
    if (f && p.isAbsolute(f) && !out.some((o) => (win ? o.toLowerCase() === f.toLowerCase() : o === f))) out.push(f);
  };
  const dirs = (envGet(env, 'PATH') ?? '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1'));
  // Only real executables: spawning git.cmd / git.bat would need a shell (and its quoting rules).
  for (const d of dirs) if (d && p.isAbsolute(d)) add(p.join(d, win ? 'git.exe' : 'git'));
  if (win) {
    for (const base of [envGet(env, 'ProgramW6432'), envGet(env, 'ProgramFiles'), envGet(env, 'ProgramFiles(x86)')]) if (base) add(p.join(base, 'Git', 'cmd', 'git.exe'));
    const local = envGet(env, 'LOCALAPPDATA');
    if (local) add(p.join(local, 'Programs', 'Git', 'cmd', 'git.exe'));
    const home = envGet(env, 'USERPROFILE');
    if (home) {
      add(p.join(home, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'));
      add(p.join(home, 'scoop', 'shims', 'git.exe'));
    }
    add('C:\\Program Files\\Git\\cmd\\git.exe');
  } else {
    // GUI apps on macOS start with a minimal PATH: try the usual install locations too.
    for (const f of ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']) add(f);
  }
  return out;
}

export interface GitExecutable {
  path: string;
  version: [number, number, number];
}

export function parseGitVersion(out: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(out);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

const atLeast = (v: [number, number, number], major: number, minor: number) => v[0] > major || (v[0] === major && v[1] >= minor);

const exeCache = new Map<string, { at: number; p: Promise<GitExecutable | null | 'timeout'> }>();

interface LocateOptions {
  gitPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Tests only (GitServiceOptions.timeouts.discover); default T_DISCOVER. */
  timeoutMs?: number;
}

/** First working git (cached; a miss is retried after a minute, in case git was just installed). */
export function locateGit(opts: LocateOptions = {}): Promise<GitExecutable | null> {
  return findGit(opts).then((r) => (r === 'timeout' ? null : r));
}

/**
 * locateGit, plus 'timeout': no candidate answered and one ran out of time (a cold start, a security scan).
 * That is not "no git" and is never remembered: the next look asks again (10-decisions: first look at git).
 */
function findGit(opts: LocateOptions): Promise<GitExecutable | null | 'timeout'> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const key = `${opts.gitPath ?? ''}\u0000${platform}\u0000${envGet(env, 'PATH') ?? ''}`;
  const hit = exeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = (async () => {
    const list = opts.gitPath ? [opts.gitPath] : gitCandidates(platform, env);
    let timedOut = false;
    for (const cand of list) {
      if (!opts.gitPath && !(await isFile(cand))) continue;
      const r = await run(cand, ['--version'], { cwd: undefined, env: gitEnv(env), timeoutMs: opts.timeoutMs ?? T_DISCOVER, maxBytes: 4096 });
      const v = r.code === 0 ? parseGitVersion(r.stdout.toString('utf8')) : null;
      if (v && atLeast(v, ...MIN_VERSION)) return { path: cand, version: v };
      if (r.timedOut) timedOut = true;
    }
    return timedOut ? ('timeout' as const) : null;
  })();
  exeCache.set(key, { at: Date.now(), p });
  p.then((r) => {
    if (r === 'timeout') {
      if (exeCache.get(key)?.p === p) exeCache.delete(key);
    } else if (!r) exeCache.set(key, { at: Date.now() - 50_000, p }); // misses expire sooner
  });
  return p;
}

// Async (here, in hunks() and statSig()): one main process serves every window, a hung share must not freeze them all.
async function isFile(f: string): Promise<boolean> {
  try {
    return (await fsp.stat(f)).isFile();
  } catch {
    return false;
  }
}

// ---- running git ----------------------------------------------------------------------------

/** Variables that would point git at another repository than the folder we ask about. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS'];

export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // GIT_TRACE*: trace output on stderr would garble the error messages we read there.
  for (const [k, v] of Object.entries(base)) if (!REPO_ENV.includes(k.toUpperCase()) && !/^GIT_TRACE/i.test(k)) env[k] = v;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GCM_INTERACTIVE = 'never';
  env.GIT_PAGER = 'cat';
  env.LC_ALL = 'C'; // stable English messages (we sniff a few errors); paths are raw bytes with -z anyway
  return env;
}

export interface RunResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  /** Spawn failure (ENOENT: git vanished). */
  error?: NodeJS.ErrnoException;
  /** Stopped through `signal`. */
  aborted?: boolean;
}

interface RunOptions {
  cwd: string | undefined;
  env: NodeJS.ProcessEnv;
  /** 0 = no timeout, never killed (index refresh: a killed git can leave index.lock behind). */
  timeoutMs: number;
  maxBytes: number;
  /** stdin; a Buffer goes in byte for byte (patches). */
  input?: string | Buffer;
  /** POSIX: own session, no controlling terminal — ssh cannot block on a passphrase prompt in the
   *  terminal Electron was started from. Killed as a group on timeout. */
  detached?: boolean;
  /** Kills the process when aborted (cancelled background job). */
  signal?: AbortSignal;
  /** Below-normal OS priority: background lists must not steal CPU / disk from status and diffs. */
  low?: boolean;
  /** Activity log: why this run happened. */
  trigger?: string;
  /** Stream stdout here instead of collecting it (the result's stdout is then empty). */
  onChunk?: (chunk: Buffer) => void;
  /** Not logged (the caller logs it, e.g. the WSL runner). */
  quiet?: boolean;
}

export function run(git: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, overflow: false, aborted: true });
    let child: ReturnType<typeof spawn>;
    const t0 = performance.now();
    try {
      child = spawn(git, args, { cwd: o.cwd, env: o.env, windowsHide: true, detached: !!o.detached && process.platform !== 'win32', stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error: any) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, overflow: false, error });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    let error: NodeJS.ErrnoException | undefined;
    let aborted = false;
    const kill = () => {
      try {
        if (o.detached && process.platform !== 'win32' && child.pid) process.kill(-child.pid);
        else child.kill();
      } catch {
        child.kill();
      }
    };
    const timer =
      o.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, o.timeoutMs)
        : undefined;
    const onAbort = () => {
      aborted = true;
      kill();
    };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.low && child.pid) {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {}
    }
    child.stdout!.on('data', (c: Buffer) => {
      if (overflow) return;
      size += c.length;
      if (size > o.maxBytes) {
        overflow = true;
        chunks.length = 0;
        child.kill();
      } else if (o.onChunk) o.onChunk(c);
      else chunks.push(c);
    });
    child.stderr!.on('data', (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString('utf8'); // status: ~8 KB of trace2 events
    });
    child.on('error', (e) => (error = e));
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      if (!o.quiet) logGitActivity({ kind: gitSubcommand(args), trigger: o.trigger, ms: Math.round(performance.now() - t0), repo: o.cwd ?? '', ok: code === 0 || code === 1, at: Date.now() });
      resolve({ code, stdout: Buffer.concat(chunks), stderr, timedOut, overflow, error, ...(aborted ? { aborted } : {}) });
    });
    if (o.input !== undefined) {
      child.stdin!.on('error', () => {}); // git exited early (EPIPE)
      child.stdin!.end(o.input);
    }
  });
}

// ---- porcelain v2 ---------------------------------------------------------------------------

export interface ParsedStatus {
  branch: GitBranch;
  entries: GitEntry[];
  truncated: boolean;
}

function stateOf(xy: string): { state: GitFileState; staged: boolean; unstaged: boolean } {
  const x = xy[0] ?? '.';
  const y = xy[1] ?? '.';
  const staged = x !== '.';
  const unstaged = y !== '.';
  let state: GitFileState = 'modified';
  if (x === 'A' || x === 'C') state = y === 'D' ? 'deleted' : 'added';
  else if (x === 'D' || y === 'D') state = 'deleted';
  return { state, staged, unstaged };
}

/** Skips `n` space-separated fields; the rest is the path (which may itself contain spaces). */
function fieldsAndPath(rec: string, n: number): { f: string[]; path: string } | null {
  const f: string[] = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const j = rec.indexOf(' ', i);
    if (j === -1) return null;
    f.push(rec.slice(i, j));
    i = j + 1;
  }
  return { f, path: rec.slice(i) };
}

/**
 * `git status --porcelain=v2 -z --branch` → branch + entries with workspace-relative paths, parsed as the
 * bytes arrive (chunk by chunk: a 50k-entry status never blocks the main thread in one go).
 * Git prints paths relative to the repository root; `prefix` ("docs/" or "") is the workspace folder
 * inside the repository, entries outside it are dropped.
 */
export class PorcelainStream {
  readonly branch: GitBranch = { head: null, oid: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  readonly entries: GitEntry[] = [];
  truncated = false;
  private decoder = new StringDecoder('utf8');
  private rest = '';
  /** A rename record waits for its source path (the next NUL field); e = null: dropped (outside). */
  private awaiting: { e: GitEntry | null; renamed: boolean } | null = null;
  private readonly pre: string;

  constructor(
    prefix = '',
    private readonly maxEntries = GIT_MAX_ENTRIES,
  ) {
    this.pre = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  }

  push(chunk: Buffer | string) {
    const text = this.rest + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    const recs = text.split('\0');
    this.rest = recs.pop() ?? '';
    for (const r of recs) this.record(r);
  }

  end(): ParsedStatus {
    const tail = this.rest + this.decoder.end();
    this.rest = '';
    if (tail) this.record(tail);
    if (this.awaiting?.e) this.add(this.awaiting.e); // source missing: keep the entry
    this.awaiting = null;
    return { branch: this.branch, entries: this.entries, truncated: this.truncated };
  }

  private toWs(p: string): { path: string; dir: boolean } | null {
    const dir = p.endsWith('/');
    const clean = dir ? p.slice(0, -1) : p;
    if (!this.pre) return { path: clean, dir };
    if (clean + '/' === this.pre) return { path: '', dir }; // the workspace folder itself (untracked/ignored as a whole)
    if (!clean.startsWith(this.pre)) return null;
    return { path: clean.slice(this.pre.length), dir };
  }

  private add(e: GitEntry) {
    if (this.entries.length >= this.maxEntries) this.truncated = true;
    else this.entries.push(e);
  }

  private record(rec: string) {
    if (this.awaiting) {
      // -z: the rename source is its own field
      const { e, renamed } = this.awaiting;
      this.awaiting = null;
      if (!e) return;
      const from = this.toWs(rec);
      e.from = from ? from.path : null;
      if (renamed && e.state !== 'deleted') e.state = 'renamed';
      this.add(e);
      return;
    }
    if (!rec) return;
    const kind = rec[0];
    if (kind === '#') {
      const line = rec.replace(/\r$/, '');
      const sp = line.indexOf(' ', 2);
      const key = sp === -1 ? line.slice(2) : line.slice(2, sp);
      const val = sp === -1 ? '' : line.slice(sp + 1);
      const b = this.branch;
      if (key === 'branch.oid') b.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') {
        b.detached = val === '(detached)';
        b.head = b.detached ? null : val;
      } else if (key === 'branch.upstream') b.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) [b.ahead, b.behind] = [Number(m[1]), Number(m[2])];
      }
      return;
    }
    if (rec[1] !== ' ') return; // unknown record type: be lenient
    if (kind === '?' || kind === '!') {
      const ws = this.toWs(rec.slice(2));
      if (ws) this.add({ path: ws.path, state: kind === '?' ? 'untracked' : 'ignored', ...(ws.dir ? { dir: true } : {}) });
      return;
    }
    if (kind !== '1' && kind !== '2' && kind !== 'u') return;
    const parsed = fieldsAndPath(rec, kind === '1' ? 8 : kind === '2' ? 9 : 10);
    const ws = parsed && this.toWs(parsed.path);
    const [xy, sub] = parsed ? parsed.f.slice(1, 3) : ['', ''];
    const e: GitEntry | null = ws ? { path: ws.path, ...stateOf(xy) } : null;
    if (e && kind === 'u') e.state = 'conflicted';
    if (e && sub?.[0] === 'S') {
      e.submodule = true;
      if (e.state !== 'conflicted' && e.state !== 'deleted' && e.state !== 'added') e.state = 'modified';
    }
    if (kind === '2') {
      // Consume the source field even when this entry is dropped (outside the workspace).
      this.awaiting = { e, renamed: xy[0] === 'R' };
      return;
    }
    if (e) this.add(e);
  }
}

export function parsePorcelainV2(out: string, prefix = '', maxEntries = GIT_MAX_ENTRIES): ParsedStatus {
  const s = new PorcelainStream(prefix, maxEntries);
  s.push(out);
  return s.end();
}

// ---- configured programs git would run on a read ---------------------------------------------

// Git LFS as `git lfs install` writes it (also with --skip-smudge). Exact strings only: git hands a filter
// command to `sh -c`, so a value that merely starts like LFS ("git-lfs clean -- %f; …") runs anything.
const LFS_COMMANDS: Record<string, ReadonlySet<string>> = {
  clean: new Set(['git-lfs clean -- %f']),
  smudge: new Set(['git-lfs smudge -- %f', 'git-lfs smudge --skip -- %f']),
  process: new Set(['git-lfs filter-process', 'git-lfs filter-process --skip']),
};

/**
 * `-c` overrides that neutralise every configured filter driver, from the output of
 * `git config --includes -z --get-regexp '^filter\..*\.(clean|smudge|process)$'` — the effective
 * config of ALL scopes (system, global, local, worktree `config.worktree`, includes): a folder's own
 * config can define a driver in any file git reads for it, and its `.gitattributes` picks the name.
 * Only Git LFS in its canonical spelling stays active (LFS files would otherwise look modified); a
 * driver with any other value among its commands is switched off as a whole.
 */
export function untrustedFilterOverrides(configZ: string, o: { lfsInstalled?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const [n, lfs] of filterDrivers(configZ)) if (!lfs || o.lfsInstalled === false) out.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
  return out;
}

/** Is a canonical Git LFS driver configured? (Then discovery checks that git-lfs exists: git dies on a missing `filter-process`.) */
export const hasLfsDriver = (configZ: string) => [...filterDrivers(configZ).values()].some(Boolean);

/**
 * A driver `-c` cannot switch off: git splits `-c filter.a=b.clean=` at the first `=` (it would set `filter.a`).
 * Discovery then treats the folder as "cannot tell what would run" → no git.
 */
export const unswitchableFilter = (configZ: string): string | null => [...filterDrivers(configZ).keys()].find((n) => n.includes('=')) ?? null;

/**
 * Config files whose later change makes the filter switch-offs stale, from the `--show-origin -z` listing discovery
 * reads (`file:<origin>` NUL `key` LF `value` NUL …): every file an include directive names — active or not, its
 * condition is not evaluated here (a superset) —, resolved like git does (relative to the including file, `~/` = home;
 * `%(prefix)` and includes from outside a file are skipped), plus HEAD when an `includeIf.onbranch:` exists (a branch
 * switch turns such an include on). Paths in the platform's `P` rules; `origin` maps an origin path to an absolute one.
 */
export function configWatchFiles(configZ: string, o: { P: PlatformPath; origin: (p: string) => string; home: string | null; head: string }): string[] {
  const out = new Set<string>();
  const parts = configZ.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [origin, rec] = [parts[i], parts[i + 1]];
    const nl = rec.indexOf('\n');
    const key = nl === -1 ? rec : rec.slice(0, nl);
    const value = nl === -1 ? '' : rec.slice(nl + 1);
    if (!/^include(if\..*)?\.path$/i.test(key) || !value) continue;
    if (/^includeif\.onbranch:/i.test(key)) out.add(o.head);
    let target: string | null = null;
    if (value.startsWith('~/')) target = o.home ? o.P.join(o.home, value.slice(2)) : null;
    else if (value.startsWith('%(prefix)')) target = null;
    else if (o.P.isAbsolute(value)) target = value;
    else if (origin.startsWith('file:')) target = o.P.resolve(o.P.dirname(o.origin(origin.slice(5))), value);
    if (target) out.add(target);
  }
  return [...out];
}

/** Driver name → every one of its commands is canonical Git LFS. */
function filterDrivers(configZ: string): Map<string, boolean> {
  const names = new Map<string, boolean>();
  for (const rec of configZ.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl === -1 ? rec : rec.slice(0, nl);
    const value = nl === -1 ? '' : rec.slice(nl + 1);
    const m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key);
    if (!m) continue;
    const lfs = LFS_COMMANDS[m[2].toLowerCase()].has(value);
    names.set(m[1], (names.get(m[1]) ?? true) && lfs);
  }
  return names;
}

// ---- service --------------------------------------------------------------------------------

export interface GitServiceOptions {
  /** Use exactly this executable (tests: a missing path simulates "git not installed"). */
  gitPath?: string;
  /** Environment for git (default process.env; tests isolate the user's global config). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The folder's file system folds case (probed per folder; default: the platform's usual answer). */
  foldCase?: boolean;
  /** Debounce for `.git` change notifications. */
  watchDebounceMs?: number;
  /** Timeout for background lists (branches / history / commit files). */
  lowTimeoutMs?: number;
  /** Tests: shorter time limits for the first look at a folder (`discover`) and for actions (`action`). */
  timeouts?: { discover?: number; action?: number };
  /** Repositories under \\wsl.localhost\<distro>\…: run git inside the distro ('auto', default) or not. */
  wsl?: {
    mode?: 'auto' | 'off';
    /** wsl.exe (tests: a fake). */
    exe?: string;
    /** Persistent helper (default on). */
    helper?: boolean;
    /** Linux path in the distro → path this process can open (default: the \\wsl.localhost UNC path). */
    hostPath?: (w: WslPath, linux: string) => string;
  };
}

interface ExecOptions {
  timeoutMs: number;
  maxBytes: number;
  input?: string | Buffer;
  signal?: AbortSignal;
  low?: boolean;
  trigger?: string;
  onChunk?: (chunk: Buffer) => void;
  /** Network: credential helpers may show their own window (GCM); never through the WSL helper. */
  net?: boolean;
  /** Mutating / long-running: per-call process (not the WSL helper). */
  direct?: boolean;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  /** trace2 event counters on stderr (status: how many unchanged files git had to re-read). */
  trace?: boolean;
}

/** Stale stat cache in the index, seen by the last status. */
export interface IndexHint {
  /** Unchanged files git re-read (stat data out of date); null = git did not say (old git). */
  wasted: number | null;
  ms: number;
}

export type IndexRefreshResult = { ok: true; ms: number } | { ok: false; skipped: 'locked' | 'busy' | 'unavailable' } | { ok: false; message: string };

const TRACE2_LIST = Object.entries(TRACE2_ENV).map(([k, v]) => `${k}=${v}`);

interface Repo {
  ok: true;
  git: GitExecutable;
  toplevel: string;
  /** Workspace folder inside the repo, POSIX with trailing slash, or ''. */
  prefix: string;
  gitDir: string;
  commonDir: string;
  /** Global `-c` arguments for every call. */
  base: string[];
  /** Config files (`configWatchFiles`) with their change signature at discovery: a change → discover again. */
  configSigs: Array<[file: string, sig: string]>;
}

const LF_POINTER = 'version https://git-lfs.github.com/spec/v1';
// Files whose change means "re-read status / branch". Lock files are skipped: their rename produces the real name.
const GIT_STATE_FILES = new Set(['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'FETCH_HEAD', 'packed-refs', 'config', 'config.worktree', 'rebase-merge', 'rebase-apply']);

export class GitService {
  private repoP: Promise<Repo | GitUnavailable> | null = null;
  /** When discovery last came back negative (0 = positive / pending). */
  private repoMissAt = 0;
  private statusRun: Promise<GitStatusResult> | null = null;
  private statusNext: Promise<GitStatusResult> | null = null;
  private watchers: fs.FSWatcher[] = [];
  private listeners = new Set<() => void>();
  private watchTimer: NodeJS.Timeout | null = null;
  private touched = new Set<string>();
  private sigs = new Map<string, string>();
  private watchGen = 0;
  private checkRun: Promise<void> | null = null;
  private checkNext: Promise<void> | null = null;
  private disposed = false;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  /** Path rules of the platform the paths belong to (win32 rules are tested on Linux). */
  private readonly P: PlatformPath;
  /** The workspace is inside a WSL distro (\\wsl.localhost\<distro>\…, or a drive letter mapped there). */
  wslTarget: WslPath | null;
  private wsl: WslGit | null = null;
  /** git runs inside the distro (decided at discovery; false = Windows git.exe fallback). */
  private viaWsl = false;
  /** git processes of ours running now / mutations queued or running (index refresh waits for both). */
  private inflight = 0;
  private acting = 0;
  private scan: IndexHint | null = null;
  private refreshRun: Promise<IndexRefreshResult> | null = null;

  constructor(
    readonly root: string,
    private readonly opts: GitServiceOptions = {},
  ) {
    this.platform = opts.platform ?? process.platform;
    this.P = this.platform === 'win32' ? path.win32 : path.posix;
    this.root = this.P.resolve(root);
    this.env = gitEnv(opts.env ?? process.env);
    this.wslTarget = this.platform === 'win32' && opts.wsl?.mode !== 'off' ? parseWslPath(this.root) : null;
  }

  /** How git is reached for this folder (status bar tooltip, logs). */
  get engine(): 'wsl' | 'native' {
    return this.viaWsl ? 'wsl' : 'native';
  }

  /** The one place git processes start: Windows / POSIX git, or git inside the WSL distro. */
  private exec(git: GitExecutable, args: string[], o: ExecOptions): Promise<RunResult> {
    this.inflight++;
    return this.spawnGit(git, args, o).finally(() => this.inflight--);
  }

  private spawnGit(git: GitExecutable, args: string[], o: ExecOptions): Promise<RunResult> {
    if (this.viaWsl && this.wsl && this.wslTarget) {
      const t0 = performance.now();
      return this.wsl
        .run(args, { cwd: this.wslTarget.linux, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, input: o.input, signal: o.signal, low: o.low, direct: o.direct || o.net, net: o.net, env: o.trace ? TRACE2_LIST : undefined })
        .then((r) => {
          logGitActivity({ kind: gitSubcommand(args), trigger: o.trigger ? `${o.trigger}/wsl` : 'wsl', ms: Math.round(performance.now() - t0), repo: this.root, ok: r.code === 0 || r.code === 1, at: Date.now() });
          if (o.onChunk && r.stdout.length) {
            o.onChunk(r.stdout);
            return { ...r, stdout: Buffer.alloc(0) };
          }
          return r;
        });
    }
    const env = o.env ?? (o.trace ? { ...this.env, ...TRACE2_ENV } : this.env);
    return run(git.path, args, { cwd: this.root, env, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, input: o.input, signal: o.signal, low: o.low, trigger: o.trigger, onChunk: o.onChunk, detached: o.detached });
  }

  /** WSL: git inside the distro when it has one (docker-desktop does not → Windows git). */
  private async wslGit(): Promise<GitExecutable | null> {
    // A drive letter mapped to \\wsl$\… (net use): best effort, Windows only, looked up once per process.
    if (!this.wslTarget && this.platform === 'win32' && this.opts.wsl?.mode !== 'off' && /^[A-Za-z]:[\\/]/.test(this.root) && !this.opts.wsl?.exe) {
      const unc = resolveMappedDrive(this.root, await mappedDrives());
      this.wslTarget = unc ? parseWslPath(unc) : null;
    }
    const t = this.wslTarget;
    if (!t) return null;
    this.wsl ??= new WslGit(t.distro, { exe: this.opts.wsl?.exe, helper: this.opts.wsl?.helper, env: this.opts.env ?? process.env }, (exe, args, o) =>
      run(exe, args, { cwd: undefined, env: o.env, timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, input: o.input, signal: o.signal, quiet: true }),
    );
    if (!(await this.wsl.available())) return null;
    this.viaWsl = true;
    const v = await this.wsl.run(['--version'], { cwd: t.linux, timeoutMs: T_DISCOVER, maxBytes: 4096 });
    const version = v.code === 0 ? parseGitVersion(v.stdout.toString('utf8')) : null;
    if (!version || !atLeast(version, ...MIN_VERSION)) {
      this.viaWsl = false;
      return null;
    }
    return { path: `wsl:${t.distro}`, version };
  }

  /**
   * Repository facts for the workspace (cached; re-checked when it was not a repo a moment ago, and discovered again
   * when an included config file or — with an onbranch include — HEAD changed since: the filter switch-offs in
   * `base` were worked out from that config).
   */
  private async repo(): Promise<Repo | GitUnavailable> {
    const p = this.cachedRepo();
    const r = await p;
    if (!r.ok || !r.configSigs.length) return r;
    for (const [f, sig] of r.configSigs) {
      if ((await statSig(f)) === sig) continue; // one at a time: a hung share holds one libuv thread, not the pool
      if (this.repoP === p) this.repoP = null;
      return this.cachedRepo(); // that one fresh discovery (shared), not checked again here
    }
    return r;
  }

  private cachedRepo(): Promise<Repo | GitUnavailable> {
    if (this.repoP && this.repoMissAt && Date.now() - this.repoMissAt > NEGATIVE_TTL_MS) this.repoP = null;
    if (!this.repoP) {
      const p = this.discover();
      this.repoP = p;
      this.repoMissAt = 0;
      void p.then((r) => {
        if (!r.ok && this.repoP === p) this.repoMissAt = Date.now();
      });
    }
    return this.repoP;
  }

  /** Is this folder inside a repository (and is git usable)? Discovery only, no status. */
  async probe(): Promise<{ ok: true } | GitUnavailable> {
    const r = await this.repo();
    return r.ok ? { ok: true } : r;
  }

  /** Forget cached repository facts (`.git` appeared / vanished, config changed). */
  invalidate() {
    this.repoP = null;
  }

  /**
   * Look again after a failed discovery (the user's Retry, see GitMonitor). A discovery still running is
   * waited for and shared, and only a failed one is dropped: two discoveries never run side by side.
   */
  async reprobe(): Promise<{ ok: true } | GitUnavailable> {
    const cur = this.repoP;
    if (cur) {
      const r = await cur;
      if (r.ok) return { ok: true };
      if (this.repoP === cur) this.repoP = null;
    }
    return this.probe();
  }

  private async discover(): Promise<Repo | GitUnavailable> {
    const git = (await this.wslGit()) ?? (await findGit({ gitPath: this.opts.gitPath, platform: this.platform, env: this.opts.env ?? process.env, timeoutMs: this.opts.timeouts?.discover }));
    // Like a rev-parse that ran out of time: "didn't answer in time", looked at again on Retry / window focus (GitMonitor).
    if (git === 'timeout') return { ok: false, reason: 'timeout' };
    if (!git) return { ok: false, reason: 'no-git', ...((await hasDotGitAboveAsync(this.root)) ? { repoLikely: true } : {}) };
    const limit = this.opts.timeouts?.discover ?? T_DISCOVER;
    const r = await this.exec(git, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir', '--git-common-dir'], { timeoutMs: limit, maxBytes: 64 * 1024, trigger: 'discover' });
    const fail = failure(r);
    if (fail) return fail;
    const [toplevel, prefix, gitDir, common] = r.stdout.toString('utf8').replace(/\r/g, '').split('\n');
    if (!toplevel || !gitDir) return { ok: false, reason: 'no-repo' };
    // Inside WSL git answers with Linux paths: the watchers / marker checks need the Windows side of them.
    const t = this.wslTarget;
    const host = this.viaWsl && t ? (linux: string) => (this.opts.wsl?.hostPath ?? ((w, l) => toUncPath(w, l)))(t, linux) : (p: string) => this.P.resolve(this.root, p);
    const commonLinux = this.viaWsl && t ? path.posix.resolve(t.linux, common || gitDir) : common || gitDir;
    const base = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=', '-c', 'status.relativePaths=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];
    // Every scope git reads for this folder (no --local: `.git/config.worktree` and includes count too), with the
    // include directives and where each entry comes from (`configWatchFiles`: what to watch for a stale result).
    // Exit 1 = no filter / include configured; anything else means we cannot tell what would run → no git here.
    const cfg = await this.exec(git, ['config', '--includes', '--show-origin', '-z', '--get-regexp', '^(filter\\..*\\.(clean|smudge|process)|include\\.path|includeif\\..*\\.path)$'], { timeoutMs: limit, maxBytes: 1024 * 1024, trigger: 'discover' });
    const configSigs: Array<[string, string]> = [];
    if (cfg.code === 0 && !cfg.overflow) {
      const z = cfg.stdout.toString('utf8');
      const bad = unswitchableFilter(z);
      if (bad !== null) return { ok: false, reason: 'error', message: `This folder's git configuration has a filter One cannot switch off (“${bad}”)` };
      // LFS configured but not installed: git would die on every status ("git-lfs: not found") → no filter at all.
      // `alias.lfs` is pinned: without git-lfs git would otherwise run an `lfs` alias from the folder's config.
      const lfsInstalled = !hasLfsDriver(z) || (await this.exec(git, ['-c', 'alias.lfs=!exit 1', 'lfs', 'version'], { timeoutMs: T_QUICK, maxBytes: 4096, trigger: 'discover' })).code === 0;
      base.push(...untrustedFilterOverrides(z, { lfsInstalled }));
      // Inside WSL the paths are the distro's (relative to the Linux folder), and its home is not known here: `~/` is skipped.
      const P = this.viaWsl ? path.posix : this.P;
      const cwd = this.viaWsl && t ? t.linux : this.root;
      const home = this.viaWsl ? null : (envGet(this.env, 'HOME') ?? (this.platform === 'win32' ? envGet(this.env, 'USERPROFILE') : undefined) ?? null);
      const files = configWatchFiles(z, { P, origin: (o) => P.resolve(cwd, o), home, head: P.join(this.viaWsl ? path.posix.resolve(t!.linux, gitDir) : this.P.resolve(this.root, gitDir), 'HEAD') });
      for (const f of files) {
        const native = this.viaWsl && t ? host(f) : f;
        configSigs.push([native, await statSig(native)]);
      }
    } else if (cfg.code !== 1 || cfg.overflow) return failure(cfg) ?? { ok: false, reason: 'error', message: 'Could not read the git configuration of this folder' };
    return { ok: true, git, toplevel: host(toplevel), prefix: prefix ?? '', gitDir: host(gitDir), commonDir: host(commonLinux), base, configSigs };
  }

  private git(repo: Repo, args: string[], o: Omit<ExecOptions, 'env'>) {
    return this.exec(repo.git, [...repo.base, ...args], o);
  }

  /** Why the next status runs (activity log). */
  private nextTrigger: string | null = null;
  private feeding: Promise<void> = Promise.resolve();
  /** Parse big outputs in slices with a yield in between (WSL helper output arrives in one piece). */
  private feed(stream: PorcelainStream, c: Buffer) {
    if (c.length <= FEED_SLICE) return void stream.push(c);
    this.feeding = this.feeding.then(async () => {
      for (let i = 0; i < c.length; i += FEED_SLICE) {
        stream.push(c.subarray(i, i + FEED_SLICE));
        await new Promise<void>((r) => setImmediate(r));
      }
    });
  }

  /** Branch + changed paths. Concurrent callers share a run; a call during a run gets the next one. */
  status(trigger?: string): Promise<GitStatusResult> {
    if (trigger) this.nextTrigger = trigger;
    if (!this.statusRun) {
      this.statusRun = this.statusOnce().finally(() => (this.statusRun = null));
      return this.statusRun;
    }
    this.statusNext ??= this.statusRun.catch(() => null).then(() => {
      this.statusNext = null;
      return this.status();
    });
    return this.statusNext;
  }

  private async statusOnce(): Promise<GitStatusResult> {
    const repo = await this.repo();
    if (!repo.ok) return repo;
    const t0 = performance.now();
    // untracked=normal / ignored=matching: one entry per untracked or ignored folder (fast on big trees).
    // Submodules: one entry each, without walking their work trees.
    // core.untrackedCache: read-only use of the cache when the user's git built one (never written here).
    const args = ['-c', 'core.untrackedCache=true', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching', '--ignore-submodules=dirty', '--', '.'];
    const stream = new PorcelainStream(repo.prefix);
    const raw = await this.git(repo, args, { timeoutMs: T_STATUS, maxBytes: MAX_STATUS_BYTES, trigger: this.nextTrigger ?? 'status', onChunk: (c) => this.feed(stream, c), trace: true });
    this.nextTrigger = null;
    await this.feeding;
    const { stderr, data } = splitTrace2(raw.stderr);
    const r = { ...raw, stderr };
    const fail = failure(r);
    if (fail) {
      if (fail.reason === 'no-repo') this.invalidate(); // .git was removed
      return fail;
    }
    const parsed = stream.end();
    const out: GitStatus = { ok: true, branch: parsed.branch, entries: parsed.entries, prefix: repo.prefix, ms: Math.round(performance.now() - t0) };
    if (parsed.truncated) out.truncated = true;
    // refresh/sum_scan = files whose stat data did not match; minus the ones really changed in the work tree
    // = re-read for nothing.
    const scanned = data['refresh/sum_scan'];
    let changed = 0;
    for (const e of parsed.entries) if (e.unstaged && e.state !== 'untracked' && e.state !== 'ignored') changed++;
    this.scan = { wasted: scanned === undefined ? null : Math.max(0, scanned - changed), ms: out.ms };
    const state = await repoState(repo.gitDir);
    if (state) out.state = state;
    return out;
  }

  /** What the last status said about the index's stat cache (null before the first status / after a refresh). */
  indexHint(): IndexHint | null {
    return this.scan;
  }

  /** No git process of ours running, no mutation queued, no background list waiting. */
  get idle(): boolean {
    return this.inflight === 0 && this.acting === 0 && !this.statusRun && !this.lowQueue.length && !this.lowRunning.size;
  }

  /**
   * Re-record timestamps / sizes of unchanged files in the index (`update-index --refresh`), so later
   * read-only statuses stop re-reading them. File contents, staging and history are untouched.
   * Hooks off (post-index-change), fsmonitor off, repo-local filters neutralised (repo.base).
   * Skipped while index.lock exists (someone's git is writing; the lock is never removed).
   * No timeout: killing git mid-write can leave index.lock behind on Windows.
   */
  refreshIndex(): Promise<IndexRefreshResult> {
    return (this.refreshRun ??= this.refreshOnce().finally(() => (this.refreshRun = null)));
  }

  private async refreshOnce(): Promise<IndexRefreshResult> {
    const repo = await this.repo();
    if (!repo.ok) return { ok: false, skipped: 'unavailable' };
    if (!this.idle) return { ok: false, skipped: 'busy' };
    // Inside serial(): one of our own commits / stages cannot start while it writes the index.
    return this.serial(async (): Promise<IndexRefreshResult> => {
      if (await exists(path.join(repo.gitDir, 'index.lock'))) return { ok: false, skipped: 'locked' };
      const t0 = performance.now();
      const args = [...this.noHooks, 'update-index', '-q', '--unmerged', '--ignore-missing', '--ignore-submodules', '--refresh'];
      const r = await this.git(repo, args, { timeoutMs: 0, maxBytes: 1024 * 1024, low: true, direct: true, trigger: 'index-refresh' });
      if (r.code === 0) {
        this.scan = null;
        return { ok: true, ms: Math.round(performance.now() - t0) };
      }
      if (/index\.lock/.test(r.stderr) && /exists/i.test(r.stderr)) return { ok: false, skipped: 'locked' };
      return { ok: false, message: firstLine(r.stderr) || r.error?.message || `git update-index exited with ${r.code}` };
    });
  }

  /** Workspace path checked against the containment rules → clean POSIX rel. */
  private validRel(rel: unknown): string {
    if (typeof rel !== 'string') throw new BackendFailure('EINVAL', 'Path must be a string');
    resolveInside(this.root, rel, this.platform === 'win32' ? path.win32 : path.posix, this.platform === 'win32');
    const clean = normalize(rel);
    if (!clean || /[\n\r\0]/.test(clean)) throw new BackendFailure('EINVAL', `Invalid path: ${rel}`);
    return clean;
  }

  /** Content of `rel` at `rev` (HEAD or a full object id), decoded + LF-normalised like the editor does. */
  async headFile(rel: string, rev: unknown = 'HEAD'): Promise<GitHeadFile> {
    const clean = this.validRel(rel);
    if (typeof rev !== 'string' || !GIT_REV_RE.test(rev)) throw new BackendFailure('EINVAL', 'Invalid revision');
    const repo = await this.repo();
    if (!repo.ok) return { content: null, oid: null };
    let repoPath = repo.prefix + clean;
    // One spawn: line 1 resolves the commit, line 2 reads the blob.
    let r = await this.catFile(repo, rev, repoPath);
    if (r.blob === 'missing' && r.oid && (this.opts.foldCase ?? (this.platform === 'win32' || this.platform === 'darwin'))) {
      // Case-insensitive file system: the tree may spell the name differently from the repository.
      const real = await this.indexCase(repo, repoPath);
      if (real && real !== repoPath) {
        repoPath = real;
        r = await this.catFile(repo, r.oid, real);
      }
    }
    if (r.tooLarge) return { content: null, oid: r.oid, tooLarge: true };
    if (!r.oid || r.blob === 'missing' || !r.data) return { content: null, oid: r.oid };
    const d = decode(r.data);
    if (d.binary) return { content: null, oid: r.oid, binary: true };
    if (d.text.startsWith(LF_POINTER)) return { content: null, oid: r.oid, lfs: true };
    return { content: toLf(d.text), oid: r.oid };
  }

  private async catFile(repo: Repo, rev: string, repoPath: string): Promise<{ oid: string | null; blob: 'ok' | 'missing'; data?: Buffer; tooLarge?: boolean }> {
    const r = await this.git(repo, ['cat-file', '--batch'], { timeoutMs: T_READ, maxBytes: GIT_MAX_BLOB_BYTES + 1024 * 1024, input: `${rev}\n${rev}:${repoPath}\n` });
    if (r.overflow) return { oid: rev === 'HEAD' ? null : rev, blob: 'missing', tooLarge: true };
    if (r.code !== 0) return { oid: null, blob: 'missing' };
    const out = r.stdout;
    const first = readBatch(out, 0);
    const oid = first.ok && first.type === 'commit' ? first.oid : null;
    if (!oid) return { oid: null, blob: 'missing' };
    const second = readBatch(out, first.next);
    if (!second.ok || second.type !== 'blob') return { oid, blob: 'missing' };
    if (second.size > GIT_MAX_BLOB_BYTES) return { oid, blob: 'ok', tooLarge: true };
    return { oid, blob: 'ok', data: out.subarray(second.start, second.start + second.size) };
  }

  /** Path as spelled in the index, matched case-insensitively (ls-tree has no icase pathspecs). */
  private async indexCase(repo: Repo, repoPath: string): Promise<string | null> {
    const r = await this.git(repo, ['ls-files', '-z', '--full-name', '--', `:(top,icase,literal)${repoPath}`], { timeoutMs: T_QUICK, maxBytes: 64 * 1024 });
    if (r.code !== 0) return null;
    const hits = r.stdout.toString('utf8').split('\0').filter(Boolean);
    return hits.length === 1 ? hits[0] : null;
  }

  /** Unified diff of the saved file against `rev` (null: not available). Never runs external diff / textconv. */
  async diff(rel: string, rev: unknown = 'HEAD'): Promise<string | null> {
    if (typeof rev !== 'string' || !GIT_REV_RE.test(rev)) throw new BackendFailure('EINVAL', 'Invalid revision');
    const clean = this.validRel(rel);
    const repo = await this.repo();
    if (!repo.ok) return null;
    const repoPath = repo.prefix + clean;
    const r = await this.git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', rev, '--', `:(top,literal)${repoPath}`], { timeoutMs: T_READ, maxBytes: MAX_DIFF_BYTES });
    if (r.code !== 0 || r.overflow) return null;
    return toLf(r.stdout.toString('utf8'));
  }

  /**
   * Added / removed line counts of every tracked file under the workspace folder that differs from HEAD (work tree,
   * staged or not), paths relative to that folder (`--relative`: also right when the folder is below the repository
   * root). null: no repository, no commit yet, too much output. Read only; never runs external diff / textconv.
   */
  async numstat(): Promise<GitNumstatRow[] | null> {
    const repo = await this.repo();
    if (!repo.ok) return null;
    const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--relative', '--raw', '--numstat', '-z', '--ignore-submodules=dirty', 'HEAD', '--'];
    const r = await this.git(repo, args, { timeoutMs: T_READ, maxBytes: MAX_DIFF_BYTES, trigger: 'numstat' });
    if (r.code !== 0 || r.overflow) return null;
    return parseNumstat(r.stdout.toString('utf8'));
  }

  // ---- tier 2: source control (mutating) ----------------------------------------------------
  // Trusted folders only (the gate). These run what the trust prompt names — the repository's hooks and filters —
  // and the user's own login (credential helper, ssh): they are what the user asked for. A filter is never switched
  // off here: `git add` would put the unfiltered file in the index (git-crypt: plain text committed), and `-c`
  // overrides reach the hooks' own git calls too (GIT_CONFIG_PARAMETERS).
  // Beyond that nothing configured runs: `core.fsmonitor` is off as in reads (it only ever saves time), and the
  // index-only writes behind the commit boxes (stage / unstage / blocks / discard) run no hook, like the index
  // refresh. `core.quotepath` / `color.ui` are forced for parsing. One mutation at a time (index.lock).

  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    this.acting++;
    const p = this.chain.then(fn, fn).finally(() => this.acting--);
    this.chain = p.catch(() => {});
    return p;
  }

  private async needRepo(): Promise<Repo | GitActionResult> {
    const repo = await this.repo();
    if (repo.ok) return repo;
    if (repo.reason === 'timeout') return { ok: false, timeout: true, message: GIT_TIMEOUT_TEXT };
    const why: Record<string, string> = { 'no-git': 'git was not found', 'no-repo': 'This folder is not a git repository', unsafe: 'git refuses this repository (safe.directory)' };
    return { ok: false, message: repo.message || why[repo.reason] || 'git is not available' };
  }

  /** No hooks: `core.hooksPath` pointed at the null device (the platform's git runs on: inside WSL that is Linux). */
  private get noHooks(): string[] {
    return ['-c', `core.hooksPath=${this.platform === 'win32' && !this.viaWsl ? 'NUL' : '/dev/null'}`];
  }

  /**
   * Runs a mutating git command and turns its outcome into an action result. `hooks: false` = an index-only write
   * (a commit box): no hook runs (post-index-change, …); commit / push / pull / switch keep the repository's hooks.
   */
  private async act(repo: Repo, args: string[], o: { input?: string | Buffer; timeoutMs?: number; net?: boolean; hooks?: false; ok?: string; explain?: (text: string) => string | null } = {}): Promise<GitActionResult> {
    const env = o.net ? { ...this.env } : this.env;
    if (o.net) delete env.GCM_INTERACTIVE; // the credential manager's own window is fine; terminal prompts are not
    const r = await this.exec(repo.git, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'core.fsmonitor=', ...(o.hooks === false ? this.noHooks : []), ...args], {
      env,
      timeoutMs: this.opts.timeouts?.action ?? o.timeoutMs ?? 60_000,
      maxBytes: 4 * 1024 * 1024,
      input: o.input,
      detached: o.net,
      net: o.net,
      direct: true,
      trigger: 'action',
    });
    if (r.error) return { ok: false, message: r.error.message };
    const text = r.stderr + (r.stderr && r.stdout.length ? '\n' : '') + r.stdout.toString('utf8');
    // The hand-off the user types: without push's `--` (its remote name was checked: no leading '-').
    const terminal = () => terminalCommand(args.filter((a) => a !== '--'));
    if (r.timedOut) return { ok: false, timeout: true, message: GIT_TIMEOUT_TEXT, ...(o.net ? { terminal: terminal(), auth: true } : {}) };
    if (r.code === 0) return { ok: true, message: o.ok ?? gitMessage(text, 2) };
    const plain = o.explain?.(text);
    if (plain) return { ok: false, message: plain };
    const msg = gitMessage(text) || `git ${args[0]} failed`;
    if (o.net && isAuthError(text)) return { ok: false, auth: true, message: msg, terminal: terminal() };
    if (/gpg failed|signing failed|passphrase/i.test(text)) return { ok: false, message: msg, terminal: `git ${args[0]}` };
    return { ok: false, message: msg };
  }

  /** Pathspecs for validated workspace paths (null = the whole workspace). */
  private specs(repo: Repo, paths: unknown): string[] {
    if (paths === null) return [repo.prefix ? `:(top,literal)${repo.prefix}` : ':(top)'];
    if (!Array.isArray(paths) || !paths.length || paths.length > 20_000) throw new BackendFailure('EINVAL', 'Expected a list of paths');
    return paths.map((p) => `:(top,literal)${repo.prefix}${this.validRel(p)}`);
  }

  /** `args -- specs`, with long lists passed on stdin (Windows command lines are limited to 32k chars). */
  private withSpecs(repo: Repo, args: string[], specs: string[]): { args: string[]; input?: string } {
    if (specs.length > 50 && atLeast(repo.git.version, 2, 26)) return { args: [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], input: specs.join('\0') };
    return { args: [...args, '--', ...specs] };
  }

  private async hasHead(repo: Repo): Promise<boolean> {
    const r = await this.git(repo, ['rev-parse', '-q', '--verify', 'HEAD'], { timeoutMs: T_QUICK, maxBytes: 4096 });
    return r.code === 0;
  }

  async stage(paths: unknown): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const c = this.withSpecs(repo, ['add', '-A'], this.specs(repo, paths));
    return this.serial(() => this.act(repo, c.args, { input: c.input, hooks: false }));
  }

  async unstage(paths: unknown): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const specs = this.specs(repo, paths);
    return this.serial(async () => {
      const head = await this.hasHead(repo);
      const verb = !head ? ['rm', '--cached', '-r', '-q', '--ignore-unmatch'] : atLeast(repo.git.version, 2, 23) ? ['restore', '--staged'] : ['reset', '-q'];
      const c = this.withSpecs(repo, verb, specs);
      return this.act(repo, c.args, { input: c.input, hooks: false });
    });
  }

  /**
   * Work-tree changes back to the staged/committed version; untracked files go to `trash` (the OS
   * recycle bin, never `git clean`). Conflicted files are refused.
   */
  async discard(paths: unknown, trash: (rel: string) => Promise<void>): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    if (!Array.isArray(paths) || !paths.length) throw new BackendFailure('EINVAL', 'Expected a list of paths');
    const clean = paths.map((p) => this.validRel(p));
    const s = await this.statusOnce();
    if (!s.ok) return { ok: false, message: s.message ?? 'git status failed' };
    const exact = new Map(s.entries.map((e) => [e.path, e]));
    const untrackedDirs = s.entries.filter((e) => e.dir && e.state === 'untracked').map((e) => e.path);
    const isUntracked = (p: string) => exact.get(p)?.state === 'untracked' || untrackedDirs.some((d) => d === '' || p === d || p.startsWith(d + '/'));
    if (clean.some((p) => exact.get(p)?.state === 'conflicted')) return { ok: false, message: 'Resolve the merge conflict first (or mark it resolved)' };
    const tracked = clean.filter((p) => !isUntracked(p) && exact.has(p));
    const loose = clean.filter(isUntracked);
    return this.serial(async () => {
      if (tracked.length) {
        const verb = atLeast(repo.git.version, 2, 23) ? ['restore', '--worktree'] : ['checkout', '-q'];
        const c = this.withSpecs(repo, verb, tracked.map((p) => `:(top,literal)${repo.prefix}${p}`));
        const r = await this.act(repo, c.args, { input: c.input, hooks: false });
        if (!r.ok) return r;
      }
      for (const p of loose) await trash(p);
      return { ok: true, message: `Discarded ${tracked.length + loose.length} ${tracked.length + loose.length === 1 ? 'change' : 'changes'}` };
    });
  }

  // ---- choose what to commit: blocks of one file in or out of the index -------------------------
  // The index is the selection (the CLI and other tools see the same thing). Blocks come from git's
  // zero-context diffs HEAD → index and index → working copy (git-hunks.ts composes them); a block goes
  // in or out with `git apply --cached`, built from git's own diff bytes. The working tree is never touched.

  /** Blocks of a file, or why it can only be staged as a whole. Read-only (repo.base: filters off). */
  private async fileBlocks(repo: Repo, clean: string, from: string | null): Promise<{ repoPath: string; headPath: string; blocks: Block[] } | { reason: GitWholeFileReason }> {
    const repoPath = repo.prefix + clean;
    const specs = [`:(top,literal)${repoPath}`];
    // Without the source in the pathspec git reports a staged rename as a new file.
    if (from && from !== clean) specs.push(`:(top,literal)${repo.prefix}${from}`);
    const st = await this.git(repo, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty', '--', ...specs], { timeoutMs: T_READ, maxBytes: 1024 * 1024, trigger: 'hunks' });
    if (st.code !== 0 || st.overflow) return { reason: 'unavailable' };
    const rec = parseFileRecord(st.stdout.toString('utf8'), repoPath);
    if (!rec) return { reason: 'unchanged' };
    if (rec.kind === '?') return { reason: 'untracked' };
    if (rec.kind === 'u') return { reason: 'conflicted' };
    const x = rec.xy[0] ?? '.';
    const y = rec.xy[1] ?? '.';
    // Submodules, symlinks: no lines to pick from.
    if (rec.sub !== 'N...' || rec.modes.some((m) => m !== '100644' && m !== '100755' && m !== '000000')) return { reason: 'special' };
    if (x === 'A' || x === 'C') return { reason: 'added' };
    if (x === 'D' || y === 'D') return { reason: 'deleted' };
    if (!'.MR'.includes(x) || !'.M'.includes(y)) return { reason: 'special' }; // type changes
    // A filter (Git LFS, clean/smudge drivers): the index holds something else than the file's lines.
    const attr = await this.git(repo, ['check-attr', '-z', 'filter', '--', clean], { timeoutMs: T_QUICK, maxBytes: 64 * 1024, trigger: 'hunks' });
    if (attr.code !== 0) return { reason: 'unavailable' };
    const filter = attr.stdout.toString('utf8').split('\0')[2] ?? 'unspecified';
    if (filter !== 'unspecified' && filter !== 'unset') return { reason: filter === 'lfs' ? 'lfs' : 'filter' };
    const headPath = x === 'R' && rec.orig ? rec.orig : repoPath;
    const base = ['diff', '-U0', '--inter-hunk-context=0', '--no-color', '--no-ext-diff', '--no-textconv'];
    const o = { timeoutMs: T_READ, maxBytes: MAX_DIFF_BYTES, trigger: 'hunks' };
    const [s, u] = await Promise.all([
      x === '.' ? null : this.git(repo, [...base, `HEAD:${headPath}`, `:0:${repoPath}`], o), // blob ↔ blob: renames need no detection
      y === '.' ? null : this.git(repo, [...base, '--', `:(top,literal)${repoPath}`], o),
    ]);
    const parse = (r: RunResult | null): ParsedZeroDiff | GitWholeFileReason => {
      if (!r) return { binary: false, hunks: [] };
      if (r.overflow) return 'too-large';
      if (r.code !== 0) return 'unavailable';
      return parseZeroDiff(r.stdout.toString('latin1')) ?? 'special';
    };
    const ps = parse(s);
    const pu = parse(u);
    if (typeof ps === 'string') return { reason: ps };
    if (typeof pu === 'string') return { reason: pu };
    if (ps.binary || pu.binary) return { reason: 'binary' };
    return { repoPath, headPath, blocks: composeBlocks(ps.hunks, pu.hunks) };
  }

  private optionalRel(from: unknown): string | null {
    return typeof from === 'string' && from ? this.validRel(from) : null;
  }

  /** The blocks of HEAD → working copy with their staged state, plus both texts the lines refer to. */
  async hunks(rel: unknown, from?: unknown): Promise<GitFileHunks> {
    const clean = this.validRel(rel);
    const src = this.optionalRel(from);
    const whole = (reason: GitWholeFileReason): GitFileHunks => ({ mode: 'file', reason });
    const repo = await this.repo();
    if (!repo.ok) return whole('unavailable');
    const f = await this.fileBlocks(repo, clean, src);
    if ('reason' in f) return whole(f.reason);
    const head = await this.catFile(repo, 'HEAD', f.headPath);
    if (head.tooLarge) return whole('too-large');
    if (!head.data) return whole('unavailable');
    const raw = await this.readWork(clean);
    if (raw === 'too-large') return whole('too-large');
    if (!raw) return whole('unavailable');
    const h = decode(head.data);
    const w = decode(raw);
    if (h.binary || w.binary) return whole('binary');
    if (h.text.startsWith(LF_POINTER)) return whole('lfs');
    // A lone CR is a line break for the editor but not for git: the lines would not line up.
    if (/\r(?!\n)/.test(h.text) || /\r(?!\n)/.test(w.text)) return whole('special');
    return { mode: 'hunks', head: toLf(h.text), work: toLf(w.text), hunks: f.blocks.map(({ a0, a1, b0, b1, state }) => ({ a0, a1, b0, b1, state })) };
  }

  /** The folder without links (only a success is remembered: an answer that failed once is asked again). */
  private realRoot: string | null = null;

  /**
   * The working copy of `clean` for hunks(), read inside the folder only: git looked at it a moment ago, and a link
   * swapped in since (the file, or a folder above it) must not lead out of the folder. Its real path must be inside
   * the folder's, it is opened without following a link and without blocking (FIFO), must be a regular file, and its
   * real path must be unchanged once it is open. null: not readable here.
   */
  private async readWork(clean: string): Promise<Buffer | 'too-large' | null> {
    const abs = this.P.join(this.root, ...clean.split('/'));
    this.realRoot ??= await fsp.realpath(this.root).catch(() => null);
    const real = await fsp.realpath(abs).catch(() => null);
    const fold = this.opts.foldCase ?? (this.platform === 'win32' || this.platform === 'darwin');
    if (!this.realRoot || !real || !isInsideDir(real, this.realRoot, this.P, fold)) return null;
    const fh = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)).catch(() => null);
    if (!fh) return null;
    try {
      const st = await fh.stat();
      if (!st.isFile()) return null;
      if (st.size > GIT_MAX_BLOB_BYTES) return 'too-large';
      if ((await fsp.realpath(abs).catch(() => null)) !== real) return null;
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, st.size, 0);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** Puts blocks into the index (`include`) or takes them out, by their ranges from `hunks()`. */
  async stageHunks(rel: unknown, picks: unknown, from?: unknown): Promise<GitActionResult> {
    const clean = this.validRel(rel);
    const src = this.optionalRel(from);
    const list = validPicks(picks);
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    return this.serial(async () => {
      // Recomputed inside the queue: positions always refer to the index as it is now.
      const f = await this.fileBlocks(repo, clean, src);
      if ('reason' in f) return { ok: false, message: f.reason === 'unchanged' ? 'There is nothing to stage in this file any more' : 'This file can only be staged as a whole' };
      const { hunks, missing } = hunksForPicks(f.blocks, list);
      if (missing) return { ok: false, message: 'The file changed meanwhile. Look at it again, then retry.' };
      if (!hunks.length) return { ok: true };
      return this.act(repo, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'], { input: buildPatch(f.repoPath, hunks), ok: '', hooks: false });
    });
  }

  async commit(opts: unknown): Promise<GitActionResult> {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { message?: unknown; amend?: unknown };
    const message = typeof o.message === 'string' ? o.message.replace(/\0/g, '').replace(/\r\n?/g, '\n') : '';
    if (message.length > 200_000) throw new BackendFailure('EINVAL', 'Commit message is too long');
    const amend = o.amend === true;
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const merging = (await repoState(repo.gitDir)) === 'merge';
    if (!message.trim() && !amend && !merging) return { ok: false, message: 'Write a commit message first' };
    const args = ['commit', '-q'];
    if (amend) args.push('--amend');
    if (message.trim()) args.push('-F', '-');
    else args.push('--no-edit');
    return this.serial(async () => {
      // Hooks (pre-commit, commit-msg) may run tests or linters: give them time.
      const r = await this.act(repo, args, {
        input: message.trim() ? message : undefined,
        timeoutMs: 15 * 60_000,
        explain: (t) => (/nothing (added )?to commit|no changes added to commit/i.test(t) ? 'Nothing is staged to commit' : null),
      });
      if (!r.ok) return r;
      const head = await this.git(repo, ['log', '-1', '--format=%h %s'], { timeoutMs: T_QUICK, maxBytes: 64 * 1024 });
      return { ok: true, message: `Committed ${head.stdout.toString('utf8').trim()}` };
    });
  }

  /** Full message of the last commit (amend pre-fill). */
  async lastMessage(): Promise<string> {
    const repo = await this.repo();
    if (!repo.ok) return '';
    const r = await this.git(repo, ['log', '-1', '--format=%B'], { timeoutMs: T_QUICK, maxBytes: 256 * 1024 });
    return r.code === 0 ? toLf(r.stdout.toString('utf8')).replace(/\s+$/, '') : '';
  }

  private async remotes(repo: Repo): Promise<string[]> {
    const r = await this.git(repo, ['remote'], { timeoutMs: T_QUICK, maxBytes: 64 * 1024 });
    return r.code === 0 ? r.stdout.toString('utf8').split('\n').map((x) => x.trim()).filter(Boolean) : [];
  }

  async fetch(): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    if (!(await this.remotes(repo)).length) return { ok: false, message: 'This repository has no remote' };
    return this.serial(() => this.act(repo, ['fetch'], { net: true, timeoutMs: 5 * 60_000, ok: 'Fetched' }));
  }

  async pull(): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const s = await this.statusOnce();
    if (s.ok && !s.branch.upstream) return { ok: false, message: s.branch.head ? 'This branch has no upstream yet: push it first' : 'Detached HEAD: switch to a branch first' };
    return this.serial(async () => {
      const r = await this.act(repo, ['pull'], { net: true, timeoutMs: 5 * 60_000, ok: 'Pulled' });
      // Divergent branches without pull.rebase/pull.ff configured: that choice is the user's.
      if (!r.ok && !r.terminal && /divergent|reconcile|not possible to fast-forward/i.test(r.message ?? '')) return { ...r, message: 'Local and remote both have new commits. Choose merge or rebase in the terminal.', terminal: 'git pull' };
      return r;
    });
  }

  /** Push the current branch (publishing it with -u when it has no upstream). Never forces. */
  async push(): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const s = await this.statusOnce();
    if (!s.ok) return { ok: false, message: s.message ?? 'git status failed' };
    if (!s.branch.head) return { ok: false, message: 'Detached HEAD: switch to a branch first' };
    let args = ['push'];
    if (!s.branch.upstream) {
      const remotes = await this.remotes(repo);
      if (!remotes.length) return { ok: false, message: 'This repository has no remote' };
      const remote = remotes.includes('origin') ? 'origin' : remotes[0];
      // Names come from the folder's config (`[remote "--receive-pack=…"]` is listed by `git remote`): never an option.
      if (remote.startsWith('-')) return { ok: false, message: `“${remote}” is not a valid remote name` };
      args = ['push', '-u', '--', remote, s.branch.head];
    }
    return this.serial(async () => {
      const r = await this.act(repo, args, { net: true, timeoutMs: 5 * 60_000, ok: s.branch.upstream ? 'Pushed' : `Published ${s.branch.head}` });
      if (!r.ok && /rejected|fetch first|non-fast-forward/i.test(r.message ?? '')) return { ...r, message: 'The remote has commits you do not have yet. Pull first, then push.' };
      return r;
    });
  }

  // ---- background lists (low priority) ---------------------------------------------------
  // Branches, history and commit file lists can be slow on big repositories. They run one at a time at
  // below-normal OS priority, time out with an explicit state (never a silent empty list), and can be
  // cancelled (section collapsed, workspace switched). Status / HEAD contents / diffs never wait for them.

  private lowQueue: Array<{ tag: GitJobTag; ac: AbortController; start: () => void }> = [];
  private lowRunning = new Set<{ tag: GitJobTag; ac: AbortController }>();

  private background<T>(tag: GitJobTag, fn: (signal: AbortSignal) => Promise<T>, cancelled: (why: GitJobError) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const ac = new AbortController();
      const job = {
        tag,
        ac,
        start: () => {
          const running = { tag, ac };
          this.lowRunning.add(running);
          fn(ac.signal)
            .then(resolve, (err) => resolve({ ...cancelled('failed'), message: String(err?.message ?? err) }))
            .finally(() => {
              this.lowRunning.delete(running);
              this.pumpLow();
            });
        },
      };
      ac.signal.addEventListener('abort', () => resolve(cancelled('cancelled')), { once: true });
      this.lowQueue.push(job);
      this.pumpLow();
    });
  }

  private pumpLow() {
    while (this.lowRunning.size < LOW_CONCURRENCY && this.lowQueue.length) {
      const job = this.lowQueue.shift()!;
      if (!job.ac.signal.aborted) job.start();
    }
  }

  /** Stop background jobs with `tag` (all when omitted): queued ones never start, running ones are killed. */
  cancel(tag?: unknown) {
    const match = (t: GitJobTag) => tag === undefined || tag === null || t === tag;
    for (const j of this.lowQueue) if (match(j.tag)) j.ac.abort();
    this.lowQueue = this.lowQueue.filter((j) => !j.ac.signal.aborted);
    for (const j of this.lowRunning) if (match(j.tag)) j.ac.abort();
    if (match('branches')) this.branchAc?.abort();
  }

  /** git for a background job: low priority, killable, its own timeout. */
  private bg(repo: Repo, args: string[], signal: AbortSignal, maxBytes: number) {
    return this.exec(repo.git, [...repo.base, ...args], { timeoutMs: this.opts.lowTimeoutMs ?? T_LOW, maxBytes, signal, low: true, trigger: 'background' });
  }

  private static jobError(r: RunResult): { error: GitJobError; message?: string } | null {
    if (r.aborted) return { error: 'cancelled' };
    if (r.timedOut) return { error: 'timeout' };
    if (r.code !== 0 || r.overflow || r.error) return { error: 'failed', message: firstLine(r.stderr) || r.error?.message || 'git failed' };
    return null;
  }

  // Branches in phases, so thousands of remote refs never hold up the list: (1) local branches + the
  // remote count straight from the refs (no commit objects, no `:short` atoms), (2) dates / subjects in
  // background batches for what is on screen, (3) remote branches a window at a time from a cached,
  // name-sorted listing.

  private branchRun: Promise<GitBranchList> | null = null;
  private branchAc: AbortController | null = null;
  /** Remote-tracking refs (name-sorted), refreshed when refs change (the .git watcher bumps refsGen). */
  private remoteRefs: { gen: number; at: number; list: Array<{ name: string; oid: string }> } | null = null;
  private remoteRun: Promise<Array<{ name: string; oid: string }> | GitJobError> | null = null;
  private refsGen = 0;

  /** Phase 1: local branches (name-sorted, current first) and how many remote ones. Single-flight. */
  branches(): Promise<GitBranchList> {
    if (this.branchRun) return this.branchRun;
    const ac = (this.branchAc = new AbortController());
    const p = (async (): Promise<GitBranchList> => {
      const repo = await this.repo();
      if (!repo.ok) return { branches: [], remotes: [], remoteCount: 0 };
      const local = this.git(repo, ['for-each-ref', `--format=${LOCAL_BRANCH_FORMAT}`, 'refs/heads'], { timeoutMs: T_READ, maxBytes: 16 * 1024 * 1024, signal: ac.signal, trigger: 'branches' });
      const [l, remotes, refs] = await Promise.all([local, this.remotes(repo), this.remoteList(repo, ac.signal, true)]);
      const fail = GitService.jobError(l);
      if (fail) return { branches: [], remotes, remoteCount: 0, error: fail.error, message: fail.message };
      return { branches: parseLocalBranches(l.stdout.toString('utf8')), remotes, remoteCount: Array.isArray(refs) ? refs.length : 0 };
    })().finally(() => {
      if (this.branchRun === p) this.branchRun = null;
      if (this.branchAc === ac) this.branchAc = null;
    });
    this.branchRun = p;
    return p;
  }

  /** Name-sorted remote-tracking refs (cached until refs change; a names-only listing is cheap). */
  private remoteList(repo: Repo, signal?: AbortSignal, fresh = false): Promise<Array<{ name: string; oid: string }> | GitJobError> {
    const c = this.remoteRefs;
    if (!fresh && c && c.gen === this.refsGen && Date.now() - c.at < 60_000) return Promise.resolve(c.list);
    if (this.remoteRun) return this.remoteRun;
    const gen = this.refsGen;
    const p = (async () => {
      const r = await this.git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes'], { timeoutMs: T_READ, maxBytes: 64 * 1024 * 1024, signal, trigger: 'remotes' });
      const fail = GitService.jobError(r);
      if (fail) return fail.error;
      const list = parseRemoteRefs(r.stdout.toString('utf8'));
      this.remoteRefs = { gen, at: Date.now(), list };
      return list;
    })().finally(() => {
      if (this.remoteRun === p) this.remoteRun = null;
    });
    this.remoteRun = p;
    return p;
  }

  /** A window of remote branches, name-sorted; `filter` matches anywhere in the name (case-insensitive). */
  async remoteBranches(opts: unknown): Promise<GitRemoteBranchPage> {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { offset?: unknown; limit?: unknown; filter?: unknown };
    const offset = Math.max(0, Math.floor(Number(o.offset) || 0));
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(o.limit) || 200)));
    const q = typeof o.filter === 'string' ? o.filter.trim().toLowerCase().slice(0, 200) : '';
    const repo = await this.repo();
    if (!repo.ok) return { total: 0, items: [] };
    const list = await this.remoteList(repo);
    if (!Array.isArray(list)) return { total: 0, items: [], error: list };
    const hits = q ? list.filter((b) => b.name.toLowerCase().includes(q)) : list;
    return { total: hits.length, items: hits.slice(offset, offset + limit) };
  }

  /** Phase 2: commit date + subject for the given commits (what is on screen), in the background queue. */
  async branchDetails(oids: unknown, tag: unknown = 'branches'): Promise<GitBranchDetails> {
    if (!Array.isArray(oids) || oids.length > 2000 || !oids.every((x) => typeof x === 'string' && /^[0-9a-f]{40,64}$/.test(x))) throw new BackendFailure('EINVAL', 'Expected a list of commit ids');
    const t: GitJobTag = tag === 'remotes' ? 'remotes' : 'branches';
    const none = (error: GitJobError): GitBranchDetails => ({ details: [], error });
    const unique = [...new Set(oids as string[])];
    if (!unique.length) return Promise.resolve({ details: [] });
    return this.background(
      t,
      async (signal) => {
        const repo = await this.repo();
        if (!repo.ok) return { details: [] };
        const r = await this.exec(repo.git, [...repo.base, 'log', '--no-walk=unsorted', '--stdin', '-z', '--no-decorate', `--format=${DETAIL_FORMAT}`], {
          timeoutMs: this.opts.lowTimeoutMs ?? T_LOW,
          maxBytes: 8 * 1024 * 1024,
          signal,
          low: true,
          input: unique.join('\n') + '\n',
          trigger: t,
        });
        const fail = GitService.jobError(r);
        if (fail) return { ...none(fail.error), message: fail.message };
        return { details: parseDetails(r.stdout.toString('utf8')) };
      },
      none,
    );
  }

  /** One page of history (workspace-scoped), newest first. One extra commit is read to know `more`. */
  log(opts: unknown): Promise<GitLogPage> {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { skip?: unknown; limit?: unknown };
    const limit = Math.max(1, Math.min(200, Number.isFinite(Number(o.limit)) ? Math.floor(Number(o.limit)) : 50));
    const skip = Math.max(0, Math.min(10_000_000, Number.isFinite(Number(o.skip)) ? Math.floor(Number(o.skip)) : 0));
    const none = (error: GitJobError): GitLogPage => ({ commits: [], more: false, error });
    return this.background(
      'history',
      async (signal) => {
        const repo = await this.repo();
        if (!repo.ok) return { commits: [], more: false };
        if (!(await this.hasHead(repo))) return { commits: [], more: false }; // no commits yet
        const spec = repo.prefix ? ['--', `:(top,literal)${repo.prefix}`] : [];
        const r = await this.bg(repo, ['log', '-z', '--no-decorate', `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, `--skip=${skip}`, 'HEAD', ...spec], signal, 4 * 1024 * 1024);
        const fail = GitService.jobError(r);
        if (fail) return { ...none(fail.error), message: fail.message };
        const commits = parseLog(r.stdout.toString('utf8'));
        return { commits: commits.slice(0, limit), more: commits.length > limit };
      },
      none,
    );
  }

  /** Files changed by a commit against its first parent, limited to the workspace (one spawn). */
  async commitFiles(oid: unknown, parent?: unknown): Promise<GitCommitFiles> {
    if (typeof oid !== 'string' || !GIT_REV_RE.test(oid) || oid === 'HEAD') throw new BackendFailure('EINVAL', 'Invalid commit id');
    if (parent !== undefined && parent !== null && (typeof parent !== 'string' || !GIT_REV_RE.test(parent) || parent === 'HEAD')) throw new BackendFailure('EINVAL', 'Invalid parent id');
    const none = (error: GitJobError): GitCommitFiles => ({ oid, parent: null, files: [], error });
    return this.background(
      'files',
      async (signal) => {
        const repo = await this.repo();
        if (!repo.ok) return { oid, parent: null, files: [] };
        let p: string | null | undefined = parent as string | null | undefined;
        if (p === undefined) {
          const pr = await this.bg(repo, ['rev-list', '--parents', '-n', '1', oid], signal, 64 * 1024);
          p = pr.code === 0 ? (pr.stdout.toString('utf8').trim().split(/\s+/)[1] ?? null) : null;
        }
        const spec = repo.prefix ? ['--', `:(top,literal)${repo.prefix}`] : [];
        const args = p ? ['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', p, oid, ...spec] : ['diff-tree', '--root', '-r', '-z', '--name-status', '--no-commit-id', oid, ...spec];
        const r = await this.bg(repo, args, signal, 16 * 1024 * 1024);
        const fail = GitService.jobError(r);
        if (fail) return { ...none(fail.error), parent: p ?? null, message: fail.message };
        return { oid, parent: p ?? null, files: parseNameStatus(r.stdout.toString('utf8'), repo.prefix) };
      },
      none,
    );
  }

  async createBranch(name: unknown): Promise<GitActionResult> {
    if (typeof name !== 'string' || !name.trim() || name.length > 250 || name.trim().startsWith('-')) throw new BackendFailure('EINVAL', 'Invalid branch name');
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const chk = await this.git(repo, ['check-ref-format', '--branch', name.trim()], { timeoutMs: T_QUICK, maxBytes: 4096 });
    const valid = chk.stdout.toString('utf8').trim();
    if (chk.code !== 0 || !valid || valid.startsWith('-')) return { ok: false, message: `“${name.trim()}” is not a valid branch name` };
    const args = atLeast(repo.git.version, 2, 23) ? ['switch', '-c', valid] : ['checkout', '-b', valid];
    return this.serial(() => this.act(repo, args, { ok: `Created and switched to ${valid}` }));
  }

  /** Switch to an existing branch; a remote branch gets a local tracking branch. (Not queued behind
   *  background lists: the name is checked directly with show-ref.) */
  async switchBranch(name: unknown): Promise<GitActionResult> {
    if (typeof name !== 'string' || !name || name.length > 250 || name.startsWith('-')) throw new BackendFailure('EINVAL', 'Invalid branch name');
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const has = async (ref: string) => (await this.git(repo, ['show-ref', '--verify', '-q', ref], { timeoutMs: T_QUICK, maxBytes: 4096 })).code === 0;
    const sw = atLeast(repo.git.version, 2, 23);
    let target = name;
    let args: string[];
    if (await has(`refs/heads/${name}`)) args = sw ? ['switch', name] : ['checkout', name];
    else if (await has(`refs/remotes/${name}`)) {
      const remotes = await this.remotes(repo);
      const remote = remotes.find((r) => name.startsWith(r + '/')) ?? name.split('/')[0];
      target = name.slice(remote.length + 1);
      // "origin/-f": the local name would reach git as an option.
      if (!target || target.startsWith('-')) return { ok: false, message: `“${target}” is not a valid branch name` };
      if (await has(`refs/heads/${target}`)) args = sw ? ['switch', target] : ['checkout', target];
      else args = sw ? ['switch', '-c', target, '--track', name] : ['checkout', '-b', target, '--track', name];
    } else return { ok: false, message: `No branch “${name}”` };
    return this.serial(async () => {
      const r = await this.act(repo, args, { ok: `Switched to ${target}` });
      if (!r.ok && /would be overwritten|commit your changes or stash/i.test(r.message ?? '')) return { ...r, message: 'Your uncommitted changes would be overwritten by this branch. Commit them (or stash them in the terminal) first.' };
      return r;
    });
  }

  // ---- watching .git -----------------------------------------------------------------------

  /**
   * Calls `cb` (debounced) when HEAD, the index or refs change — commits, checkouts, `git add` in a
   * terminal — or when a repository appears/disappears. A handful of handles, never the object store.
   * Events are checked against file stats, so access-time-only notifications (Windows) cannot loop.
   */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    if (this.listeners.size === 1) void this.startWatching();
    return () => {
      this.listeners.delete(cb);
      if (!this.listeners.size) this.stopWatching();
    };
  }

  private async startWatching() {
    const gen = ++this.watchGen; // a newer start (rediscovery) wins over one still awaiting
    const stale = () => gen !== this.watchGen || this.disposed || !this.listeners.size || this.watchers.length > 0;
    const repo = await this.repo();
    if (stale()) return;
    // Baselines first (the stats are async), then every watcher is armed in one synchronous step.
    const dotGit = path.join(this.root, '.git');
    const dirs = repo.ok ? [...new Set([repo.gitDir, repo.commonDir])] : [];
    const files = dirs.flatMap((d) => ['HEAD', 'index', 'packed-refs', 'config'].map((f) => path.join(d, f)));
    const dotGitSig = await statSig(dotGit, true);
    const fileSigs: string[] = [];
    for (const f of files) fileSigs.push(await statSig(f)); // one at a time: a hung share holds one libuv thread, not the pool
    if (stale()) return;
    const watch = (dir: string, opts: { recursive?: boolean }, accept: (name: string) => boolean) => {
      try {
        const w = fs.watch(dir, { persistent: false, recursive: !!opts.recursive }, (_t, name) => {
          const n = name == null ? '' : String(name).split(path.sep).join('/');
          if (n && !accept(n)) return;
          this.touched.add(n ? path.join(dir, n) : dir);
          this.scheduleEmit();
        });
        w.on('error', () => w.close());
        this.watchers.push(w);
      } catch {}
    };
    // `.git` appearing or vanishing in the workspace (git init / rm -rf .git).
    this.sigs.set(dotGit, dotGitSig);
    watch(this.root, {}, (n) => n === '.git');
    if (!repo.ok) return;
    for (const d of dirs) watch(d, {}, (n) => GIT_STATE_FILES.has(n));
    watch(path.join(repo.commonDir, 'refs'), { recursive: true }, (n) => !n.endsWith('.lock'));
    files.forEach((f, i) => this.sigs.set(f, fileSigs[i]));
  }

  private scheduleEmit() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.checkTouched();
    }, this.opts.watchDebounceMs ?? 300);
  }

  /** One check at a time (async stats must not interleave); a timer firing during a run gets the next one. */
  private checkTouched(): Promise<void> {
    if (!this.checkRun) {
      this.checkRun = this.checkTouchedOnce().finally(() => (this.checkRun = null));
      return this.checkRun;
    }
    this.checkNext ??= this.checkRun.catch(() => {}).then(() => {
      this.checkNext = null;
      return this.checkTouched();
    });
    return this.checkNext;
  }

  private async checkTouchedOnce() {
    const gen = this.watchGen;
    const files = [...this.touched];
    this.touched.clear(); // events arriving meanwhile belong to the next run
    const sigs: string[] = [];
    for (const f of files) sigs.push(await statSig(f, path.dirname(f) === this.root));
    if (gen !== this.watchGen) return; // stopped or re-armed meanwhile: the new baselines count
    const changed: string[] = [];
    files.forEach((f, i) => {
      if (this.sigs.get(f) !== sigs[i]) changed.push(f);
      this.sigs.set(f, sigs[i]);
    });
    if (!changed.length || this.disposed) return;
    if (changed.some((f) => f.includes(`${path.sep}refs${path.sep}`) || path.basename(f) === 'packed-refs')) this.refsGen++;
    if (changed.some((f) => path.dirname(f) === this.root || path.basename(f) === 'config' || path.basename(f) === 'config.worktree')) {
      // Repository appeared / vanished / was reconfigured: rediscover and re-arm the watchers.
      this.invalidate();
      this.stopWatching();
      if (this.listeners.size) void this.startWatching();
    }
    this.listeners.forEach((l) => {
      try {
        l();
      } catch {}
    });
  }

  private stopWatching(clearListeners = false) {
    this.watchGen++;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.sigs.clear();
    this.touched.clear();
    if (clearListeners) this.listeners.clear();
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.wsl?.dispose();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.stopWatching(true);
  }
}

/** Change signature of a file (no atime: Windows reports reads as changes). `kindOnly`: just its existence. */
async function statSig(f: string, kindOnly = false): Promise<string> {
  try {
    const st = await fsp.stat(f);
    if (kindOnly) return st.isDirectory() ? 'dir' : 'file';
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'none';
  }
}

/** fs.existsSync without blocking the main thread: false on any error. */
function exists(f: string): Promise<boolean> {
  return fsp.access(f).then(
    () => true,
    () => false,
  );
}

/** Operation in progress, from the marker files git leaves in its directory (checked one at a time, in this order). */
async function repoState(gitDir: string): Promise<GitRepoState | undefined> {
  const has = (f: string) => exists(path.join(gitDir, f));
  if ((await has('rebase-merge')) || (await has('rebase-apply'))) return 'rebase';
  if (await has('MERGE_HEAD')) return 'merge';
  if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (await has('REVERT_HEAD')) return 'revert';
  return undefined;
}

/** Where a `.git` may be: in `dir`, then in each parent, at most 64 levels. */
function* dotGitPlaces(dir: string): Generator<string> {
  // Same boundary as git's own discovery: never step up into a GIT_CEILING_DIRECTORIES entry.
  const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(Boolean).map((c) => path.resolve(c)));
  for (let d = dir, i = 0; i < 64; i++) {
    yield path.join(d, '.git');
    const up = path.dirname(d);
    if (up === d || ceilings.has(up)) return;
    d = up;
  }
}

/** A `.git` folder or file in `dir` or any parent (without git we cannot ask git). One check at a time, first hit wins. */
export async function hasDotGitAboveAsync(dir: string): Promise<boolean> {
  for (const f of dotGitPlaces(dir)) if (await exists(f)) return true;
  return false;
}

/** One `cat-file --batch` record at `at`: "<oid> <type> <size>\n<data>\n" or "<name> missing\n". */
function readBatch(buf: Buffer, at: number): { ok: true; oid: string; type: string; size: number; start: number; next: number } | { ok: false; next: number } {
  const nl = buf.indexOf(0x0a, at);
  if (nl === -1) return { ok: false, next: buf.length };
  const head = buf.subarray(at, nl).toString('utf8');
  const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(head);
  if (!m) return { ok: false, next: nl + 1 };
  const size = Number(m[3]);
  return { ok: true, oid: m[1], type: m[2], size, start: nl + 1, next: nl + 1 + size + 1 };
}

/** Block picks from the renderer: whole, non-negative line numbers and an include flag, nothing else. */
function validPicks(v: unknown): GitHunkPick[] {
  if (!Array.isArray(v) || !v.length || v.length > 10_000) throw new BackendFailure('EINVAL', 'Expected a list of blocks');
  return v.map((p) => {
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const n = (k: string) => {
      const x = o[k];
      if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 1e9) throw new BackendFailure('EINVAL', 'Invalid block');
      return x;
    };
    if (typeof o.include !== 'boolean') throw new BackendFailure('EINVAL', 'Invalid block');
    return { a0: n('a0'), a1: n('a1'), b0: n('b0'), b1: n('b1'), include: o.include };
  });
}

/** Classifies a failed git call; null when it succeeded. */
function failure(r: RunResult): GitUnavailable | null {
  if (r.error) return { ok: false, reason: r.error.code === 'ENOENT' ? 'no-git' : 'error', message: r.error.message };
  if (r.timedOut) return { ok: false, reason: 'timeout' }; // no text of its own: the UI has one sentence for it (GIT_TIMEOUT_TEXT)
  if (r.overflow) return { ok: false, reason: 'error', message: 'git output too large' };
  if (r.code === 0) return null;
  const err = r.stderr;
  if (/dubious ownership|unsafe repository|safe\.directory/i.test(err)) return { ok: false, reason: 'unsafe', message: firstLine(err) };
  if (/not a git repository|must be run in a work tree|outside repository/i.test(err)) return { ok: false, reason: 'no-repo' };
  return { ok: false, reason: 'error', message: firstLine(err) || `git exited with ${r.code}` };
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
