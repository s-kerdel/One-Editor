// GitMonitor cadence rules with a fake clock and fake per-repository services.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { CADENCE, GitMonitor, REFRESH, findNestedRepos, type Clock, type GitMonitorEvent } from '../../../src/backend/git-monitor';
import type { IndexHint, IndexRefreshResult } from '../../../src/backend/git';
import type { GitEntry, GitStatus, GitStatusResult } from '../../../src/shared/git';
import { tmpDir } from './helpers';

class FakeClock implements Clock {
  t = 1_000_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private n = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const id = ++this.n;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clear = (h: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== h);
  };
  /** Moves time forward, firing due timers in order (and letting promises settle in between). */
  async advance(ms: number) {
    const end = this.t + ms;
    await settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

/** A repository's status service: records runs, takes `ms` of fake time per run. */
class FakeRepo {
  runs: Array<{ at: number; trigger?: string }> = [];
  entries: GitEntry[] = [];
  ms = 50;
  listeners = new Set<() => void>();
  engine = 'native' as const;
  constructor(
    readonly root: string,
    private clock: FakeClock,
    readonly isRepo = true,
  ) {}
  probe = async () => (this.isRepo ? { ok: true as const } : { ok: false as const, reason: 'no-repo' as const });
  status = (trigger?: string): Promise<GitStatusResult> => {
    this.runs.push({ at: this.clock.t, trigger });
    const ms = this.stale ? this.staleMs : this.ms;
    return new Promise((resolve) => {
      this.clock.set(() => {
        const r: GitStatus = { ok: true, branch: { head: 'main', oid: 'a'.repeat(40), detached: false, upstream: null, ahead: 0, behind: 0 }, entries: this.entries.map((e) => ({ ...e })), prefix: '', ms };
        this.hint = { wasted: !this.counter ? null : this.stale ? this.staleFiles : 0, ms };
        resolve(r);
      }, ms);
    });
  };
  // Index model: a stale stat cache makes status slow (and git's counter high) until a refresh fixes it.
  stale = false;
  staleMs = 300;
  staleFiles = 5000;
  /** Does git report the trace2 counter (false = old git)? */
  counter = true;
  /** Does a refresh fix it (false: a file system with unstable timestamps)? */
  fixes = true;
  hint: IndexHint | null = null;
  idle = true;
  hang = false;
  refreshMs = 40;
  refreshes: number[] = [];
  results: IndexRefreshResult[] = [];
  indexHint = () => this.hint;
  refreshIndex = (): Promise<IndexRefreshResult> => {
    this.refreshes.push(this.clock.t);
    if (this.hang) return new Promise(() => {});
    return new Promise((resolve) => {
      this.clock.set(() => {
        const r = this.results.shift() ?? { ok: true, ms: this.refreshMs };
        if (r.ok) {
          if (this.fixes) this.stale = false;
          this.hint = null;
        }
        resolve(r);
      }, this.refreshMs);
    });
  };
  onChange = (cb: () => void) => (this.listeners.add(cb), () => this.listeners.delete(cb));
  dispose() {}
  gitDirChanged() {
    this.listeners.forEach((l) => l());
  }
}

function setup(opts: { nested?: string[]; refreshIndex?: boolean; stale?: boolean } = {}) {
  const clock = new FakeClock();
  const repos = new Map<string, FakeRepo>();
  const root = '/ws';
  const make = (r: string) => {
    const f = new FakeRepo(r, clock, !opts.nested || r !== root);
    f.stale = !!opts.stale;
    repos.set(r, f);
    return f as unknown as import('../../../src/backend/git').GitService;
  };
  const m = new GitMonitor(root, make, { clock, maxDepth: 1, refreshIndex: opts.refreshIndex });
  if (opts.nested) {
    // Replace the nested scan: the fake folder does not exist on disk.
    (m as any).discover = undefined;
  }
  return { clock, m, repo: (r = root) => repos.get(r)!, repos };
}

async function started(s: ReturnType<typeof setup>) {
  await s.m.ready;
  await s.clock.advance(100); // the initial 'open' run
  s.repo().runs.length = 0;
  await s.clock.advance(CADENCE.minInterval * 3); // out of every interval
}

describe('GitMonitor cadence', () => {
  it('debounces saves (500 ms) and fs events (1.5 s) into one run', async () => {
    const s = setup();
    await started(s);
    for (let i = 0; i < 5; i++) {
      s.m.trigger('save', ['a.md']);
      await s.clock.advance(100);
    }
    expect(s.repo().runs).toHaveLength(0);
    await s.clock.advance(500);
    expect(s.repo().runs).toHaveLength(1);
    expect(s.repo().runs[0].trigger).toBe('save');
    await s.clock.advance(5000);
    s.m.trigger('fs', ['x/y.js']);
    await s.clock.advance(1400);
    expect(s.repo().runs).toHaveLength(1);
    await s.clock.advance(200);
    expect(s.repo().runs).toHaveLength(2);
  });

  it('a storm still runs every ≤ 5 s (max wait), never in a tight loop', async () => {
    const s = setup();
    await started(s);
    for (let i = 0; i < 40; i++) {
      s.m.trigger('fs', [`gen/f${i}.js`]);
      await s.clock.advance(500); // 20 s of non-stop events
    }
    const runs = s.repo().runs.map((r) => r.at);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < runs.length; i++) expect(runs[i] - runs[i - 1]).toBeGreaterThanOrEqual(CADENCE.minInterval);
  });

  it('single-flight: triggers during a run become ONE follow-up', async () => {
    const s = setup();
    await started(s);
    s.repo().ms = 1000;
    s.m.trigger('action');
    await s.clock.advance(10);
    expect(s.repo().runs).toHaveLength(1);
    for (let i = 0; i < 10; i++) s.m.trigger('save', ['a.md']), s.repo().gitDirChanged();
    await s.clock.advance(990);
    expect(s.repo().runs).toHaveLength(1); // nothing started while running
    await s.clock.advance(60_000);
    expect(s.repo().runs).toHaveLength(2); // exactly one follow-up
  });

  it('adaptive minimum interval: max(2 s, 5 × the last run)', async () => {
    const s = setup();
    await started(s);
    s.repo().ms = 1000; // a slow repository: 5 s between runs
    s.m.trigger('git-dir');
    await s.clock.advance(1000);
    const first = s.repo().runs.at(-1)!.at;
    s.m.trigger('git-dir');
    await s.clock.advance(3000);
    expect(s.repo().runs.at(-1)!.at).toBe(first);
    await s.clock.advance(3000);
    expect(s.repo().runs.at(-1)!.at).toBeGreaterThanOrEqual(first + 1000 + 5000);
  });

  it('focus only re-checks after 10 s of quiet', async () => {
    const s = setup();
    await started(s);
    s.m.trigger('action');
    await s.clock.advance(100);
    const n = s.repo().runs.length;
    s.m.trigger('focus');
    await s.clock.advance(3000);
    expect(s.repo().runs).toHaveLength(n);
    await s.clock.advance(10_000);
    s.m.trigger('focus');
    await s.clock.advance(100);
    expect(s.repo().runs).toHaveLength(n + 1);
  });

  it('hidden window: no runs at all, then one catch-up run on show', async () => {
    const s = setup();
    await started(s);
    s.m.setVisible('w1', false);
    for (let i = 0; i < 20; i++) {
      s.m.trigger('fs', [`gen/${i}.js`]);
      s.repo().gitDirChanged();
      s.m.trigger('focus');
      await s.clock.advance(1000);
    }
    expect(s.repo().runs).toHaveLength(0);
    s.m.setVisible('w1', true);
    await s.clock.advance(100);
    expect(s.repo().runs).toHaveLength(1);
    expect(s.repo().runs[0].trigger).toBe('show');
    await s.clock.advance(30_000);
    expect(s.repo().runs).toHaveLength(1);
  });

  it('several windows: paused only while none is visible', async () => {
    const s = setup();
    await started(s);
    s.m.setVisible('a', false);
    s.m.setVisible('b', true);
    s.m.trigger('save', ['x']);
    await s.clock.advance(600);
    expect(s.repo().runs).toHaveLength(1);
  });

  it('fs events on git-ignored paths are not triggers', async () => {
    const s = setup();
    await s.m.ready;
    s.repo().entries = [
      { path: 'gen-ignored', state: 'ignored', dir: true },
      { path: 'debug.log', state: 'ignored' },
    ];
    s.m.trigger('action');
    await s.clock.advance(10_000);
    s.repo().runs.length = 0;
    s.m.trigger('fs', ['gen-ignored/a/b.js', 'debug.log', '.git/index']);
    await s.clock.advance(10_000);
    expect(s.repo().runs).toHaveLength(0);
    s.m.trigger('fs', ['gen-ignored/a.js', 'src/a.ts']);
    await s.clock.advance(10_000);
    expect(s.repo().runs).toHaveLength(1);
  });

  it('deltas: same / changed paths only / full when out of step; fresh runs now', async () => {
    const s = setup();
    s.repo().entries = [
      { path: 'a.md', state: 'modified' },
      { path: 'b.md', state: 'untracked' },
    ];
    const first = s.m.status({});
    await s.clock.advance(100);
    const full = (await first) as GitStatus;
    expect(full.entries).toHaveLength(2);
    const v = full.version!;
    expect(await s.m.status({ since: v })).toEqual({ ok: true, same: true, version: v });
    s.repo().entries = [
      { path: 'a.md', state: 'modified', staged: true },
      { path: 'c.md', state: 'untracked' },
    ];
    const fresh = s.m.status({ since: v, fresh: true }); // within the min interval: still runs now
    await s.clock.advance(100);
    expect(await fresh).toMatchObject({
      delta: true,
      base: v,
      version: v + 1,
      set: [
        { path: 'a.md', staged: true },
        { path: 'c.md', state: 'untracked' },
      ],
      removed: ['b.md'],
    });
    expect(await s.m.status({ since: v - 5 })).toMatchObject({ version: v + 1, entries: expect.any(Array) });
  });

  it('pushes the version on change, and running on / off (spinner)', async () => {
    const s = setup();
    const events: unknown[] = [];
    s.m.onEvent((e) => events.push(e));
    await s.m.ready;
    await s.clock.advance(100);
    const ran = { ran: { trigger: 'open', ms: 50, repo: '', engine: 'native', ok: true } };
    expect(events).toEqual([{ running: true }, ran, { version: 1 }, { running: false }]);
    events.length = 0;
    s.m.trigger('action');
    await s.clock.advance(100);
    // nothing changed: no new version (the activity log still hears about the run)
    expect(events).toEqual([{ running: true }, { ran: { ...ran.ran, trigger: 'action' } }, { running: false }]);
  });
});

describe('GitMonitor with several repositories', () => {
  async function multi() {
    const clock = new FakeClock();
    const dir = await tmpDir('multi');
    for (const r of ['p1', 'p2', 'group/p3']) fs.mkdirSync(path.join(dir, r, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules/pkg/.git'), { recursive: true }); // never scanned
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    const repos = new Map<string, FakeRepo>();
    const m = new GitMonitor(
      dir,
      (r) => {
        const f = new FakeRepo(r, clock, r !== dir);
        repos.set(path.relative(dir, r).split(path.sep).join('/'), f);
        return f as unknown as import('../../../src/backend/git').GitService;
      },
      { clock },
    );
    await m.ready;
    return { clock, m, dir, repo: (r: string) => repos.get(r)! };
  }

  it('finds the repositories below a parent folder (shallow, skipping node_modules)', async () => {
    const { dir, m } = await multi();
    expect(await findNestedRepos(dir)).toEqual(['group/p3', 'p1', 'p2']);
    expect(m.repoRels).toEqual(['group/p3', 'p1', 'p2']);
  });

  it('staggered first runs, then only repositories with changes', async () => {
    const { clock, m, repo } = await multi();
    await clock.advance(5000);
    const starts = ['group/p3', 'p1', 'p2'].map((r) => repo(r).runs[0].at).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(CADENCE.stagger);
    for (const r of ['group/p3', 'p1', 'p2']) repo(r).runs.length = 0;
    await clock.advance(10_000);
    m.trigger('save', ['p2/src/a.ts']);
    m.trigger('fs', ['docs/readme.md']); // not inside any repository
    await clock.advance(5000);
    expect([repo('group/p3').runs.length, repo('p1').runs.length, repo('p2').runs.length]).toEqual([0, 0, 1]);
  });

  it('entries are combined with their folder prefix; HEAD per repository', async () => {
    const { clock, m, repo } = await multi();
    repo('p1').entries = [{ path: 'a.md', state: 'modified' }];
    repo('group/p3').entries = [{ path: 'x/y.md', state: 'untracked' }];
    const st = m.status({ fresh: true });
    await clock.advance(5000);
    const r = (await st) as GitStatus;
    expect(r.entries.map((e) => e.path).sort()).toEqual(['group/p3/x/y.md', 'p1/a.md']);
    expect(r.repos?.map((x) => x.rel)).toEqual(['group/p3', 'p1', 'p2']);
    expect(m.locate('group/p3/x/y.md')).toMatchObject({ rel: 'group/p3', sub: 'x/y.md' });
    expect(m.locate('docs/readme.md')).toBeNull();
  });
});

describe('GitMonitor fresh status during a run', () => {
  it('answers with the follow-up run (which sees the action), not the run already going', async () => {
    const s = setup();
    await started(s);
    s.repo().ms = 1000;
    s.m.trigger('action');
    await s.clock.advance(100); // a run is going
    s.repo().entries = [{ path: 'staged.md', state: 'added', staged: true }];
    const fresh = s.m.status({ fresh: true });
    await s.clock.advance(5000);
    const r = (await fresh) as GitStatus;
    expect(r.entries.map((e) => e.path)).toEqual(['staged.md']);
    expect(s.repo().runs).toHaveLength(2);
  });
});

describe('GitMonitor typing with autosave', () => {
  it('a file already marked changed: no status while typing goes on, one after 10 s of quiet', async () => {
    const s = setup();
    await s.m.ready;
    s.repo().entries = [{ path: 'notes/a.md', state: 'modified', unstaged: true }];
    s.m.trigger('action');
    await s.clock.advance(5000);
    s.repo().runs.length = 0;
    for (let i = 0; i < 30; i++) {
      s.m.trigger('save', ['notes/a.md']); // autosave every 1.5 s for 45 s
      await s.clock.advance(1500);
    }
    expect(s.repo().runs).toHaveLength(0);
    await s.clock.advance(10_000);
    expect(s.repo().runs).toHaveLength(1);
    // A clean file's first save shows its mark quickly.
    s.m.trigger('save', ['notes/b.md']);
    await s.clock.advance(3000);
    expect(s.repo().runs).toHaveLength(2);
  });
});

describe('GitMonitor index refresh (git.refreshIndex)', () => {
  const refreshEvents = (events: GitMonitorEvent[]) => events.filter((e) => 'ran' in e && e.ran.trigger === 'index-refresh').map((e) => ('ran' in e ? e.ran : null));
  async function open(o: Parameters<typeof setup>[0] = {}) {
    const s = setup({ stale: true, ...o });
    const events: GitMonitorEvent[] = [];
    s.m.onEvent((e) => events.push(e));
    await s.m.ready;
    await s.clock.advance(400); // the 'open' status (300 ms: stale)
    return { ...s, f: s.repo(), events };
  }

  it('status re-read many unchanged files → ONE refresh once quiet; status is fast after it', async () => {
    const s = await open();
    expect(s.f.refreshes).toHaveLength(0); // never right away
    await s.clock.advance(REFRESH.idle);
    expect(s.f.refreshes).toHaveLength(1);
    await s.clock.advance(100);
    expect(refreshEvents(s.events)).toEqual([{ trigger: 'index-refresh', ms: 40, repo: '', engine: 'native', ok: true }]);
    s.f.gitDirChanged(); // the refresh rewrote .git/index → the watcher → status
    await s.clock.advance(500);
    expect(s.f.runs.at(-1)).toMatchObject({ trigger: 'git-dir' });
    expect(s.f.hint).toEqual({ wasted: 0, ms: 50 });
    for (let i = 0; i < 20; i++) {
      s.m.trigger('fs', ['a.md']);
      await s.clock.advance(30_000);
    }
    expect(s.f.refreshes).toHaveLength(1);
  });

  it('nothing to gain → no refresh: few re-read files, a quick status, or a clean index', async () => {
    for (const tweak of [(f: FakeRepo) => (f.staleFiles = 50), (f: FakeRepo) => (f.staleMs = 20), (f: FakeRepo) => (f.stale = false)]) {
      const s = setup({ stale: true });
      tweak(s.repo());
      await s.m.ready;
      await s.clock.advance(10 * 60_000);
      expect(s.repo().refreshes).toHaveLength(0);
    }
  });

  it('old git without the counter: only slow statuses (≥ 400 ms) get one', async () => {
    const slow = setup({ stale: true });
    slow.repo().counter = false;
    slow.repo().staleMs = 500;
    await slow.m.ready;
    await slow.clock.advance(600 + REFRESH.idle);
    expect(slow.repo().refreshes).toHaveLength(1);
    const quick = setup({ stale: true });
    quick.repo().counter = false;
    quick.repo().staleMs = 200;
    await quick.m.ready;
    await quick.clock.advance(10 * 60_000);
    expect(quick.repo().refreshes).toHaveLength(0);
  });

  it('hidden window → skipped; on show it runs', async () => {
    const s = setup({ stale: true });
    s.m.setVisible('w1', true);
    await s.m.ready;
    await s.clock.advance(400);
    s.m.setVisible('w1', false);
    await s.clock.advance(10 * 60_000);
    expect(s.repo().refreshes).toHaveLength(0);
    s.m.setVisible('w1', true);
    await s.clock.advance(REFRESH.idle + 100);
    expect(s.repo().refreshes).toHaveLength(1);
  });

  it('setting off → never (also when switched off while one is planned)', async () => {
    const off = await open({ refreshIndex: false });
    await off.clock.advance(30 * 60_000);
    expect(off.f.refreshes).toHaveLength(0);
    const live = await open();
    live.m.setRefreshIndex(false);
    for (let i = 0; i < 10; i++) {
      live.m.trigger('fs', ['a.md']);
      await live.clock.advance(60_000);
    }
    expect(live.f.refreshes).toHaveLength(0);
  });

  it('index.lock present → skipped (logged), tried again later', async () => {
    const s = setup({ stale: true });
    s.repo().results.push({ ok: false, skipped: 'locked' });
    const events: GitMonitorEvent[] = [];
    s.m.onEvent((e) => events.push(e));
    await s.m.ready;
    await s.clock.advance(400 + REFRESH.idle + 100);
    expect(refreshEvents(events)).toEqual([expect.objectContaining({ ok: false, skipped: 'locked' })]);
    await s.clock.advance(REFRESH.lockRetry);
    expect(s.repo().refreshes).toHaveLength(2);
    expect(refreshEvents(events).at(-1)).toMatchObject({ ok: true });
  });

  it('never alongside our own git or the user’s: waits for idle, a quiet .git, and holds statuses back meanwhile', async () => {
    const s = await open();
    s.f.idle = false; // e.g. a branch list is loading
    await s.clock.advance(REFRESH.idle * 3);
    expect(s.f.refreshes).toHaveLength(0);
    s.f.idle = true;
    // The user runs git commands in a terminal: .git keeps changing.
    for (let i = 0; i < 4; i++) {
      s.f.gitDirChanged();
      await s.clock.advance(3000);
    }
    expect(s.f.refreshes).toHaveLength(0);
    await s.clock.advance(REFRESH.userQuiet + REFRESH.idle);
    expect(s.f.refreshes).toHaveLength(1);
    // A status asked for during a refresh starts when it ends (one slot).
    const s2 = await open();
    s2.f.refreshMs = 1000;
    await s2.clock.advance(REFRESH.idle);
    expect(s2.f.refreshes).toHaveLength(1);
    const runs = s2.f.runs.length;
    void s2.m.status({ fresh: true });
    await s2.clock.advance(500);
    expect(s2.f.runs).toHaveLength(runs);
    await s2.clock.advance(600);
    expect(s2.f.runs).toHaveLength(runs + 1);
    expect(s2.f.runs.at(-1)!.at).toBe(s2.f.refreshes[0] + 1000);
  });

  it('a refresh that does not help → less often (6, 12 … min); one that hangs → slot freed, never again', async () => {
    const s = await open();
    s.f.fixes = false;
    for (let i = 0; i < 50; i++) {
      s.m.trigger('fs', ['a.md']);
      await s.clock.advance(30_000);
    }
    const gaps = s.f.refreshes.slice(1).map((t, i) => (t - s.f.refreshes[i]) / 60_000);
    expect(gaps).toHaveLength(2); // 25 minutes: 3 refreshes
    expect(gaps[0]).toBeGreaterThanOrEqual(6);
    expect(gaps[1]).toBeGreaterThanOrEqual(12);
    const h = await open();
    h.f.hang = true;
    await h.clock.advance(REFRESH.idle + REFRESH.waitMax + 100);
    const runs = h.f.runs.length;
    h.m.trigger('action');
    await h.clock.advance(1000);
    expect(h.f.runs.length).toBe(runs + 1);
    await h.clock.advance(60 * 60_000);
    expect(h.f.refreshes).toHaveLength(1);
  });
});
