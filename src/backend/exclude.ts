// Matches the user's "excluded folders" setting against path segments.
// Supported forms: plain names ("node_modules"), simple globs ("*.log", ".~*"), and rooted paths ("docs/build").
export interface ExcludeMatcher {
  /** True if a single entry name should be hidden (checked while walking). */
  name(name: string): boolean;
  /** True if any segment of the relative path is excluded. */
  path(rel: string): boolean;
  /** Has path-style patterns ("docs/build") that need the full relative path to evaluate. */
  readonly rooted: boolean;
}

/** Our own temp files (atomic saves, case-only renames) must never surface anywhere. */
export const OWN_TEMP = /^\.~.*\.sec-edit\.tmp$|\.sec-edit-rename-\d+$/;

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`, 'i');
}

export function createExcludeMatcher(patterns: string[], showHidden: boolean): ExcludeMatcher {
  const names = new Set<string>();
  const globs: RegExp[] = [];
  const rooted: string[] = [];
  for (const raw of patterns) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p) continue;
    if (p.includes('/')) rooted.push(p.toLowerCase());
    else if (/[*?]/.test(p)) globs.push(globToRegExp(p));
    else names.add(p.toLowerCase());
  }
  const name = (n: string) => {
    if (OWN_TEMP.test(n)) return true;
    if (!showHidden && n.startsWith('.')) return true;
    if (names.has(n.toLowerCase())) return true;
    return globs.some((g) => g.test(n));
  };
  return {
    name,
    rooted: rooted.length > 0,
    path(rel) {
      if (!rel) return false;
      const lower = rel.toLowerCase();
      if (rooted.some((r) => lower === r || lower.startsWith(r + '/'))) return true;
      return rel.split('/').some(name);
    },
  };
}
