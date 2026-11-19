// Read-only git service (tier 1): status, branch, file content at HEAD, diff, and a cheap `.git` watcher.
// Runs the user's own `git` executable, so their config, SSH keys and credential manager apply.
//
// Safety rules (nothing here may mutate a repository or run repository-supplied programs):
//  - only read commands; GIT_OPTIONAL_LOCKS=0 so `status` never rewrites the index (→ no index hooks);
//  - `core.fsmonitor` is forced off and filter drivers defined in the repo's *own* config are neutralised:
//    a downloaded folder with a hostile `.git/config` must not get code execution by being opened;
//  - `diff` runs with --no-ext-diff --no-textconv;
//  - git is resolved to an absolute path ourselves: Windows' search order would otherwise run a `git.exe`
//    sitting in the (untrusted) workspace folder;
//  - every renderer-supplied path goes through the workspace containment rules (pathsafe.resolveInside);
//  - timeouts + output caps on every call; no terminal prompts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  GIT_REV_RE,
  type GitActionResult,
  type GitBranch,
  type GitBranchList,
  type GitCommitFiles,
  type GitJobError,
  type GitJobTag,
  type GitLogPage,
  type GitEntry,
  type GitFileState,
  type GitHeadFile,
  type GitRepoState,
  type GitStatus,
  type GitStatusResult,
  type GitUnavailable,
} from '../shared/git';
import { BRANCH_FORMAT, LOG_FORMAT, gitMessage, isAuthError, parseBranches, parseLog, parseNameStatus, terminalCommand } from './git-ops';
import { normalize } from '../shared/paths';
import { BackendFailure } from './errors';
import { resolveInside } from './pathsafe';
import { decode, toLf } from './textcodec';

type PlatformPath = typeof path.posix;

/** Blobs above this are not diffed in the renderer. */
export const GIT_MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_STATUS_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
export const GIT_MAX_ENTRIES = 50_000;
const MIN_VERSION: [number, number] = [2, 18]; // porcelain v2, --absolute-git-dir, --ignored=matching
const T_QUICK = 5_000;
const T_STATUS = 20_000;
const T_READ = 10_000;
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

const exeCache = new Map<string, { at: number; p: Promise<GitExecutable | null> }>();

/** First working git (cached; a miss is retried after a minute, in case git was just installed). */
export function locateGit(opts: { gitPath?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): Promise<GitExecutable | null> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const key = `${opts.gitPath ?? ''}\u0000${platform}\u0000${envGet(env, 'PATH') ?? ''}`;
  const hit = exeCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = (async () => {
    const list = opts.gitPath ? [opts.gitPath] : gitCandidates(platform, env);
    for (const cand of list) {
      if (!opts.gitPath && !isFile(cand)) continue;
      const r = await run(cand, ['--version'], { cwd: undefined, env: gitEnv(env), timeoutMs: T_QUICK, maxBytes: 4096 });
      const v = r.code === 0 ? parseGitVersion(r.stdout.toString('utf8')) : null;
      if (v && atLeast(v, ...MIN_VERSION)) return { path: cand, version: v };
    }
    return null;
  })();
  exeCache.set(key, { at: Date.now(), p });
  p.then((r) => r || exeCache.set(key, { at: Date.now() - 50_000, p })); // misses expire sooner
  return p;
}

function isFile(f: string): boolean {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

// ---- running git ----------------------------------------------------------------------------

/** Variables that would point git at another repository than the folder we ask about. */
const REPO_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG_PARAMETERS'];

export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!REPO_ENV.includes(k.toUpperCase())) env[k] = v;
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
  timeoutMs: number;
  maxBytes: number;
  input?: string;
  /** POSIX: own session, no controlling terminal — ssh cannot block on a passphrase prompt in the
   *  terminal Electron was started from. Killed as a group on timeout. */
  detached?: boolean;
  /** Kills the process when aborted (cancelled background job). */
  signal?: AbortSignal;
  /** Below-normal OS priority: background lists must not steal CPU / disk from status and diffs. */
  low?: boolean;
}

export function run(git: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, overflow: false, aborted: true });
    let child: ReturnType<typeof spawn>;
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
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
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
      } else chunks.push(c);
    });
    child.stderr!.on('data', (c: Buffer) => {
      if (stderr.length < 8192) stderr += c.toString('utf8');
    });
    child.on('error', (e) => (error = e));
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
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
 * `git status --porcelain=v2 -z --branch` → branch + entries with workspace-relative paths.
 * Git prints paths relative to the repository root; `prefix` ("docs/" or "") is the workspace folder
 * inside the repository, entries outside it are dropped.
 */
export function parsePorcelainV2(out: string, prefix = '', maxEntries = GIT_MAX_ENTRIES): ParsedStatus {
  const branch: GitBranch = { head: null, oid: null, detached: false, upstream: null, ahead: 0, behind: 0 };
  const entries: GitEntry[] = [];
  let truncated = false;
  const pre = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
  const toWs = (p: string): { path: string; dir: boolean } | null => {
    const dir = p.endsWith('/');
    const clean = dir ? p.slice(0, -1) : p;
    if (!pre) return { path: clean, dir };
    if (clean + '/' === pre) return { path: '', dir }; // the workspace folder itself (untracked/ignored as a whole)
    if (!clean.startsWith(pre)) return null;
    return { path: clean.slice(pre.length), dir };
  };
  const push = (e: GitEntry) => {
    if (entries.length >= maxEntries) truncated = true;
    else entries.push(e);
  };
  const recs = out.split('\0');
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === '#') {
      const line = rec.replace(/\r$/, '');
      const sp = line.indexOf(' ', 2);
      const key = sp === -1 ? line.slice(2) : line.slice(2, sp);
      const val = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') {
        branch.detached = val === '(detached)';
        branch.head = branch.detached ? null : val;
      } else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) [branch.ahead, branch.behind] = [Number(m[1]), Number(m[2])];
      }
      continue;
    }
    if (rec[1] !== ' ') continue; // unknown record type: be lenient
    if (kind === '?' || kind === '!') {
      const ws = toWs(rec.slice(2));
      if (ws) push({ path: ws.path, state: kind === '?' ? 'untracked' : 'ignored', ...(ws.dir ? { dir: true } : {}) });
      continue;
    }
    if (kind === '1' || kind === '2' || kind === 'u') {
      const parsed = fieldsAndPath(rec, kind === '1' ? 8 : kind === '2' ? 9 : 10);
      const orig = kind === '2' ? recs[++i] : undefined; // -z: the rename source is its own field
      if (!parsed) continue;
      const ws = toWs(parsed.path);
      if (!ws) continue;
      const [xy, sub] = parsed.f.slice(1, 3);
      const e: GitEntry = { path: ws.path, ...stateOf(xy) };
      if (kind === 'u') e.state = 'conflicted';
      else if (kind === '2') {
        if (xy[0] === 'R' && e.state !== 'deleted') e.state = 'renamed';
        const from = orig !== undefined ? toWs(orig) : null;
        e.from = from ? from.path : null;
      }
      if (sub?.[0] === 'S') {
        e.submodule = true;
        if (e.state !== 'conflicted' && e.state !== 'deleted' && e.state !== 'added') e.state = 'modified';
      }
      push(e);
    }
  }
  return { branch, entries, truncated };
}

// ---- repository-local config that would run programs ---------------------------------------

/**
 * `-c` overrides that neutralise filter drivers defined in the repository's own config
 * (`git config --local --includes -z --get-regexp '^filter\..*\.(clean|smudge|process)$'` output).
 * Git LFS is common and benign, so its drivers stay active (LFS files would otherwise look modified).
 */
export function untrustedFilterOverrides(localConfigZ: string): string[] {
  const names = new Set<string>();
  for (const rec of localConfigZ.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl === -1 ? rec : rec.slice(0, nl);
    const value = nl === -1 ? '' : rec.slice(nl + 1);
    const m = /^filter\.(.+)\.(clean|smudge|process)$/i.exec(key);
    if (!m) continue;
    if (/^\s*git[- ]lfs(\.exe)?\s/i.test(value + ' ')) continue;
    names.add(m[1]);
  }
  const out: string[] = [];
  for (const n of names) out.push('-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`);
  return out;
}

// ---- service --------------------------------------------------------------------------------

export interface GitServiceOptions {
  /** Use exactly this executable (tests: a missing path simulates "git not installed"). */
  gitPath?: string;
  /** Environment for git (default process.env; tests isolate the user's global config). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Debounce for `.git` change notifications. */
  watchDebounceMs?: number;
  /** Timeout for background lists (branches / history / commit files). */
  lowTimeoutMs?: number;
}

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
}

const LF_POINTER = 'version https://git-lfs.github.com/spec/v1';
// Files whose change means "re-read status / branch". Lock files are skipped: their rename produces the real name.
const GIT_STATE_FILES = new Set(['HEAD', 'index', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'FETCH_HEAD', 'packed-refs', 'config', 'rebase-merge', 'rebase-apply']);

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
  private disposed = false;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly root: string,
    private readonly opts: GitServiceOptions = {},
  ) {
    this.root = path.resolve(root);
    this.platform = opts.platform ?? process.platform;
    this.env = gitEnv(opts.env ?? process.env);
  }

  /** Repository facts for the workspace (cached; re-checked when it was not a repo a moment ago). */
  private repo(): Promise<Repo | GitUnavailable> {
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

  /** Forget cached repository facts (`.git` appeared / vanished, config changed). */
  invalidate() {
    this.repoP = null;
  }

  private async discover(): Promise<Repo | GitUnavailable> {
    const git = await locateGit({ gitPath: this.opts.gitPath, platform: this.platform, env: this.opts.env ?? process.env });
    if (!git) return { ok: false, reason: 'no-git', ...(hasDotGitAbove(this.root) ? { repoLikely: true } : {}) };
    const r = await run(git.path, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir', '--git-common-dir'], { cwd: this.root, env: this.env, timeoutMs: T_QUICK, maxBytes: 64 * 1024 });
    const fail = failure(r);
    if (fail) return fail;
    const [toplevel, prefix, gitDir, common] = r.stdout.toString('utf8').replace(/\r/g, '').split('\n');
    if (!toplevel || !gitDir) return { ok: false, reason: 'no-repo' };
    const commonDir = path.resolve(this.root, common || gitDir);
    const base = ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=', '-c', 'status.relativePaths=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false'];
    const cfg = await run(git.path, ['config', '--local', '--includes', '-z', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'], { cwd: this.root, env: this.env, timeoutMs: T_QUICK, maxBytes: 256 * 1024 });
    if (cfg.code === 0) base.push(...untrustedFilterOverrides(cfg.stdout.toString('utf8')));
    return { ok: true, git, toplevel: path.resolve(toplevel), prefix: prefix ?? '', gitDir: path.resolve(gitDir), commonDir, base };
  }

  private git(repo: Repo, args: string[], o: { timeoutMs: number; maxBytes: number; input?: string }) {
    return run(repo.git.path, [...repo.base, ...args], { cwd: this.root, env: this.env, ...o });
  }

  /** Branch + changed paths. Concurrent callers share a run; a call during a run gets the next one. */
  status(): Promise<GitStatusResult> {
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
    const args = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=normal', '--ignored=matching', '--ignore-submodules=dirty', '--', '.'];
    const r = await this.git(repo, args, { timeoutMs: T_STATUS, maxBytes: MAX_STATUS_BYTES });
    const fail = failure(r);
    if (fail) {
      if (fail.reason === 'no-repo') this.invalidate(); // .git was removed
      return fail;
    }
    const parsed = parsePorcelainV2(r.stdout.toString('utf8'), repo.prefix);
    const out: GitStatus = { ok: true, branch: parsed.branch, entries: parsed.entries, prefix: repo.prefix, ms: Math.round(performance.now() - t0) };
    if (parsed.truncated) out.truncated = true;
    const state = repoState(repo.gitDir);
    if (state) out.state = state;
    return out;
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
    if (r.blob === 'missing' && r.oid && (this.platform === 'win32' || this.platform === 'darwin')) {
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

  // ---- tier 2: source control (mutating) ----------------------------------------------------
  // These run with the user's full configuration — hooks and filters included: they are what the
  // user asked for. Only `core.quotepath` is forced, for parsing. One mutation at a time (index.lock).

  private chain: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  private async needRepo(): Promise<Repo | GitActionResult> {
    const repo = await this.repo();
    if (repo.ok) return repo;
    const why: Record<string, string> = { 'no-git': 'git was not found', 'no-repo': 'This folder is not a git repository', unsafe: 'git refuses this repository (safe.directory)', timeout: 'git took too long' };
    return { ok: false, message: repo.message || why[repo.reason] || 'git is not available' };
  }

  /** Runs a mutating git command and turns its outcome into an action result. */
  private async act(repo: Repo, args: string[], o: { input?: string; timeoutMs?: number; net?: boolean; ok?: string; explain?: (text: string) => string | null } = {}): Promise<GitActionResult> {
    const env = o.net ? { ...this.env } : this.env;
    if (o.net) delete env.GCM_INTERACTIVE; // the credential manager's own window is fine; terminal prompts are not
    const r = await run(repo.git.path, ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
      cwd: this.root,
      env,
      timeoutMs: o.timeoutMs ?? 60_000,
      maxBytes: 4 * 1024 * 1024,
      input: o.input,
      detached: o.net,
    });
    if (r.error) return { ok: false, message: r.error.message };
    const text = r.stderr + (r.stderr && r.stdout.length ? '\n' : '') + r.stdout.toString('utf8');
    if (r.timedOut) return { ok: false, message: 'git took too long and was stopped', ...(o.net ? { terminal: terminalCommand(args), auth: true } : {}) };
    if (r.code === 0) return { ok: true, message: o.ok ?? gitMessage(text, 2) };
    const plain = o.explain?.(text);
    if (plain) return { ok: false, message: plain };
    const msg = gitMessage(text) || `git ${args[0]} failed`;
    if (o.net && isAuthError(text)) return { ok: false, auth: true, message: msg, terminal: terminalCommand(args) };
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
    return this.serial(() => this.act(repo, c.args, { input: c.input }));
  }

  async unstage(paths: unknown): Promise<GitActionResult> {
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const specs = this.specs(repo, paths);
    return this.serial(async () => {
      const head = await this.hasHead(repo);
      const verb = !head ? ['rm', '--cached', '-r', '-q', '--ignore-unmatch'] : atLeast(repo.git.version, 2, 23) ? ['restore', '--staged'] : ['reset', '-q'];
      const c = this.withSpecs(repo, verb, specs);
      return this.act(repo, c.args, { input: c.input });
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
        const r = await this.act(repo, c.args, { input: c.input });
        if (!r.ok) return r;
      }
      for (const p of loose) await trash(p);
      return { ok: true, message: `Discarded ${tracked.length + loose.length} ${tracked.length + loose.length === 1 ? 'change' : 'changes'}` };
    });
  }

  async commit(opts: unknown): Promise<GitActionResult> {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { message?: unknown; amend?: unknown };
    const message = typeof o.message === 'string' ? o.message.replace(/\0/g, '').replace(/\r\n?/g, '\n') : '';
    if (message.length > 200_000) throw new BackendFailure('EINVAL', 'Commit message is too long');
    const amend = o.amend === true;
    const repo = await this.needRepo();
    if (!('base' in repo)) return repo;
    const merging = repoState(repo.gitDir) === 'merge';
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
      args = ['push', '-u', remotes.includes('origin') ? 'origin' : remotes[0], s.branch.head];
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
  }

  /** git for a background job: low priority, killable, its own timeout. */
  private bg(repo: Repo, args: string[], signal: AbortSignal, maxBytes: number) {
    return run(repo.git.path, [...repo.base, ...args], { cwd: this.root, env: this.env, timeoutMs: this.opts.lowTimeoutMs ?? T_LOW, maxBytes, signal, low: true });
  }

  private static jobError(r: RunResult): { error: GitJobError; message?: string } | null {
    if (r.aborted) return { error: 'cancelled' };
    if (r.timedOut) return { error: 'timeout', message: 'git took too long' };
    if (r.code !== 0 || r.overflow || r.error) return { error: 'failed', message: firstLine(r.stderr) || r.error?.message || 'git failed' };
    return null;
  }

  /** Local branches, then remote ones, each most recently committed first; capped at BRANCH_CAP. */
  branches(): Promise<GitBranchList> {
    const none = (error: GitJobError): GitBranchList => ({ branches: [], remotes: [], error });
    return this.background(
      'branches',
      async (signal) => {
        const repo = await this.repo();
        if (!repo.ok) return { branches: [], remotes: [] };
        const r = await this.bg(repo, ['for-each-ref', '--sort=-committerdate', `--count=${BRANCH_CAP + 1}`, `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], signal, 16 * 1024 * 1024);
        const fail = GitService.jobError(r);
        if (fail) return { ...none(fail.error), message: fail.message };
        let list = parseBranches(r.stdout.toString('utf8'));
        const truncated = list.length > BRANCH_CAP;
        if (truncated) list = list.slice(0, BRANCH_CAP);
        const out: GitBranchList = { branches: [...list.filter((b) => !b.remote), ...list.filter((b) => b.remote)], remotes: await this.remotes(repo) };
        if (truncated) out.truncated = true;
        return out;
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
    const repo = await this.repo();
    if (gen !== this.watchGen || this.disposed || !this.listeners.size || this.watchers.length) return;
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
    const dotGit = path.join(this.root, '.git');
    this.sigs.set(dotGit, statSig(dotGit, true));
    watch(this.root, {}, (n) => n === '.git');
    if (!repo.ok) return;
    const dirs = [...new Set([repo.gitDir, repo.commonDir])];
    for (const d of dirs) watch(d, {}, (n) => GIT_STATE_FILES.has(n));
    watch(path.join(repo.commonDir, 'refs'), { recursive: true }, (n) => !n.endsWith('.lock'));
    for (const d of dirs) for (const f of ['HEAD', 'index', 'packed-refs', 'config']) this.sigs.set(path.join(d, f), statSig(path.join(d, f)));
  }

  private scheduleEmit() {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      const changed: string[] = [];
      for (const f of this.touched) {
        const s = statSig(f, path.dirname(f) === this.root);
        if (this.sigs.get(f) !== s) changed.push(f);
        this.sigs.set(f, s);
      }
      this.touched.clear();
      if (!changed.length || this.disposed) return;
      if (changed.some((f) => path.dirname(f) === this.root || path.basename(f) === 'config')) {
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
    }, this.opts.watchDebounceMs ?? 150);
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
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.stopWatching(true);
  }
}

/** Change signature of a file (no atime: Windows reports reads as changes). `kindOnly`: just its existence. */
function statSig(f: string, kindOnly = false): string {
  try {
    const st = fs.statSync(f);
    if (kindOnly) return st.isDirectory() ? 'dir' : 'file';
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return 'none';
  }
}

/** Operation in progress, from the marker files git leaves in its directory. */
function repoState(gitDir: string): GitRepoState | undefined {
  const has = (f: string) => fs.existsSync(path.join(gitDir, f));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return undefined;
}

/** A `.git` folder or file in `dir` or any parent (without git we cannot ask git). */
function hasDotGitAbove(dir: string): boolean {
  // Same boundary as git's own discovery: never step up into a GIT_CEILING_DIRECTORIES entry.
  const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? '').split(path.delimiter).filter(Boolean).map((c) => path.resolve(c)));
  for (let d = dir, i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d || ceilings.has(up)) return false;
    d = up;
  }
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

/** Classifies a failed git call; null when it succeeded. */
function failure(r: RunResult): GitUnavailable | null {
  if (r.error) return { ok: false, reason: r.error.code === 'ENOENT' ? 'no-git' : 'error', message: r.error.message };
  if (r.timedOut) return { ok: false, reason: 'timeout', message: 'git took too long' };
  if (r.overflow) return { ok: false, reason: 'error', message: 'git output too large' };
  if (r.code === 0) return null;
  const err = r.stderr;
  if (/dubious ownership|unsafe repository|safe\.directory/i.test(err)) return { ok: false, reason: 'unsafe', message: firstLine(err) };
  if (/not a git repository|must be run in a work tree|outside repository/i.test(err)) return { ok: false, reason: 'no-repo' };
  return { ok: false, reason: 'error', message: firstLine(err) || `git exited with ${r.code}` };
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim() ?? '';
