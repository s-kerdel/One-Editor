// Tier 2 (source control) against real repositories: stage / unstage / discard / commit / amend,
// branches, conflicts, push / pull with a local bare remote, auth hand-off, and the RPC dispatcher.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { GitService } from '../../../src/backend/git';
import { BackendService } from '../../../src/backend/service';
import { parseBranches, parseLog, parseNameStatus, terminalCommand, isAuthError, gitMessage } from '../../../src/backend/git-ops';
import type { GitStatus, GitStatusResult } from '../../../src/shared/git';
import { BASE, git, makeRepo, testEnv, tmpDir, write } from './helpers';

const services: Array<{ dispose(): void }> = [];
const svc = (root: string) => {
  const s = new GitService(root, { env: testEnv() });
  services.push(s);
  return s;
};
afterEach(() => services.splice(0).forEach((s) => s.dispose()));
const ok = (r: GitStatusResult): GitStatus => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};
const states = async (g: GitService) => Object.fromEntries(ok(await g.status()).entries.map((e) => [e.path, `${e.state}${e.staged ? '+s' : ''}${e.unstaged ? '+u' : ''}`]));
const noTrash = async () => {
  throw new Error('trash not expected');
};

describe('stage / unstage / discard', () => {
  it('stages and unstages files, deletions and renames', async () => {
    const dir = await makeRepo('stage', { 'a.md': 'a\n', 'b.md': 'b\n', 'c.md': 'c\n' });
    write(dir, 'a.md', 'a2\n');
    fs.rmSync(path.join(dir, 'b.md'));
    write(dir, 'new file.md', 'n\n');
    const g = svc(dir);
    expect(await g.stage(['a.md', 'b.md', 'new file.md'])).toMatchObject({ ok: true });
    expect(await states(g)).toEqual({ 'a.md': 'modified+s', 'b.md': 'deleted+s', 'new file.md': 'added+s' });
    expect(await g.unstage(['a.md', 'new file.md'])).toMatchObject({ ok: true });
    expect(await states(g)).toEqual({ 'a.md': 'modified+u', 'b.md': 'deleted+s', 'new file.md': 'untracked' });
    expect(await g.stage(null)).toMatchObject({ ok: true }); // everything
    expect(Object.values(await states(g)).every((v) => v.endsWith('+s'))).toBe(true);
  });

  it('unstage works before the first commit', async () => {
    const dir = await makeRepo('stage-initial');
    write(dir, 'a.md', 'a\n');
    const g = svc(dir);
    await g.stage(['a.md']);
    expect(await states(g)).toEqual({ 'a.md': 'added+s' });
    expect(await g.unstage(['a.md'])).toMatchObject({ ok: true });
    expect(await states(g)).toEqual({ 'a.md': 'untracked' });
  });

  it('passes long path lists on stdin (Windows command-line limit)', async () => {
    const dir = await makeRepo('stage-many', { 'keep.md': 'k\n' });
    const names = Array.from({ length: 120 }, (_, i) => `many/file ${i}.md`);
    for (const n of names) write(dir, n, 'x\n');
    const g = svc(dir);
    expect(await g.stage(names)).toMatchObject({ ok: true });
    expect(Object.keys(await states(g))).toHaveLength(120);
  });

  it('discard: tracked back to the index, untracked to the trash, conflicts refused', async () => {
    const dir = await makeRepo('discard', { 'a.md': 'a\n', 'b.md': 'b\n' });
    write(dir, 'a.md', 'edited\n');
    write(dir, 'b.md', 'staged\n');
    git(dir, 'add', 'b.md');
    write(dir, 'b.md', 'staged then edited\n');
    write(dir, 'junk.md', 'junk\n');
    write(dir, 'newdir/x.md', 'x\n');
    const trashed: string[] = [];
    const g = svc(dir);
    const r = await g.discard(['a.md', 'b.md', 'junk.md', 'newdir/x.md'], async (p) => void trashed.push(p));
    expect(r).toMatchObject({ ok: true, message: 'Discarded 4 changes' });
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('a\n');
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('staged\n'); // the staged version survives
    expect(trashed.sort()).toEqual(['junk.md', 'newdir/x.md']);
  });

  it('refuses paths outside the workspace and garbage input', async () => {
    const dir = await makeRepo('validate', { 'docs/a.md': 'a\n', 'secret.md': 's\n' });
    write(dir, 'secret.md', 'changed\n');
    const g = svc(path.join(dir, 'docs'));
    // `..` collapses inside the workspace (docs/secret.md does not exist) — the outer file is untouched.
    await g.stage(['../secret.md']).catch(() => null);
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('');
    await expect(g.stage('a.md' as unknown as string[])).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.stage([])).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.stage(['a\nb.md'])).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(g.discard([42 as unknown as string], noTrash)).rejects.toMatchObject({ code: 'EINVAL' });
  });
});

describe('commit', () => {
  it('commits staged changes with the message; amend keeps or replaces the message', async () => {
    const dir = await makeRepo('commit', { 'a.md': 'a\n' });
    write(dir, 'a.md', 'a2\n');
    const g = svc(dir);
    expect(await g.commit({ message: 'nothing staged' })).toEqual({ ok: false, message: 'Nothing is staged to commit' });
    await g.stage(['a.md']);
    expect(await g.commit({ message: '' })).toEqual({ ok: false, message: 'Write a commit message first' });
    const r = await g.commit({ message: 'Fix the thing\r\n\r\nLonger body ünïcode' });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Committed [0-9a-f]+ Fix the thing$/);
    expect(await g.lastMessage()).toBe('Fix the thing\n\nLonger body ünïcode');
    write(dir, 'b.md', 'b\n');
    await g.stage(['b.md']);
    expect((await g.commit({ message: '', amend: true })).ok).toBe(true); // --no-edit
    expect(git(dir, 'log', '--format=%s').trim().split('\n')).toEqual(['Fix the thing', 'init']);
    expect(git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.md', 'b.md']);
    expect((await g.commit({ message: 'Reworded', amend: true })).ok).toBe(true);
    expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Reworded');
  });

  it('runs the user’s hooks and reports their output', async () => {
    const dir = await makeRepo('hook', { 'a.md': 'a\n' });
    fs.writeFileSync(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho "lint failed: a.md" >&2\nexit 1\n', { mode: 0o755 });
    write(dir, 'a.md', 'b\n');
    const g = svc(dir);
    await g.stage(['a.md']);
    const r = await g.commit({ message: 'x' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('lint failed: a.md');
  });
});

describe('branches', () => {
  it('lists, creates, switches (local and remote-tracking)', async () => {
    const dir = await makeRepo('branches', { 'a.md': 'a\n' });
    const remote = await tmpDir('branches-remote');
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    git(dir, 'push', '-q', 'origin', 'main:refs/heads/remote-only');
    git(dir, 'fetch', '-q');
    const g = svc(dir);
    const list = await g.branches();
    expect(list.remotes).toEqual(['origin']);
    expect(list.branches.map((b) => `${b.name}${b.current ? '*' : ''}${b.remote ? '@r' : ''}`)).toEqual(['main*', 'origin/main@r', 'origin/remote-only@r']);
    expect(list.branches[0]).toMatchObject({ upstream: 'origin/main', subject: 'init' });
    expect(list.branches[0]).not.toHaveProperty('ahead'); // only the current branch has it (status)
    expect(await g.createBranch('feature/x')).toMatchObject({ ok: true, message: 'Created and switched to feature/x' });
    expect(ok(await g.status()).branch.head).toBe('feature/x');
    expect(await g.createBranch('bad..name')).toMatchObject({ ok: false });
    await expect(g.createBranch('-rf')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await g.switchBranch('main')).toMatchObject({ ok: true, message: 'Switched to main' });
    expect(await g.switchBranch('origin/remote-only')).toMatchObject({ ok: true, message: 'Switched to remote-only' });
    expect(ok(await g.status()).branch).toMatchObject({ head: 'remote-only', upstream: 'origin/remote-only' });
    expect(await g.switchBranch('nope')).toMatchObject({ ok: false });
  });

  it('a dirty tree that would be overwritten gets a clear message', async () => {
    const dir = await makeRepo('dirty-switch', { 'a.md': 'a\n' });
    git(dir, 'checkout', '-qb', 'other');
    write(dir, 'a.md', 'other\n');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'a.md', 'local edit\n');
    const r = await svc(dir).switchBranch('other');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('uncommitted changes would be overwritten');
  });
});

describe('conflicts', () => {
  it('shows the merge state; staging marks a conflict resolved; commit finishes the merge', async () => {
    const dir = await makeRepo('merge', { 'c.md': 'base\n' });
    git(dir, 'checkout', '-qb', 'other');
    write(dir, 'c.md', 'theirs\n');
    git(dir, 'commit', '-qam', 'other');
    git(dir, 'checkout', '-q', 'main');
    write(dir, 'c.md', 'ours\n');
    git(dir, 'commit', '-qam', 'ours');
    try {
      git(dir, 'merge', '-q', 'other');
    } catch {}
    const g = svc(dir);
    const s = ok(await g.status());
    expect(s.state).toBe('merge');
    expect(s.entries[0]).toMatchObject({ path: 'c.md', state: 'conflicted' });
    expect(await g.discard(['c.md'], noTrash)).toMatchObject({ ok: false, message: expect.stringContaining('Resolve the merge conflict') });
    write(dir, 'c.md', 'resolved\n');
    expect((await g.stage(['c.md'])).ok).toBe(true);
    expect(await states(g)).toEqual({ 'c.md': 'modified+s' });
    expect((await g.commit({ message: '' })).ok).toBe(true); // merge message from MERGE_MSG
    const after = ok(await g.status());
    expect(after.state).toBeUndefined();
    expect(git(dir, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2);
  });
});

describe('push / pull / fetch with a local bare remote', () => {
  it('publishes a branch, pushes, fetches, pulls; never forces', async () => {
    const dir = await makeRepo('sync', { 'a.md': 'a\n' });
    const remote = await tmpDir('sync-remote');
    git(remote, 'init', '-q', '--bare');
    const g = svc(dir);
    expect(await g.push()).toEqual({ ok: false, message: 'This repository has no remote' });
    git(dir, 'remote', 'add', 'origin', remote);
    expect(await g.push()).toMatchObject({ ok: true, message: 'Published main' });
    expect(ok(await g.status()).branch.upstream).toBe('origin/main');
    write(dir, 'b.md', 'b\n');
    await g.stage(['b.md']);
    await g.commit({ message: 'b' });
    expect(ok(await g.status()).branch.ahead).toBe(1);
    expect(await g.push()).toMatchObject({ ok: true, message: 'Pushed' });
    expect(ok(await g.status()).branch.ahead).toBe(0);
    // Someone else pushes.
    const other = await tmpDir('sync-other');
    git(other, 'clone', '-q', remote, '.');
    write(other, 'c.md', 'c\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'c');
    git(other, 'push', '-q');
    expect(await g.fetch()).toMatchObject({ ok: true });
    expect(ok(await g.status()).branch.behind).toBe(1);
    // Diverge: our push is rejected (no force), pull merges (pull.rebase=false configured here).
    write(dir, 'd.md', 'd\n');
    await g.stage(['d.md']);
    await g.commit({ message: 'd' });
    const rejected = await g.push();
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('Pull first');
    git(dir, 'config', 'pull.rebase', 'false');
    expect(await g.pull()).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(dir, 'c.md'))).toBe(true);
    expect((await g.push()).ok).toBe(true);
  });

  it('divergent pull without a configured strategy hands off to the terminal', async () => {
    const dir = await makeRepo('diverge', { 'a.md': 'a\n' });
    const remote = await tmpDir('diverge-remote');
    git(remote, 'init', '-q', '--bare');
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'push', '-q', '-u', 'origin', 'main');
    const other = await tmpDir('diverge-other');
    git(other, 'clone', '-q', remote, '.');
    write(other, 'x.md', 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-qm', 'x');
    git(other, 'push', '-q');
    write(dir, 'y.md', 'y\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'y');
    const r = await svc(dir).pull();
    // git ≥ 2.33 refuses to guess; older versions merge and warn.
    if (!r.ok) expect(r).toMatchObject({ terminal: 'git pull' });
  });

  it('authentication needed → a terminal command, no hanging prompt', async () => {
    const server = http.createServer((_req, res) => res.writeHead(401, { 'www-authenticate': 'Basic realm="git"' }).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      const dir = await makeRepo('auth', { 'a.md': 'a\n' });
      git(dir, 'remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`);
      const g = svc(dir);
      const t0 = Date.now();
      const r = await g.push();
      expect(r).toMatchObject({ ok: false, auth: true, terminal: 'git push -u origin main' });
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(await g.fetch()).toMatchObject({ ok: false, auth: true, terminal: 'git fetch' });
    } finally {
      server.close();
    }
  });
});

describe('history', () => {
  it('log (workspace-scoped, paged) and files per commit incl. renames and the root commit', async () => {
    const dir = await makeRepo('history', { 'docs/a.md': 'a\n', 'src/x.ts': 'x\n' });
    git(dir, 'mv', 'docs/a.md', 'docs/b.md');
    write(dir, 'src/x.ts', 'x2\n');
    git(dir, 'commit', '-qam', 'rename + edit');
    write(dir, 'src/y.ts', 'y\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'only src');
    const ws = svc(path.join(dir, 'docs'));
    const page = await ws.log({});
    const log = page.commits;
    expect(page.more).toBe(false);
    expect(log.map((c) => c.subject)).toEqual(['rename + edit', 'init']); // "only src" touches nothing here
    expect(log[0]).toMatchObject({ author: 'Test', email: 'test@example.com', parents: [log[1].oid] });
    expect(await ws.log({ skip: 0, limit: 1 })).toMatchObject({ more: true, commits: [{ subject: 'rename + edit' }] });
    expect(await ws.log({ skip: 1, limit: 1 })).toMatchObject({ more: false, commits: [{ subject: 'init' }] });
    const files = await ws.commitFiles(log[0].oid);
    expect(files).toEqual({ oid: log[0].oid, parent: log[1].oid, files: [{ path: 'b.md', status: 'renamed', from: 'a.md' }] });
    expect(await ws.commitFiles(log[0].oid, log[0].parents[0])).toEqual(files); // parent known: one spawn
    const root = await ws.commitFiles(log[1].oid, null);
    expect(root).toEqual({ oid: log[1].oid, parent: null, files: [{ path: 'a.md', status: 'added' }] });
    await expect(ws.commitFiles('HEAD~1')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(ws.commitFiles(log[0].oid, '--output=x')).rejects.toMatchObject({ code: 'EINVAL' });
    expect((await ws.headFile('a.md', log[1].oid)).content).toBe('a\n');
    expect(await svc(await makeRepo('history-empty')).log({})).toEqual({ commits: [], more: false });
  });
});

describe('background lists (low-priority queue)', () => {
  /** A git that takes `secs` before every `log`: a stand-in for history on a huge repository. */
  function slowGit(secs: number): string {
    const f = path.join(BASE, `slow-git-${secs}.sh`);
    fs.writeFileSync(f, `#!/bin/sh\nfor a in "$@"; do [ "$a" = "log" ] && sleep ${secs} && break; done\nexec git "$@"\n`, { mode: 0o755 });
    return f;
  }

  it('status, HEAD contents and diff stay fast while a slow git log runs; the rest of the queue waits', async () => {
    const dir = await makeRepo('slowlog', { 'a.md': 'one\n', 'b.md': 'two\n' });
    write(dir, 'a.md', 'ONE\n');
    const g = new GitService(dir, { env: testEnv(), gitPath: slowGit(3) });
    services.push(g);
    await g.status(); // discovery out of the way
    const t0 = Date.now();
    const history = g.log({});
    const branches = g.branches(); // queued behind the log (one background job at a time)
    await new Promise((r) => setTimeout(r, 150)); // the log is running now
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Date.now();
      await g.status();
      await g.headFile('a.md');
      await g.diff('a.md');
      times.push(Date.now() - t);
    }
    expect(Math.max(...times)).toBeLessThan(800); // ≈ 20 ms each here; nowhere near the 3 s log
    expect(Date.now() - t0).toBeLessThan(2500); // all of it while the log was still sleeping
    const [h, b] = await Promise.all([history, branches]);
    expect(h.commits.map((c) => c.subject)).toEqual(['init']);
    expect(b.branches.map((x) => x.name)).toEqual(['main']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3000);
  });

  it('cancel: a running log is killed at once, queued jobs never start', async () => {
    const dir = await makeRepo('cancel', { 'a.md': 'a\n' });
    const g = new GitService(dir, { env: testEnv(), gitPath: slowGit(5) });
    services.push(g);
    await g.status();
    const t0 = Date.now();
    const running = g.log({});
    const queued = g.log({ skip: 50 });
    const files = g.commitFiles('a'.repeat(40), null);
    await new Promise((r) => setTimeout(r, 200));
    g.cancel('history');
    expect(await running).toEqual({ commits: [], more: false, error: 'cancelled' });
    expect(await queued).toEqual({ commits: [], more: false, error: 'cancelled' });
    expect(Date.now() - t0).toBeLessThan(2000);
    // Other tags keep their place in the queue.
    expect((await files).error).not.toBe('cancelled');
  });

  it('a background job that takes too long says so (no silent empty list)', async () => {
    const dir = await makeRepo('timeout', { 'a.md': 'a\n' });
    const g = new GitService(dir, { env: testEnv(), gitPath: slowGit(3), lowTimeoutMs: 400 });
    services.push(g);
    expect(await g.log({})).toMatchObject({ commits: [], more: false, error: 'timeout' });
    expect((await g.branches()).error).toBeUndefined(); // for-each-ref is not slowed down
  });

  it('dispose (workspace switch) cancels everything', async () => {
    const dir = await makeRepo('dispose', { 'a.md': 'a\n' });
    const g = new GitService(dir, { env: testEnv(), gitPath: slowGit(5) });
    await g.status();
    const h = g.log({});
    await new Promise((r) => setTimeout(r, 150));
    g.dispose();
    expect((await h).error).toBe('cancelled');
  });
});

describe('BackendService.git dispatcher', () => {
  it('validates the operation and routes untracked discards to the trash hook', async () => {
    const dir = await makeRepo('dispatch', { 'a.md': 'a\n' });
    write(dir, 'junk.md', 'j\n');
    const trashed: string[] = [];
    const cfg = await tmpDir('dispatch-cfg');
    const s = new BackendService(cfg, { trash: async (abs) => void (trashed.push(abs), fs.rmSync(abs)), trashIsAuthoritative: true }, {}, { env: testEnv() });
    services.push(s);
    expect(await s.git('status')).toEqual({ ok: false, reason: 'no-repo' }); // no folder yet
    await s.openWorkspace(dir);
    await expect(s.git('rm -rf')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(s.git('constructor')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await s.git('status')).toMatchObject({ ok: true });
    expect(await s.git('discard', ['junk.md'])).toMatchObject({ ok: true });
    expect(trashed).toEqual([path.join(dir, 'junk.md')]);
    expect(fs.existsSync(path.join(dir, 'junk.md'))).toBe(false);
  });
});

describe('parsers', () => {
  it('branches, log, name-status, errors, terminal commands', () => {
    const rec = (...f: string[]) => f.join('\x00');
    const b = parseBranches([rec('refs/heads/main', 'main', 'abc1234', 'origin/main', '*', '100', 'Subject one'), rec('refs/remotes/origin/HEAD', 'origin', 'abc', '', ' ', '100', 'x'), rec('refs/remotes/origin/main', 'origin/main', 'def', '', ' ', '90', 'two')].join('\n'));
    expect(b.map((x) => [x.name, x.current, x.remote, x.upstream, x.date])).toEqual([
      ['main', true, false, 'origin/main', 100],
      ['origin/main', false, true, null, 90],
    ]);
    const H = 'a'.repeat(40);
    expect(parseLog(`${H}\x1faaaaaaa\x1f\x1fMe\x1fme@x\x1f5\x1fFirst\0`)).toEqual([{ oid: H, short: 'aaaaaaa', parents: [], author: 'Me', email: 'me@x', date: 5, subject: 'First' }]);
    expect(parseNameStatus('M\0docs/a.md\0R100\0docs/o.md\0docs/n.md\0A\0src/x\0', 'docs/')).toEqual([
      { path: 'a.md', status: 'modified' },
      { path: 'n.md', status: 'renamed', from: 'o.md' },
    ]);
    expect(isAuthError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toBe(true);
    expect(isAuthError('git@github.com: Permission denied (publickey).')).toBe(true);
    expect(isAuthError('fatal: unable to access: Could not resolve host')).toBe(false);
    expect(gitMessage('hint: use --force\nTo x\n ! [rejected] main -> main (fetch first)\nerror: failed to push')).toBe('To x\n! [rejected] main -> main (fetch first)\nerror: failed to push');
    expect(terminalCommand(['push', '-u', 'origin', 'feature/x'])).toBe('git push -u origin feature/x');
    expect(terminalCommand(['push', '-u', 'origin', 'evil;rm -rf ~'])).toBe('git push'); // never a command the shell would split
  });
});
