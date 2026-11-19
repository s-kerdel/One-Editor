// Renderer-side git state: the latest status (signal), derived tree marks, and HEAD contents for the
// gutter / diff view. Refreshes are debounced and single-flight: typing never waits for git, and a
// burst of triggers (save + fs event + focus) costs one `git status`.
import { computed, signal } from '@preact/signals';
import type { GitHeadFile, GitStatusResult, GitUnavailable } from '@shared/git';
import { buildMarks, EMPTY_MARKS, type GitMarks } from './marks';

/** The slice of the backend this store needs (BackendApi gains these in phase 2). */
export interface GitBackend {
  gitStatus(): Promise<GitStatusResult>;
  gitHeadFile(path: string, rev?: string): Promise<GitHeadFile>;
}

export interface GitStoreOptions {
  debounceMs?: number;
  /** Case-insensitive path lookups (Windows / macOS). */
  foldCase?: boolean;
  /** Once per store: git is missing although the folder looks like a repository. */
  onHint?: (r: GitUnavailable) => void;
}

const HEAD_CACHE = 64;

/** Status equality ignoring timing, so an unchanged repo does not re-render the tree. */
const fingerprint = (r: GitStatusResult | null) => (r ? JSON.stringify(r.ok ? { ...r, ms: 0 } : r) : '');

export class GitStore {
  readonly status = signal<GitStatusResult | null>(null);
  /** "Show changes": the file tree lists changed files only. */
  readonly changesOnly = signal(false);
  readonly marks = computed<GitMarks>(() => {
    const s = this.status.value;
    return s?.ok ? buildMarks(s.entries, { foldCase: this.opts.foldCase }) : EMPTY_MARKS;
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
        void this.refreshNow();
      },
      immediate ? 0 : (this.opts.debounceMs ?? 250),
    );
  }

  /** Runs `git status` now (or after the one in flight). */
  refreshNow(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const gen = this.gen;
    this.running = (async () => {
      let r: GitStatusResult;
      try {
        r = await this.backend.gitStatus();
      } catch (err: any) {
        r = { ok: false, reason: 'error', message: String(err?.message ?? err) };
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

  private apply(r: GitStatusResult) {
    const print = fingerprint(r);
    if (print === this.lastPrint) return;
    this.lastPrint = print;
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

  /** Cheap, sync identity of `path`'s HEAD content: changes on commit / checkout. null = nothing to compare. */
  headKey(path: string): string | null {
    const s = this.status.peek();
    if (!s?.ok || !s.branch.oid) return null;
    const src = this.headPath(path);
    return src === null ? null : `${s.branch.oid}:${src}`;
  }

  /** Content of `path` in the last commit (cached per commit). null = no HEAD version / git unavailable. */
  headFile(path: string): Promise<GitHeadFile | null> {
    const s = this.status.peek();
    const key = this.headKey(path);
    if (!key || !s?.ok || !s.branch.oid) return Promise.resolve(null);
    let p = this.heads.get(key);
    if (!p) {
      p = this.backend.gitHeadFile(this.headPath(path)!, s.branch.oid).catch(() => null);
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
