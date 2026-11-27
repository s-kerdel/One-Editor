// Path links in terminal output + "Run in terminal" text preparation.
import { describe, it, expect } from 'vitest';
import { findPathCandidates, resolveLinkPath, type LinkContext } from '../../../src/renderer/terminal/links';
import { copyableCode, isRunnableFence, prepareRunText } from '../../../src/renderer/terminal/run';

const pick = (text: string) => findPathCandidates(text).map((c) => ({ text: text.slice(c.start, c.end), path: c.path, line: c.line, col: c.col }));

describe('findPathCandidates', () => {
  it('path:line:col, path(line,col), path(line), ./relative', () => {
    expect(pick('src/a.ts:12:3 - error TS2322')).toEqual([{ text: 'src/a.ts:12:3', path: 'src/a.ts', line: 12, col: 3 }]);
    expect(pick('C:\\x\\y.php(14)')).toEqual([{ text: 'C:\\x\\y.php(14)', path: 'C:\\x\\y.php', line: 14, col: undefined }]);
    expect(pick('src/a.ts(12,3): error TS1005')).toMatchObject([{ path: 'src/a.ts', line: 12, col: 3 }]);
    expect(pick('see ./notes/a.md.')).toEqual([{ text: './notes/a.md', path: './notes/a.md', line: undefined, col: undefined }]);
  });

  it('stack traces, grep, Python, PHP and .NET formats', () => {
    expect(pick('    at run (/home/me/proj/src/x.js:10:5)')).toMatchObject([{ path: '/home/me/proj/src/x.js', line: 10, col: 5 }]);
    expect(pick('src/a.ts:7:const x = 1')).toMatchObject([{ path: 'src/a.ts', line: 7, col: undefined }]);
    expect(pick('  File "app/main.py", line 3, in <module>')).toMatchObject([{ text: 'app/main.py', path: 'app/main.py', line: 3 }]);
    expect(pick('PHP Fatal error: x in C:\\www\\index.php on line 14')).toMatchObject([{ path: 'C:\\www\\index.php', line: 14 }]);
    expect(pick('   at Foo() in C:\\src\\Foo.cs:line 42')).toMatchObject([{ path: 'C:\\src\\Foo.cs', line: 42 }]);
    expect(pick('--> src/main.rs:2:5')).toMatchObject([{ path: 'src/main.rs', line: 2, col: 5 }]);
    expect(pick('\tmodified:   README.md')).toMatchObject([{ path: 'README.md' }]);
  });

  it('skips plain words, versions and URLs (those are the web-links addon’s job)', () => {
    expect(pick('hello world 1.2.3 v20.1 done')).toEqual([]);
    expect(pick('open https://example.com/a/b.html now').filter((c) => !c.path.startsWith('//'))).toEqual([]);
  });
});

describe('resolveLinkPath', () => {
  const files = new Set(['src/a.ts', 'notes/a.md', 'README.md', 'www/index.php', 'sub/dir/x.js']);

  it('relative to the shell’s start folder, then the workspace root', () => {
    const ctx: LinkContext = { root: '/home/me/proj', os: 'linux', files, cwd: 'sub' };
    expect(resolveLinkPath('dir/x.js', ctx)).toBe('sub/dir/x.js');
    expect(resolveLinkPath('./notes/a.md', ctx)).toBe('notes/a.md');
    expect(resolveLinkPath('../src/a.ts', ctx)).toBe('src/a.ts');
    expect(resolveLinkPath('src/missing.ts', ctx)).toBeNull();
    expect(resolveLinkPath('../../etc/passwd', ctx)).toBeNull();
    expect(resolveLinkPath('~/x.md', ctx)).toBeNull();
  });

  it('absolute paths inside the workspace (Linux: case-sensitive)', () => {
    const ctx: LinkContext = { root: '/home/me/proj', os: 'linux', files };
    expect(resolveLinkPath('/home/me/proj/src/a.ts', ctx)).toBe('src/a.ts');
    expect(resolveLinkPath('/home/me/PROJ/src/a.ts', ctx)).toBeNull();
    expect(resolveLinkPath('/home/me/project2/src/a.ts', ctx)).toBeNull();
    expect(resolveLinkPath('/etc/passwd', ctx)).toBeNull();
  });

  it('Windows: drive paths case-insensitively, backslashes, Git Bash /c/… and WSL /mnt/c/…', () => {
    const ctx: LinkContext = { root: 'C:\\Users\\me\\proj', os: 'win32', files };
    expect(resolveLinkPath('C:\\Users\\me\\proj\\www\\index.php', ctx)).toBe('www/index.php');
    expect(resolveLinkPath('c:/users/ME/proj/SRC/A.ts', ctx)).toBe('src/a.ts');
    expect(resolveLinkPath('src\\a.ts', ctx)).toBe('src/a.ts');
    expect(resolveLinkPath('/c/Users/me/proj/README.md', ctx)).toBe('README.md');
    expect(resolveLinkPath('/mnt/c/Users/me/proj/README.md', ctx)).toBe('README.md');
    expect(resolveLinkPath('D:\\Users\\me\\proj\\README.md', ctx)).toBeNull();
    expect(resolveLinkPath('C:\\Users\\me\\proj2\\README.md', ctx)).toBeNull();
  });

  it('Windows folder inside WSL: Linux paths printed by the distro’s shell', () => {
    const ctx: LinkContext = { root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj', os: 'win32', files };
    expect(resolveLinkPath('/home/me/proj/src/a.ts', ctx)).toBe('src/a.ts');
    expect(resolveLinkPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\README.md', ctx)).toBe('README.md');
    expect(resolveLinkPath('/home/me/other/README.md', ctx)).toBeNull();
  });
});

describe('run in terminal', () => {
  it('knows which fences are shell code', () => {
    for (const l of ['bash', 'sh', 'shell', 'console', 'powershell', 'pwsh', 'cmd', 'bat', 'Bash', 'bash title="x"', 'zsh']) expect(isRunnableFence(l), l).toBe(true);
    for (const l of ['', 'js', 'php', 'text', 'mermaid', null, undefined]) expect(isRunnableFence(l), String(l)).toBe(false);
  });

  it('console transcripts: only prompt lines, prompts stripped', () => {
    const code = '$ npm install\nadded 3 packages\n\n$ npm test -- --watch=false\n> continued line\nPASS\n';
    expect(prepareRunText(code, 'console')).toBe('npm install\nnpm test -- --watch=false\ncontinued line');
    expect(prepareRunText('ls -la\n', 'console')).toBe('ls -la'); // no prompts at all: it is a plain command
  });

  it('README-style `$ ` on every line is stripped; otherwise text is kept verbatim (minus edges)', () => {
    expect(prepareRunText('$ cd app\r\n$ make\r\n', 'bash')).toBe('cd app\nmake');
    expect(prepareRunText('echo "$ HOME"\n$ ls\n', 'sh')).toBe('echo "$ HOME"\n$ ls');
    expect(prepareRunText('\n\nGet-ChildItem | Select Name   \n\n', 'powershell')).toBe('Get-ChildItem | Select Name');
    expect(prepareRunText('> not a prompt in bash', 'bash')).toBe('> not a prompt in bash');
  });

  it('control characters never reach the terminal (Ctrl-O would run the line without Enter)', () => {
    expect(prepareRunText('echo pwned > x\u000f', 'bash')).toBe('echo pwned > x');
    expect(prepareRunText('ls\u0003\u0004\u001a\u007f\u0000', 'sh')).toBe('ls');
    expect(prepareRunText('echo a\u001b[201~\u000f', 'bash')).toBe('echo a[201~');
    expect(prepareRunText('echo \u009b31m\u0085x', 'bash')).toBe('echo 31mx'); // C1 (8-bit CSI, NEL)
    expect(prepareRunText('$ make\u000f\n$ ls\u000b', 'console')).toBe('make\nls');
    // Tabs and newlines stay; a lone CR is a line break (so the "several lines?" question still comes).
    expect(prepareRunText('a\tb\rc', 'bash')).toBe('a\tb\nc');
  });

  it('Copy hands out code without control characters (a paste into a terminal must not run it)', () => {
    expect(copyableCode('echo hi\u001b[201~rm -rf ~\u000f')).toBe('echo hi[201~rm -rf ~');
    expect(copyableCode('a\u009b201~b\u0085c')).toBe('a201~bc'); // C1
    // Everything else stays as written: indentation, blank lines, tabs, no trimming.
    expect(copyableCode('  if x:\r\n\n\tpass\r')).toBe('  if x:\n\n\tpass\n');
  });
});
