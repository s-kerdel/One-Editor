// .gitignore semantics in pure JS (no git binary, no per-file spawns), used only to decide what the
// search / knowledge indexers skip — the file tree still lists ignored files.
//
// Precedence like git: core.excludesFile < .git/info/exclude < .gitignore files from the root down;
// within that order the last matching rule wins, and a file below an ignored folder stays ignored
// (git cannot re-include it either).
export interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** One pattern line → rule (null for blanks / comments). */
export function parseIgnoreLine(raw: string, foldCase: boolean): IgnoreRule | null {
  let line = raw.replace(/\r$/, '');
  // Trailing spaces are ignored unless escaped with a backslash.
  line = line.replace(/(?<!\\)\s+$/, '');
  if (!line || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
  let dirOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    dirOnly = true;
    line = line.replace(/\/+$/, '');
  }
  if (!line) return null;
  // A slash at the start or in the middle anchors the pattern to the .gitignore's folder.
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  const body = globToRegexSource(line);
  const src = anchored ? `^${body}$` : `^(?:.*/)?${body}$`;
  try {
    return { re: new RegExp(src, foldCase ? 'i' : ''), negate, dirOnly };
  } catch {
    return null; // malformed class etc.: git skips those too
  }
}

function globToRegexSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          i++; // consume second '*'
          if (glob[i + 1] === '/') {
            i++;
            out += '(?:.*/)?'; // "**/" — zero or more folders
          } else out += '.*'; // trailing "/**" — everything inside
          continue;
        }
      }
      while (glob[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '\\' && i + 1 < glob.length) out += escapeRe(glob[++i]);
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) out += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else out += escapeRe(c);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Serialised rule set (structured-clone friendly: sent from the indexer worker to the watcher). */
export interface IgnoreSet {
  base: string;
  prefix: string;
  rules: Array<{ source: string; flags: string; negate: boolean; dirOnly: boolean }>;
}

interface RuleSet {
  /** Folder (workspace-relative, '' = root) the patterns are relative to; may be outside the root ('../'). */
  base: string;
  /** Prefix that turns a workspace-relative path into a base-relative one (for sets above the root). */
  prefix: string;
  rules: IgnoreRule[];
}

export class IgnoreStack {
  private sets: RuleSet[] = [];
  private dirCache = new Map<string, boolean>();
  constructor(private readonly foldCase = false) {}

  get size() {
    return this.sets.reduce((n, s) => n + s.rules.length, 0);
  }

  toJSON(): IgnoreSet[] {
    return this.sets.map((s) => ({ base: s.base, prefix: s.prefix, rules: s.rules.map((r) => ({ source: r.re.source, flags: r.re.flags, negate: r.negate, dirOnly: r.dirOnly })) }));
  }

  static fromJSON(sets: IgnoreSet[], foldCase = false): IgnoreStack {
    const st = new IgnoreStack(foldCase);
    st.sets = sets.map((s) => ({ base: s.base, prefix: s.prefix, rules: s.rules.map((r) => ({ re: new RegExp(r.source, r.flags), negate: r.negate, dirOnly: r.dirOnly })) }));
    return st;
  }

  /**
   * Adds patterns relative to `base` (a workspace-relative folder). `prefix`: for files above the
   * workspace root, the root's path relative to that file's folder ("sub/dir/").
   * Order of calls = precedence (later wins): global, info/exclude, then .gitignore by depth.
   */
  add(base: string, text: string, prefix = ''): void {
    const rules: IgnoreRule[] = [];
    for (const line of text.split('\n')) {
      const r = parseIgnoreLine(line, this.foldCase);
      if (r) rules.push(r);
    }
    if (!rules.length) return;
    this.sets.push({ base, prefix, rules });
    this.dirCache.clear();
  }

  /** Last matching rule of all sets that apply to `rel` decides; null = no rule matched. */
  private decide(rel: string, isDir: boolean): boolean | null {
    let result: boolean | null = null;
    for (const s of this.sets) {
      let sub: string;
      if (s.base === '') sub = s.prefix + rel;
      else if (rel.startsWith(s.base + '/')) sub = rel.slice(s.base.length + 1);
      else continue;
      for (const r of s.rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.re.test(sub)) result = !r.negate;
      }
    }
    return result;
  }

  private dirIgnored(dir: string): boolean {
    const hit = this.dirCache.get(dir);
    if (hit !== undefined) return hit;
    const slash = dir.lastIndexOf('/');
    const parent = slash === -1 ? '' : dir.slice(0, slash);
    const v = (parent !== '' && this.dirIgnored(parent)) || this.decide(dir, true) === true;
    this.dirCache.set(dir, v);
    return v;
  }

  /** Is the workspace-relative `rel` ignored (itself, or through an ignored parent folder)? */
  ignored(rel: string, isDir = false): boolean {
    if (!this.sets.length) return false;
    if (isDir) return this.dirIgnored(rel);
    const slash = rel.lastIndexOf('/');
    if (slash !== -1 && this.dirIgnored(rel.slice(0, slash))) return true;
    return this.decide(rel, false) === true;
  }
}

/** Lockfiles: machine-written, huge, never what you search for. */
const LOCKFILES = new Set(
  'package-lock.json npm-shrinkwrap.json yarn.lock pnpm-lock.yaml bun.lock composer.lock cargo.lock gemfile.lock poetry.lock pipfile.lock pdm.lock uv.lock go.sum flake.lock packages.lock.json paket.lock mix.lock pubspec.lock podfile.lock gradle.lockfile deno.lock'.split(' '),
);
export const isLockfile = (name: string) => LOCKFILES.has(name.toLowerCase());
/** Minified bundles and source maps. */
export const isMinified = (name: string) => /\.min\.(?:js|mjs|cjs|css)$|\.map$/i.test(name);

/** Where git keeps the global ignore file: core.excludesFile, else $XDG_CONFIG_HOME/git/ignore. */
export function globalExcludesPath(readText: (abs: string) => string | null, env: NodeJS.ProcessEnv, home: string, join: (...p: string[]) => string): string {
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  for (const cfg of [join(home, '.gitconfig'), join(xdg, 'git', 'config')]) {
    const text = readText(cfg);
    if (!text) continue;
    let inCore = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      const sec = /^\[\s*([^\]\s]+)/.exec(line);
      if (sec) inCore = sec[1].toLowerCase() === 'core';
      else if (inCore) {
        const m = /^excludesfile\s*=\s*(.+)$/i.exec(line);
        if (m) {
          const v = m[1].replace(/^"(.*)"$/, '$1').trim();
          return v.startsWith('~/') ? join(home, v.slice(2)) : v;
        }
      }
    }
  }
  return join(xdg, 'git', 'ignore');
}
