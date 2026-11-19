// Pure parsing / locating rules (no git needed): porcelain v2 fixtures, Windows lookup rules, config sniffing.
import { describe, it, expect } from 'vitest';
import { gitCandidates, gitEnv, parseGitVersion, parsePorcelainV2, untrustedFilterOverrides } from '../../../src/backend/git';

const z = (...recs: string[]) => recs.join('\0') + '\0';
const H = 'a'.repeat(40);
const one = (xy: string, p: string, sub = 'N...') => `1 ${xy} ${sub} 100644 100644 100644 ${H} ${H} ${p}`;

describe('parsePorcelainV2', () => {
  it('branch headers', () => {
    const r = parsePorcelainV2(z(`# branch.oid ${H}`, '# branch.head feature/x', '# branch.upstream origin/feature/x', '# branch.ab +3 -12'));
    expect(r.branch).toEqual({ head: 'feature/x', oid: H, detached: false, upstream: 'origin/feature/x', ahead: 3, behind: 12 });
    expect(r.entries).toEqual([]);
  });

  it('initial and detached', () => {
    expect(parsePorcelainV2(z('# branch.oid (initial)', '# branch.head main')).branch).toMatchObject({ oid: null, head: 'main' });
    expect(parsePorcelainV2(z(`# branch.oid ${H}`, '# branch.head (detached)')).branch).toMatchObject({ detached: true, head: null, oid: H });
  });

  it('ordinary, renamed (-z: source as its own field), unmerged, untracked, ignored', () => {
    const r = parsePorcelainV2(
      z(
        one('.M', 'notes/with space.md'),
        one('M.', 'staged.md'),
        one('A.', 'added.md'),
        one('AM', 'added-then-edited.md'),
        one('.D', 'gone.md'),
        one('D.', 'removed.md'),
        one('.T', 'typechange'),
        `2 R. N... 100644 100644 100644 ${H} ${H} R100 new name.md`,
        'old name.md',
        `2 C. N... 100644 100644 100644 ${H} ${H} C75 copy.md`,
        'orig.md',
        `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict me.md`,
        '? untracked file.md',
        '? newdir/',
        '! build/',
        '! debug.log',
      ),
    );
    const e = Object.fromEntries(r.entries.map((x) => [x.path, x]));
    expect(e['notes/with space.md']).toEqual({ path: 'notes/with space.md', state: 'modified', staged: false, unstaged: true });
    expect(e['staged.md']).toMatchObject({ state: 'modified', staged: true, unstaged: false });
    expect(e['added.md'].state).toBe('added');
    expect(e['added-then-edited.md'].state).toBe('added');
    expect(e['gone.md'].state).toBe('deleted');
    expect(e['removed.md'].state).toBe('deleted');
    expect(e['typechange'].state).toBe('modified');
    expect(e['new name.md']).toMatchObject({ state: 'renamed', from: 'old name.md' });
    expect(e['copy.md']).toMatchObject({ state: 'added', from: 'orig.md' });
    expect(e['conflict me.md'].state).toBe('conflicted');
    expect(e['untracked file.md'].state).toBe('untracked');
    expect(e['newdir']).toEqual({ path: 'newdir', state: 'untracked', dir: true });
    expect(e['build']).toEqual({ path: 'build', state: 'ignored', dir: true });
    expect(e['debug.log'].state).toBe('ignored');
    expect(r.entries).toHaveLength(14);
  });

  it('Git for Windows output: forward slashes, raw UTF-8, CR-tolerant headers', () => {
    // core.quotepath=off + -z: no C-quoting even for non-ASCII; git uses "/" on every OS.
    const r = parsePorcelainV2(z('# branch.oid ' + H + '\r', '# branch.head main\r', one('.M', 'Ünïcode Ordner/日本 語.md'), '? C:odd\\name.md'));
    expect(r.branch.head).toBe('main');
    expect(r.branch.oid).toBe(H);
    expect(r.entries.map((x) => x.path)).toEqual(['Ünïcode Ordner/日本 語.md', 'C:odd\\name.md']);
  });

  it('submodules are one modified entry', () => {
    const r = parsePorcelainV2(z(`1 .M SC.. 160000 160000 160000 ${H} ${H} vendor/lib`, `1 .M S.M. 160000 160000 160000 ${H} ${H} vendor/other`));
    expect(r.entries).toEqual([
      { path: 'vendor/lib', state: 'modified', staged: false, unstaged: true, submodule: true },
      { path: 'vendor/other', state: 'modified', staged: false, unstaged: true, submodule: true },
    ]);
  });

  it('maps repo paths to a workspace prefix and drops the rest', () => {
    const r = parsePorcelainV2(z(one('.M', 'docs/a.md'), one('.M', 'src/x.ts'), `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/in.md`, 'src/out.md', '? docs/', '? docsier/x.md'), 'docs/');
    expect(r.entries).toEqual([
      { path: 'a.md', state: 'modified', staged: false, unstaged: true },
      { path: 'in.md', state: 'renamed', staged: true, unstaged: false, from: null },
      { path: '', state: 'untracked', dir: true },
    ]);
  });

  it('caps the entry count', () => {
    const recs = Array.from({ length: 30 }, (_, i) => `? f${i}.md`);
    const r = parsePorcelainV2(z(...recs), '', 10);
    expect(r.entries).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('tolerates junk and unknown record types', () => {
    const r = parsePorcelainV2(z('garbage', 'x y', '1 broken', one('.M', 'ok.md')));
    expect(r.entries.map((e) => e.path)).toEqual(['ok.md']);
  });
});

describe('gitCandidates', () => {
  it('Windows: absolute PATH entries only (no cwd lookup), then the usual install folders', () => {
    const env = {
      Path: 'C:\\Windows\\system32;.;relative\\bin;"C:\\Program Files\\Git\\cmd";;C:\\tools\\git\\bin',
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\me',
    };
    const c = gitCandidates('win32', env);
    expect(c.slice(0, 3)).toEqual(['C:\\Windows\\system32\\git.exe', 'C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\tools\\git\\bin\\git.exe']);
    expect(c).toContain('C:\\Program Files (x86)\\Git\\cmd\\git.exe');
    expect(c).toContain('C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe');
    expect(c).toContain('C:\\Users\\me\\scoop\\shims\\git.exe');
    expect(c.every((p) => /^[A-Z]:\\/i.test(p))).toBe(true);
    expect(c.some((p) => p.toLowerCase().endsWith('.cmd') || p.toLowerCase().endsWith('.bat'))).toBe(false);
    // Program Files is listed once even though PATH already had it (case-insensitive dedupe).
    expect(c.filter((p) => p.toLowerCase() === 'c:\\program files\\git\\cmd\\git.exe')).toHaveLength(1);
  });

  it('POSIX: PATH then common locations (GUI apps on macOS get a minimal PATH)', () => {
    const c = gitCandidates('darwin', { PATH: '/usr/bin:./node_modules/.bin:/opt/homebrew/bin' });
    expect(c).toEqual(['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']);
  });
});

describe('gitEnv', () => {
  it('drops repository selectors, disables prompts and optional locks', () => {
    const env = gitEnv({ PATH: '/bin', GIT_DIR: '/elsewhere', git_work_tree: '/x', GIT_INDEX_FILE: 'i', GIT_CONFIG_PARAMETERS: "'core.x=1'", HOME: '/h' });
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.git_work_tree).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });
});

describe('misc', () => {
  it('parses git versions incl. Windows builds', () => {
    expect(parseGitVersion('git version 2.45.2.windows.1\n')).toEqual([2, 45, 2]);
    expect(parseGitVersion('git version 2.39.3 (Apple Git-146)')).toEqual([2, 39, 3]);
    expect(parseGitVersion('nope')).toBeNull();
  });

  it('neutralises repository-local filter drivers, keeps Git LFS', () => {
    const out = untrustedFilterOverrides('filter.evil.clean\n./x.sh\0filter.lfs.process\ngit-lfs filter-process\0filter.dot.ted.smudge\ncat\0');
    expect(out).toEqual([
      '-c', 'filter.evil.clean=', '-c', 'filter.evil.smudge=', '-c', 'filter.evil.process=', '-c', 'filter.evil.required=false',
      '-c', 'filter.dot.ted.clean=', '-c', 'filter.dot.ted.smudge=', '-c', 'filter.dot.ted.process=', '-c', 'filter.dot.ted.required=false',
    ]);
    expect(untrustedFilterOverrides('')).toEqual([]);
  });
});
