// No blocking file calls on the main thread (one main process serves every window): locating git, the
// working-copy read of hunks() and the .git watcher's signatures use fs.promises, with the same results.
// The watcher's checks never overlap, and a check that outlives its watchers reports nothing.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_MAX_BLOB_BYTES, GitService, locateGit } from '../../../src/backend/git';
import { git, makeRepo, testEnv, tmpDir, until, write } from './helpers';

const services: GitService[] = [];
const svc = (root: string) => {
  const s = new GitService(root, { env: testEnv(), watchDebounceMs: 40 });
  services.push(s);
  return s;
};
afterEach(() => {
  services.splice(0).forEach((s) => s.dispose());
  vi.restoreAllMocks();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realStat = fs.promises.stat.bind(fs.promises) as (p: fs.PathLike) => Promise<fs.Stats>;
const pathsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

/** fs.promises.stat under `prefix` can be held at a gate; counts how many run at once. */
function gateStats(prefix: string) {
  const g = { inflight: 0, max: 0, hold: null as Promise<void> | null, release: () => {} };
  vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
    if (typeof p !== 'string' || !p.startsWith(prefix)) return realStat(p);
    g.inflight++;
    g.max = Math.max(g.max, g.inflight);
    try {
      if (g.hold) await g.hold;
      return await realStat(p);
    } finally {
      g.inflight--;
    }
  }) as never);
  const block = () => (g.hold = new Promise<void>((r) => (g.release = () => ((g.hold = null), r()))));
  return Object.assign(g, { block });
}

describe('locateGit', () => {
  it('skips missing candidates and folders with an async stat, never statSync', async () => {
    const dir = await tmpDir('async-locate');
    fs.mkdirSync(path.join(dir, 'a', 'git'), { recursive: true }); // a folder named git
    fs.mkdirSync(path.join(dir, 'b'));
    const fake = path.join(dir, 'b', 'git');
    fs.writeFileSync(fake, '#!/bin/sh\necho "git version 2.99.0"\n', { mode: 0o755 });
    const sync = vi.spyOn(fs, 'statSync');
    const stat = vi.spyOn(fs.promises, 'stat');
    const cands = ['missing', 'a', 'b'].map((d) => path.join(dir, d, 'git'));
    const r = await locateGit({ platform: 'linux', env: { PATH: cands.map((c) => path.dirname(c)).join(':') } });
    expect(r).toEqual({ path: fake, version: [2, 99, 0] });
    expect(pathsOf(stat).filter((p) => p.startsWith(dir))).toEqual(cands); // in order, the first file wins
    expect(pathsOf(sync).filter((p) => p.startsWith(dir))).toEqual([]);
  });
});

describe('hunks(): the working copy', () => {
  async function changed() {
    const dir = await makeRepo('async-hunks', { 'f.txt': 'one\ntwo\nthree\n' });
    write(dir, 'f.txt', 'one\nTWO\nthree\n');
    return { g: svc(dir), abs: path.join(dir, 'f.txt') };
  }

  it('is read with fs.promises, never statSync / readFileSync', async () => {
    const { g, abs } = await changed();
    const sync = [vi.spyOn(fs, 'statSync'), vi.spyOn(fs, 'readFileSync')];
    const read = vi.spyOn(fs.promises, 'readFile');
    expect(await g.hunks('f.txt')).toMatchObject({ mode: 'hunks', head: 'one\ntwo\nthree\n', work: 'one\nTWO\nthree\n' });
    expect(pathsOf(read)).toContain(abs);
    for (const s of sync) expect(pathsOf(s)).not.toContain(abs);
  });

  it('over the size cap: "too-large", checked before any read', async () => {
    const { g, abs } = await changed();
    vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => {
      const st = await realStat(p);
      return p === abs ? Object.assign(st, { size: GIT_MAX_BLOB_BYTES + 1 }) : st;
    }) as never);
    const read = vi.spyOn(fs.promises, 'readFile');
    expect(await g.hunks('f.txt')).toEqual({ mode: 'file', reason: 'too-large' });
    expect(pathsOf(read)).not.toContain(abs);
  });

  it('a stat or read that fails: "unavailable"', async () => {
    const { g, abs } = await changed();
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const stat = vi.spyOn(fs.promises, 'stat').mockImplementation((async (p: fs.PathLike) => (p === abs ? Promise.reject(enoent) : realStat(p))) as never);
    expect(await g.hunks('f.txt')).toEqual({ mode: 'file', reason: 'unavailable' });
    stat.mockRestore();
    vi.spyOn(fs.promises, 'readFile').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));
    expect(await g.hunks('f.txt')).toEqual({ mode: 'file', reason: 'unavailable' });
  });
});

describe('watching .git with async stats', () => {
  it('checks never overlap: a change during a held check gets its own run afterwards', async () => {
    const dir = await makeRepo('async-watch', { 'a.md': 'a\n' });
    const st = gateStats(path.join(dir, '.git'));
    const g = svc(dir);
    let n = 0;
    g.onChange(() => n++);
    expect((await g.status()).ok).toBe(true);
    await sleep(200); // watchers armed
    st.block();
    write(dir, 'b.md', 'b\n');
    git(dir, 'add', 'b.md');
    git(dir, 'commit', '-qm', 'b');
    await until(() => st.inflight > 0); // the first check is stat-ing
    git(dir, 'checkout', '-qb', 'feature');
    await sleep(150); // its debounce fired while the first check is still held
    expect(st.inflight).toBe(1);
    st.release();
    await until(() => n >= 2);
    expect(st.max).toBe(1);
    const s = await g.status();
    expect(s.ok && s.branch.head).toBe('feature');
  });

  it('a check still running when its watchers stop reports nothing to the next subscriber', async () => {
    const dir = await makeRepo('async-restart', { 'a.md': 'a\n' });
    const st = gateStats(path.join(dir, '.git'));
    const g = svc(dir);
    const offA = g.onChange(() => {});
    expect((await g.status()).ok).toBe(true);
    await sleep(200);
    st.block();
    git(dir, 'checkout', '-qb', 'feature');
    await until(() => st.inflight > 0);
    offA(); // watchers stop; the held check belongs to them
    let b = 0;
    g.onChange(() => b++); // re-arms with fresh baselines (taken after the checkout)
    await sleep(50);
    st.release();
    await sleep(300);
    expect(b).toBe(0);
    write(dir, 'b.md', 'b\n');
    git(dir, 'add', 'b.md');
    git(dir, 'commit', '-qm', 'b');
    await until(() => b > 0); // the new watchers work
  });
});
