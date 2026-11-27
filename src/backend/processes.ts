// Process explorer, backend half ("Developer: Process explorer"). One snapshot per request while the
// explorer is open (it asks every 2 s); when it is closed nothing here runs, polls or spawns.
//   · this process (main / server): CPU from process.cpuUsage deltas, RSS, event-loop utilisation
//   · registered sources (registerProcessSource): the indexer thread + readers (service.ts), Electron's
//     app metrics + terminal shells (main/process-rows.ts) — features add their own rows the same way
//   · child processes: Linux reads /proc (no spawn); macOS one `ps` per refresh; Windows one long-lived
//     PowerShell CIM query helper, started on the first snapshot and stopped on close or after 10 s
//     without a snapshot. Inside WSL (Windows, \\wsl.localhost root): `ps` in the distro every 3rd refresh.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { performance, type EventLoopUtilization } from 'node:perf_hooks';
import { childRows, descendantsOf, parsePs, parseProcStat, parseWinProcs, toMB, type ChildInfo, type ProcRow, type ProcSnapshot } from '../shared/processes';
import { parseWslPath } from './git-wsl';
import { winSystemExe } from './winsys';

export interface ProcessSourceCtx {
  /** ms since the previous snapshot (0 on the first): for CPU % from cumulative counters. */
  intervalMs: number;
}

export interface ProcessSource {
  id: string;
  rows(ctx: ProcessSourceCtx): ProcRow[] | Promise<ProcRow[]>;
  /** Terminal shells: the child classifier shows them (and their foreground job) as terminals. */
  shellPids?(): number[];
  /** Processes the source reports itself (Electron's GPU / renderers): not listed again as children. */
  ownPids?(): number[];
}

const sources = new Map<string, ProcessSource>();

/** Extension point: add rows to the process explorer. Called only while the explorer is open. */
export function registerProcessSource(s: ProcessSource): () => void {
  sources.set(s.id, s);
  return () => void (sources.get(s.id) === s && sources.delete(s.id));
}

const HELPER_IDLE_MS = 10_000;
const isWin = process.platform === 'win32';

/**
 * The process group `pgid` may be signalled as a whole: a real group (> 1) that is not this process's own (`own`;
 * unknown = no group signal) nor that of its parent. 0 = signal the one process only.
 */
export function safeGroup(pgid: number, own: number | null): number {
  if (!Number.isInteger(pgid) || pgid <= 1 || own === null || pgid === own || pgid === process.pid || pgid === process.ppid) return 0;
  return pgid;
}

let psPath: string | undefined;
/**
 * `ps` by absolute path (POSIX): a bare name is looked up through PATH, where an empty entry means the current
 * folder. Looked up once, on the first use (the explorer, a terminal's kill), never at startup.
 */
export function posixPs(): string {
  return (psPath ??= ['/bin/ps', '/usr/bin/ps'].find((p) => fs.existsSync(p)) ?? '/bin/ps');
}

export class ProcessExplorer {
  private lastSelf: { cpu: NodeJS.CpuUsage; at: number; elu: EventLoopUtilization } | null = null;
  private cpuSamples = new Map<number, { cpuMs: number; at: number }>();
  /** pid → its process group and whether it is a terminal's foreground job (only rows this explorer offered an action for). */
  private killable = new Map<number, { pgid: number; foreground: boolean }>();
  /** This process's own group (POSIX; null = not known yet, or unknowable): never signalled. */
  private ownPgid: number | null = null;
  /** The last snapshot's children: what a stopped process started goes with it. */
  private lastChildren: ChildInfo[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private win: WinQuery | null = null;
  private wslRows: ProcRow[] = [];
  private ticks = 0;
  /** CPU ms of our own query helper since the previous snapshot (shown as part of "itself"). */
  private helperMs = 0;
  private helperCpu: number | null = null;

  /** `rows`: what only this explorer's owner knows (its backend's indexer): never a shared source, so one window's
   *  backend never lists — or keeps alive — another's. */
  constructor(private readonly opts: { root: () => string | null; rows?: (ctx: { intervalMs: number }) => Promise<ProcRow[]> | ProcRow[] }) {}

  get helperRunning(): boolean {
    return !!this.win?.alive;
  }

  async snapshot(): Promise<ProcSnapshot> {
    const c0 = process.cpuUsage();
    this.armIdle();
    const now = performance.now();
    const intervalMs = this.lastSelf ? now - this.lastSelf.at : 0;
    const notes: string[] = [];
    const rows: ProcRow[] = [this.selfRow(now)];
    const extra: ProcRow[] = [];
    if (this.opts.rows) {
      try {
        extra.push(...(await this.opts.rows({ intervalMs })));
      } catch (err) {
        notes.push(`own rows: ${(err as Error).message}`);
      }
    }
    for (const s of sources.values()) {
      try {
        extra.push(...(await s.rows({ intervalMs })));
      } catch (err) {
        notes.push(`${s.id}: ${(err as Error).message}`);
      }
    }
    // A source may describe this process better (Electron: Chromium's per-process accounting).
    for (const r of extra) {
      if (r.id === rows[0].id) Object.assign(rows[0], { ...r, busy: rows[0].busy, name: rows[0].name, kind: 'app' });
      else rows.push(r);
    }
    const shellPids = new Set<number>();
    const skip = new Set<number>();
    for (const s of sources.values()) {
      for (const p of s.shellPids?.() ?? []) shellPids.add(p);
      for (const p of s.ownPids?.() ?? []) skip.add(p);
    }
    let children: ChildInfo[] = [];
    try {
      children = await this.children(skip);
    } catch (err) {
      notes.push(`child processes: ${(err as Error).message}`);
    }
    const selfPids = new Set(this.win?.pid ? [this.win.pid] : []);
    const helper = children.find((c) => selfPids.has(c.pid));
    if (helper?.cpuMs !== undefined) {
      this.helperMs = this.helperCpu === null ? 0 : Math.max(0, helper.cpuMs - this.helperCpu);
      this.helperCpu = helper.cpuMs;
    }
    const kids = childRows(children, process.pid, { shellPids, selfPids }, (c) => this.cpuPct(c, now));
    this.killable = new Map(kids.filter((r) => r.pid && r.actions?.length).map((r) => [r.pid!, { pgid: children.find((c) => c.pid === r.pid)?.pgid ?? 0, foreground: !!r.actions?.includes('stopForeground') }]));
    this.lastChildren = children;
    rows.push(...kids);
    if (isWin) rows.push(...(await this.wslProcesses(notes)));
    for (const pid of this.cpuSamples.keys()) if (!children.some((c) => c.pid === pid)) this.cpuSamples.delete(pid);
    const used = process.cpuUsage(c0);
    const selfMs = (used.user + used.system) / 1000;
    rows.push({
      id: 'explorer',
      parent: 'main',
      kind: 'self',
      name: 'Process explorer (itself)',
      cpu: intervalMs ? ((selfMs + this.helperMs) / intervalMs) * 100 : null,
      detail: `${selfMs.toFixed(1)} ms per refresh here${this.win ? ` + query helper ${this.helperMs.toFixed(0)} ms` : ''}`,
    });
    if (isWin) notes.push('Windows: memory = private bytes; the CIM query also costs the WMI service a little CPU (not shown).');
    return { at: Date.now(), platform: process.platform, rows, selfMs, notes };
  }

  /** Stop helpers and forget samples (explorer closed, or no snapshot for 10 s). */
  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.win?.dispose();
    this.win = null;
    this.lastSelf = null;
    this.cpuSamples.clear();
    this.killable.clear();
    this.lastChildren = [];
    this.wslRows = [];
    this.ticks = 0;
    this.helperCpu = null;
    this.helperMs = 0;
  }

  /** Stop a child the explorer listed with an action (never the app or its Chromium processes). */
  kill(pid: number, group = false): boolean {
    const k = Number.isInteger(pid) && pid > 0 && pid !== process.pid ? this.killable.get(pid) : undefined;
    if (!k) return false;
    // `group` comes from the page: only a terminal's foreground job (`npm test` and what it started) goes as a group.
    // Any other child may share a group with others, One's own included (git is not started in a group of its own).
    const pgid = group && k.foreground && !isWin ? safeGroup(k.pgid, this.ownPgid) : 0;
    try {
      if (pgid) process.kill(-pgid, 'SIGTERM');
      else process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    // What it started goes too (git's ssh / credential helper would keep its pipes — and the git call — open).
    for (const d of descendantsOf(pid, this.lastChildren)) {
      try {
        if (d.pid !== process.pid) process.kill(d.pid, 'SIGTERM');
      } catch {}
    }
    return true;
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), HELPER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private selfRow(now: number): ProcRow {
    const cpu = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    const prev = this.lastSelf;
    this.lastSelf = { cpu, at: now, elu };
    const dt = prev ? now - prev.at : 0;
    return {
      id: 'main',
      name: process.versions.electron ? 'Main process' : 'Server process',
      kind: 'app',
      pid: process.pid,
      cpu: prev && dt > 0 ? ((cpu.user - prev.cpu.user + cpu.system - prev.cpu.system) / 1000 / dt) * 100 : null,
      busy: prev ? performance.eventLoopUtilization(elu, prev.elu).utilization * 100 : null,
      mem: toMB(process.memoryUsage.rss()),
      memKind: 'RSS',
      activity: ['tree'],
    };
  }

  /** % of one core since the previous snapshot, from cumulative CPU time (or the OS's own %). */
  private cpuPct(c: ChildInfo, now: number): number | null {
    if (c.cpuPct !== undefined) return c.cpuPct;
    if (c.cpuMs === undefined) return null;
    const prev = this.cpuSamples.get(c.pid);
    this.cpuSamples.set(c.pid, { cpuMs: c.cpuMs, at: now });
    return prev && now > prev.at ? (Math.max(0, c.cpuMs - prev.cpuMs) / (now - prev.at)) * 100 : null;
  }

  private async children(skip: ReadonlySet<number>): Promise<ChildInfo[]> {
    if (process.platform === 'linux') {
      if (this.ownPgid === null) {
        const self = await readText('/proc/self/stat');
        this.ownPgid = (self && parseProcStat(self)?.pgid) || null;
      }
      return linuxChildren(process.pid, skip);
    }
    if (isWin) {
      this.win ??= new WinQuery();
      return descendantsOf(process.pid, await this.win.query()).filter((c) => !skip.has(c.pid));
    }
    const all = parsePs(await run(posixPs(), ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,%cpu=,rss=,command=']));
    this.ownPgid = all.find((c) => c.pid === process.pid)?.pgid || null;
    return descendantsOf(process.pid, all).filter((c) => !skip.has(c.pid));
  }

  /** git / inotifywait running inside the workspace's WSL distro (Windows sees only wsl.exe). */
  private async wslProcesses(notes: string[]): Promise<ProcRow[]> {
    const root = this.opts.root();
    const wsl = root ? parseWslPath(root) : null;
    if (!wsl) return [];
    if (this.ticks++ % 3 === 0) {
      try {
        const out = await run(winSystemExe('wsl.exe'), ['-d', wsl.distro, '--exec', 'ps', '-e', '-o', 'pid=,ppid=,pgid=,tpgid=,%cpu=,rss=,args=']);
        const procs = parsePs(out).filter((p) => /^git$|^inotifywait$/.test(p.comm) || /\bgit\b|inotifywait/.test(p.args.split(' ')[0]));
        this.wslRows = procs.map((p) => ({ id: `wsl:${p.pid}`, parent: 'wsl', kind: 'child' as const, name: p.comm === 'inotifywait' ? 'inotifywait (folder watcher)' : `git ${p.args.split(/\s+/)[1] ?? ''}`.trim(), pid: p.pid, cpu: p.cpuPct ?? null, mem: toMB(p.memBytes), memKind: 'RSS' as const, detail: p.args.slice(0, 160) }));
      } catch (err) {
        notes.push(`WSL processes: ${(err as Error).message}`);
      }
    }
    return [{ id: 'wsl', parent: 'main', kind: 'helper', name: `Inside WSL (${wsl.distro})`, detail: 'git and folder watcher only · every 6 s' }, ...this.wslRows];
  }
}

// ---------------------------------------------------------------- Linux: /proc, no spawn

async function readText(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

let ownExe: string | null | undefined;
function exeOf(pid: number): Promise<string | null> {
  return fsp.readlink(`/proc/${pid}/exe`).catch(() => null);
}

/**
 * Descendants of `root` via /proc/<pid>/task/<tid>/children — only our tree is read, not all of /proc.
 * The app's own children (git, shells, helpers) are forked from its JS thread, so for `root` only that
 * thread's list is read (Electron's main has ~60 threads; reading all cost ~15 ms of kernel time per
 * refresh); `skip` (Chromium's processes, known from app metrics) is never opened.
 */
export async function linuxChildren(root: number, skip: ReadonlySet<number> = new Set()): Promise<ChildInfo[]> {
  ownExe ??= await exeOf(process.pid);
  const uptime = Number((await readText('/proc/uptime'))?.split(' ')[0]) || 0;
  const out: ChildInfo[] = [];
  const seen = new Set<number>([root]);
  let level = [root];
  while (level.length) {
    const next: number[] = [];
    await Promise.all(
      level.map(async (pid) => {
        const tasks = pid === root ? [String(root)] : await fsp.readdir(`/proc/${pid}/task`).catch(() => [] as string[]);
        for (const tid of tasks) {
          const kids = (await readText(`/proc/${pid}/task/${tid}/children`)) ?? '';
          for (const k of kids.split(/\s+/)) if (k && !seen.has(+k) && !skip.has(+k)) seen.add(+k), next.push(+k);
        }
      }),
    );
    const infos = await Promise.all(next.map((pid) => linuxInfo(pid, uptime)));
    level = [];
    for (const info of infos) {
      if (!info || skip.has(info.pid)) continue;
      out.push(info);
      if (!info.ownExe) level.push(info.pid); // Chromium's own helpers: not our business (app metrics)
    }
  }
  return out;
}

async function linuxInfo(pid: number, uptimeS: number): Promise<ChildInfo | null> {
  const [stat, comm, cmdline, exe] = await Promise.all([readText(`/proc/${pid}/stat`), readText(`/proc/${pid}/comm`), readText(`/proc/${pid}/cmdline`), exeOf(pid)]);
  const s = stat ? parseProcStat(stat) : null;
  if (!s) return null;
  const args = (cmdline ?? '').split('\0').filter(Boolean).join(' ');
  return { ...s, comm: (comm ?? '').trim() || args.split(' ')[0] || String(pid), args, memKind: 'RSS', ageMs: uptimeS ? Math.max(0, (uptimeS - s.startTicks / 100) * 1000) : undefined, ownExe: !!exe && exe === ownExe };
}

// ---------------------------------------------------------------- Windows: one query helper

/** One long-lived PowerShell running a CIM query per request: far cheaper than a process per refresh. */
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$in = [Console]::In',
  'while (($line = $in.ReadLine()) -ne $null) {',
  '  Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,CommandLine | ForEach-Object {',
  '    "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.WorkingSetSize)`t$($_.PrivatePageCount)`t$($_.KernelModeTime)`t$($_.UserModeTime)`t$(($_.CommandLine -replace \'\\s+\', \' \'))"',
  '  }',
  "  '<<END>>'",
  '}',
].join('\n');

class WinQuery {
  private p: ChildProcess | null = null;
  private buf = '';
  private waiting: ((out: string) => void) | null = null;
  alive = false;
  get pid() {
    return this.p?.pid ?? 0;
  }
  private start() {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    this.p = spawn(winSystemExe('powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.alive = true;
    this.p.stdout!.setEncoding('utf8');
    this.p.stdout!.on('data', (d: string) => {
      this.buf += d;
      const end = this.buf.indexOf('<<END>>');
      if (end < 0) return;
      const out = this.buf.slice(0, end);
      this.buf = this.buf.slice(end + 7);
      const w = this.waiting;
      this.waiting = null;
      w?.(out);
    });
    this.p.on('exit', () => {
      this.alive = false;
      this.p = null;
      this.waiting?.('');
      this.waiting = null;
    });
  }
  query(): Promise<ChildInfo[]> {
    if (!this.p) this.start();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting = null;
        this.dispose(); // wedged: a fresh one next time
        reject(new Error('process query timed out'));
      }, 5000);
      this.waiting = (out) => {
        clearTimeout(t);
        resolve(parseWinProcs(out));
      };
      this.p!.stdin!.write('q\n');
    });
  }
  dispose() {
    this.alive = false;
    try {
      this.p?.stdin?.end();
      this.p?.kill();
    } catch {}
    this.p = null;
  }
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: 5000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))),
  );
}
