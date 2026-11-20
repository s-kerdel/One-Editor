// Renderer-side git state: the latest status (signal), derived tree marks, and HEAD contents for the
// gutter / diff view. WHEN git runs is the backend's decision (GitMonitor: debounce, single-flight,
// adaptive interval, paused while hidden); the store only pulls what changed since its version —
// usually a small delta — when the backend says there is something new. Pulls are single-flight too.
import { computed, signal } from '@preact/signals';
import type { GitEntry, GitHeadFile, GitRepoInfo, GitStatus, GitStatusReply, GitStatusResult, GitUnavailable } from '@shared/git';
import { buildMarks, EMPTY_MARKS, type GitMarks } from './marks';

/** The slice of the backend this store needs. */
export interface GitBackend {
  /** `since`: the version we have (→ same / delta / full); `fresh`: run now (after an action). */
  gitStatus(opts?: { since?: number; fresh?: boolean }): Promise<GitStatusReply>;
  gitHeadFile(path: string, rev?: string): Promise<GitHeadFile>;
}

export interface GitStoreOptions {
  debounceMs?: number;
  /** Case-insensitive path lookups: the folder's file system folds case (read per status: folders differ). */
  foldCase?: boolean | (() => boolean);
  /** Once per store: git is missing although the folder looks like a repository. */
  onHint?: (r: GitUnavailable) => void;
}

const HEAD_CACHE = 64;

/** Status equality ignoring timing, so an unchanged repo does not re-render the tree. */
const fingerprint = (r: GitStatusResult | null) => (r ? JSON.stringify(r.ok ? { ...r, ms: 0 } : r) : '');

export class GitStore {
  readonly status = signal<GitStatusResult | null>(null);
  /** A git run is in progress on the backend (branch-item spinner). */
  readonly busy = signal(false);
  /** "Show changes": the file tree lists changed files only. */
  readonly changesOnly = signal(false);
  readonly marks = computed<GitMarks>(() => {
    const s = this.status.value;
    const fold = this.opts.foldCase;
    return s?.ok ? buildMarks(s.entries, { foldCase: typeof fold === 'function' ? fold() : fold }) : EMPTY_MARKS;
  });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private enabled = true;
  /** Bumped on workspace switch / disable: late results of an older generation are dropped. */
  private gen = 0;
  private lastPrint = '';
  private hinted = false;
  private heads = new Map<string, Promise<GitHeadFile | null>>();
  private subs = new Set<() => void>();
  /** Entries of the applied status, by path (deltas patch this). */
  private entries = new Map<string, GitEntry>();
  private fresh = false;

  constructor(
    private readonly backend: GitBackend,
    private readonly opts: GitStoreOptions = {},
  ) {}

  /** Ask for a fresh status (debounced). `immediate`: skip the debounce (focus, workspace opened). */
  refresh(immediate = false) {
    if (!this.enabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.pull();
      },
      immediate ? 0 : (this.opts.debounceMs ?? 60), // the backend already debounced; this only merges notices
    );
  }

  /** Status after an action the user just did: the backend runs git now and answers with the result. */
  refreshNow(): Promise<void> {
    this.fresh = true;
    // A pull in flight started before this call: its answer can predate what the user just did
    // (switching branches right after a save then skipped the uncommitted-changes warning).
    // Wait for it, then pull: the caller always gets a status from after its own action.
    // Everyone asking during that run shares ONE follow-up (single-flight).
    // Reset on either outcome: a run that rejected must not pin its rejection for every later caller.
    if (this.running)
      return (this.followUp ??= this.running
        .catch(() => {})
        .then(() => {
          this.followUp = null;
          return this.pull();
        }));
    return this.pull();
  }
  private followUp: Promise<void> | null = null;

  /** Fetch what changed since our version (or after the pull in flight). */
  pull(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const gen = this.gen;
    const fresh = this.fresh;
    this.fresh = false;
    this.running = (async () => {
      let r: GitStatusReply;
      try {
        r = await this.backend.gitStatus({ since: this.version(), fresh });
      } catch (err: any) {
        r = { ok: false, reason: 'error', message: String(err?.message ?? err) };
      }
      if (gen !== this.gen || !this.enabled) return;
      if (r.ok && 'delta' in r && r.base !== this.version()) {
        try {
          r = await this.backend.gitStatus({}); // out of step: whole list
        } catch (err: any) {
          r = { ok: false, reason: 'error', message: String(err?.message ?? err) };
        }
      }
      if (gen === this.gen && this.enabled) this.apply(r);
    })().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        this.refresh();
      }
    });
    return this.running;
  }

  private version(): number | undefined {
    const s = this.status.peek();
    return s?.ok ? s.version : undefined;
  }

  private apply(reply: GitStatusReply) {
    if (reply.ok && 'same' in reply) return;
    let r: GitStatusResult;
    if (reply.ok && 'delta' in reply) {
      for (const p of reply.removed) this.entries.delete(p);
      for (const e of reply.set) this.entries.set(e.path, e);
      const { delta: _d, base: _b, set: _s, removed: _r, ...rest } = reply;
      r = { ...rest, entries: [...this.entries.values()] } as GitStatus;
    } else {
      r = reply as GitStatusResult;
      // Backends without versions (tests, older servers): skip identical results by content.
      if (!r.ok || r.version === undefined) {
        const print = fingerprint(r);
        if (print === this.lastPrint) return;
        this.lastPrint = print;
      }
      this.entries = new Map(r.ok ? r.entries.map((e) => [e.path, e]) : []);
    }
    this.status.value = r;
    if (!r.ok && r.reason === 'no-git' && r.repoLikely && !this.hinted) {
      this.hinted = true;
      this.opts.onHint?.(r);
    }
    this.subs.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('[git] listener failed', err);
      }
    });
  }

  /** Another folder was opened: forget everything and load its status. */
  reset() {
    this.gen++;
    this.lastPrint = '';
    this.entries.clear();
    this.heads.clear();
    this.changesOnly.value = false;
    this.status.value = null;
    this.subs.forEach((cb) => cb());
    this.refresh(true);
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) return this.refresh(true);
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastPrint = '';
    this.entries.clear();
    this.status.value = null;
    this.changesOnly.value = false;
    this.subs.forEach((cb) => cb());
  }

  /** Called when the status changed (gutters re-check their HEAD key). */
  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }

  /** Path whose HEAD version `path` is compared with (renames: the old name), or null when it has none. */
  private headPath(path: string): string | null {
    const m = this.marks.peek().file(path);
    if (m && (m.state === 'untracked' || m.state === 'ignored' || m.state === 'added')) return null;
    return m?.state === 'renamed' && m.from ? m.from : path;
  }

  /** The repository a path belongs to (several repositories below a parent folder). */
  repoOf(path: string): GitRepoInfo | null {
    const s = this.status.peek();
    if (!s?.ok) return null;
    let best: GitRepoInfo | null = null;
    for (const r of s.repos ?? []) if (!r.rel || path === r.rel || path.startsWith(r.rel + '/')) if (!best || r.rel.length > best.rel.length) best = r;
    return best ?? (s.repos?.length ? null : { rel: '', branch: s.branch });
  }

  /** HEAD commit of the repository holding `path`. */
  private headOid(path: string): string | null {
    return this.repoOf(path)?.branch?.oid ?? null;
  }

  /** Cheap, sync identity of `path`'s HEAD content: changes on commit / checkout. null = nothing to compare. */
  headKey(path: string): string | null {
    const oid = this.headOid(path);
    if (!oid) return null;
    const src = this.headPath(path);
    return src === null ? null : `${oid}:${src}`;
  }

  /** Content of `path` in the last commit (cached per commit). null = no HEAD version / git unavailable. */
  headFile(path: string): Promise<GitHeadFile | null> {
    const oid = this.headOid(path);
    const key = this.headKey(path);
    if (!key || !oid) return Promise.resolve(null);
    let p = this.heads.get(key);
    if (!p) {
      p = this.backend.gitHeadFile(this.headPath(path)!, oid).catch(() => null);
      this.heads.set(key, p);
      if (this.heads.size > HEAD_CACHE) this.heads.delete(this.heads.keys().next().value!);
      void p.then((r) => r || this.heads.delete(key));
    } else {
      // LRU: most recently used last.
      this.heads.delete(key);
      this.heads.set(key, p);
    }
    return p;
  }

  dispose() {
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.subs.clear();
    this.heads.clear();
  }
}
