// Windows system programs are started by absolute path: a bare "powershell.exe" is looked up in the
// current directory first (libuv), and that is the opened — possibly untrusted — folder.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { winSystemExe, winSystemRoot } from '../../../src/backend/winsys';
import { defaultWslExe } from '../../../src/backend/git-wsl';

describe('winSystemExe', () => {
  it('resolves under %SystemRoot%, whatever the case of the variable name', () => {
    expect(winSystemExe('wsl.exe', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\wsl.exe');
    expect(winSystemExe('powershell.exe', { SYSTEMROOT: 'D:\\WinNT' })).toBe('D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(winSystemExe('explorer.exe', { systemroot: 'C:\\Windows\\' })).toBe('C:\\Windows\\explorer.exe');
    expect(winSystemExe('net.exe', { SystemRoot: 'C:/Windows' })).toBe('C:\\Windows\\System32\\net.exe');
    expect(winSystemExe('taskkill.exe', { SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(defaultWslExe({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\wsl.exe');
  });

  it('never returns a relative path: a missing, relative or rootless %SystemRoot% falls back to C:\\Windows', () => {
    for (const env of [{}, { SystemRoot: '' }, { SystemRoot: 'Windows' }, { SystemRoot: '.' }, { SystemRoot: '..\\x' }, { SystemRoot: '\\Windows' }, { SystemRoot: '\\\\evil\\share' }]) {
      expect(winSystemRoot(env), JSON.stringify(env)).toBe('C:\\Windows');
      for (const exe of ['wsl.exe', 'powershell.exe', 'explorer.exe', 'net.exe', 'taskkill.exe'] as const) expect(path.win32.isAbsolute(winSystemExe(exe, env))).toBe(true);
    }
  });

  // src/server is not covered yet: cli.ts starts `cmd.exe` by bare name for --open (reported to the lead).
  it('no backend / Electron-main source starts a Windows program by bare name', () => {
    const root = path.resolve(__dirname, '../../../src');
    const files = ['backend', 'main'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(root, d, f)));
    const bad: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          // spawn('x.exe' … / execFile("x.exe" … / run('x.exe' … / [cmd, args] = ['x.exe', …
          if (/(?:spawn\w*|execFile\w*|exec|run)\(\s*['"`][\w.-]+\.exe['"`]|\?\s*\[\s*['"`][\w.-]+\.exe['"`]/i.test(line)) bad.push(`${path.relative(root, f)}:${i + 1}`);
        });
    }
    expect(bad).toEqual([]);
  });
});
