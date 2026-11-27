// .gitignore semantics in pure JS (no git binary, no per-file spawns), used only to decide what the
// search / knowledge indexers skip — the file tree still lists ignored files.
//
// Precedence like git: core.excludesFile < .git/info/exclude < .gitignore files from the root down;
// within that order the last matching rule wins, and a file below an ignored folder stays ignored
// (git cannot re-include it either).
export interface IgnoreRule {
  /** Does the pattern match this base-relative path? */
  test(sub: string): boolean;
  /** The pattern after the line rules (no "!", no trailing "/", no leading "/"): what the serialised set keeps. */
  glob: string;
  /** Has a "/" (at the start or in the middle): matched from the .gitignore's folder, else at any depth. */
  anchored: boolean;
  negate: boolean;
  dirOnly: boolean;
}

/** One pattern line → rule (null for blanks / comments). Loops, never a regex over the line (a 1 MB line of
 *  spaces or slashes made `\s+$` / `\/+$` quadratic). */
export function parseIgnoreLine(raw: string, foldCase: boolean): IgnoreRule | null {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  // Trailing spaces are ignored unless escaped with a backslash.
  line = trimTrailingSpaces(line);
  if (!line || line.startsWith('#')) return null;
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
  let dirOnly = false;
  if (line.endsWith('/') && !line.endsWith('\\/')) {
    dirOnly = true;
    let end = line.length;
    while (end > 0 && line[end - 1] === '/') end--;
    line = line.slice(0, end);
  }
  if (!line) return null;
  // A slash at the start or in the middle anchors the pattern to the .gitignore's folder.
  const anchored = line.includes('/');
  if (line.startsWith('/')) line = line.slice(1);
  return compileRule(line, anchored, negate, dirOnly, foldCase);
}

function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && /\s/.test(line[end - 1])) end--;
  if (end === line.length) return line;
  if (end > 0 && line[end - 1] === '\\') end++; // "a\ " keeps its escaped space
  return line.slice(0, end);
}

function compileRule(glob: string, anchored: boolean, negate: boolean, dirOnly: boolean, foldCase: boolean): IgnoreRule | null {
  const test = globMatcher(glob, anchored, foldCase);
  return test ? { test, glob, anchored, negate, dirOnly } : null; // malformed class etc.: git skips those too
}

// ---- glob matching: no RegExp ---------------------------------------------------------------------------
// The patterns come from the folder (a downloaded repo's .gitignore) and run in Electron main for every file
// event: a glob compiled to a regex (`[^/]*a[^/]*a…b`) backtracked exponentially on a long name and froze every
// window. This is a state-set scan (like search's globSearch): O(path length × live states), whatever the input.

// Token kinds (numbers, as in globSearch).
/** One character (folded when the folder folds case). */
const LIT = 0;
/** `?`: one character but "/". */
const ONE = 1;
/** `[…]`: one character of the class (never "/", as in git). */
const CLS = 2;
/** `*`: any run without "/". */
const STAR = 3;
/** Trailing `/**`: everything below. */
const ALL = 4;
/** `**\/` (and the start of an unanchored pattern): nothing, or folders. Entry state: skip or go in. */
const DIRS_IN = 5;
/** Inside `**\/`: any character; a "/" may also end it. */
const DIRS_BODY = 6;

interface Tok {
  k: number;
  /** Lit: the character (lower case when folding). */
  c?: string;
  /** Cls: single characters, [lo, hi] code ranges, negated. */
  chars?: string;
  ranges?: number[];
  neg?: boolean;
}

const lowerChar = (c: string) => {
  const l = c.toLowerCase();
  return l.length === 1 ? l : c;
};

/** The class between "[" and "]" (backslashes literal, "!" or "^" negates, "a-z" ranges), or null when invalid. */
function parseClass(body: string, fold: boolean): Tok | null {
  let cls = body;
  const neg = cls[0] === '!' || cls[0] === '^';
  if (neg) cls = cls.slice(1);
  let chars = '';
  const ranges: number[] = [];
  for (let j = 0; j < cls.length; j++) {
    if (cls[j + 1] === '-' && j + 2 < cls.length) {
      const lo = cls.charCodeAt(j);
      const hi = cls.charCodeAt(j + 2);
      if (lo > hi) return null; // as the regex form: an invalid range drops the rule
      ranges.push(lo, hi);
      j += 2;
    } else chars += cls[j];
  }
  return { k: CLS, chars: fold ? chars + chars.toLowerCase() + chars.toUpperCase() : chars, ranges, neg };
}

function inClass(t: Tok, ch: string, fold: boolean): boolean {
  const probe = (c: string) => {
    if (t.chars!.includes(c)) return true;
    const code = c.charCodeAt(0);
    for (let r = 0; r < t.ranges!.length; r += 2) if (code >= t.ranges![r] && code <= t.ranges![r + 1]) return true;
    return false;
  };
  const hit = probe(ch) || (fold && (probe(ch.toLowerCase()) || probe(ch.toUpperCase())));
  return hit !== !!t.neg;
}

function tokenize(glob: string, fold: boolean): Tok[] | null {
  const toks: Tok[] = [];
  const lit = (c: string) => toks.push({ k: LIT, c: fold ? lowerChar(c) : c });
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
            // "**/" — zero or more folders ("**/**/" is the same thing once)
            if (toks.at(-1)?.k !== DIRS_BODY) toks.push({ k: DIRS_IN }, { k: DIRS_BODY });
          } else toks.push({ k: ALL }); // trailing "/**" — everything inside
          continue;
        }
      }
      while (glob[i + 1] === '*') i++;
      toks.push({ k: STAR });
    } else if (c === '?') toks.push({ k: ONE });
    else if (c === '\\' && i + 1 < glob.length) lit(glob[++i]);
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) lit('[');
      else {
        const t = parseClass(glob.slice(i + 1, end), fold);
        if (!t) return null;
        toks.push(t);
        i = end;
      }
    } else lit(c);
  }
  return toks;
}

/** The matcher for one pattern (whole path, like `^…$`), or null when the pattern is invalid. */
export function globMatcher(glob: string, anchored: boolean, fold: boolean): ((s: string) => boolean) | null {
  const body = tokenize(glob, fold);
  if (!body) return null;
  // Unanchored: `^(?:.*/)?body$` — the pattern may start after any "/".
  const toks: Tok[] = anchored ? body : [{ k: DIRS_IN }, { k: DIRS_BODY }, ...body];
  const m = toks.length;
  const same = (t: Tok, ch: string) => t.c === ch || (fold && t.c === lowerChar(ch));
  // Cheap rejects first (most rules miss most paths): characters the pattern must consume, its literal tail.
  let need = 0;
  for (const t of toks) if (t.k === LIT || t.k === ONE || t.k === CLS) need++;
  let tail = 0;
  while (tail < m && toks[m - 1 - tail].k === LIT) tail++;
  const literalBody = body.every((t) => t.k === LIT);
  // Reused per call (one thread): states of this step and the next, and the step each state was last added in.
  let cur: number[] = [];
  let nxt: number[] = [];
  const mark = new Float64Array(m + 1).fill(-1);
  let gen = 0;
  const add = (list: number[], j: number) => {
    for (;;) {
      if (mark[j] === gen) return;
      mark[j] = gen;
      list.push(j);
      if (j === m) return;
      const k = toks[j].k;
      if (k === STAR || k === ALL) j++; // may match nothing
      else if (k === DIRS_IN) {
        add(list, j + 1); // into the folders…
        j += 2; // …or none
      } else return;
    }
  };
  return (s: string) => {
    if (s.length < need) return false;
    for (let x = 0; x < tail; x++) if (!same(toks[m - 1 - x], s[s.length - 1 - x])) return false;
    if (literalBody) {
      // "name" (any depth) / "a/b" (from the folder): equal, or a whole last part.
      if (anchored) return s.length === body.length;
      return s.length === body.length || s[s.length - body.length - 1] === '/';
    }
    gen++;
    cur.length = 0;
    add(cur, 0);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      gen++;
      nxt.length = 0;
      for (const j of cur) {
        if (j === m) continue;
        const t = toks[j];
        switch (t.k) {
          case LIT:
            if (same(t, ch)) add(nxt, j + 1);
            break;
          case ONE:
            if (ch !== '/') add(nxt, j + 1);
            break;
          case CLS:
            if (ch !== '/' && inClass(t, ch, fold)) add(nxt, j + 1);
            break;
          case STAR:
            if (ch !== '/') add(nxt, j);
            break;
          case ALL:
            add(nxt, j);
            break;
          case DIRS_BODY:
            add(nxt, j);
            if (ch === '/') add(nxt, j + 1);
            break;
        }
      }
      if (!nxt.length) return false;
      [cur, nxt] = [nxt, cur];
    }
    return mark[m] === gen;
  };
}

/** Serialised rule set (structured-clone friendly: sent from the indexer worker to the watcher). */
export interface IgnoreSet {
  base: string;
  prefix: string;
  rules: Array<{ glob: string; anchored: boolean; negate: boolean; dirOnly: boolean }>;
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
    return this.sets.map((s) => ({ base: s.base, prefix: s.prefix, rules: s.rules.map((r) => ({ glob: r.glob, anchored: r.anchored, negate: r.negate, dirOnly: r.dirOnly })) }));
  }

  /** The worker's rules, compiled again here (main): patterns, never a regex source, cross the boundary. */
  static fromJSON(sets: IgnoreSet[], foldCase = false): IgnoreStack {
    const st = new IgnoreStack(foldCase);
    st.sets = sets.map((s) => ({
      base: s.base,
      prefix: s.prefix,
      rules: s.rules.flatMap((r) => compileRule(String(r.glob), !!r.anchored, !!r.negate, !!r.dirOnly, foldCase) ?? []),
    }));
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
        if (r.test(sub)) result = !r.negate;
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
