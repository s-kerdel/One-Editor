// WSL-aware git: path translation, command lines, helper framing, and end-to-end runs through a fake
// `wsl` (this Linux machine plays the distro). Real wsl.exe behaviour still needs a Windows check.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FrameParser, HELPER_SCRIPT, encodeRequest, parseNetUse, parseWslPath, resolveMappedDrive, toUncPath, wslGitArgs, type Frame } from '../../../src/backend/git-wsl';
import { GitService } from '../../../src/backend/git';
import { onGitActivity, type GitActivity } from '../../../src/backend/git-activity';
import { BASE, makeRepo, testEnv, write } from './helpers';

const services: GitService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

describe('WSL paths', () => {
  it('parses \\\\wsl.localhost and \\\\wsl$ roots (any slashes / case), distro names with dots and dashes', () => {
    expect(parseWslPath('\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\my repo')).toEqual({ host: 'wsl.localhost', distro: 'Ubuntu-22.04', linux: '/home/me/my repo' });
    expect(parseWslPath('\\\\WSL$\\Debian\\')).toEqual({ host: 'wsl$', distro: 'Debian', linux: '/' });
    expect(parseWslPath('//wsl.localhost/openSUSE.Tumbleweed/srv/ünï 😀')).toEqual({ host: 'wsl.localhost', distro: 'openSUSE.Tumbleweed', linux: '/srv/ünï 😀' });
    expect(parseWslPath('\\\\wsl.localhost\\my_distro')).toEqual({ host: 'wsl.localhost', distro: 'my_distro', linux: '/' });
    expect(parseWslPath('C:\\Users\\me')).toBeNull();
    expect(parseWslPath('\\\\server\\share\\x')).toBeNull();
    expect(parseWslPath('\\\\wsl.localhost\\bad name\\x')).toBeNull();
    expect(parseWslPath('\\\\wsl.localhost\\-x\\y')).toBeNull();
  });

  it('Linux paths back to UNC (watchers, marker files)', () => {
    const w = parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')!;
    expect(toUncPath(w, '/home/me/repo/.git')).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\.git');
    expect(toUncPath({ host: 'wsl$', distro: 'Ubuntu' }, '/')).toBe('\\\\wsl$\\Ubuntu');
  });

  it('drive letters mapped to WSL shares (net use), best effort', () => {
    const out = [
      'New connections will be remembered.',
      'Status       Local     Remote                    Network',
      '-------------------------------------------------------------------------------',
      'OK           Z:        \\\\wsl.localhost\\Ubuntu\\home\\me   Microsoft Windows Network',
      'Unavailable  Y:        \\\\fileserver\\share         Microsoft Windows Network',
      '             W:        \\\\wsl$\\Debian              Microsoft Windows Network',
    ].join('\r\n');
    const drives = parseNetUse(out);
    expect([...drives]).toEqual([
      ['Z:', '\\\\wsl.localhost\\Ubuntu\\home\\me'],
      ['W:', '\\\\wsl$\\Debian'],
    ]);
    expect(resolveMappedDrive('z:\\src\\app', drives)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\src\\app');
    expect(resolveMappedDrive('C:\\x', drives)).toBeNull();
  });
});

describe('command construction', () => {
  it('per call: no shell, env via env(1), nice for background, credential window allowed for network', () => {
    expect(wslGitArgs('Ubuntu', '/home/me/a b', ['-c', 'core.fsmonitor=', 'status', '-z'])).toEqual([
      '-d', 'Ubuntu', '--cd', '/home/me/a b', '--exec', 'env', 'GIT_TERMINAL_PROMPT=0', 'GIT_OPTIONAL_LOCKS=0', 'GCM_INTERACTIVE=never', 'GIT_PAGER=cat', 'LC_ALL=C', 'git', '-c', 'core.fsmonitor=', 'status', '-z',
    ]);
    expect(wslGitArgs('U', '/', ['log'], { low: true })).toEqual(expect.arrayContaining(['nice', '-n', '10', 'git', 'log']));
    expect(wslGitArgs('U', '/', ['push'], { net: true })).not.toContain('GCM_INTERACTIVE=never');
  });

  it('helper requests: base64 fields, line breaks refused', () => {
    const line = encodeRequest(7, '/home/me/ünï', ['status', '', 'a b'], 'in\n');
    const [id, cwd, args, input] = line.trim().split(' ');
    expect(id).toBe('7');
    expect(Buffer.from(cwd, 'base64').toString()).toBe('/home/me/ünï');
    expect(args.split(',').map((a) => (a === '-' ? '' : Buffer.from(a, 'base64').toString()))).toEqual(['status', '', 'a b']);
    expect(Buffer.from(input, 'base64').toString()).toBe('in\n');
    expect(encodeRequest(1, '/', ['x'])).toMatch(/ -\n$/);
    // Patch bytes (partial staging) go in byte for byte: CR, non-UTF-8, no re-encoding.
    const bytes = Buffer.from([0x2d, 0xe9, 0x0d, 0x0a, 0xff]);
    expect(Buffer.from(encodeRequest(3, '/', ['apply'], bytes).trim().split(' ')[3], 'base64')).toEqual(bytes);
    expect(encodeRequest(1, '/', ['x'], Buffer.alloc(0))).toMatch(/ -\n$/);
    expect(() => encodeRequest(1, '/', ['a\nb'])).toThrow();
    // Optional 5th field: extra NAME=value for this call only (trace2 counters for status).
    const env = encodeRequest(2, '/', ['status'], undefined, ['GIT_TRACE2_EVENT=2', 'A_B=x y']).trim().split(' ')[4];
    expect(env.split(',').map((e) => Buffer.from(e, 'base64').toString())).toEqual(['GIT_TRACE2_EVENT=2', 'A_B=x y']);
    expect(() => encodeRequest(1, '/', ['x'], undefined, ['bad name=1'])).toThrow();
    expect(() => encodeRequest(1, '/', ['x'], undefined, ['A=1\nB=2'])).toThrow();
    expect(wslGitArgs('U', '/', ['status'], { extraEnv: ['GIT_TRACE2_EVENT=2'] })).toEqual(expect.arrayContaining(['LC_ALL=C', 'GIT_TRACE2_EVENT=2', 'git', 'status']));
  });

  it('framing parser: frames split anywhere, READY / NOGIT markers, banner noise, overflow', () => {
    const frames: Frame[] = [];
    const p = new FrameParser((f) => frames.push(f), (id) => (id === 3 ? 4 : Infinity));
    const out = Buffer.concat([Buffer.from('Welcome to Ubuntu\nREADY\n'), Buffer.from('1 0 5 0\nhello'), Buffer.from('2 1 3 4\nabcerr!'), Buffer.from('3 0 10 0\n0123456789')]);
    for (let i = 0; i < out.length; i++) p.push(out.subarray(i, i + 1)); // byte by byte
    expect(p.ready).toBe(true);
    expect(frames.map((f) => [f.id, f.code, f.stdout.toString(), f.stderr, !!f.overflow])).toEqual([
      [1, 0, 'hello', '', false],
      [2, 1, 'abc', 'err!', false],
      [3, 0, '', '', true],
    ]);
    const q = new FrameParser(() => {});
    q.push(Buffer.from('NOGIT\n'));
    expect(q.noGit).toBe(true);
  });

  it('the helper script is POSIX sh (parses with sh -n)', () => {
    const f = path.join(BASE, 'helper.sh');
    fs.mkdirSync(BASE, { recursive: true });
    fs.writeFileSync(f, HELPER_SCRIPT);
    expect(() => require('node:child_process').execFileSync('sh', ['-n', f])).not.toThrow();
  });
});

/** A fake wsl.exe: `-d <distro> [--cd <dir>] --exec <cmd…>` runs here; counts its starts. */
function fakeWsl(name: string, opts: { noGit?: boolean; noHelper?: boolean } = {}): { exe: string; starts: () => number } {
  const exe = path.join(BASE, `${name}.sh`);
  const count = path.join(BASE, `${name}.count`);
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(count, '');
  fs.writeFileSync(
    exe,
    [
      '#!/bin/sh',
      `echo x >> '${count}'`,
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      '    -d) shift 2;;',
      '    --cd) cd "$2" || exit 1; shift 2;;',
      '    --exec) shift;',
      opts.noGit ? '      [ "$1" = sh ] && [ "$2" = -c ] && exit 1;' : '',
      opts.noHelper ? '      [ "$1" = sh ] && [ "$2" = -s ] && exit 1; [ "$1" = nice ] && exit 1;' : '',
      '      exec "$@";;',
      '    *) exit 2;;',
      '  esac',
      'done',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { exe, starts: () => fs.readFileSync(count, 'utf8').split('\n').filter(Boolean).length };
}

const unc = (linux: string) => '\\\\wsl.localhost\\Fake' + linux.replace(/\//g, '\\');

describe('git inside WSL (fake distro)', () => {
  it('status, HEAD contents and branches through one persistent helper', async () => {
    const dir = await makeRepo('wsl-e2e', { 'a b/ünï.md': 'old\n', 'x.txt': 'x\n' });
    write(dir, 'a b/ünï.md', 'new\n');
    write(dir, 'new file.md', 'n\n');
    const w = fakeWsl('wsl-ok');
    const log: GitActivity[] = [];
    const off = onGitActivity((a) => log.push(a));
    const g = new GitService(unc(dir), { platform: 'win32', env: testEnv(), wsl: { exe: w.exe, hostPath: (_w, l) => l } });
    services.push(g);
    const s = await g.status();
    off();
    if (!s.ok) throw new Error(s.reason + ' ' + (s.message ?? ''));
    expect(g.engine).toBe('wsl');
    expect(Object.fromEntries(s.entries.map((e) => [e.path, e.state]))).toEqual({ 'a b/ünï.md': 'modified', 'new file.md': 'untracked' });
    expect((await g.headFile('a b/ünï.md')).content).toBe('old\n');
    expect((await g.branches()).branches.map((b) => b.name)).toEqual(['main']);
    for (let i = 0; i < 5; i++) await g.status();
    // `command -v git` + one helper; everything else ran through it (no wsl.exe per call).
    expect(w.starts()).toBeLessThanOrEqual(3);
    expect(log.some((a) => a.kind === 'status' && a.trigger?.endsWith('wsl'))).toBe(true);
    await expect(g.headFile('..\\..\\etc\\passwd')).resolves.toMatchObject({ content: null }); // still contained
  });

  it('mutations / network go per call (never through the helper)', async () => {
    const dir = await makeRepo('wsl-mut', { 'a.md': 'a\n' });
    write(dir, 'a.md', 'b\n');
    const w = fakeWsl('wsl-mut');
    const g = new GitService(unc(dir), { platform: 'win32', env: testEnv(), wsl: { exe: w.exe, hostPath: (_w, l) => l } });
    services.push(g);
    await g.status();
    const before = w.starts();
    expect((await g.stage(['a.md'])).ok).toBe(true);
    expect(w.starts()).toBe(before + 1);
    expect(Object.fromEntries((await g.status() as any).entries.map((e: any) => [e.path, e.staged]))).toEqual({ 'a.md': true });
  });

  it('stale index: the helper reports git’s counter; the refresh runs per call (never killed) and fixes it', async () => {
    const all: Record<string, string> = {};
    for (let i = 0; i < 300; i++) all[`d/f${i}.txt`] = `${i}\n`.repeat(10);
    const dir = await makeRepo('wsl-refresh', all);
    const past = new Date(Date.now() - 3600_000);
    for (const r of Object.keys(all)) fs.utimesSync(path.join(dir, r), past, past);
    const w = fakeWsl('wsl-refresh');
    const log: GitActivity[] = [];
    const off = onGitActivity((a) => log.push(a));
    const g = new GitService(unc(dir), { platform: 'win32', env: testEnv(), wsl: { exe: w.exe, hostPath: (_w, l) => l } });
    services.push(g);
    expect((await g.status()).ok).toBe(true);
    expect(g.indexHint()?.wasted).toBe(300);
    const before = w.starts();
    expect(await g.refreshIndex()).toMatchObject({ ok: true });
    expect(w.starts()).toBe(before + 1); // its own wsl.exe, not the helper
    expect((await g.status()).ok).toBe(true);
    expect(g.indexHint()?.wasted).toBe(0);
    off();
    expect(log.some((a) => a.kind === 'update-index' && a.trigger === 'index-refresh/wsl')).toBe(true);
  });

  it('helper cannot start → per-call wsl.exe, same results', async () => {
    const dir = await makeRepo('wsl-nohelper', { 'a.md': 'a\n' });
    write(dir, 'a.md', 'b\n');
    const w = fakeWsl('wsl-nohelper', { noHelper: true });
    const g = new GitService(unc(dir), { platform: 'win32', env: testEnv(), wsl: { exe: w.exe, hostPath: (_w, l) => l } });
    services.push(g);
    const s = await g.status();
    expect(s.ok && s.entries.map((e) => e.path)).toEqual(['a.md']);
    expect(g.engine).toBe('wsl');
  });

  it('distro without git (docker-desktop) → Windows git; routing off → Windows git', async () => {
    const dir = await makeRepo('wsl-nogit', { 'a.md': 'a\n' });
    const w = fakeWsl('wsl-nogit', { noGit: true });
    const g = new GitService(unc(dir), { platform: 'win32', env: testEnv(), gitPath: path.join(BASE, 'no-such-git'), wsl: { exe: w.exe, hostPath: (_w, l) => l } });
    services.push(g);
    expect(await g.status()).toMatchObject({ ok: false, reason: 'no-git' });
    expect(g.engine).toBe('native');
    const off = new GitService(unc(dir), { platform: 'win32', env: testEnv(), gitPath: path.join(BASE, 'no-such-git'), wsl: { mode: 'off', exe: w.exe } });
    services.push(off);
    expect(off.wslTarget).toBeNull();
  });
});
