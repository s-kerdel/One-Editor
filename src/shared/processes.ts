// "Developer: Process explorer": what runs in the editor and what it costs. Rows come from the
// backend (main / server process, its threads, child processes) and from the UI (renderer workers).
// Pure helpers here (parsing, tree order, text export): unit-tested, shared by both sides.

export type ProcKind = 'app' | 'thread' | 'worker' | 'child' | 'helper' | 'self';
export type ProcAction = 'kill' | 'stopGit' | 'stopForeground' | 'restartIndexer';

export interface ProcRow {
  /** Stable across refreshes ('main', 'renderer', 'pid:4242', 'indexer', …). */
  id: string;
  parent?: string;
  name: string;
  kind: ProcKind;
  pid?: number;
  /** % of one core over the last refresh; null = not measurable here. */
  cpu?: number | null;
  /** Event-loop utilisation % (threads / workers, where per-thread CPU is not available). */
  busy?: number | null;
  /** MB; `memKind` says what was measured (Windows: private bytes; Linux / macOS: RSS). */
  mem?: number | null;
  memKind?: 'private' | 'working set' | 'RSS' | 'JS heap';
  state?: string;
  detail?: string;
  /** Activity-log kinds this row's "Doing now" comes from (index, index-update, git, tree…). */
  activity?: string[];
  /** Right now (a git command line, "Indexing 1,200 / 4,000"): wins over the activity log. */
  doing?: string;
  actions?: ProcAction[];
}

export interface ProcSnapshot {
  at: number;
  platform: string;
  rows: ProcRow[];
  /** Backend CPU ms this snapshot cost (its own row: "Process explorer (itself)"). */
  selfMs: number;
  notes?: string[];
}

export type ProcRequest = { op: 'snapshot' } | { op: 'close' } | { op: 'kill'; pid: number; group?: boolean } | { op: 'restartIndexer' };

const MB = 1024 * 1024;
export const toMB = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

// ---------------------------------------------------------------- child process info

export interface ChildInfo {
  pid: number;
  ppid: number;
  /** Process group / terminal foreground group (POSIX; 0 when unknown). */
  pgid: number;
  tpgid: number;
  /** Executable name ("git", "bash", "wsl.exe"). */
  comm: string;
  args: string;
  /** Cumulative CPU ms (to diff), or an instantaneous % when only that is known (macOS ps). */
  cpuMs?: number;
  cpuPct?: number;
  memBytes: number;
  memKind: ProcRow['memKind'];
  /** ms since the process started (when known). */
  ageMs?: number;
  /** Same executable as the app itself (Chromium helpers: reported by app metrics instead). */
  ownExe?: boolean;
}

/** /proc/<pid>/stat → fields (comm may contain spaces and parentheses). */
export function parseProcStat(text: string, clkTck = 100, pageSize = 4096): Omit<ChildInfo, 'comm' | 'args' | 'memKind' | 'ageMs'> & { startTicks: number } | null {
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const f = text.slice(close + 2).trim().split(/\s+/); // f[0] = state (field 3)
  const n = (field: number) => Number(f[field - 3]);
  if (!Number.isFinite(pid) || f.length < 22) return null;
  return { pid, ppid: n(4), pgid: n(5), tpgid: n(8), cpuMs: ((n(14) + n(15)) * 1000) / clkTck, startTicks: n(22), memBytes: n(24) * pageSize };
}

/** `ps -A -o pid=,ppid=,pgid=,tpgid=,%cpu=,rss=,command=` (macOS; Linux has /proc). rss in KiB. */
export function parsePs(out: string): ChildInfo[] {
  const rows: ChildInfo[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const args = m[7].trim();
    rows.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], cpuPct: +m[5], memBytes: +m[6] * 1024, memKind: 'RSS', comm: baseName(args.split(' ')[0]), args });
  }
  return rows;
}

/**
 * Windows helper output (one CIM query per refresh, tab-separated, see backend/processes.ts):
 * pid · ppid · name · working set · private bytes · kernel time · user time (100 ns) · command line.
 */
export function parseWinProcs(out: string): ChildInfo[] {
  const rows: ChildInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const c = line.split('\t');
    if (c.length < 7 || !/^\d+$/.test(c[0])) continue;
    const priv = Number(c[4]);
    rows.push({
      pid: +c[0],
      ppid: +c[1],
      pgid: 0,
      tpgid: 0,
      comm: c[2],
      args: c[7] ?? c[2],
      memBytes: priv > 0 ? priv : Number(c[3]) || 0,
      memKind: priv > 0 ? 'private' : 'working set',
      cpuMs: (Number(c[5]) + Number(c[6])) / 10_000,
    });
  }
  return rows;
}

export const baseName = (p: string) => p.replace(/^.*[\\/]/, '');
const exeName = (c: ChildInfo) => baseName(c.comm).toLowerCase().replace(/\.exe$/, '');

/** All descendants of `root` (breadth first), from a pid → info list (ps / Windows). */
export function descendantsOf(root: number, all: readonly ChildInfo[]): ChildInfo[] {
  const kids = new Map<number, ChildInfo[]>();
  for (const c of all) {
    if (c.pid === root || c.pid === c.ppid) continue;
    const list = kids.get(c.ppid);
    if (list) list.push(c);
    else kids.set(c.ppid, [c]);
  }
  const out: ChildInfo[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const c of kids.get(queue.shift()!) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

const SHELLS = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'nu', 'pwsh', 'powershell', 'cmd', 'tcsh', 'ksh']);
/** Console plumbing on Windows: never somebody's "foreground process". */
const CONSOLE_HOSTS = new Set(['conhost', 'openconsole', 'winpty-agent']);

/** The git subcommand in a command line ("git -c x=y status --porcelain" → "status"). */
export function gitVerb(args: string): string {
  const t = args.split(/\s+/);
  let i = t.findIndex((x) => /(^|[\\/])git(\.exe)?$/i.test(x));
  if (i < 0) return '';
  for (i++; i < t.length; i++) {
    if (t[i] === '-c' || t[i] === '-C') i++;
    else if (!t[i].startsWith('-')) return t[i];
  }
  return '';
}

export interface ClassifyCtx {
  /** Terminal shells (TerminalService.pids()). */
  shellPids: ReadonlySet<number>;
  /** The explorer's own helper (Windows query process / WSL ps): shown as part of "itself". */
  selfPids: ReadonlySet<number>;
}

/** Child processes → rows: terminals with their foreground job, git, watchers, helpers, the rest. */
export function childRows(children: readonly ChildInfo[], appPid: number, ctx: ClassifyCtx, cpu: (c: ChildInfo) => number | null): ProcRow[] {
  const byPid = new Map(children.map((c) => [c.pid, c]));
  const rows: ProcRow[] = [];
  const rowId = (pid: number) => `pid:${pid}`;
  // The nearest ancestor we show (Chromium helpers are skipped, their children are not ours anyway).
  const parentRow = (c: ChildInfo): string => (c.ppid === appPid || !byPid.has(c.ppid) ? 'main' : rowId(c.ppid));
  const shellOf = (c: ChildInfo): ChildInfo | null => {
    for (let p = byPid.get(c.ppid); p; p = byPid.get(p.ppid)) if (ctx.shellPids.has(p.pid)) return p;
    return null;
  };
  for (const c of children) {
    if (c.ownExe) continue;
    const exe = exeName(c);
    const base: ProcRow = { id: rowId(c.pid), parent: parentRow(c), pid: c.pid, kind: 'child', name: exe, cpu: cpu(c), mem: toMB(c.memBytes), memKind: c.memKind };
    if (ctx.selfPids.has(c.pid)) continue; // folded into "Process explorer (itself)"
    if (ctx.shellPids.has(c.pid)) {
      const fg = c.tpgid > 0 && c.tpgid !== c.pgid ? c.tpgid : 0;
      rows.push({ ...base, name: `Terminal: ${exe}`, state: fg ? 'running a command' : 'idle prompt' });
      continue;
    }
    const shell = shellOf(c);
    if (/^git$/.test(exe) || (exe === 'wsl' && /\sgit(\s|$)/.test(c.args) && !/HELPER|sec-edit-git-helper/.test(c.args))) {
      const verb = gitVerb(c.args);
      rows.push({ ...base, name: `git ${verb}`.trim(), activity: ['git'], doing: c.args.slice(0, 160), actions: ['stopGit'], state: 'running' });
      continue;
    }
    if (exe === 'inotifywait' || (exe === 'wsl' && /inotifywait/.test(c.args))) {
      rows.push({ ...base, kind: 'helper', name: exe === 'wsl' ? 'Folder watcher (WSL inotifywait)' : 'Folder watcher (inotifywait)', state: 'watching' });
      continue;
    }
    if (exe === 'wsl') {
      rows.push({ ...base, kind: 'helper', name: /sec-edit-git-helper|HELPER/.test(c.args) ? 'WSL git helper' : 'wsl.exe', detail: c.args.slice(0, 120) });
      continue;
    }
    if (shell) {
      // A command started in a terminal: the shell's foreground job (POSIX: its process group).
      const foreground = c.pgid > 0 ? c.pgid === shell.tpgid && shell.tpgid !== shell.pgid : !CONSOLE_HOSTS.has(exe);
      rows.push({ ...base, name: exe, detail: c.args.slice(0, 160), state: foreground ? 'foreground' : 'background', actions: foreground && !CONSOLE_HOSTS.has(exe) ? ['stopForeground'] : ['kill'] });
      continue;
    }
    if (SHELLS.has(exe) || CONSOLE_HOSTS.has(exe)) {
      rows.push({ ...base, kind: 'helper', detail: c.args.slice(0, 120) });
      continue;
    }
    rows.push({ ...base, detail: c.args.slice(0, 160), actions: ['kill'] });
  }
  return rows;
}

// ---------------------------------------------------------------- tree order + text export

const KIND_ORDER: Record<ProcKind, number> = { app: 0, thread: 1, worker: 2, helper: 3, child: 4, self: 5 };

/** Rows in tree order with their depth (parents first; orphans hang off the root). */
export function treeOrder(rows: readonly ProcRow[]): Array<{ row: ProcRow; depth: number }> {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, ProcRow[]>();
  const roots: ProcRow[] = [];
  for (const r of rows) {
    if (r.parent && ids.has(r.parent) && r.parent !== r.id) {
      const list = kids.get(r.parent);
      if (list) list.push(r);
      else kids.set(r.parent, [r]);
    } else roots.push(r);
  }
  const order = (list: ProcRow[]) => list.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.pid ?? 0) - (b.pid ?? 0) || a.name.localeCompare(b.name));
  const out: Array<{ row: ProcRow; depth: number }> = [];
  const seen = new Set<string>();
  const visit = (r: ProcRow, depth: number) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ row: r, depth });
    for (const k of order(kids.get(r.id) ?? [])) visit(k, depth + 1);
  };
  for (const r of order(roots)) visit(r, 0);
  return out;
}

const fmt = (v: number | null | undefined, digits = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits));

/** "Copy as text" (bug reports): aligned columns, tree by indentation. */
export function procText(rows: ReadonlyArray<{ row: ProcRow; depth: number; doing?: string }>, head: string): string {
  const table = [['Name', 'PID', 'CPU %', 'Busy %', 'Memory', 'State', 'Doing now']];
  for (const { row: r, depth, doing } of rows) {
    table.push(['  '.repeat(depth) + r.name, r.pid ? String(r.pid) : '', fmt(r.cpu), fmt(r.busy, 0), r.mem == null ? '—' : `${fmt(r.mem)} MB${r.memKind ? ` ${r.memKind}` : ''}`, [r.state, r.detail].filter(Boolean).join(' · '), doing ?? r.doing ?? '']);
  }
  const widths = table[0].map((_, i) => Math.min(60, Math.max(...table.map((t) => t[i].length))));
  return [head, ...table.map((t) => t.map((c, i) => (i === t.length - 1 ? c : c.slice(0, 60).padEnd(widths[i]))).join('  ').trimEnd())].join('\n');
}
