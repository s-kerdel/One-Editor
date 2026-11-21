// Matches the user's "excluded folders" setting against path segments.
// Supported forms (case-insensitive):
//   plain names            "node_modules"           any entry with that name, at any depth
//   name globs             "*.log", ".~*", "a?c"     * = any run of characters, ? = one character
//   rooted paths           "docs/build"             that folder (or file) under the workspace root
//   rooted globs           "private/*.md", "**/secrets", "docs/**/drafts"   ** = any number of folders
// A matched folder hides everything under it. No pattern is compiled to a regex: matching is a plain
// wildcard scan (a crafted pattern or name can never make it backtrack exponentially).
export interface ExcludeMatcher {
  /** True if a single entry name should be hidden (checked while walking). */
  name(name: string): boolean;
  /** True if any segment of the relative path is excluded. */
  path(rel: string): boolean;
  /** Has path-style patterns ("docs/build") that need the full relative path to evaluate. */
  readonly rooted: boolean;
  /** Plain excluded folder names (for watchers that can filter natively). */
  names(): string[];
}

/** Our own temp files (atomic saves, case-only renames) must never surface anywhere. */
export const OWN_TEMP = /^\.~.*\.sec-edit\.(?:tmp|bak)$|\.sec-edit-rename-\d+$/;

/** `*` / `?` wildcard match of one name (both already lower case). O(|p|·|s|) at worst, no recursion. */
export function wildcard(p: string, s: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (i < s.length) {
    if (j < p.length && (p[j] === '?' || p[j] === s[i])) {
      i++;
      j++;
    } else if (j < p.length && p[j] === '*') {
      star = j++;
      mark = i;
    } else if (star !== -1) {
      j = star + 1;
      i = ++mark;
    } else return false;
  }
  while (j < p.length && p[j] === '*') j++;
  return j === p.length;
}

const hasWild = (s: string) => /[*?]/.test(s);

/** Does the rooted pattern (segments, `**` = any number of folders) match the path or a folder above it? */
function rootedMatch(pat: readonly string[], segs: readonly string[]): boolean {
  if (!pat.includes('**')) {
    // The common case ("docs/build", "private/*.md"): segment by segment, no search.
    if (segs.length < pat.length) return false;
    for (let i = 0; i < pat.length; i++) if (!(hasWild(pat[i]) ? wildcard(pat[i], segs[i]) : pat[i] === segs[i])) return false;
    return true;
  }
  const memo = new Map<number, boolean>();
  const go = (pi: number, si: number): boolean => {
    if (pi === pat.length) return true; // the pattern ends here: this folder (and all below) is excluded
    const key = pi * 4096 + si;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r = false;
    if (pat[pi] === '**') {
      for (let k = si; k <= segs.length && !r; k++) r = go(pi + 1, k);
    } else r = si < segs.length && (hasWild(pat[pi]) ? wildcard(pat[pi], segs[si]) : pat[pi] === segs[si]) && go(pi + 1, si + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

export function createExcludeMatcher(patterns: string[], showHidden: boolean): ExcludeMatcher {
  const names = new Set<string>();
  const globs: string[] = [];
  const rooted: string[][] = [];
  for (const raw of patterns) {
    const p = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!p) continue;
    if (p.includes('/')) {
      // "a//b" and "**/**" collapse; a pattern of only "**" would hide everything: ignored.
      const segs = p.toLowerCase().split('/').filter(Boolean).filter((s, i, a) => !(s === '**' && a[i - 1] === '**'));
      if (segs.some((s) => s !== '**')) rooted.push(segs);
    } else if (hasWild(p)) globs.push(p.toLowerCase());
    else names.add(p.toLowerCase());
  }
  const name = (n: string) => {
    if (OWN_TEMP.test(n)) return true;
    if (!showHidden && n.startsWith('.')) return true;
    const l = n.toLowerCase();
    if (names.has(l)) return true;
    return globs.some((g) => wildcard(g, l));
  };
  return {
    name,
    names: () => [...names],
    rooted: rooted.length > 0,
    path(rel) {
      if (!rel) return false;
      if (rooted.length) {
        const segs = rel.toLowerCase().split('/');
        if (rooted.some((r) => rootedMatch(r, segs))) return true;
      }
      return rel.split('/').some(name);
    },
  };
}
