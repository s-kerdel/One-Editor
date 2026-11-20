// Windows system programs by absolute path. Node (libuv) resolves a bare "powershell.exe" in the
// process's current directory BEFORE %PATH% — and that directory is the opened folder when the app is
// started from Explorer's "Open with sec-edit" or as `sec-edit .` in a terminal. A program planted in an
// untrusted folder must never be what we run.
import path from 'node:path';

const WHERE = {
  'wsl.exe': ['System32'],
  'cmd.exe': ['System32'],
  'net.exe': ['System32'],
  'taskkill.exe': ['System32'],
  'powershell.exe': ['System32', 'WindowsPowerShell', 'v1.0'],
  'explorer.exe': [],
} as const;

export type WinSystemExe = keyof typeof WHERE;

/** %SystemRoot% as an absolute path (a relative or missing value falls back to C:\Windows). */
export function winSystemRoot(env: NodeJS.ProcessEnv = process.env): string {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'systemroot');
  const root = key ? env[key] : undefined;
  return root && path.win32.isAbsolute(root) && /^[a-z]:[\\/]/i.test(root) ? path.win32.normalize(root) : 'C:\\Windows';
}

/** Absolute path of a Windows system program (`winSystemExe('wsl.exe')` → C:\Windows\System32\wsl.exe). */
export function winSystemExe(name: WinSystemExe, env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(winSystemRoot(env), ...WHERE[name], name);
}
