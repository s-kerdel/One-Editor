// When `git status` runs (and for which repository): the cadence policy, in one place on the backend.
//
//  - triggers are debounced per kind: save 500 ms, fs events 1.5 s (non-ignored paths only), `.git`
//    HEAD / index / refs 300 ms (debounced by GitService's watcher), window focus only after 10 s quiet;
//    a trigger storm still runs at most every 5 s (max wait);
//  - single-flight per repository: triggers during a run coalesce into ONE follow-up run;
//  - adaptive minimum interval per repository: max(2 s, 5 × the last run's duration);
//  - paused entirely while no window is visible (one catch-up run on show); no periodic polling;
//  - a parent folder holding several repositories: one status per repository, one at a time
//    (staggered), only repositories that changed since their last run;
//  - index refresh (`git.refreshIndex`): when a status had to re-read many unchanged files (stale stat
//    cache; git's own trace2 counter says how many), one `update-index --refresh` in the same slot once
//    things are quiet — window visible, nothing of ours running, no .git activity for a few seconds,
//    no index.lock. At most every few minutes per repository; less often when it did not help.
// The renderer gets small deltas (changed paths only) against the version it already has.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitEntry, GitRepoInfo, GitStatus, GitStatusDelta, GitStatusReply, GitStatusResult, GitUnavailable } from '../shared/git';
import type { GitService, IndexRefreshResult } from './git';

/** `save-known`: a save of a file that is already marked changed (it almost never changes its mark). */
export type GitTrigger = 'open' | 'save' | 'save-known' | 'fs' | 'git-dir' | 'focus' | 'action' | 'show';

/** Pushed to windows: a new status version, a run started / ended, or one finished (activity log). */
export type GitMonitorEvent =
  | { version: number }
  | { running: boolean }
  | { ran: { trigger: GitTrigger | 'index-refresh'; ms: number; repo: string; engine: 'wsl' | 'native'; ok: boolean; skipped?: string } };

export interface Clock {
  now(): number;
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realClock: Clock = { now: () => Date.now(), set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as NodeJS.Timeout) };

export const CADENCE = {
  debounce: { save: 500, 'save-known': 10_000, fs: 1500, 'git-dir': 0, focus: 0, open: 0, action: 0, show: 0 } as Record<GitTrigger, number>,
  /** A storm of triggers still gets a run this long after its first one. */
  maxWait: 5000,
  minInterval: 2000,
  durationFactor: 5,
  /** Focus only re-checks a repository whose last run is older than this. */
  focusQuiet: 10_000,
  /** Between two repositories' runs (parent folder with several repos). */
  stagger: 250,
};

export const REFRESH = {
  /** Unchanged files one status re-read: below this a refresh buys nothing … */
  minWasted: 100,
  /** … nor when that status was quick anyway. */
  minMs: 50,
  /** Old git without the trace2 counter: a status this slow gets a refresh now and then. */
  slowMs: 400,
  /** Between two refreshes of a repository; doubled (up to maxCooldown) while they do not help. */
  cooldown: 3 * 60_000,
  maxCooldown: 60 * 60_000,
  /** Without the counter: "helped" = the next status took at most this share of the time before. */
  helpRatio: 0.75,
  /** Quiet before a refresh: after the status that asked for it / after any .git activity. */
  idle: 2000,
  userQuiet: 5000,
  /** index.lock present (someone's git is writing) / our git busy: try again this much later. */
  lockRetry: 30_000,
  maxTries: 10,
  /** Stop waiting for a refresh (the process is left alone to finish) and never refresh that repo again. */
  waitMax: 30_000,
};

/** Bypass debounce and minimum interval. */
const URGENT = new Set<GitTrigger>(['action', 'open', 'show']);
const RANK: Record<GitTrigger, number> = { 'save-known': -1, fs: 0, save: 0, 'git-dir': 0, focus: 0, show: 1, open: 2, action: 3 };
/** Triggers without a max wait: typing in a changed file never forces a run while it goes on. */
const NO_MAX_WAIT = new Set<GitTrigger>(['save-known']);

interface RepoState {
  rel: string;
  svc: GitService;
  dirty: boolean;
  /** First trigger of the current burst (max wait). */
  firstAt: number;
  due: number | null;
  timer: unknown;
  kind: GitTrigger;
  running: boolean;
  again: GitTrigger | null;
  lastEnd: number;
  lastMs: number;
  result: GitStatusResult | null;
  ignoredFiles: Set<string>;
  ignoredDirs: string[];
  /** Resolved when the next run of this repo ends. */
  waiters: Array<() => void>;
  /** Asked for during a run: resolved by the follow-up run, which sees their change. */
  later: Array<() => void>;
  unsub: () => void;
  // index refresh
  lastGitDirAt: number;
  /** Earliest next refresh; its cooldown. */
  refreshNext: number;
  refreshBackoff: number;
  refreshTimer: unknown;
  refreshTries: number;
  /** Asked for while hidden: on show. */
  refreshWanted: boolean;
  /** Never again (hung refresh, or not ours to refresh). */
  refreshOff: boolean;
  /** A refresh ran: the next status tells whether it helped (`ms` = the status time before it). */
  judge: { at: number; ms: number } | null;
}

export interface MonitorOptions {
  clock?: Clock;
  /** Nested repository scan (parent folders): depth and caps. */
  maxDepth?: number;
  maxRepos?: number;
  /** Folder names never scanned for nested repositories. */
  skip?: (name: string) => boolean;
  /** Refresh the index's stat cache when status says it is stale (setting `git.refreshIndex`, default on). */
  refreshIndex?: boolean;
}

const DEFAULT_SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'target', '.next', '.cache', '__pycache__', 'venv', '.venv']);
const join = (rel: string, p: string) => (!rel ? p : p ? `${rel}/${p}` : rel);
const entryKey = (e: GitEntry) => `${e.state}|${e.staged ? 1 : 0}|${e.unstaged ? 1 : 0}|${e.from ?? ''}|${e.dir ? 1 : 0}|${e.submodule ? 1 : 0}`;

/** Repositories below `root` (not root itself), breadth-first, shallow, capped. */
export async function findNestedRepos(root: string, o: { maxDepth?: number; maxRepos?: number; skip?: (n: string) => boolean } = {}): Promise<string[]> {
  const maxDepth = o.maxDepth ?? 3;
  const maxRepos = o.maxRepos ?? 32;
  const skip = o.skip ?? ((n: string) => DEFAULT_SKIP.has(n.toLowerCase()));
  const found: string[] = [];
  let queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: root, rel: '', depth: 0 }];
  let visited = 0;
  while (queue.length && found.length < maxRepos && visited < 4000) {
    const next: typeof queue = [];
    for (const d of queue) {
      visited++;
      let ents: import('node:fs').Dirent[];
      try {
        ents = await fsp.readdir(d.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      if (d.rel && ents.some((e) => e.name === '.git')) {
        found.push(d.rel); // a repository: its own submodules / nested folders belong to it
        if (found.length >= maxRepos) break;
        continue;
      }
      if (d.depth >= maxDepth) continue;
      for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !skip(e.name)) next.push({ abs: path.join(d.abs, e.name), rel: join(d.rel, e.name), depth: d.depth + 1 });
    }
    queue = next.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  }
  return found.sort();
}

export class GitMonitor {
  private repos: RepoState[] = [];
  private unavailable: GitUnavailable | null = null;
  readonly ready: Promise<void>;
  private version = 0;
  private prevVersion = -1;
  private snapshot = new Map<string, GitEntry>();
  private reposInfo: GitRepoInfo[] = [];
  private lastDelta: { set: GitEntry[]; removed: string[] } | null = null;
  private listeners = new Set<(e: GitMonitorEvent) => void>();
  private clients = new Map<string, boolean>();
  private queue: RepoState[] = [];
  private slotBusy = false;
  private lastSlotEnd = 0;
  private pumpTimer: unknown = null;
  private wasRunning = false;
  private disposed = false;
  private rootSvc: GitService;
  private rootUnsub: (() => void) | null = null;
  private readonly clock: Clock;
  private refreshOn: boolean;

  constructor(
    readonly root: string,
    private readonly make: (root: string) => GitService,
    private readonly opts: MonitorOptions = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.refreshOn = opts.refreshIndex !== false;
    this.rootSvc = make(root);
    this.ready = this.discover();
  }

  /** Which repositories live here (the folder itself, or several below a plain parent folder).
   *  `again`: a second look after a failed one (retryDiscovery). */
  private async discover(again = false) {
    const probe = again ? await this.rootSvc.reprobe() : await this.rootSvc.probe();
    if (this.disposed) return;
    this.discoveredAt = this.clock.now();
    this.unavailable = null;
    if (probe.ok) this.repos = [this.state('', this.rootSvc)];
    else if (probe.reason === 'no-repo') {
      const rels = await findNestedRepos(this.root, this.opts);
      if (this.disposed) return;
      this.repos = rels.map((rel) => this.state(rel, this.make(path.join(this.root, ...rel.split('/')))));
      if (!this.repos.length) this.unavailable = probe;
      // `git init` here (or a new clone below) → look again.
      this.rootUnsub ??= this.rootSvc.onChange(() => void this.rediscover());
    } else this.unavailable = probe;
    for (const r of this.repos) this.mark(r, 'open');
  }

  /**
   * The first look failed for a reason that can pass (git gave no answer in time: a permission prompt,
   * a cold disk; git was installed / the folder was marked safe since): look again. Without this the
   * failure stayed for as long as the folder was open. Single-flight: everyone asking during a look
   * shares it, and GitService.reprobe never starts a discovery beside one still running.
   */
  private retryDiscovery(): Promise<void> {
    if (this.repos.length || this.disposed) return Promise.resolve();
    return (this.retrying ??= (async () => {
      const before = this.unavailable?.reason;
      try {
        await this.discover(true);
      } catch {
        // keeps the failure it had
      } finally {
        this.retrying = null;
      }
      // Still nothing, for another reason: every window reads it (a found repository reports itself after its first status).
      if (!this.disposed && !this.repos.length && this.unavailable?.reason !== before) this.emit({ version: this.version });
    })());
  }
  private retrying: Promise<void> | null = null;
  /** When the folder was last looked at (the focus retry waits `focusQuiet` after it). */
  private discoveredAt = 0;

  private async rediscover() {
    const rels = new Set(this.repos.map((r) => r.rel));
    const probe = await this.rootSvc.probe();
    const want = probe.ok ? [''] : await findNestedRepos(this.root, this.opts);
    if (want.length === rels.size && want.every((w) => rels.has(w))) return;
    for (const r of this.repos) this.drop(r);
    this.repos = want.map((rel) => this.state(rel, rel ? this.make(path.join(this.root, ...rel.split('/'))) : this.rootSvc));
    this.unavailable = this.repos.length ? null : probe.ok ? null : probe;
    for (const r of this.repos) this.mark(r, 'open');
    if (!this.repos.length) await this.rebuild();
  }

  private state(rel: string, svc: GitService): RepoState {
    const r: RepoState = {
      rel, svc, dirty: false, firstAt: 0, due: null, timer: null, kind: 'fs', running: false, again: null, lastEnd: 0, lastMs: 0, result: null,
      ignoredFiles: new Set(), ignoredDirs: [], waiters: [], later: [], unsub: () => {},
      lastGitDirAt: 0, refreshNext: 0, refreshBackoff: REFRESH.cooldown, refreshTimer: null, refreshTries: 0, refreshWanted: false, refreshOff: false, judge: null,
    };
    r.unsub = svc.onChange(() => {
      r.lastGitDirAt = this.clock.now();
      this.mark(r, 'git-dir');
    });
    return r;
  }

  private drop(r: RepoState) {
    r.unsub();
    if (r.timer) this.clock.clear(r.timer);
    if (r.refreshTimer) this.clock.clear(r.refreshTimer);
    if (r.svc !== this.rootSvc) r.svc.dispose();
  }

  // ---- triggers --------------------------------------------------------------------------------

  /** Something happened. `paths` (workspace-relative) narrows it to the repositories they belong to. */
  trigger(kind: GitTrigger, paths?: readonly string[]) {
    if (this.disposed) return;
    if (!this.repos.length) {
      // git gave no answer in time at the first look (often a prompt the user was still reading): coming
      // back to the window looks again by itself, at most every `focusQuiet`. Other failures wait for Retry.
      if (kind === 'focus' && this.unavailable?.reason === 'timeout' && this.clock.now() - this.discoveredAt >= CADENCE.focusQuiet) void this.retryDiscovery();
      return;
    }
    if (!paths) {
      for (const r of this.repos) this.mark(r, kind);
      return;
    }
    const hit = new Map<RepoState, GitTrigger>();
    for (const p of paths) {
      const r = this.repoFor(p);
      if (!r || this.isIgnored(r, p)) continue;
      // Saving a file that is already modified / new keeps its mark: no quick status for that.
      const k: GitTrigger = kind === 'save' && this.snapshot.get(p)?.state !== undefined && this.snapshot.get(p)?.state !== 'ignored' ? 'save-known' : kind;
      const prev = hit.get(r);
      if (!prev || RANK[k] > RANK[prev]) hit.set(r, k);
    }
    for (const [r, k] of hit) this.mark(r, k);
  }

  /** The repository a workspace path belongs to (longest folder match). */
  repoFor(p: string): RepoState | null {
    let best: RepoState | null = null;
    for (const r of this.repos) if (!r.rel || p === r.rel || p.startsWith(r.rel + '/')) if (!best || r.rel.length > best.rel.length) best = r;
    return best;
  }

  private isIgnored(r: RepoState, p: string) {
    if (/(^|\/)\.git(\/|$)/.test(p)) return true;
    if (r.ignoredFiles.has(p)) return true;
    return r.ignoredDirs.some((d) => p === d || p.startsWith(d + '/'));
  }

  private paused() {
    if (!this.clients.size) return false;
    for (const v of this.clients.values()) if (v) return false;
    return true;
  }

  /** A window became visible / hidden (several browser tabs: paused when none is visible). */
  setVisible(client: string, visible: boolean) {
    const was = this.paused();
    this.clients.set(String(client).slice(0, 64), !!visible);
    if (this.clients.size > 32) this.clients.delete(this.clients.keys().next().value!);
    if (!was || this.paused()) return;
    for (const r of this.repos) {
      if (r.dirty && !r.running && !r.timer) this.mark(r, 'show');
      else if (r.refreshWanted) this.scheduleRefresh(r, REFRESH.idle);
    }
  }

  /** Setting `git.refreshIndex` changed. */
  setRefreshIndex(on: boolean) {
    this.refreshOn = !!on;
    if (this.refreshOn) return;
    for (const r of this.repos) {
      if (r.refreshTimer) this.clock.clear(r.refreshTimer);
      r.refreshTimer = null;
      r.refreshWanted = false;
    }
  }

  private minInterval(r: RepoState) {
    return Math.max(CADENCE.minInterval, CADENCE.durationFactor * r.lastMs);
  }

  private mark(r: RepoState, kind: GitTrigger) {
    const now = this.clock.now();
    if (kind === 'focus' && (r.lastEnd === 0 || now - r.lastEnd < CADENCE.focusQuiet) && !r.dirty) return;
    r.dirty = true;
    if (this.paused() && kind !== 'action' && kind !== 'open') return; // catch up on show
    if (r.running) {
      if (!r.again || RANK[kind] > RANK[r.again]) r.again = kind;
      return;
    }
    if (this.queue.includes(r)) {
      if (RANK[kind] > RANK[r.kind]) r.kind = kind;
      return;
    }
    let due: number;
    if (URGENT.has(kind)) due = now;
    else {
      if (!r.firstAt && !NO_MAX_WAIT.has(kind)) r.firstAt = now;
      due = now + CADENCE.debounce[kind];
      if (r.firstAt) due = Math.min(due, r.firstAt + CADENCE.maxWait);
      due = Math.max(due, r.lastEnd + this.minInterval(r));
      if (r.due !== null && URGENT.has(r.kind)) due = Math.min(due, r.due);
    }
    if (r.timer) this.clock.clear(r.timer);
    r.due = due;
    if (!r.timer || RANK[kind] >= RANK[r.kind]) r.kind = kind;
    r.timer = this.clock.set(() => this.enqueue(r), Math.max(0, due - now));
  }

  private enqueue(r: RepoState) {
    r.timer = null;
    if (!this.queue.includes(r)) this.queue.push(r);
    this.pump();
  }

  private pump() {
    if (this.slotBusy || !this.queue.length || this.disposed) return;
    const wait = this.repos.length > 1 ? this.lastSlotEnd + CADENCE.stagger - this.clock.now() : 0;
    if (wait > 0) {
      if (!this.pumpTimer) this.pumpTimer = this.clock.set(() => ((this.pumpTimer = null), this.pump()), wait);
      return;
    }
    void this.runRepo(this.queue.shift()!);
  }

  private async runRepo(r: RepoState) {
    this.slotBusy = true;
    r.running = true;
    r.dirty = false;
    r.firstAt = 0;
    r.due = null;
    this.emitRunning();
    const t0 = this.clock.now();
    let res: GitStatusResult;
    try {
      res = await r.svc.status(r.kind);
    } catch (err: any) {
      res = { ok: false, reason: 'error', message: String(err?.message ?? err) };
    }
    if (this.disposed) return;
    r.lastMs = res.ok ? res.ms : this.clock.now() - t0;
    r.lastEnd = this.clock.now();
    r.running = false;
    r.result = res;
    if (res.ok) {
      r.ignoredFiles = new Set(res.entries.filter((e) => e.state === 'ignored' && !e.dir).map((e) => join(r.rel, e.path)));
      r.ignoredDirs = res.entries.filter((e) => e.state === 'ignored' && e.dir).map((e) => join(r.rel, e.path));
    }
    this.emit({ ran: { trigger: r.kind, ms: r.lastMs, repo: r.rel, engine: r.svc.engine, ok: res.ok } });
    await this.rebuild();
    this.slotBusy = false;
    this.lastSlotEnd = this.clock.now();
    const waiters = r.waiters.splice(0);
    r.waiters.push(...r.later.splice(0));
    const again = r.again;
    r.again = null;
    if (again) this.mark(r, again); // ONE follow-up for everything that came in meanwhile
    else if (res.ok) this.considerRefresh(r);
    this.pump();
    this.emitRunning();
    waiters.forEach((w) => w());
  }

  // ---- index refresh ---------------------------------------------------------------------------

  /** After a status: judge the last refresh, and plan one when this status re-read many unchanged files. */
  private considerRefresh(r: RepoState) {
    const hint = r.svc.indexHint?.() ?? null;
    if (!hint) return;
    if (r.judge) {
      const helped = hint.wasted !== null ? hint.wasted < REFRESH.minWasted : hint.ms <= REFRESH.helpRatio * r.judge.ms;
      r.refreshBackoff = helped ? REFRESH.cooldown : Math.min(r.refreshBackoff * 2, REFRESH.maxCooldown);
      r.refreshNext = r.judge.at + r.refreshBackoff;
      r.judge = null;
    }
    if (!this.refreshOn || r.refreshOff) return;
    const want = hint.wasted !== null ? hint.wasted >= REFRESH.minWasted && hint.ms >= REFRESH.minMs : hint.ms >= REFRESH.slowMs;
    if (!want || this.clock.now() < r.refreshNext) return; // a later status asks again once the cooldown is over
    r.refreshTries = 0;
    this.scheduleRefresh(r, REFRESH.idle);
  }

  private scheduleRefresh(r: RepoState, ms: number) {
    if (r.refreshTimer) return;
    const quiet = r.lastGitDirAt + REFRESH.userQuiet - this.clock.now();
    r.refreshTimer = this.clock.set(() => {
      r.refreshTimer = null;
      void this.tryRefresh(r);
    }, Math.max(ms, quiet));
  }

  private async tryRefresh(r: RepoState) {
    if (this.disposed || !this.refreshOn || r.refreshOff || !this.repos.includes(r)) return;
    if (this.paused()) return void (r.refreshWanted = true);
    r.refreshWanted = false;
    // A status of this repo is due / running: its end decides again.
    if (r.running || r.dirty || r.timer || this.queue.includes(r)) return;
    const now = this.clock.now();
    if (this.slotBusy || this.queue.length || now - r.lastGitDirAt < REFRESH.userQuiet || r.svc.idle === false) {
      if (++r.refreshTries <= REFRESH.maxTries) this.scheduleRefresh(r, REFRESH.idle);
      return;
    }
    this.slotBusy = true;
    r.running = true;
    this.emitRunning();
    const base = r.svc.indexHint?.()?.ms ?? r.lastMs;
    let timer: unknown = null;
    let res: IndexRefreshResult | 'timeout';
    try {
      res = await Promise.race([r.svc.refreshIndex(), new Promise<'timeout'>((resolve) => (timer = this.clock.set(() => resolve('timeout'), REFRESH.waitMax)))]);
    } catch (err: any) {
      res = { ok: false, message: String(err?.message ?? err) };
    }
    this.clock.clear(timer);
    if (this.disposed) return;
    const end = this.clock.now();
    r.running = false;
    this.slotBusy = false;
    this.lastSlotEnd = end;
    let skipped: string | undefined;
    if (res === 'timeout') r.refreshOff = true; // git keeps going on its own; never killed
    else if (res.ok) {
      r.judge = { at: end, ms: base };
      r.refreshNext = end + r.refreshBackoff;
    } else if ('skipped' in res) {
      if (res.skipped === 'unavailable') r.refreshOff = true;
      else {
        skipped = res.skipped; // index.lock: someone's git is writing → later
        if (++r.refreshTries <= REFRESH.maxTries) this.scheduleRefresh(r, REFRESH.lockRetry);
      }
    } else r.refreshNext = end + REFRESH.maxCooldown;
    // Activity log: runs, failures and lock skips (not "busy": nothing was attempted).
    const ok = res !== 'timeout' && res.ok;
    if (res === 'timeout' || !('skipped' in res) || skipped === 'locked') this.emit({ ran: { trigger: 'index-refresh', ms: res !== 'timeout' && res.ok ? res.ms : end - now, repo: r.rel, engine: r.svc.engine, ok, ...(skipped ? { skipped } : {}) } });
    r.waiters.push(...r.later.splice(0));
    const again = r.again;
    r.again = null;
    if (again) this.mark(r, again);
    this.pump();
    this.emitRunning();
  }

  private emitRunning() {
    const running = this.slotBusy || this.queue.length > 0;
    if (running === this.wasRunning) return;
    this.wasRunning = running;
    this.emit({ running });
  }

  private emit(e: GitMonitorEvent) {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {}
    }
  }

  onEvent(cb: (e: GitMonitorEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Run every repository now (an action the user just did) and wait for the results. */
  private runNow(): Promise<void> {
    return Promise.all(
      this.repos.map(
        (r) =>
          new Promise<void>((resolve) => {
            (r.running ? r.later : r.waiters).push(resolve);
            this.mark(r, 'action');
          }),
      ),
    ).then(() => {});
  }

  /** Every repository has a first result. */
  private firstResults(): Promise<void> {
    return Promise.all(this.repos.filter((r) => !r.result).map((r) => new Promise<void>((resolve) => r.waiters.push(resolve)))).then(() => {});
  }

  // ---- results ---------------------------------------------------------------------------------

  /** Combined, workspace-relative entries of every repository → new version + delta when it changed.
   *  Yields every few thousand entries: a 50k-entry status never holds the event loop for long. */
  private async rebuild() {
    let n = 0;
    const tick = async () => {
      if (++n % 5000 === 0) await new Promise<void>((r) => setImmediate(r));
    };
    const next = new Map<string, GitEntry>();
    const info: GitRepoInfo[] = [];
    for (const r of this.repos) {
      const res = r.result;
      if (!res) continue;
      if (!res.ok) {
        info.push({ rel: r.rel, branch: null, error: res.reason, engine: r.svc.engine });
        continue;
      }
      info.push({ rel: r.rel, branch: res.branch, ...(res.state ? { state: res.state } : {}), engine: r.svc.engine, prefix: res.prefix });
      for (const e of res.entries) {
        const p = join(r.rel, e.path);
        next.set(p, r.rel ? { ...e, path: p, ...(e.from ? { from: join(r.rel, e.from) } : {}) } : e);
        await tick();
      }
    }
    const set: GitEntry[] = [];
    const removed: string[] = [];
    for (const [p, e] of next) {
      const old = this.snapshot.get(p);
      if (!old || entryKey(old) !== entryKey(e)) set.push(e);
      await tick();
    }
    for (const p of this.snapshot.keys()) {
      if (!next.has(p)) removed.push(p);
      await tick();
    }
    const infoSame = JSON.stringify(info) === JSON.stringify(this.reposInfo);
    if (!set.length && !removed.length && infoSame && this.version) return;
    this.prevVersion = this.version;
    this.version++;
    this.snapshot = next;
    this.reposInfo = info;
    this.lastDelta = { set, removed };
    this.emit({ version: this.version });
  }

  private full(): GitStatusResult {
    const primary = this.repos.find((r) => r.result?.ok)?.result as GitStatus | undefined;
    if (!primary) {
      const failed = this.repos.find((r) => r.result && !r.result.ok)?.result as GitUnavailable | undefined;
      return failed ?? this.unavailable ?? { ok: false, reason: 'no-repo' };
    }
    const single = this.repos.length === 1 && this.repos[0].rel === '';
    return {
      ok: true,
      branch: primary.branch,
      entries: [...this.snapshot.values()],
      prefix: single ? primary.prefix : '',
      ms: Math.max(...this.repos.map((r) => r.lastMs)),
      ...(single && primary.state ? { state: primary.state } : {}),
      version: this.version,
      repos: this.reposInfo,
    };
  }

  /**
   * The status for a renderer that already has version `since`: unchanged, a delta, or the whole list.
   * `fresh`: run now (after an action) and answer with the result.
   */
  async status(o: { since?: unknown; fresh?: unknown } = {}): Promise<GitStatusReply> {
    await this.ready;
    // Retry (pane / status bar: a `fresh` status): a failed first look is taken again. "Not a repository"
    // is not a failure: its watcher sees a `git init`.
    if (!this.repos.length && o.fresh === true && this.unavailable && this.unavailable.reason !== 'no-repo') await this.retryDiscovery();
    if (!this.repos.length) return this.unavailable ?? { ok: false, reason: 'no-repo' };
    if (o.fresh === true) await this.runNow();
    else await this.firstResults();
    const since = typeof o.since === 'number' ? o.since : -2;
    const full = this.full();
    if (!full.ok) return full;
    if (since === this.version) return { ok: true, same: true, version: this.version };
    if (since === this.prevVersion && this.lastDelta) {
      const d: GitStatusDelta = { ok: true, delta: true, version: this.version, base: since, set: this.lastDelta.set, removed: this.lastDelta.removed, branch: full.branch, prefix: full.prefix, ms: full.ms, repos: this.reposInfo };
      if (full.state) d.state = full.state;
      return d;
    }
    return full;
  }

  /** The repository service for a repository folder ('' = the workspace itself / the first repository). */
  service(rel?: unknown): GitService | null {
    if (typeof rel === 'string' && rel) return this.repos.find((r) => r.rel === rel)?.svc ?? null;
    return this.repos[0]?.svc ?? this.rootSvc;
  }

  /** Repository + path relative to it, for a workspace path. */
  locate(p: string): { svc: GitService; rel: string; sub: string } | null {
    const r = this.repoFor(p);
    if (!r) return null;
    return { svc: r.svc, rel: r.rel, sub: r.rel ? p.slice(r.rel.length + 1) : p };
  }

  get repoRels(): string[] {
    return this.repos.map((r) => r.rel);
  }

  dispose() {
    this.disposed = true;
    this.rootUnsub?.();
    if (this.pumpTimer) this.clock.clear(this.pumpTimer);
    for (const r of this.repos) this.drop(r);
    this.rootSvc.dispose();
    this.listeners.clear();
  }
}
