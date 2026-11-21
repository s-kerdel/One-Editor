// PHP name resolution for Go to definition: the file's namespace and `use` imports (aliases, group use,
// `use function` / `use const`), and PSR-4 maps (composer.json `autoload` + `autoload-dev`,
// vendor/composer/autoload_psr4.php) that turn a fully qualified class name into candidate files —
// so a jump can land in vendor/, which the index never holds. Files are parsed as TEXT with bounded,
// linear regexes: nothing is executed or evaluated. Every directory goes through safeJoin().
import { braceDepths } from '../symbols';
import { dirOf, safeJoin } from './paths';

/** A PHP name: segments of identifier characters (ASCII word + the 0x80+ range PHP allows). */
const NAME_SEG = /^[A-Za-z_\u0080-\uffff][\w\u0080-\uffff]*$/;
export const isPhpName = (fqn: string) => fqn.split('\\').every((s) => NAME_SEG.test(s));

export interface PhpUse {
  kind: 'class' | 'function' | 'const';
  alias: string;
  fqn: string;
  /** First / last line of the `use` statement. */
  line: number;
  endLine: number;
}

export interface PhpContext {
  /** Namespace in effect at the line asked for ('' = global). */
  ns: string;
  uses: PhpUse[];
}

const stripLead = (s: string) => s.replace(/^\\+/, '');

/** Lines where each offset starts (for line numbers of matches). */
function lineAt(starts: number[], off: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= off) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** One `use …` body (without `use` and `;`) → imports. Returns [] for closures / malformed text. */
export function parseUseBody(body: string, line = 0, endLine = line): PhpUse[] {
  let text = body.trim();
  let kind: PhpUse['kind'] = 'class';
  const k = /^(function|const)\s+/i.exec(text);
  if (k) {
    kind = k[1].toLowerCase() as PhpUse['kind'];
    text = text.slice(k[0].length);
  }
  const out: PhpUse[] = [];
  const item = (raw: string, prefix: string, outer: PhpUse['kind']) => {
    let s = raw.trim();
    if (!s) return;
    let kd = outer;
    const ik = /^(function|const)\s+/i.exec(s);
    if (ik) {
      kd = ik[1].toLowerCase() as PhpUse['kind'];
      s = s.slice(ik[0].length);
    }
    const m = /^(\\?[^\s,{}]+)(?:\s+as\s+([^\s,{}]+))?$/i.exec(s);
    if (!m) return;
    const fqn = stripLead(prefix + m[1]);
    if (!fqn || !isPhpName(fqn)) return;
    const alias = m[2] ?? fqn.slice(fqn.lastIndexOf('\\') + 1);
    if (!NAME_SEG.test(alias)) return;
    out.push({ kind: kd, alias, fqn, line, endLine });
  };
  const group = /^(\\?[^\s{}]*\\)\s*\{([^{}]*)\}$/.exec(text);
  if (group) {
    for (const part of group[2].split(',')) item(part, group[1], kind);
    return out;
  }
  if (/[{}()$]/.test(text)) return []; // a closure's `use ($x)` or garbage
  for (const part of text.split(',')) item(part, '', kind);
  return out;
}

/** Parsed head of a file (imports never sit megabytes down). */
export const PARSE_MAX = 2_000_000;
const MAX_USES = 5000;
const MAX_USE_BODY = 4000;
// `use` at a line start; the statement runs to the next `;` (found with a forward-only pointer).
const USE_START_RE = /^[ \t]*use\s/gm;
const NS_RE = /^[ \t]*namespace[ \t]+([A-Za-z_\u0080-\uffff][\w\\\u0080-\uffff]*)[ \t]*[;{]/gm;

/** What phpContext needs from a file, independent of the line: parse once per text (Session caches it). */
export interface PhpParse {
  nsLines: Array<{ line: number; ns: string }>;
  uses: PhpUse[];
}

/** Namespaces and top-level `use` imports. Linear: no statement start re-scans a window (20,000 unfinished `use` lines = one pass). */
export function phpParse(content: string): PhpParse {
  const text = content.length > PARSE_MAX ? content.slice(0, PARSE_MAX) : content;
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const nsLines: PhpParse['nsLines'] = [];
  NS_RE.lastIndex = 0;
  for (let m = NS_RE.exec(text); m; m = NS_RE.exec(text)) nsLines.push({ line: lineAt(starts, m.index + m[0].length - 1), ns: stripLead(m[1]) });
  const depths = braceDepths(text, true);
  const bracketed = /^[ \t]*namespace\b[^;{\n]*\{/m.test(text);
  const uses: PhpUse[] = [];
  let semi = -1;
  let resume = -1;
  USE_START_RE.lastIndex = 0;
  for (let m = USE_START_RE.exec(text); m && uses.length < MAX_USES; m = USE_START_RE.exec(text)) {
    const at = m.index + m[0].length;
    if (at <= resume) continue;
    const first = lineAt(starts, m.index);
    if ((depths[first] ?? 0) > (bracketed ? 1 : 0)) continue; // a trait `use` inside a class body
    if (semi < at) {
      semi = text.indexOf(';', at);
      if (semi < 0) break; // no statement can end any more
    }
    if (semi - at > MAX_USE_BODY) continue;
    uses.push(...parseUseBody(text.slice(at, semi), first, lineAt(starts, semi)));
    resume = semi;
  }
  return { nsLines, uses };
}

/** The namespace holding `line` and the imports in effect there. */
export function phpContextAt(parse: PhpParse, line = Number.MAX_SAFE_INTEGER): PhpContext {
  let ns = '';
  let nsLine = -1;
  for (const n of parse.nsLines) {
    if (n.line <= line && n.line >= nsLine) {
      ns = n.ns;
      nsLine = n.line;
    }
  }
  const nextNs = parse.nsLines.find((n) => n.line > nsLine)?.line ?? Infinity;
  return { ns, uses: parse.uses.filter((u) => u.line >= nsLine && u.line <= nextNs) };
}

/** Namespace (at `line`) and the file's top-level imports. `use` inside class bodies (traits) is skipped. */
export function phpContext(content: string, line = Number.MAX_SAFE_INTEGER): PhpContext {
  return phpContextAt(phpParse(content), line);
}

/** Fully qualified class name for a name as written in a file (`Foo`, `Sub\Foo`, `\Foo`, `namespace\Foo`). */
export function resolveClassName(name: string, ctx: PhpContext): string {
  if (name.startsWith('\\')) return stripLead(name);
  if (/^namespace\\/i.test(name)) return stripLead(`${ctx.ns}\\${name.slice(10)}`);
  const cut = name.indexOf('\\');
  const first = (cut < 0 ? name : name.slice(0, cut)).toLowerCase();
  const imp = ctx.uses.find((u) => u.kind === 'class' && u.alias.toLowerCase() === first);
  if (imp) return cut < 0 ? imp.fqn : `${imp.fqn}${name.slice(cut)}`;
  return ctx.ns ? `${ctx.ns}\\${name}` : name;
}

/** Candidates for a function call (`use function` alias, then the namespace, then the global function). */
export function resolveFunctionNames(name: string, ctx: PhpContext): string[] {
  if (name.startsWith('\\')) return [stripLead(name)];
  const imp = ctx.uses.find((u) => u.kind === 'function' && u.alias.toLowerCase() === name.toLowerCase());
  if (imp) return [imp.fqn];
  if (name.includes('\\')) return [resolveClassName(name, ctx)];
  return ctx.ns ? [`${ctx.ns}\\${name}`, name] : [name];
}

/** Splits `A\B\C` into namespace `A\B` and short name `C`. */
export function splitFqn(fqn: string): { ns: string; short: string } {
  const i = fqn.lastIndexOf('\\');
  return i < 0 ? { ns: '', short: fqn } : { ns: fqn.slice(0, i), short: fqn.slice(i + 1) };
}

// --------------------------------------------------------------------------- PSR-4

/** Namespace prefix (with trailing `\`, '' = fallback) → workspace-relative folders. */
export type Psr4Map = Array<{ prefix: string; dirs: string[] }>;

const MAX_PREFIXES = 5000;
const MAX_DIRS = 16;
/** composer.json / autoload_psr4.php bigger than this are not parsed. */
const MAX_MAP_TEXT = 2 << 20;

/** Map + Set: adding stays O(1) however many entries a (crafted) map holds. */
type Builder = Map<string, Set<string>>;

function addEntry(map: Builder, prefix: string, dir: string | null) {
  if (dir === null) return;
  const p = prefix ? stripLead(prefix).replace(/\\*$/, '\\') : '';
  if (p && !isPhpName(p.slice(0, -1))) return;
  let dirs = map.get(p);
  if (!dirs) {
    if (map.size >= MAX_PREFIXES) return;
    map.set(p, (dirs = new Set()));
  }
  if (dirs.size < MAX_DIRS) dirs.add(dir);
}

const listOf = (map: Builder): Psr4Map => [...map].map(([prefix, dirs]) => ({ prefix, dirs: [...dirs] }));

/** `""` is the composer root itself; anything leaving the folder is dropped. */
function dirIn(base: string, rel: unknown): string | null {
  if (typeof rel !== 'string') return null;
  const r = rel.trim().replace(/\/+$/, '');
  if (!r || r === '.') return base;
  return safeJoin(base, r);
}

/** PSR-4 roots from a composer.json at `composerPath` (`autoload` + `autoload-dev`), plus its vendor folder. */
export function psr4FromComposer(json: string, composerPath: string): { map: Psr4Map; vendorDir: string | null } {
  const base = dirOf(composerPath);
  const map: Builder = new Map();
  let data: unknown;
  try {
    data = json.length > MAX_MAP_TEXT ? null : JSON.parse(json);
  } catch {
    data = null;
  }
  if (!data || typeof data !== 'object') return { map: [], vendorDir: safeJoin(base, 'vendor') };
  const d = data as Record<string, any>;
  for (const key of ['autoload', 'autoload-dev']) {
    const psr4 = d[key]?.['psr-4'];
    if (!psr4 || typeof psr4 !== 'object' || Array.isArray(psr4)) continue;
    for (const [prefix, dirs] of Object.entries(psr4)) {
      if (typeof prefix !== 'string') continue;
      for (const dir of Array.isArray(dirs) ? dirs : [dirs]) addEntry(map, prefix, dirIn(base, dir));
    }
  }
  const vd = d.config?.['vendor-dir'];
  return { map: listOf(map), vendorDir: typeof vd === 'string' ? dirIn(base, vd) : safeJoin(base, 'vendor') };
}

const unquote = (s: string) => s.replace(/\\(['\\])/g, '$1');
// One entry per line, as Composer writes them: anchored at line starts (no attempt at every quote).
const ENTRY_RE = /^[ \t]*'((?:[^'\\\n]|\\.){0,512})'[ \t]*=>[ \t]*array[ \t]*\(([^)\n]{0,16384})\)/gm;
const DIR_RE = /\$(vendorDir|baseDir)\s*\.\s*'((?:[^'\\\n]|\\.){0,1024})'/g;

/**
 * vendor/composer/autoload_psr4.php as text: `'Ns\\' => array($vendorDir . '/pkg/src', $baseDir . '/app')`.
 * `$vendorDir` = the folder holding composer/, `$baseDir` = its parent (composer's own definitions).
 */
export function psr4FromAutoload(text: string, autoloadPath: string): Psr4Map {
  const vendorDir = dirOf(dirOf(autoloadPath));
  const baseDir = dirOf(vendorDir);
  const map: Builder = new Map();
  if (text.length > MAX_MAP_TEXT) return [];
  ENTRY_RE.lastIndex = 0;
  for (let m = ENTRY_RE.exec(text); m; m = ENTRY_RE.exec(text)) {
    const prefix = unquote(m[1]);
    DIR_RE.lastIndex = 0;
    for (let d = DIR_RE.exec(m[2]); d; d = DIR_RE.exec(m[2])) {
      const rel = unquote(d[2]).replace(/^\/+/, '');
      addEntry(map, prefix, dirIn(d[1] === 'vendorDir' ? vendorDir : baseDir, rel));
    }
  }
  return listOf(map);
}

/** PSR-4 maps merged for lookups: prefix → folders (exact, and lower-cased for PHP's case-insensitive names). */
export interface Psr4Index {
  exact: Map<string, string[]>;
  lower: Map<string, string[]>;
  fallback: string[];
}

export function psr4Index(maps: Psr4Map[]): Psr4Index {
  const ix: Psr4Index = { exact: new Map(), lower: new Map(), fallback: [] };
  const add = (m: Map<string, string[]>, k: string, dirs: string[]) => {
    const list = m.get(k) ?? [];
    for (const d of dirs) if (!list.includes(d) && list.length < MAX_DIRS * 4) list.push(d);
    m.set(k, list);
  };
  for (const map of maps) {
    for (const e of map) {
      if (!e.prefix) add(ix.exact, '', e.dirs);
      else {
        add(ix.exact, e.prefix, e.dirs);
        add(ix.lower, e.prefix.toLowerCase(), e.dirs);
      }
    }
  }
  ix.fallback = ix.exact.get('') ?? [];
  return ix;
}

/** Candidate files for a class, longest matching prefix first (PSR-4: prefix → folder, rest → path). */
export function psr4Candidates(fqn: string, maps: Psr4Map[] | Psr4Index, limit = 12): string[] {
  const name = stripLead(fqn);
  if (!name || !isPhpName(name)) return [];
  const ix = Array.isArray(maps) ? psr4Index(maps) : maps;
  const segs = name.split('\\');
  const out: string[] = [];
  const push = (dirs: readonly string[], rest: string) => {
    for (const dir of dirs) {
      const p = safeJoin(dir, `${rest}.php`);
      if (p && !out.includes(p)) out.push(p);
      if (out.length >= limit) return true;
    }
    return false;
  };
  // One lookup per namespace prefix of the name (a map lookup each, whatever the map size).
  for (let k = segs.length - 1; k >= 1; k--) {
    const prefix = `${segs.slice(0, k).join('\\')}\\`;
    const rest = segs.slice(k).join('/');
    if (push(ix.exact.get(prefix) ?? [], rest) || push(ix.lower.get(prefix.toLowerCase()) ?? [], rest)) return out;
  }
  push(ix.fallback, segs.join('/'));
  return out;
}
