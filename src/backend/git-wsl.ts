// WSL-aware git. A Windows app reading a repository at \\wsl.localhost\<distro>\… with Windows git.exe
// crawls over the 9P bridge (and trips safe.directory). Instead git runs INSIDE the distro:
//   wsl.exe -d <distro> --cd <linux path> --exec env GIT_…=… git <args>   (no shell, args verbatim)
// A persistent helper (`wsl.exe -d <distro> --exec sh -s`, fed a small POSIX script) runs the frequent
// read commands without paying wsl.exe's start-up (~50–150 ms) per call; per-call wsl.exe is the fallback.
//
// Pure parts (path translation, command lines, framing) are unit-tested on Linux with a fake `wsl`.
// Needs a real Windows check: wsl.exe argument handling, helper start-up / teardown, killing a git that
// runs inside the distro when wsl.exe is killed, fs.watch on \\wsl.localhost paths.
import { spawn } from 'node:child_process';
import type { RunResult } from './git';
import { winSystemExe } from './winsys';

export interface WslPath {
  distro: string;
  /** Absolute Linux path ("/home/me/repo"). */
  linux: string;
  /** "wsl.localhost" or "wsl$" (kept for translating back). */
  host: string;
}

const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `\\wsl.localhost\Ubuntu-22.04\home\me\repo` (or `\\wsl$\…`, forward slashes, any case) → distro + Linux path. */
export function parseWslPath(p: string): WslPath | null {
  const m = /^[\\/]{2}(wsl\.localhost|wsl\$)[\\/]+([^\\/]+)((?:[\\/].*)?)$/i.exec(p);
  if (!m || !DISTRO.test(m[2])) return null;
  const rest = m[3].replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  return { host: m[1].toLowerCase() === 'wsl$' ? 'wsl$' : 'wsl.localhost', distro: m[2], linux: rest || '/' };
}

/** Linux path inside `distro` → the Windows UNC path for it. */
export function toUncPath(w: Pick<WslPath, 'distro' | 'host'>, linux: string): string {
  return `\\\\${w.host}\\${w.distro}${linux.replace(/\//g, '\\')}`.replace(/\\$/, '');
}

/** `net use` output → drive letter (upper case, "Z:") → UNC root, for drives mapped to \\wsl$ shares. */
export function parseNetUse(out: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /\b([A-Za-z]:)\s+(\\\\wsl(?:\.localhost|\$)\\[^\s]+)/i.exec(line);
    if (m) map.set(m[1].toUpperCase(), m[2]);
  }
  return map;
}

/** A path on a drive letter mapped to a WSL share → the UNC form (best effort, from `net use`). */
export function resolveMappedDrive(p: string, drives: Map<string, string>): string | null {
  const m = /^([A-Za-z]:)([\\/].*)?$/.exec(p);
  const root = m && drives.get(m[1].toUpperCase());
  return root ? root + (m![2] ?? '').replace(/\//g, '\\') : null;
}

/** What git needs inside the distro (WSLENV would also work, but `env` keeps it explicit). */
export const WSL_GIT_ENV = ['GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0', 'GCM_INTERACTIVE=never', 'GIT_PAGER=cat', 'LC_ALL=C'];

/** Arguments for one per-call `wsl.exe` run of git (no shell anywhere: git gets `args` verbatim). */
export function wslGitArgs(distro: string, cwd: string, args: readonly string[], opts: { env?: readonly string[]; extraEnv?: readonly string[]; low?: boolean; net?: boolean } = {}): string[] {
  const env = opts.env ?? (opts.net ? WSL_GIT_ENV.filter((e) => !e.startsWith('GCM_INTERACTIVE=')) : WSL_GIT_ENV);
  return ['-d', distro, '--cd', cwd, '--exec', 'env', ...env, ...(opts.extraEnv ?? []), ...(opts.low ? ['nice', '-n', '10'] : []), 'git', ...args];
}

// ---- persistent helper ----------------------------------------------------------------------------
// Request (one line): `<id> <cwd> <args> <stdin> [<env>]` — each field base64 (args / env: comma-separated,
// one per item; '-' for no stdin; env = extra NAME=value for this call only). Response: `<id> <exit> <outBytes> <errBytes>\n` then the raw stdout and
// stderr bytes. Fields are base64, so paths with spaces / unicode / newlines-free arbitrary bytes are safe.

export const HELPER_SCRIPT = [
  `export ${WSL_GIT_ENV.join(' ')}`,
  'command -v git >/dev/null 2>&1 || { echo "NOGIT"; exit 3; }',
  'd=$(mktemp -d) || exit 1',
  `trap 'rm -rf "$d"' EXIT`,
  `dec() { printf '%s' "$1" | base64 -d; }`,
  'echo READY',
  'while read -r id cwd args input envs; do',
  '  set --',
  '  o=$IFS; IFS=,',
  '  for a in $args; do IFS=$o; if [ "$a" = "-" ]; then set -- "$@" ""; else set -- "$@" "$(dec "$a")"; fi; IFS=,; done',
  '  IFS=$o',
  `  if [ "$input" = "-" ]; then : > "$d/in"; else dec "$input" > "$d/in"; fi`,
  '  (cd "$(dec "$cwd")" || exit 1; o=$IFS; IFS=,; for e in $envs; do IFS=$o; export "$(dec "$e")"; IFS=,; done; IFS=$o; exec git "$@") < "$d/in" > "$d/out" 2> "$d/err"',
  '  rc=$?',
  `  printf '%s %s %s %s\\n' "$id" "$rc" "$(wc -c < "$d/out" | tr -d ' ')" "$(wc -c < "$d/err" | tr -d ' ')"`,
  '  cat "$d/out" "$d/err"',
  'done',
  '',
].join('\n');

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

export function encodeRequest(id: number, cwd: string, args: readonly string[], input?: string | Buffer, env?: readonly string[]): string {
  if (args.some((a) => /[\n\r]/.test(a)) || /[\n\r]/.test(cwd)) throw new Error('Line breaks are not allowed in git arguments');
  if (env?.some((e) => !/^[A-Z_][A-Z0-9_]*=[^\n\r]*$/.test(e))) throw new Error('Invalid environment entry');
  const extra = env?.length ? ` ${env.map(b64).join(',')}` : '';
  return `${id} ${b64(cwd)} ${args.map((a) => b64(a) || '-').join(',')} ${input?.length ? b64(input) : '-'}${extra}\n`;
}

export interface Frame {
  id: number;
  code: number;
  stdout: Buffer;
  stderr: string;
  /** stdout was larger than the caller's cap (not kept). */
  overflow?: boolean;
}

/** Incremental parser for the helper's output stream. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private head: { id: number; code: number; out: number; err: number } | null = null;
  ready = false;
  noGit = false;
  constructor(
    private onFrame: (f: Frame) => void,
    private maxOut: (id: number) => number = () => Infinity,
  ) {}

  push(chunk: Buffer) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (!this.head) {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString('utf8').trim();
        this.buf = this.buf.subarray(nl + 1);
        if (line === 'READY') {
          this.ready = true;
          continue;
        }
        if (line === 'NOGIT') {
          this.noGit = true;
          continue;
        }
        const m = /^(\d+) (\d+) (\d+) (\d+)$/.exec(line);
        if (!m) continue; // noise (login banners…)
        this.head = { id: Number(m[1]), code: Number(m[2]), out: Number(m[3]), err: Number(m[4]) };
      }
      const h = this.head;
      if (this.buf.length < h.out + h.err) return;
      const over = h.out > this.maxOut(h.id);
      const stdout = over ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(0, h.out));
      const stderr = this.buf.subarray(h.out, h.out + h.err).toString('utf8');
      this.buf = this.buf.subarray(h.out + h.err);
      this.head = null;
      this.onFrame({ id: h.id, code: h.code, stdout, stderr, ...(over ? { overflow: true } : {}) });
    }
  }
}

// ---- runner ---------------------------------------------------------------------------------------

export interface WslRunnerOptions {
  /** wsl.exe (default: %SystemRoot%\System32\wsl.exe). Tests pass a fake. */
  exe?: string;
  /** Use the persistent helper (default true). */
  helper?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface WslRunOptions {
  /** Linux working directory. */
  cwd: string;
  timeoutMs: number;
  maxBytes: number;
  input?: string | Buffer;
  signal?: AbortSignal;
  low?: boolean;
  /** Long-running / interactive-ish commands (push, commit hooks): never through the helper. */
  direct?: boolean;
  /** Network: let the credential manager show its window (no GCM_INTERACTIVE=never). */
  net?: boolean;
  /** Extra NAME=value for this call (trace2 counters for status). */
  env?: readonly string[];
}

export function defaultWslExe(env: NodeJS.ProcessEnv = process.env): string {
  return winSystemExe('wsl.exe', env);
}

interface Pending {
  id: number;
  resolve: (r: RunResult) => void;
  timer: NodeJS.Timeout;
  maxBytes: number;
  t0: number;
}

/** A long-lived `sh -s` inside the distro answering framed git requests, one at a time. */
class Helper {
  private child: ReturnType<typeof spawn>;
  private parser: FrameParser;
  private pending = new Map<number, Pending>();
  private next = 1;
  dead = false;
  readonly started: Promise<boolean>;

  constructor(exe: string, distro: string, low: boolean, env: NodeJS.ProcessEnv) {
    const args = ['-d', distro, '--exec', ...(low ? ['nice', '-n', '10'] : []), 'sh', '-s'];
    this.child = spawn(exe, args, { windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let ready!: (ok: boolean) => void;
    this.started = new Promise<boolean>((r) => (ready = r));
    const startTimer = setTimeout(() => (this.kill(), ready(false)), 15_000);
    this.parser = new FrameParser(
      (f) => {
        const p = this.pending.get(f.id);
        if (!p) return;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        p.resolve({ code: f.code, stdout: f.stdout, stderr: f.stderr, timedOut: false, overflow: !!f.overflow });
      },
      (id) => this.pending.get(id)?.maxBytes ?? Infinity,
    );
    this.child.stdout!.on('data', (c: Buffer) => {
      const was = this.parser.ready;
      this.parser.push(c);
      if (!was && this.parser.ready) (clearTimeout(startTimer), ready(true));
      if (this.parser.noGit) (clearTimeout(startTimer), ready(false), this.kill());
    });
    this.child.stderr!.on('data', () => {});
    this.child.on('error', () => (clearTimeout(startTimer), ready(false), this.fail()));
    this.child.on('close', () => (clearTimeout(startTimer), ready(false), this.fail()));
    this.child.stdin!.on('error', () => {});
    this.child.stdin!.write(HELPER_SCRIPT);
  }

  run(cwd: string, args: readonly string[], o: WslRunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      const id = this.next++;
      const timer = setTimeout(() => {
        // A sequential helper cannot drop one request: restart it (the others retry per call).
        this.pending.delete(id);
        resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: true, overflow: false });
        this.kill();
      }, o.timeoutMs);
      this.pending.set(id, { id, resolve, timer, maxBytes: o.maxBytes, t0: Date.now() });
      try {
        this.child.stdin!.write(encodeRequest(id, cwd, args, o.input, o.env));
      } catch {
        this.fail();
      }
    });
  }

  /** Pending requests come back as spawn failures: the runner retries them per call. */
  private fail() {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, overflow: false, error: Object.assign(new Error('helper stopped'), { code: 'EHELPER' }) });
    }
    this.pending.clear();
  }

  kill() {
    this.fail();
    try {
      this.child.kill();
    } catch {}
  }
}

/** git inside one WSL distro: helper for quick reads, per-call wsl.exe for the rest and as fallback. */
export class WslGit {
  private helpers: { high: Helper | null; low: Helper | null } = { high: null, low: null };
  private helperDownUntil = 0;
  readonly exe: string;

  constructor(
    readonly distro: string,
    private readonly opts: WslRunnerOptions,
    private readonly direct: (exe: string, args: string[], o: { timeoutMs: number; maxBytes: number; input?: string | Buffer; signal?: AbortSignal; env: NodeJS.ProcessEnv }) => Promise<RunResult>,
  ) {
    this.exe = opts.exe ?? defaultWslExe(opts.env);
  }

  /** Does the distro have git? (docker-desktop does not.) */
  async available(): Promise<boolean> {
    const r = await this.direct(this.exe, ['-d', this.distro, '--exec', 'sh', '-c', 'command -v git'], { timeoutMs: 15_000, maxBytes: 4096, env: this.opts.env ?? process.env });
    return r.code === 0 && /git/.test(r.stdout.toString('utf8'));
  }

  private helper(low: boolean): Helper | null {
    if (this.opts.helper === false || Date.now() < this.helperDownUntil) return null;
    const k = low ? 'low' : 'high';
    let h = this.helpers[k];
    if (!h || h.dead) {
      h = new Helper(this.exe, this.distro, low, this.opts.env ?? process.env);
      this.helpers[k] = h;
      void h.started.then((ok) => {
        if (!ok) this.helperDownUntil = Date.now() + 30_000; // retry later; per call meanwhile
      });
    }
    return h;
  }

  async run(args: readonly string[], o: WslRunOptions): Promise<RunResult> {
    // timeoutMs 0 = never killed (index refresh: a killed git can leave index.lock behind) → per call only.
    const viaHelper = !o.direct && o.timeoutMs > 0 && !o.signal?.aborted ? this.helper(!!o.low) : null;
    if (viaHelper && (await viaHelper.started)) {
      const onAbort = () => viaHelper.kill();
      o.signal?.addEventListener('abort', onAbort, { once: true });
      const r = await viaHelper.run(o.cwd, args, o);
      o.signal?.removeEventListener('abort', onAbort);
      if (o.signal?.aborted) return { ...r, aborted: true };
      if (!(r.error as { code?: string } | undefined)?.code?.startsWith('EHELPER')) return r;
    }
    return this.direct(this.exe, wslGitArgs(this.distro, o.cwd, args, { low: o.low, net: o.net, extraEnv: o.env }), { timeoutMs: o.timeoutMs, maxBytes: o.maxBytes, input: o.input, signal: o.signal, env: this.opts.env ?? process.env });
  }

  dispose() {
    this.helpers.high?.kill();
    this.helpers.low?.kill();
  }
}
