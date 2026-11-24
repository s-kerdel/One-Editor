// Shell detection, WSL parsing, spawn planning and environment rules — Windows fixtures run on Linux.
import { describe, it, expect } from 'vitest';
import { decodeWslOutput, detectClaude, detectOpencode, OPENCODE_WSL_CWD, OPENCODE_WSL_LOOKUP, OPENCODE_WSL_SERVE, planOpencode, planOpencodeServeWsl, wslFollowNotice, detectShells, parseWslList, pickDefaultShell, planClaude, planSpawn, pwshName, which, windowsBuildOf, wslPathFor, wslUncInfo, type DetectEnv } from '../../../src/main/terminal-shells';
import { prettyDistro, prettyExe, uniqueNames } from '../../../src/shared/terminal';
import { buildTerminalEnv, resolveTerminalCwd } from '../../../src/main/terminal';
import { isTerminalMethod, TERMINAL_RPC_METHODS } from '../../../src/shared/terminal';
import { RPC_METHODS } from '../../../src/shared/api';

const utf16 = (s: string, bom = false) => {
  const b = Buffer.from(s, 'utf16le');
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), b]) : b;
};

/** Fake machine: a set of existing files (case-insensitive on Windows), dir listings, wsl.exe output. */
function machine(o: { platform: string; env: Record<string, string>; files: string[]; dirs?: Record<string, string[]>; wsl?: { code: number | null; stdout: Uint8Array } | 'throw' }): DetectEnv & { runs: string[][] } {
  const win = o.platform === 'win32';
  const norm = (p: string) => (win ? p.toLowerCase() : p);
  const files = new Set(o.files.map(norm));
  const runs: string[][] = [];
  return {
    platform: o.platform,
    env: o.env,
    runs,
    exists: async (p) => files.has(norm(p)),
    readdir: async (p) => {
      const k = Object.keys(o.dirs ?? {}).find((d) => norm(d) === norm(p));
      if (!k) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return o.dirs![k];
    },
    run: async (file, args) => {
      runs.push([file, ...args]);
      if (o.wsl === 'throw') throw new Error('spawn failed');
      return o.wsl ?? { code: 1, stdout: new Uint8Array() };
    },
  };
}

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me',
  Path: 'C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

describe('shell detection — Windows', () => {
  it('finds PowerShell 7, Windows PowerShell, cmd, Git Bash and WSL distros (UTF-16 `wsl -l -q`)', async () => {
    const m = machine({
      platform: 'win32',
      env: WIN_ENV,
      files: [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\system32\\cmd.exe',
        'C:\\Program Files\\Git\\cmd\\git.exe',
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Windows\\System32\\bash.exe', // the WSL launcher: never "Git Bash"
        'C:\\Windows\\System32\\wsl.exe',
      ],
      dirs: { 'C:\\Program Files\\PowerShell': ['7-preview', '7'] },
      wsl: { code: 0, stdout: utf16('Ubuntu-24.04\r\ndocker-desktop\r\nDebian\r\n\r\n') },
    });
    const shells = await detectShells(m);
    expect(shells.map((s) => s.id)).toEqual(['pwsh', 'powershell', 'cmd', 'gitbash', 'wsl:Ubuntu-24.04', 'wsl:Debian']);
    expect(shells[0]).toMatchObject({ name: 'PowerShell 7', path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', args: ['-NoLogo'] }); // stable before preview
    expect(shells[3]).toMatchObject({ path: 'C:\\Program Files\\Git\\bin\\bash.exe', args: ['--login', '-i'] });
    expect(shells[4]).toMatchObject({ kind: 'wsl', name: 'Ubuntu 24.04', detail: 'WSL · Ubuntu-24.04', path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu-24.04'] });
    expect(m.runs).toEqual([['C:\\Windows\\System32\\wsl.exe', '-l', '-q']]);
  });

  it('pwsh from PATH (store alias) and no WSL distros installed', async () => {
    const m = machine({
      platform: 'win32',
      env: WIN_ENV,
      files: ['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe', 'C:\\Windows\\system32\\cmd.exe', 'C:\\Windows\\System32\\wsl.exe'],
      wsl: { code: 4294967295, stdout: utf16('Windows Subsystem for Linux has no installed distributions.\r\n') },
    });
    const shells = await detectShells(m);
    expect(shells.map((s) => s.id)).toEqual(['pwsh', 'cmd']);
    expect(shells[0].path).toBe('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe');
  });

  it('survives wsl.exe failing to start, and finds Git under LOCALAPPDATA', async () => {
    const m = machine({
      platform: 'win32',
      env: { ...WIN_ENV, Path: 'C:\\Windows\\system32' },
      files: ['C:\\Windows\\System32\\cmd.exe', 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\wsl.exe'],
      wsl: 'throw',
    });
    expect((await detectShells(m)).map((s) => s.id)).toEqual(['cmd', 'gitbash']);
  });

  it('decodes `wsl -l -q` in UTF-16LE (with/without BOM) and UTF-8 (WSL_UTF8=1); drops junk names', () => {
    expect(parseWslList(decodeWslOutput(utf16('Ubuntu\r\nDebian\r\n')))).toEqual(['Ubuntu', 'Debian']);
    expect(parseWslList(decodeWslOutput(utf16('Ubuntu\r\n', true)))).toEqual(['Ubuntu']);
    expect(parseWslList(decodeWslOutput(Buffer.from('Ubuntu\nkali-linux\n')))).toEqual(['Ubuntu', 'kali-linux']);
    expect(parseWslList('Ubuntu (Default)\r\nUbuntu\r\nrancher-desktop\r\nbad name\r\n$(calc)\r\n\u0000\r\n')).toEqual(['Ubuntu']);
  });
});

describe('shell detection — Linux / macOS', () => {
  const env = { SHELL: '/usr/bin/zsh', PATH: '/usr/local/bin:/usr/bin:/bin' };
  it('login shell first, then bash/zsh/fish from PATH, deduped by name', async () => {
    const m = machine({ platform: 'linux', env, files: ['/usr/bin/zsh', '/usr/bin/bash', '/bin/bash'] });
    const shells = await detectShells(m);
    expect(shells.map((s) => [s.id, s.path, s.args])).toEqual([
      ['zsh', '/usr/bin/zsh', []],
      ['bash', '/usr/bin/bash', []],
    ]);
  });

  it('macOS starts login shells; unknown $SHELL is kept as "other"', async () => {
    const m = machine({ platform: 'darwin', env: { SHELL: '/opt/homebrew/bin/nu', PATH: '/opt/homebrew/bin:/bin' }, files: ['/opt/homebrew/bin/nu', '/bin/bash', '/opt/homebrew/bin/fish'] });
    const shells = await detectShells(m);
    expect(shells.map((s) => [s.id, s.kind, s.args])).toEqual([
      ['nu', 'other', []],
      ['bash', 'bash', ['-l']],
      ['fish', 'fish', ['-l']],
    ]);
  });

  it('falls back to /bin/sh; ignores a relative or missing $SHELL', async () => {
    const m = machine({ platform: 'linux', env: { SHELL: 'zsh', PATH: '' }, files: ['/bin/sh'] });
    expect((await detectShells(m)).map((s) => s.id)).toEqual(['sh']);
  });

  it('which() honours PATHEXT on Windows only', async () => {
    const w = machine({ platform: 'win32', env: { PATH: 'C:\\bin;relative\\dir', PATHEXT: '.EXE' }, files: ['C:\\bin\\tool.exe', 'relative\\dir\\x.exe'] });
    expect(await which('tool', w)).toBe('C:\\bin\\tool.exe');
    expect(await which('x', w)).toBeNull(); // relative PATH entries are skipped (planted-binary risk)
    const l = machine({ platform: 'linux', env: { PATH: '/bin' }, files: ['/bin/tool'] });
    expect(await which('tool', l)).toBe('/bin/tool');
  });
});

describe('default shell + spawn plan', () => {
  const win = [
    { id: 'pwsh', name: '', kind: 'pwsh', path: 'C:\\pwsh.exe', args: ['-NoLogo'] },
    { id: 'cmd', name: '', kind: 'cmd', path: 'C:\\Windows\\System32\\cmd.exe', args: [] },
    { id: 'gitbash', name: '', kind: 'gitbash', path: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
    { id: 'wsl:Ubuntu', name: '', kind: 'wsl', path: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu'] },
  ] as const;
  const shells = win.map((s) => ({ ...s, args: [...s.args] }));

  it('a folder inside a WSL distro defaults to that distro; else PowerShell 7 → PowerShell → cmd', () => {
    expect(pickDefaultShell(shells, { platform: 'win32', root: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj' })).toBe('wsl:Ubuntu');
    expect(pickDefaultShell(shells, { platform: 'win32', root: '\\\\wsl$\\ubuntu\\home' })).toBe('wsl:Ubuntu');
    expect(pickDefaultShell(shells, { platform: 'win32', root: '\\\\wsl$\\Debian\\home' })).toBe('pwsh');
    expect(pickDefaultShell(shells, { platform: 'win32', root: 'C:\\notes' })).toBe('pwsh');
    expect(pickDefaultShell(shells.slice(1), { platform: 'win32', root: 'C:\\notes' })).toBe('cmd');
    expect(pickDefaultShell([], { platform: 'linux' })).toBeNull();
  });

  it('WSL starts in the folder (Linux path inside the same distro, Windows path otherwise)', () => {
    const env = { USERPROFILE: 'C:\\Users\\me' };
    expect(planSpawn(shells[3], '\\\\wsl.localhost\\Ubuntu\\home\\me\\my proj', { platform: 'win32', env }).args).toEqual(['-d', 'Ubuntu', '--cd', '/home/me/my proj']);
    expect(planSpawn(shells[3], 'C:\\notes', { platform: 'win32', env }).args).toEqual(['-d', 'Ubuntu', '--cd', 'C:\\notes']);
  });

  it('cmd.exe on a UNC folder: starts in the profile and pushd-s there; Git Bash keeps the folder', () => {
    const env = { USERPROFILE: 'C:\\Users\\me' };
    expect(planSpawn(shells[1], '\\\\wsl$\\Ubuntu\\home\\me', { platform: 'win32', env })).toEqual({ file: shells[1].path, args: '/S /K "pushd "\\\\wsl$\\Ubuntu\\home\\me""', cwd: 'C:\\Users\\me', env: {} });
    expect(planSpawn(shells[1], 'C:\\notes', { platform: 'win32', env })).toMatchObject({ args: [], cwd: 'C:\\notes' });
    expect(planSpawn(shells[2], 'C:\\notes', { platform: 'win32', env }).env).toEqual({ CHERE_INVOKING: '1' });
    expect(planSpawn(shells[0], 'C:\\notes', { platform: 'win32', env })).toMatchObject({ args: ['-NoLogo'], cwd: 'C:\\notes' });
  });

  it('parses WSL UNC paths and Windows build numbers', () => {
    expect(wslUncInfo('\\\\wsl$\\Ubuntu\\home\\me')).toEqual({ distro: 'Ubuntu', linuxPath: '/home/me' });
    expect(wslUncInfo('//wsl.localhost/Ubuntu/')).toEqual({ distro: 'Ubuntu', linuxPath: '/' });
    expect(wslUncInfo('\\\\server\\share\\x')).toBeNull();
    expect(wslUncInfo('C:\\wsl$\\x')).toBeNull();
    expect(windowsBuildOf('10.0.22631')).toBe(22631);
    expect(windowsBuildOf('unknown')).toBeUndefined();
  });
});

describe('terminal environment', () => {
  it('Windows: strips app vars case-insensitively and never duplicates differently-cased keys', () => {
    const env = buildTerminalEnv({ Path: 'C:\\x', Term: 'dumb', Sec_Edit_Test: '1', electron_run_as_node: '1', NPM_CONFIG_X: 'y', USERNAME: 'me' }, { platform: 'win32', appVersion: '1.2.3', extra: { CHERE_INVOKING: '1' } });
    expect(env).toEqual({ Path: 'C:\\x', USERNAME: 'me', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'sec-edit', TERM_PROGRAM_VERSION: '1.2.3', CHERE_INVOKING: '1' });
  });

  it('Linux: restores the desktop Electron replaced; macOS gets a UTF-8 locale', () => {
    const l = buildTerminalEnv({ XDG_CURRENT_DESKTOP: 'Unity', ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME', VITE_DEV_SERVER_URL: 'http://x', INIT_CWD: '/x', HOME: '/home/me' }, { platform: 'linux' });
    expect(l).toEqual({ XDG_CURRENT_DESKTOP: 'GNOME', HOME: '/home/me', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'sec-edit' });
    expect(buildTerminalEnv({}, { platform: 'darwin' }).LANG).toBe('en_US.UTF-8');
    expect(buildTerminalEnv({ LANG: 'nl_NL.UTF-8' }, { platform: 'darwin' }).LANG).toBe('nl_NL.UTF-8');
  });
});

describe('terminal cwd (win32 rules, fake fs)', () => {
  const dirs = new Set(['C:\\ws', 'C:\\ws\\sub', 'C:\\ws\\link']);
  const fsx = {
    stat: async (p: string) => {
      if (!dirs.has(p)) throw new Error('ENOENT');
      return { isDirectory: () => true };
    },
    realpath: async (p: string) => (p === 'C:\\ws\\link' ? 'D:\\elsewhere' : p.replace(/^c:/, 'C:')),
  };
  const go = (rel: string) => resolveTerminalCwd('C:\\ws', rel, { platform: 'win32', fs: fsx });

  it('accepts the root and folders inside it, refuses traversal, drives, devices, symlink escapes', async () => {
    expect(await go('')).toEqual({ abs: 'C:\\ws', rel: '' });
    expect(await go('sub')).toEqual({ abs: 'C:\\ws\\sub', rel: 'sub' });
    expect(await go('sub\\..\\sub')).toEqual({ abs: 'C:\\ws\\sub', rel: 'sub' });
    await expect(go('..\\Windows')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    await expect(go('sub/../../x')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    await expect(go('C:\\Windows')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(go('\\\\server\\share')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(go('/etc')).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(go('con')).rejects.toMatchObject({ code: 'EINVAL' }); // device name
    await expect(go('sub:stream')).rejects.toMatchObject({ code: 'EINVAL' }); // ADS
    await expect(go('link')).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    await expect(go('missing')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('browser mode never exposes a shell', () => {
  it('terminal names are not plain RPC methods, and the server-side matcher catches them all', () => {
    for (const m of TERMINAL_RPC_METHODS) {
      expect(isTerminalMethod(m), m).toBe(true);
      expect((RPC_METHODS as readonly string[]).includes(m)).toBe(false);
    }
    for (const m of ['term:spawn', 'terminalAnything', 'term']) expect(isTerminalMethod(m), m).toBe(true);
    for (const m of RPC_METHODS) expect(isTerminalMethod(m), m).toBe(false);
    expect(isTerminalMethod('terminate')).toBe(false);
  });
});

describe('Claude Code detection + start plan', () => {
  it('Windows: claude.exe on PATH, the native installer folder, or the npm shim', async () => {
    const env = { ...WIN_ENV, APPDATA: 'C:\\Users\\me\\AppData\\Roaming' };
    const onPath = machine({ platform: 'win32', env: { ...env, Path: `${env.Path};C:\\Tools` }, files: ['C:\\Tools\\claude.exe'] });
    expect(await detectClaude(onPath)).toEqual({ available: true, via: 'native', path: 'C:\\Tools\\claude.exe' });
    const native = machine({ platform: 'win32', env, files: ['C:\\Users\\me\\.local\\bin\\claude.exe'] });
    expect((await detectClaude(native)).path).toBe('C:\\Users\\me\\.local\\bin\\claude.exe');
    const npm = machine({ platform: 'win32', env, files: ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'] });
    expect((await detectClaude(npm)).path).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
    const none = await detectClaude(machine({ platform: 'win32', env, files: [] }));
    expect(none).toMatchObject({ available: false, hint: expect.stringContaining('irm https://claude.ai/install.ps1 | iex') });
  });

  it('WSL default shell: looked up inside the distro (login shell output may carry rc noise)', async () => {
    const m = machine({ platform: 'win32', env: WIN_ENV, files: [], wsl: { code: 0, stdout: Buffer.from('Welcome!\n/home/me/.local/bin/claude\n') } });
    expect(await detectClaude(m, { wsl: { exe: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu' } })).toEqual({ available: true, via: 'wsl', distro: 'Ubuntu', path: '/home/me/.local/bin/claude' });
    expect(m.runs).toEqual([['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '-e', 'bash', '-lic', 'command -v claude']]);
    // Not inside the distro → a Windows install still counts; nothing anywhere → the Linux install hint.
    const win = machine({ platform: 'win32', env: WIN_ENV, files: ['C:\\Users\\me\\.local\\bin\\claude.exe'], wsl: { code: 1, stdout: new Uint8Array() } });
    expect((await detectClaude(win, { wsl: { exe: 'wsl.exe', distro: 'Ubuntu' } })).via).toBe('native');
    const none = machine({ platform: 'win32', env: WIN_ENV, files: [], wsl: { code: 1, stdout: new Uint8Array() } });
    expect((await detectClaude(none, { wsl: { exe: 'wsl.exe', distro: 'Ubuntu' } })).hint).toContain('curl -fsSL https://claude.ai/install.sh | bash');
  });

  it('Linux / macOS: PATH first, then ~/.local/bin (GUI apps often lack it on PATH)', async () => {
    expect((await detectClaude(machine({ platform: 'darwin', env: { HOME: '/Users/me', PATH: '/usr/bin' }, files: ['/Users/me/.local/bin/claude'] }))).path).toBe('/Users/me/.local/bin/claude');
    expect((await detectClaude(machine({ platform: 'linux', env: { HOME: '/home/me', PATH: '/opt/x/bin' }, files: ['/opt/x/bin/claude', '/home/me/.local/bin/claude'] }))).path).toBe('/opt/x/bin/claude');
  });

  it('cmd.exe command lines: a folder or program name can never add a command (& | ^ stay inside quotes, % is refused)', async () => {
    // What CreateProcess gets: node-pty's own command-line builder (a string is passed through as it is).
    const { argsToCommandLine } = (await import('node-pty/lib/windowsPtyAgent.js' as string)) as { argsToCommandLine(file: string, args: string[] | string): string };
    const env = { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\me' };
    const cmd = { id: 'cmd', name: 'Command Prompt', kind: 'cmd' as const, path: env.ComSpec, args: [] };
    const line = (p: { file: string; args: string[] | string }) => argsToCommandLine(p.file, p.args);
    /** What cmd.exe parses: with /S the command is the text after /K or /C minus its first and last quote;
     *  returned are the characters outside double quotes — where cmd would act on an operator. */
    const bare = (l: string) => {
      const m = /^.*? \/S \/[KC] "(.*)"$/.exec(l);
      if (!m) throw new Error(`not a /S command line: ${l}`);
      return m[1].split('"').filter((_, i) => i % 2 === 0).join('');
    };
    for (const dir of ['\\\\nas\\share\\proj&calc.exe', '\\\\nas\\share\\a|b', '\\\\nas\\share\\a^b&&c', '\\\\nas\\share\\(x)<y>', '\\\\nas\\share\\my proj&calc.exe', '\\\\nas\\share\\wow!']) {
      const l = line(planSpawn(cmd, dir, { platform: 'win32', env }));
      expect(l, dir).toBe(`${env.ComSpec} /S /K "pushd "${dir}""`);
      expect(bare(l), dir).not.toMatch(/[&|<>^()]/);
    }
    const shim = { available: true, via: 'native' as const, path: 'C:\\Users\\R&D\\AppData\\Roaming\\npm\\claude.cmd' };
    const unc = line(planClaude(shim, '\\\\nas\\share\\proj&calc.exe', { platform: 'win32', env }));
    expect(unc).toBe(`${env.ComSpec} /D /S /C "pushd "\\\\nas\\share\\proj&calc.exe" && "${shim.path}""`);
    expect(bare(unc).match(/&/g)).toHaveLength(2); // only our own &&
    expect(bare(line(planClaude(shim, 'C:\\notes', { platform: 'win32', env })))).not.toMatch(/[&|<>^()]/);
    // %NAME% expands inside quotes too and cannot be escaped on a command line: no shell there.
    expect(() => planSpawn(cmd, '\\\\nas\\share\\%COMSPEC%', { platform: 'win32', env })).toThrow(/%/);
    expect(() => planClaude(shim, '\\\\nas\\share\\100%', { platform: 'win32', env })).toThrow(/%/);
    expect(() => planClaude({ ...shim, path: 'C:\\x"y\\claude.cmd' }, 'C:\\notes', { platform: 'win32', env })).toThrow();
    // A local folder is the process's working directory, never part of the command line.
    expect(planSpawn(cmd, 'C:\\a&b%c', { platform: 'win32', env })).toMatchObject({ args: [], cwd: 'C:\\a&b%c' });
  });

  it('start plans: WSL (cd back after rc files), cmd shim (pushd on UNC), native binary (its folder first on PATH)', () => {
    const env = { Path: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERPROFILE: 'C:\\Users\\me' };
    const wsl = planClaude({ available: true, via: 'wsl', distro: 'Ubuntu', path: '/usr/bin/claude' }, '\\\\wsl.localhost\\Ubuntu\\home\\me\\my proj', { platform: 'win32', env, wslExe: 'C:\\Windows\\System32\\wsl.exe' });
    expect(wsl).toEqual({ file: 'C:\\Windows\\System32\\wsl.exe', args: ['-d', 'Ubuntu', '--cd', '/home/me/my proj', '-e', 'bash', '-lic', 'cd -- "$0" 2>/dev/null; exec claude', '/home/me/my proj'], cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\my proj', env: {} });
    const shim = { available: true, via: 'native' as const, path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd' };
    expect(planClaude(shim, 'C:\\notes', { platform: 'win32', env })).toMatchObject({ file: env.ComSpec, args: `/D /S /C ""${shim.path}""`, cwd: 'C:\\notes', env: { Path: 'C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Windows' } });
    expect(planClaude(shim, '\\\\server\\share\\notes', { platform: 'win32', env })).toMatchObject({ args: `/D /S /C "pushd "\\\\server\\share\\notes" && "${shim.path}""`, cwd: 'C:\\Users\\me' });
    expect(planClaude({ available: true, via: 'native', path: '/home/me/.local/bin/claude' }, '/home/me/proj', { platform: 'linux', env: { PATH: '/usr/bin' } })).toEqual({ file: '/home/me/.local/bin/claude', args: [], cwd: '/home/me/proj', env: { PATH: '/home/me/.local/bin:/usr/bin' } });
  });

  it('Windows folders as seen from WSL', () => {
    expect(wslPathFor('C:\\Users\\me\\proj', 'Ubuntu')).toBe('/mnt/c/Users/me/proj');
    expect(wslPathFor('D:\\', 'Ubuntu')).toBe('/mnt/d');
    expect(wslPathFor('\\\\wsl$\\Ubuntu\\srv', 'ubuntu')).toBe('/srv');
    expect(wslPathFor('\\\\wsl$\\Debian\\srv', 'Ubuntu')).toBeNull();
    expect(wslPathFor('\\\\server\\share', 'Ubuntu')).toBeNull();
  });
});

describe('friendly profile names', () => {
  it('WSL distro ids → readable names (odd ones too)', () => {
    expect(prettyDistro('Ubuntu-24.04')).toBe('Ubuntu 24.04');
    expect(prettyDistro('Ubuntu')).toBe('Ubuntu');
    expect(prettyDistro('kali-linux')).toBe('Kali Linux');
    expect(prettyDistro('docker-desktop')).toBe('Docker Desktop');
    expect(prettyDistro('openSUSE-Tumbleweed')).toBe('openSUSE Tumbleweed');
    expect(prettyDistro('OracleLinux_9_1')).toBe('OracleLinux 9.1');
    expect(prettyDistro('debian')).toBe('Debian');
    expect(prettyDistro('Ubuntu-22.04_dev')).toBe('Ubuntu 22.04 Dev');
  });

  it('PowerShell takes the real major version from its install folder', () => {
    expect(pwshName('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('PowerShell 7');
    expect(pwshName('C:\\Program Files\\PowerShell\\8\\pwsh.exe')).toBe('PowerShell 8');
    expect(pwshName('C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe')).toBe('PowerShell 7 Preview');
    expect(pwshName('C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe')).toBe('PowerShell 7');
  });

  it('Unix shells are capitalised; duplicates get (2), (3)', () => {
    expect(['bash', 'zsh', 'fish', 'nu', 'sh'].map(prettyExe)).toEqual(['Bash', 'Zsh', 'Fish', 'Nu', 'sh (POSIX)']);
    expect(uniqueNames([{ name: 'Ubuntu' }, { name: 'Debian' }, { name: 'Ubuntu' }, { name: 'Ubuntu' }]).map((x) => x.name)).toEqual(['Ubuntu', 'Debian', 'Ubuntu (2)', 'Ubuntu (3)']);
  });

  it('detection uses the friendly names + one-line details (Windows)', async () => {
    const m = machine({
      platform: 'win32',
      env: WIN_ENV,
      files: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'C:\\Windows\\system32\\cmd.exe', 'C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Windows\\System32\\wsl.exe'],
      dirs: { 'C:\\Program Files\\PowerShell': ['7'] },
      wsl: { code: 0, stdout: utf16('Ubuntu-24.04\r\nkali-linux\r\nUbuntu_24.04\r\n') },
    });
    const shells = await detectShells(m);
    expect(shells.map((s) => [s.id, s.name, s.detail])).toEqual([
      ['pwsh', 'PowerShell 7', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'],
      ['powershell', 'Windows PowerShell', 'PowerShell 5.1 · built into Windows'],
      ['cmd', 'Command Prompt', 'cmd.exe'],
      ['gitbash', 'Git Bash', 'C:\\Program Files\\Git\\bin\\bash.exe'],
      ['wsl:Ubuntu-24.04', 'Ubuntu 24.04', 'WSL · Ubuntu-24.04'],
      ['wsl:kali-linux', 'Kali Linux', 'WSL · kali-linux'],
      ['wsl:Ubuntu_24.04', 'Ubuntu 24.04 (2)', 'WSL · Ubuntu_24.04'], // ids stay unique and unchanged
    ]);
  });

  it('detection uses the friendly names (Linux)', async () => {
    const m = machine({ platform: 'linux', env: { SHELL: '/usr/bin/zsh', PATH: '/usr/bin' }, files: ['/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/fish'] });
    expect((await detectShells(m)).map((s) => [s.id, s.name, s.detail])).toEqual([
      ['zsh', 'Zsh', '/usr/bin/zsh'],
      ['bash', 'Bash', '/usr/bin/bash'],
      ['fish', 'Fish', '/usr/bin/fish'],
    ]);
  });
});


describe('opencode detection + start plan', () => {
  it('finds the CLI on PATH or in the installer folders; says how to install when missing', async () => {
    expect((await detectOpencode(machine({ platform: 'darwin', env: { HOME: '/Users/me', PATH: '/usr/bin' }, files: ['/Users/me/.opencode/bin/opencode'] }))).path).toBe('/Users/me/.opencode/bin/opencode');
    expect((await detectOpencode(machine({ platform: 'linux', env: { HOME: '/h', PATH: '/opt/x/bin' }, files: ['/opt/x/bin/opencode', '/h/.opencode/bin/opencode'] }))).path).toBe('/opt/x/bin/opencode');
    const none = await detectOpencode(machine({ platform: 'linux', env: { HOME: '/h', PATH: '/usr/bin' }, files: [] }));
    expect(none).toMatchObject({ available: false, install: expect.stringContaining('opencode') });
  });

  it('attaches to One\'s server: address in argv, the password only in the environment', () => {
    const plan = planOpencode({ available: true, path: '/h/.opencode/bin/opencode' }, '/ws', { platform: 'linux', env: { PATH: '/usr/bin' }, server: { url: 'http://127.0.0.1:4000', password: 'pw-123456789' } });
    expect(plan.file).toBe('/h/.opencode/bin/opencode');
    expect(plan.args).toEqual(['--server', 'http://127.0.0.1:4000']);
    expect(JSON.stringify(plan.args)).not.toContain('pw-123456789');
    expect(plan.env).toMatchObject({ OPENCODE_PASSWORD: 'pw-123456789' });
    expect(planOpencode({ available: true, path: '/x/opencode' }, '/ws', { platform: 'linux', env: {} }).args).toEqual([]);
  });

  it('WSL default shell: looked up inside the distro first (PATH, then the installer folders), native as the fallback', async () => {
    const wsl = { exe: 'C:\\Windows\\System32\\wsl.exe', distro: 'Ubuntu' };
    const m = machine({ platform: 'win32', env: WIN_ENV, files: [], wsl: { code: 0, stdout: Buffer.from('Welcome!\nalias opencode=x\n/home/me/.opencode/bin/opencode\n') } });
    expect(await detectOpencode(m, { wsl })).toEqual({ available: true, via: 'wsl', distro: 'Ubuntu', path: '/home/me/.opencode/bin/opencode' });
    expect(m.runs).toEqual([['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '-e', 'bash', '-lic', OPENCODE_WSL_LOOKUP]]);
    for (const dir of ['$HOME/.opencode/bin', '$HOME/.local/bin', '$HOME/.npm-global/bin']) expect(OPENCODE_WSL_LOOKUP).toContain(`"${dir}/opencode"`);
    // Output that is not a plain absolute path is never taken (it becomes a bash argument later).
    const odd = machine({ platform: 'win32', env: WIN_ENV, files: [], wsl: { code: 0, stdout: Buffer.from('/tmp/$(calc)/opencode\n/tmp/a b/opencode\nopencode\n') } });
    expect((await detectOpencode(odd, { wsl })).available).toBe(false);
    // Not in the distro, but installed on Windows: native.
    const win = machine({ platform: 'win32', env: WIN_ENV, files: ['C:\\Users\\me\\.opencode\\bin\\opencode.exe'], wsl: { code: 1, stdout: new Uint8Array() } });
    expect(await detectOpencode(win, { wsl })).toMatchObject({ available: true, via: 'native', path: 'C:\\Users\\me\\.opencode\\bin\\opencode.exe' });
    // Nowhere: the hint names the distro and gives the Linux command, not PowerShell / npm.
    const none = await detectOpencode(machine({ platform: 'win32', env: WIN_ENV, files: [], wsl: 'throw' }), { wsl });
    expect(none).toEqual({ available: false, hint: 'Opencode is not installed. In a terminal (WSL · Ubuntu): curl -fsSL https://opencode.ai/install | bash — then refresh.', install: 'curl -fsSL https://opencode.ai/install | bash' });
    // Native Windows (no WSL default shell) keeps the PowerShell text and never starts wsl.exe.
    const native = machine({ platform: 'win32', env: WIN_ENV, files: [] });
    expect(await detectOpencode(native)).toEqual({ available: false, hint: 'Opencode is not installed. In PowerShell: npm i -g opencode-ai — then refresh.', install: 'npm i -g opencode-ai' });
    expect(native.runs).toEqual([]);
  });

  it('WSL start plan: login bash, cd back after the rc files, exec the found path; with a server: address as an argument, password through WSLENV', () => {
    const info = { available: true, via: 'wsl' as const, distro: 'Ubuntu', path: '/home/me/.opencode/bin/opencode' };
    const o = { platform: 'win32', env: { ...WIN_ENV, WSLENV: 'X/p' }, wslExe: 'C:\\Windows\\System32\\wsl.exe' };
    const script = 'cd -- "$0" 2>/dev/null; exec "$1"';
    expect(planOpencode(info, '\\\\wsl.localhost\\Ubuntu\\home\\me\\my proj', o)).toEqual({ file: o.wslExe, args: ['-d', 'Ubuntu', '--cd', '/home/me/my proj', '-e', 'bash', '-lic', script, '/home/me/my proj', info.path], cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\my proj', env: {} });
    expect(planOpencode(info, 'C:\\Users\\me\\proj', o).args).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/Users/me/proj', '-e', 'bash', '-lic', script, '/mnt/c/Users/me/proj', info.path]);
    // Plain: nothing of a server.
    expect(JSON.stringify(planOpencode(info, 'C:\\ws', o))).not.toMatch(/--server|OPENCODE_PASSWORD|WSLENV/);
    const withServer = planOpencode(info, 'C:\\ws', { ...o, server: { url: 'http://127.0.0.1:4000', password: 'pw-123456789' } });
    // The script stays fixed text: address + path are arguments; the password is never in argv.
    expect(withServer.args).toEqual(['-d', 'Ubuntu', '--cd', '/mnt/c/ws', '-e', 'bash', '-lic', 'cd -- "$0" 2>/dev/null; exec "$1" --server "$2"', '/mnt/c/ws', info.path, 'http://127.0.0.1:4000']);
    expect(JSON.stringify(withServer.args)).not.toContain('pw-123456789');
    expect(withServer.env).toEqual({ OPENCODE_PASSWORD: 'pw-123456789', WSLENV: 'X/p:OPENCODE_PASSWORD' });
    expect(planOpencode(info, 'C:\\ws', { ...o, env: WIN_ENV, server: { url: 'http://127.0.0.1:4000', password: 'pw-123456789' } }).env.WSLENV).toBe('OPENCODE_PASSWORD');
  });

  it('WSL server plan: the fixed script through wsl.exe in the folder\'s Linux path; none for a folder the distro cannot name', () => {
    const info = { available: true, via: 'wsl' as const, distro: 'Ubuntu', path: '/home/me/.opencode/bin/opencode' };
    const exe = 'C:\\Windows\\System32\\wsl.exe';
    expect(planOpencodeServeWsl(info, '\\\\wsl$\\ubuntu\\home\\me\\my proj', exe)).toEqual({ file: exe, args: ['-d', 'Ubuntu', '--cd', '/home/me/my proj', '-e', 'bash', '-lic', OPENCODE_WSL_SERVE, '/home/me/my proj', info.path], linuxRoot: '/home/me/my proj' });
    expect(planOpencodeServeWsl(info, 'C:\\ws', exe)?.linuxRoot).toBe('/mnt/c/ws');
    expect(planOpencodeServeWsl(info, '\\\\wsl.localhost\\Debian\\home\\me', exe)).toBeNull(); // another distro's folder
    expect(planOpencodeServeWsl(info, '\\\\nas\\share\\proj', exe)).toBeNull();
    expect(planOpencodeServeWsl({ available: true, via: 'native', path: 'C:\\x\\opencode.exe' }, 'C:\\ws', exe)).toBeNull();
    // Fixed text: loopback only, a port of the OS's choice, ends with its stdin, no password of the user's.
    expect(OPENCODE_WSL_SERVE).toContain('"$1" serve --hostname 127.0.0.1 --port 0');
    expect(OPENCODE_WSL_SERVE).toContain('unset OPENCODE_PASSWORD OPENCODE_SERVER_PASSWORD');
    expect(OPENCODE_WSL_SERVE).toMatch(/trap "kill -- \\\$g 2>\/dev\/null" EXIT.*cat >\/dev\/null$/);
    // No single quotes: wsl.exe re-quotes each argument for the distro with `'` — a `'` here would leave bash
    // waiting for the rest of that quote, and the server would never start.
    expect(OPENCODE_WSL_SERVE).not.toContain("'");
    expect(OPENCODE_WSL_CWD.exec('hello\r\none-cwd /home/me/my proj\r\nserver listening')?.[1]).toBe('/home/me/my proj');
    expect(OPENCODE_WSL_CWD.exec('one-cwd relative/x\n')).toBeNull();
  });

  it('WSL follow: every failure says which part failed, never "WSL is not supported"', () => {
    const n = (w: 'folder' | 'spawn' | 'answer' | 'reach' | undefined) => wslFollowNotice(w);
    // Each names WSL, what failed, and the consequence — a wrong one sends the user to the wrong fix.
    expect(n('folder')).toMatch(/inside WSL.*no path inside that distro.*not followed/s);
    expect(n('answer')).toMatch(/inside WSL.*did not report itself.*not followed/s);
    expect(n('reach')).toMatch(/inside WSL.*answers there.*cannot reach it from Windows.*not followed/s);
    expect(n('spawn')).toBe(n('answer'));
    expect(n(undefined)).toBe(n('answer'));
    // Three distinct sentences; none claims WSL is unsupported.
    expect(new Set([n('folder'), n('answer'), n('reach')]).size).toBe(3);
    for (const x of [n('folder'), n('answer'), n('reach')]) expect(x).not.toMatch(/not supported|not available/);
  });

  it('Windows npm shim (opencode.cmd) goes through cmd.exe', () => {
    const plan = planOpencode({ available: true, path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd' }, 'C:\\ws', { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe', Path: 'C:\\Windows' }, server: { url: 'http://127.0.0.1:4000', password: 'pw-123456789' } });
    expect(plan.file).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(String(plan.args)).toContain('opencode.cmd');
    expect(String(plan.args)).not.toContain('pw-123456789');
  });
});
