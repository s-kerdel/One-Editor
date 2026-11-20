// The git trust gate: a folder the user has not trusted gets no git at all — refused in the backend,
// before any git process could start. Remembered per folder in app data; recent folders migrate once.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BackendService } from '../../../src/backend/service';
import { GitTrust } from '../../../src/backend/git-trust';
import { git, makeRepo, testEnv, tmpDir, write } from './helpers';

const services: BackendService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

/** A git that leaves a line in `log` for every start (and then is the real git). */
async function spyGit(): Promise<{ gitPath: string; calls: () => string[] }> {
  const dir = await tmpDir('spy');
  const log = path.join(dir, 'calls.log');
  const real = git(dir, '--exec-path') && require('node:child_process').execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  const gitPath = path.join(dir, 'git');
  fs.writeFileSync(gitPath, `#!/bin/sh\necho "$PWD :: $*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  return { gitPath, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
async function service(gitPath: string, cfg?: string) {
  const configDir = cfg ?? (await tmpDir('cfg'));
  const s = new BackendService(configDir, {}, { cacheDir: '' }, { env: testEnv(), gitPath });
  services.push(s);
  return { s, configDir };
}
const inRepo = (calls: string[], dir: string) => calls.filter((c) => c.startsWith(fs.realpathSync(dir)));

describe('git trust gate (backend)', () => {
  it('an untrusted repository: every git operation is refused or empty, and git is never started there', async () => {
    const dir = await makeRepo('untrusted', { 'a.md': 'one\n', '.gitattributes': '*.md filter=evil\n' });
    const marker = path.join(dir, '..', `${path.basename(dir)}-pwned`);
    git(dir, 'config', 'filter.evil.clean', `touch '${marker}'; cat`);
    git(dir, 'config', 'core.fsmonitor', `touch '${marker}'`);
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    write(dir, 'a.md', 'two\n');
    const spy = await spyGit();
    const { s } = await service(spy.gitPath);
    await s.openWorkspace(dir);
    const before = spy.calls().length;

    expect(await s.git('status')).toEqual({ ok: false, reason: 'untrusted', repoLikely: true });
    expect(await s.git('status', { fresh: true })).toMatchObject({ ok: false, reason: 'untrusted' });
    expect(await s.git('nudge', 'focus')).toBeNull();
    expect(await s.git('visibility', 'w1', true)).toBeNull();
    expect(await s.git('headFile', 'a.md')).toEqual({ content: null, oid: null });
    expect(await s.git('diff', 'a.md')).toBeNull();
    expect(await s.git('hunks', 'a.md')).toEqual({ mode: 'file', reason: 'unavailable' });
    for (const call of [['stage', ['a.md']], ['unstage', null], ['discard', ['a.md']], ['commit', { message: 'x' }], ['fetch'], ['pull'], ['push'], ['branches'], ['log', {}], ['lastMessage'], ['createBranch', 'x'], ['switchBranch', 'main'], ['stageHunks', 'a.md', []], ['remoteBranches', {}], ['branchDetails', []], ['commitFiles', 'a'.repeat(40)]] as const) {
      await expect(s.git(...(call as unknown as [string, ...unknown[]])), call[0]).rejects.toMatchObject({ code: 'EACCES' });
    }
    // Saves and file events (what triggers status runs in a trusted folder) start nothing either.
    await s.writeFile('a.md', 'three\n');
    await s.createFile('new.md', 'x');
    await new Promise((r) => setTimeout(r, 400));
    expect(inRepo(spy.calls().slice(before), dir)).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('three\n'); // discard did not run
    expect(git(dir, 'status', '--porcelain')).toContain(' M a.md'); // nothing was staged
  });

  it('Trust → git works; it is remembered across restarts by real path; "Stop trusting" switches it off again', async () => {
    const dir = await makeRepo('trusting', { 'a.md': 'one\n' });
    write(dir, 'a.md', 'two\n');
    const spy = await spyGit();
    const { s, configDir } = await service(spy.gitPath);
    await s.openWorkspace(dir);
    const events: unknown[] = [];
    s.onGitChanged((e) => events.push(e));
    expect(await s.git('status')).toMatchObject({ ok: false, reason: 'untrusted' });
    expect(await s.git('trust')).toBe(true);
    expect(events).toContainEqual({}); // every window of this backend looks again
    const st = (await s.git('status', { fresh: true })) as { ok: boolean; entries: Array<{ path: string }> };
    expect(st.ok).toBe(true);
    expect(st.entries.map((e) => e.path)).toEqual(['a.md']);
    expect(inRepo(spy.calls(), dir).length).toBeGreaterThan(0);
    const file = JSON.parse(fs.readFileSync(path.join(configDir, 'git-trust.json'), 'utf8'));
    expect(file).toEqual({ version: 1, trusted: [fs.realpathSync(dir)], legacy: [] });
    expect(fs.existsSync(path.join(configDir, 'settings.json')) ? fs.readFileSync(path.join(configDir, 'settings.json'), 'utf8') : '').not.toContain(path.basename(dir));

    // Another process / a restart with the same app data: still trusted — also through a symlink to the folder.
    const again = await service(spy.gitPath, configDir);
    await again.s.openWorkspace(dir);
    expect(await again.s.git('status')).toMatchObject({ ok: true });
    const alias = `${dir}-alias`;
    fs.symlinkSync(dir, alias, 'dir');
    await again.s.openWorkspace(alias);
    expect(await again.s.git('status')).toMatchObject({ ok: true });

    // Revoke: off at once, also for the other spelling, and nothing more is started.
    expect(await again.s.git('untrust')).toBe(false);
    const n = spy.calls().length;
    expect(await again.s.git('status')).toMatchObject({ ok: false, reason: 'untrusted', repoLikely: true });
    await expect(again.s.git('stage', ['a.md'])).rejects.toMatchObject({ code: 'EACCES' });
    await again.s.openWorkspace(dir);
    expect(await again.s.git('status')).toMatchObject({ ok: false, reason: 'untrusted' });
    await new Promise((r) => setTimeout(r, 300));
    expect(spy.calls().length).toBe(n);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'git-trust.json'), 'utf8')).trusted).toEqual([]);
  });

  it('a folder that is no repository says so (nothing to trust); repositories below a plain folder count', async () => {
    const plain = await tmpDir('plain');
    write(plain, 'note.md', 'x\n');
    const spy = await spyGit();
    const { s } = await service(spy.gitPath);
    await s.openWorkspace(plain);
    expect(await s.git('status')).toEqual({ ok: false, reason: 'untrusted' });
    const nested = await tmpDir('parent');
    fs.mkdirSync(path.join(nested, 'projects', 'a'), { recursive: true });
    git(path.join(nested, 'projects', 'a'), 'init', '-q');
    await s.openWorkspace(nested);
    expect(await s.git('status')).toEqual({ ok: false, reason: 'untrusted', repoLikely: true });
    await s.git('trust'); // the opened folder is what is trusted: its repositories with it
    expect(await s.git('status', { fresh: true })).toMatchObject({ ok: true });
  });

  it('compare text needs no repository and stays available', async () => {
    const dir = await makeRepo('compare', { 'a.md': 'one\n' });
    const spy = await spyGit();
    const { s } = await service(spy.gitPath);
    await s.openWorkspace(dir);
    expect(await s.git('diffTexts', 'a\nb\n', 'a\nc\n')).toMatchObject({ engine: 'git' });
    expect(inRepo(spy.calls(), dir)).toEqual([]);
  });
});

describe('git trust store', () => {
  it('migration: the recent folders of the first start count as trusted — a folder opened then does not', async () => {
    const mine = await makeRepo('mine', { 'a.md': 'x\n' });
    const theirs = await makeRepo('theirs', { 'a.md': 'x\n' });
    const configDir = await tmpDir('cfg-mig');
    fs.writeFileSync(path.join(configDir, 'recent.json'), JSON.stringify([mine, '/gone/away']));
    const spy = await spyGit();
    // First start of the new version, launched straight into the folder someone sent.
    const { s } = await service(spy.gitPath, configDir);
    await s.openWorkspace(theirs);
    expect(await s.git('status')).toMatchObject({ ok: false, reason: 'untrusted' });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'git-trust.json'), 'utf8'))).toEqual({ version: 1, trusted: [], legacy: [mine, '/gone/away'] });
    await s.openWorkspace(mine);
    expect(await s.git('status')).toMatchObject({ ok: true });
    // The recent list grows; the migration does not run again.
    const later = await service(spy.gitPath, configDir);
    await later.s.openWorkspace(theirs);
    expect(await later.s.git('status')).toMatchObject({ ok: false, reason: 'untrusted' });
  });

  it('case: compared with the folder’s own rule; a corrupt file trusts nothing; no file and no recents → nothing', async () => {
    const dir = await tmpDir('store');
    const file = path.join(dir, 'git-trust.json');
    const t = new GitTrust(file, { recent: async () => [], realpath: async (p) => p });
    expect(await t.isTrusted('/Work/Repo', false)).toBe(false);
    await t.set('/Work/Repo', false, true);
    expect(await t.isTrusted('/Work/Repo', false)).toBe(true);
    expect(await t.isTrusted('/work/repo', false)).toBe(false); // a case-sensitive folder: another folder
    expect(await t.isTrusted('/work/repo', true)).toBe(true); // a folding one: the same
    expect(await t.isTrusted('/Work/Repo/sub', true)).toBe(false);
    expect(await t.isTrusted('/Work', true)).toBe(false);
    await t.set('/work/repo', true, false);
    expect(await t.isTrusted('/Work/Repo', false)).toBe(false);
    fs.writeFileSync(file, '{ not json');
    expect(await new GitTrust(file, { recent: async () => ['/Work/Repo'], realpath: async (p) => p }).isTrusted('/Work/Repo', false)).toBe(false);
    fs.writeFileSync(file, JSON.stringify({ trusted: 'all', legacy: [1, null, '/a'] }));
    const odd = new GitTrust(file, { recent: async () => [], realpath: async (p) => p });
    expect(await odd.isTrusted('/a', false)).toBe(true);
    expect(await odd.isTrusted('/b', false)).toBe(false);
  });
});
