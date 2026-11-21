// Navigation history (Go back / Go forward): a pure stack of locations, no DOM and no app imports.
// The current entry follows the cursor; a new entry is pushed only for a navigation (another file,
// or a big non-typing jump within one).

export interface NavEntry {
  path: string;
  /** Text docs: 0-based cursor line / column. */
  line?: number;
  col?: number;
  /** Text docs: top visible line (scroll), when known. */
  top?: number;
  /** PDF tabs: 1-based page. */
  page?: number;
}

export interface NavOptions {
  /** Most entries kept (oldest dropped first). */
  cap?: number;
  /** A cursor move of more than this many lines is a navigation. */
  jumpLines?: number;
  /** Jumps within one file closer together than this replace each other (held PgDn, F3 through matches). */
  coalesceMs?: number;
}

export interface VisitOptions {
  now: number;
  /** The move came with a document change (typing, undo, format): never a navigation. */
  edit?: boolean;
  /** A feature marked this move as a navigation (markNavigation): push whatever the distance. */
  force?: boolean;
}

/** PDF pages count from 1, and "no page yet" is the first one. */
const sameSpot = (a: NavEntry, b: NavEntry) => a.path === b.path && (a.line ?? 0) === (b.line ?? 0) && (a.page ?? 1) === (b.page ?? 1);

export class NavHistory {
  entries: NavEntry[] = [];
  index = -1;
  private pushedAt = -Infinity;
  private cap: number;
  private jumpLines: number;
  private coalesceMs: number;

  constructor(o: NavOptions = {}) {
    this.cap = o.cap ?? 100;
    this.jumpLines = o.jumpLines ?? 10;
    this.coalesceMs = o.coalesceMs ?? 350;
  }

  get current(): NavEntry | null {
    return this.entries[this.index] ?? null;
  }
  get canBack(): boolean {
    return this.index > 0;
  }
  get canForward(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** The user is now at `loc`. Returns true when that was a navigation (false: the current entry followed along). */
  visit(loc: NavEntry, o: VisitOptions): boolean {
    const cur = this.current;
    if (!cur || cur.path !== loc.path) return this.push(loc, o.now);
    const big = loc.line !== undefined && cur.line !== undefined && Math.abs(loc.line - cur.line) > this.jumpLines;
    const far = !o.edit && (o.force ? !sameSpot(cur, loc) : big);
    if (!far) {
      Object.assign(cur, loc); // small move / typing: the entry follows the cursor
      return false;
    }
    if (o.now - this.pushedAt < this.coalesceMs) {
      // A run of jumps is one navigation: keep where it started (the entry before), land on the last.
      this.entries.length = this.index + 1;
      this.entries[this.index] = { ...loc };
      this.pushedAt = o.now;
      return true;
    }
    return this.push(loc, o.now);
  }

  /** Scroll position etc. of the current entry, without it ever counting as a move. */
  patch(path: string, part: Partial<NavEntry>): void {
    const cur = this.current;
    if (cur && cur.path === path) Object.assign(cur, part);
  }

  private push(loc: NavEntry, now: number): boolean {
    this.entries.length = this.index + 1; // a new navigation drops the forward entries
    this.entries.push({ ...loc });
    if (this.entries.length > this.cap) this.entries.splice(0, this.entries.length - this.cap);
    this.index = this.entries.length - 1;
    this.pushedAt = now;
    return true;
  }

  /**
   * Move one entry back (-1) or forward (1) and return it; null at either end.
   * Entries whose file is gone (`exists` false) are dropped on the way, and so is an entry that then
   * equals the place we are already at.
   */
  step(dir: 1 | -1, exists: (path: string) => boolean = () => true): NavEntry | null {
    const from = this.current;
    for (;;) {
      const i = this.index + dir;
      const e = this.entries[i];
      if (!e) return null;
      if (exists(e.path) && !(from && sameSpot(e, from))) {
        this.index = i;
        this.pushedAt = -Infinity; // the next jump is a new entry, not part of an old run
        return e;
      }
      this.entries.splice(i, 1);
      if (dir < 0) this.index--;
    }
  }

  /** The entry just stepped to could not be shown (unreadable file): forget it and stand where we came from. */
  dropCurrent(dir: 1 | -1): void {
    if (this.index < 0) return;
    this.entries.splice(this.index, 1);
    if (dir > 0) this.index--;
    else this.index = Math.min(this.index, this.entries.length - 1);
  }

  /**
   * The places back (-1) or forward (1) of here, nearest first, as repeated step() calls would reach
   * them (gone files and repeats of the place before skipped), without moving. `[0]` = where one step goes.
   */
  places(dir: 1 | -1, max: number, exists: (path: string) => boolean = () => true): NavEntry[] {
    const out: NavEntry[] = [];
    let last = this.current;
    for (let i = this.index + dir; out.length < max && i >= 0 && i < this.entries.length; i += dir) {
      const e = this.entries[i];
      if (!exists(e.path) || (last && sameSpot(e, last))) continue;
      out.push(e);
      last = e;
    }
    return out;
  }

  /** Straight to `entry` (one of places()); the entries in between stay. False when it left the history meanwhile. */
  goTo(entry: NavEntry): boolean {
    const i = this.entries.indexOf(entry);
    if (i < 0) return false;
    this.index = i;
    this.pushedAt = -Infinity;
    return true;
  }

  /** The entry jumped to could not be shown: forget it and stand at `at` (where we were) again. */
  forget(entry: NavEntry, at: NavEntry | null): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
    const j = at ? this.entries.indexOf(at) : -1;
    this.index = j >= 0 ? j : Math.min(this.index, this.entries.length - 1);
  }

  /** A file or folder was renamed / moved: entries follow it. */
  rename(from: string, to: string): void {
    for (const e of this.entries) {
      if (e.path === from) e.path = to;
      else if (e.path.startsWith(from + '/')) e.path = to + e.path.slice(from.length);
    }
  }

  clear(): void {
    this.entries = [];
    this.index = -1;
    this.pushedAt = -Infinity;
  }

  /** At most `max` entries around the current one (session). */
  snapshot(max = 50): { entries: NavEntry[]; index: number } {
    const start = Math.max(0, Math.min(this.index - (max - 10), this.entries.length - max));
    return { entries: this.entries.slice(start, start + max), index: this.index - start };
  }

  restore(s: unknown): void {
    const o = s as { entries?: unknown; index?: unknown } | null;
    if (!o || !Array.isArray(o.entries)) return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
    const list: NavEntry[] = [];
    for (const raw of o.entries.slice(-this.cap) as Array<Record<string, unknown> | null>) {
      if (!raw || typeof raw.path !== 'string' || !raw.path) continue;
      list.push({ path: raw.path, line: num(raw.line), col: num(raw.col), top: num(raw.top), page: num(raw.page) });
    }
    if (!list.length) return;
    this.entries = list;
    const i = num(o.index);
    this.index = i !== undefined && i < list.length ? i : list.length - 1;
    this.pushedAt = -Infinity;
  }
}
