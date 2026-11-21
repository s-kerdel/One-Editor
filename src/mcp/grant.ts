// Which folders may be shared with MCP clients at all. Main checks a folder when the user adds it; the
// server checks every mcp.json entry again before serving it (mcp.json is a plain file: it is not trusted).
// Pure (path flavour injectable), so the Windows rules are unit-tested on Linux.
import path from 'node:path';
import { isInsideDir } from '../backend/pathsafe';

/** Why `real` (a resolved folder) cannot be shared, or null. */
export function folderProblem(real: string, o: { configDir: string; homedir: string; foldCase: boolean; p?: typeof path }): string | null {
  const p = o.p ?? path;
  const norm = (x: string) => p.resolve(x);
  const r = norm(real);
  if (p.parse(r).root === r) return 'A whole drive cannot be shared: pick a folder on it.';
  const same = (a: string, b: string) => (o.foldCase ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b));
  if (same(r, o.homedir)) return 'Your whole home folder cannot be shared: pick a folder inside it.';
  if (isInsideDir(r, o.configDir, p, o.foldCase) || isInsideDir(o.configDir, r, p, o.foldCase)) return 'This folder holds One’s own data (settings, secrets): pick another one.';
  return null;
}
