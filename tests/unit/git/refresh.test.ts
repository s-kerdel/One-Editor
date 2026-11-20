// Index stat-cache refresh (setting `git.refreshIndex`): status notices unchanged files it had to
// re-read (git's trace2 counter), `update-index --refresh` fixes that. Never with index.lock present,
// never overlapping our own git, hooks / repo-local filters never run. Real repos under .tmp/git/unit.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GitService, gitEnv } from '../../../src/backend/git';
import { splitTrace2 } from '../../../src/backend/git-ops';
import { REFRESH, type GitMonitorEvent } from '../../../src/backend/git-monitor';
import { BackendService } from '../../../src/backend/service';
import type { GitStatus } from '../../../src/shared/git';
import { git, makeRepo, testEnv, tmpDir, until, write } from './helpers';

const services: Array<{ dispose(): void }> = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

function files(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`d${Math.floor(i / 200)}/f${i}.txt`] = `line ${i}\n`.repeat(20);
  return out;
}

/** Same contents, new timestamps (a copy, a checkout by another tool, a formatter rewriting files). */
function makeStale(dir: string, rels: string[], ageS = 3600) {
  // Older than the index → not "racily clean" afterwards. A different age each time: git may compare whole seconds.
  const past = new Date(Date.now() - ageS * 1000);
  for (const r of rels) fs.utimesSync(path.join(dir, ...r.split('/')), past, past);
}

async function status(g: GitService): Promise<GitStatus> {
  const s = await g.status();
  if (!s.ok) throw new Error(`${s.reason} ${s.message ?? ''}`);
  return s;
}

const svc = (dir: string) => {
  const g = new GitService(dir, { env: testEnv() });
  services.push(g);
  return g;
};

describe('trace2 counters', () => {
  it('splits event lines from real messages; keeps numeric data only', () => {
    const text = [
      '{"event":"version","sid":"x","evt":"3","exe":"2.34.1"}',
      'warning: something real',
      '{"event":"data","sid":"x","category":"index","key":"refresh/sum_scan","value":"20002"}',
      '{"event":"data","sid":"x","category":"index","key":"read/cache_nr","value":"20002"}',
      '{"event":"data","sid":"x","category":"x","key":"path","value":"/home/me"}',
      '{"event":"data", broken json',
      'fatal: not a git repository',
    ].join('\n');
    expect(splitTrace2(text)).toEqual({ stderr: 'warning: something real\nfatal: not a git repository', data: { 'refresh/sum_scan': 20002, 'read/cache_nr': 20002 } });
    expect(splitTrace2('fatal: x')).toEqual({ stderr: 'fatal: x', data: {} });
  });

  it("the user's own GIT_TRACE* never reaches git (stderr is parsed)", () => {
    const env = gitEnv({ PATH: '/bin', GIT_TRACE: '1', GIT_TRACE2_PERF: '2', git_trace2_event: '/tmp/x', GIT_TRACE_PACKET: '1' });
    expect(Object.keys(env).filter((k) => /trace/i.test(k))).toEqual([]);
    expect(env.PATH).toBe('/bin');
  });
});

describe('index refresh (real repositories)', () => {
  it('stale stat cache: status re-reads every file; after the refresh none, and status is fast again', async () => {
    const all = files(4000);
    const dir = await makeRepo('refresh-stale', { ...all, 'staged.md': 'a\n', 'mod.md': 'a\n' });
    write(dir, 'staged.md', 'b\n');
    git(dir, 'add', 'staged.md');
    write(dir, 'mod.md', 'changed\n');
    const head = git(dir, 'rev-parse', 'HEAD');
    makeStale(dir, Object.keys(all));
    const g = svc(dir);

    const times = async () => {
      const ms: number[] = [];
      for (let i = 0; i < 3; i++) ms.push((await status(g)).ms);
      return Math.min(...ms);
    };
    const before = await times();
    expect(g.indexHint()?.wasted).toBeGreaterThanOrEqual(4000);
    const entriesBefore = (await status(g)).entries;

    const r = await g.refreshIndex();
    expect(r).toMatchObject({ ok: true });
    const after = await times();
    expect(g.indexHint()?.wasted).toBe(0);
    expect(after).toBeLessThan(before);
    // Only timestamps changed: same entries, still staged / modified, same HEAD, same contents.
    expect((await status(g)).entries).toEqual(entriesBefore);
    expect(entriesBefore.map((e) => [e.path, e.state, !!e.staged, !!e.unstaged]).sort()).toEqual([
      ['mod.md', 'modified', false, true],
      ['staged.md', 'modified', true, false],
    ]);
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
    expect(fs.readFileSync(path.join(dir, 'mod.md'), 'utf8')).toBe('changed\n');
  });

  it('index.lock present (someone else’s git): skipped, the lock is left exactly as it was', async () => {
    const all = files(300);
    const dir = await makeRepo('refresh-lock', all);
    makeStale(dir, Object.keys(all));
    const lock = path.join(dir, '.git', 'index.lock');
    fs.writeFileSync(lock, 'another git');
    const indexStat = fs.statSync(path.join(dir, '.git', 'index'));
    const g = svc(dir);
    await status(g);
    expect(await g.refreshIndex()).toEqual({ ok: false, skipped: 'locked' });
    expect(fs.readFileSync(lock, 'utf8')).toBe('another git');
    expect(fs.statSync(path.join(dir, '.git', 'index')).mtimeMs).toBe(indexStat.mtimeMs);
    fs.rmSync(lock); // the other git finished
    expect(await g.refreshIndex()).toMatchObject({ ok: true });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('hooks (post-index-change, also via core.hooksPath) and repo-local filters never run', async () => {
    const all = files(50);
    const dir = await makeRepo('refresh-hooks', all);
    const marker = path.join(dir, 'pwned');
    const hook = `#!/bin/sh\necho hook >> '${marker}'\n`;
    write(dir, '.git/hooks/post-index-change', hook);
    fs.chmodSync(path.join(dir, '.git/hooks/post-index-change'), 0o755);
    write(dir, 'myhooks/post-index-change', hook);
    fs.chmodSync(path.join(dir, 'myhooks/post-index-change'), 0o755);
    git(dir, 'config', 'core.hooksPath', 'myhooks');
    git(dir, 'config', 'filter.evil.clean', `sh -c 'echo filter >> "${marker}"; cat'`);
    write(dir, '.gitattributes', '*.txt filter=evil\n');
    makeStale(dir, Object.keys(all));
    const g = svc(dir);
    await status(g);
    expect(await g.refreshIndex()).toMatchObject({ ok: true });
    expect(fs.existsSync(marker)).toBe(false);
    // Sanity: the same command run plainly WOULD have run both (so the check above means something).
    makeStale(dir, Object.keys(all), 7200);
    git(dir, 'update-index', '-q', '--refresh');
    expect(fs.readFileSync(marker, 'utf8')).toMatch(/filter[\s\S]*hook|hook[\s\S]*filter/);
  });

  it('never overlaps our own git: skipped while a status runs', async () => {
    const dir = await makeRepo('refresh-busy', files(200));
    const g = svc(dir);
    await status(g);
    const running = g.status();
    expect(g.idle).toBe(false);
    expect(await g.refreshIndex()).toEqual({ ok: false, skipped: 'busy' });
    await running;
    expect(g.idle).toBe(true);
  });
});

describe('index refresh through the backend (setting git.refreshIndex)', () => {
  const saved = { ...REFRESH };
  afterEach(() => Object.assign(REFRESH, saved));

  async function run(setting: boolean | undefined) {
    Object.assign(REFRESH, { idle: 20, userQuiet: 0, minMs: 0 }); // a 500-file status is quick here
    const all = files(500);
    const dir = await makeRepo(`refresh-setting-${setting}`, all);
    makeStale(dir, Object.keys(all));
    const cfg = await tmpDir('refresh-cfg');
    const s = new BackendService(cfg, { trash: async () => {}, trashIsAuthoritative: true }, {}, { env: testEnv() });
    services.push(s);
    if (setting !== undefined) await s.saveSettings({ 'git.refreshIndex': setting } as any);
    const events: GitMonitorEvent[] = [];
    s.onGitChanged((e) => events.push(e));
    await s.openWorkspace(dir);
    await s.git('trust'); // the user's "Trust" in the Source control panel: no git runs without it
    expect(await s.git('status')).toMatchObject({ ok: true });
    return { s, events, refreshes: () => events.filter((e) => 'ran' in e && e.ran.trigger === 'index-refresh') };
  }

  it('default on: one refresh after the first status (activity log: trigger index-refresh)', async () => {
    const { refreshes } = await run(undefined);
    await until(() => refreshes().length > 0, 10_000);
    expect(refreshes()[0]).toMatchObject({ ran: { trigger: 'index-refresh', ok: true, engine: 'native' } });
    await new Promise((r) => setTimeout(r, 500));
    expect(refreshes()).toHaveLength(1);
  });

  it('setting off → never', async () => {
    const { events, refreshes } = await run(false);
    await until(() => events.some((e) => 'ran' in e), 10_000);
    await new Promise((r) => setTimeout(r, 800));
    expect(refreshes()).toHaveLength(0);
  });
});
