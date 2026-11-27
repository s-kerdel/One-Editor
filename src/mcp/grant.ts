// Which folders may be shared with MCP clients at all. Main checks a folder when the user adds it; the
// server checks every mcp.json entry again before serving it (mcp.json is a plain file: it is not trusted).
// Pure (path flavour injectable), so the Windows rules are unit-tested on Linux.
import path from 'node:path';
import { isInsideDir } from '../backend/pathsafe';
import { defaultCacheDir } from '../backend/appdata';

/**
 * One's own program folders: the executable's folder (Windows / Linux: resources/ with the MCP server's
 * cli.mjs is inside it), Electron's resources folder when this process knows it, and on macOS the bundle's
 * Contents (MacOS/ and Resources/ side by side). A share there could rewrite the program that serves it.
 */
export function oneInstallDirs(execPath: string = process.execPath, resourcesPath: unknown = (process as { resourcesPath?: unknown }).resourcesPath, p: typeof path = path): string[] {
  const exeDir = p.dirname(execPath);
  const out = [exeDir];
  if (typeof resourcesPath === 'string' && resourcesPath) out.push(resourcesPath);
  if (/[\\/]Contents[\\/]MacOS$/.test(exeDir)) out.push(p.dirname(exeDir));
  return out;
}

/**
 * Why `real` (a resolved folder) cannot be shared, or null. `cacheDir` (default: the one next to `configDir`,
 * %LOCALAPPDATA% on Windows) and `installDirs` (default: oneInstallDirs()) are refused like the data folder:
 * neither inside nor around them.
 */
export function folderProblem(
  real: string,
  o: { configDir: string; homedir: string; foldCase: boolean; p?: typeof path; cacheDir?: string; installDirs?: readonly string[] },
): string | null {
  const p = o.p ?? path;
  const norm = (x: string) => p.resolve(x);
  const r = norm(real);
  if (p.parse(r).root === r) return 'A whole drive cannot be shared: pick a folder on it.';
  const same = (a: string, b: string) => (o.foldCase ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));
  if (same(r, o.homedir)) return 'Your whole home folder cannot be shared: pick a folder inside it.';
  const near = (dir: string) => isInsideDir(r, dir, p, o.foldCase) || isInsideDir(dir, r, p, o.foldCase);
  if (near(o.configDir) || near(o.cacheDir ?? defaultCacheDir(o.configDir))) return 'This folder holds One’s own data (settings, secrets): pick another one.';
  if ((o.installDirs ?? oneInstallDirs()).some(near)) return 'This folder holds One itself (its program files): pick another one.';
  return null;
}
