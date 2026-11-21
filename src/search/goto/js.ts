// JS / TS (and relative Python) imports for Go to definition: which local name comes from which module,
// and the files a relative specifier can mean. Text scans with bounded, linear regexes; bare package
// names (`react`, `@scope/x`, path aliases) are not resolved. Every candidate goes through safeJoin().
import { dirOf, safeJoin } from './paths';

export interface JsImport {
  local: string;
  /** Exported name, 'default', or '*' (namespace / CommonJS module object). */
  imported: string;
  spec: string;
  line: number;
}

export interface JsReexport {
  /** null = `export * from` (every name). */
  names: Array<{ local: string; exported: string }> | null;
  spec: string;
}

/** offset → 0-based line, by binary search over line starts (built once per text). */
function lineIndex(text: string): (off: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/** `a, b as c, type d` → [[imported, local]]. */
function namedList(list: string, sep: RegExp): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of list.split(',')) {
    const s = raw.trim().replace(/^type\s+/, '');
    if (!s) continue;
    const m = sep.exec(s);
    if (m) out.push([m[1], m[2] ?? m[1]]);
  }
  return out;
}
const AS_RE = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/;
const COLON_RE = /^([\w$]+)(?:\s*:\s*([\w$]+))?$/;

// A statement start is `^`, `;`, `}` or a newline followed by blanks only ([ \t]*: never `\s*` after `\n`,
// which made every blank line of a run re-scan the rest of it).
// The clause starts and ends with a non-blank, so neither `\s+` before nor `\s*` after it can trade blanks with it.
const IMPORT_RE = /(?:^|[;}\n])[ \t]*import\s+(?:type\s+)?([^'"`;\s](?:[^'"`;]{0,2000}?[^'"`;\s])?)\s*\bfrom\s*(['"])([^'"\n]{1,500})\2/g;
const REQUIRE_RE = /\b(?:const|let|var)\s+([\w$]+|\{[^}]{0,1000}\})\s*=\s*(?:await\s+)?(?:require|import)\s*\(\s*(['"])([^'"\n]{1,500})\2\s*\)/g;
const REEXPORT_RE = /(?:^|[;}\n])[ \t]*export\s+(?:type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]{0,2000}\})\s*from\s*(['"])([^'"\n]{1,500})\2/g;

/** Every import of a module file: static, `require()`, `await import()` bound to a name. */
export function jsImports(content: string): JsImport[] {
  const out: JsImport[] = [];
  const lineOf = lineIndex(content);
  IMPORT_RE.lastIndex = 0;
  for (let m = IMPORT_RE.exec(content); m; m = IMPORT_RE.exec(content)) {
    const line = lineOf(m.index + m[0].indexOf('import'));
    const spec = m[3];
    let clause = m[1].trim();
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) out.push({ local: ns[1], imported: '*', spec, line });
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) for (const [imported, local] of namedList(named[1], AS_RE)) out.push({ local, imported, spec, line });
    clause = clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '');
    const def = /^([\w$]+)/.exec(clause.trim());
    if (def) out.push({ local: def[1], imported: 'default', spec, line });
  }
  REQUIRE_RE.lastIndex = 0;
  for (let m = REQUIRE_RE.exec(content); m; m = REQUIRE_RE.exec(content)) {
    const line = lineOf(m.index);
    if (m[1].startsWith('{')) for (const [imported, local] of namedList(m[1].slice(1, -1), COLON_RE)) out.push({ local, imported, spec: m[3], line });
    else out.push({ local: m[1], imported: '*', spec: m[3], line });
  }
  return out;
}

export function jsReexports(content: string): JsReexport[] {
  const out: JsReexport[] = [];
  REEXPORT_RE.lastIndex = 0;
  for (let m = REEXPORT_RE.exec(content); m; m = REEXPORT_RE.exec(content)) {
    if (m[1].startsWith('*')) {
      const as = /as\s+([\w$]+)/.exec(m[1]);
      out.push({ names: as ? [{ local: '*', exported: as[1] }] : null, spec: m[3] });
    } else out.push({ names: namedList(m[1].slice(1, -1), AS_RE).map(([local, exported]) => ({ local, exported })), spec: m[3] });
  }
  return out;
}

/** `export default Foo`, `export default class Foo`, `export { x as default }` → the local name (or null). */
export function jsDefaultExport(content: string): { name: string | null; line: number } | null {
  const lineOf = lineIndex(content);
  const m = /(?:^|\n)[ \t]*export[ \t]+default[ \t]+(?:abstract[ \t]+)?(?:(?:class|function\*?|async[ \t]+function\*?)[ \t]+([\w$]+)|([\w$]+)[ \t]*(?:;[ \t]*)?(?:\r?\n|$))?/.exec(content);
  if (m) return { name: m[1] ?? m[2] ?? null, line: lineOf(m.index + (m[0].startsWith('\n') ? 1 : 0)) };
  const r = /\bexport\s*\{([^}]{0,2000})\}/g;
  for (let x = r.exec(content); x; x = r.exec(content)) {
    for (const [local, exp] of namedList(x[1], AS_RE)) if (exp === 'default') return { name: local, line: lineOf(x.index) };
  }
  return null;
}

/** `export { local as exported }` (no `from`): the local name behind an exported one. */
export function jsLocalExport(content: string, exported: string): string | null {
  const re = /(?:^|[;}\n])[ \t]*export\s*\{([^}]{0,2000})\}(?![ \t]*from)/g;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    for (const [local, exp] of namedList(m[1], AS_RE)) if (exp === exported) return local;
  }
  return null;
}

const SCRIPT_EXTS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const KNOWN_EXT = /\.(?:[cm]?[jt]sx?|vue|json|css|scss|less|svelte|astro|d\.ts)$/i;

/** Files a relative specifier can mean, in resolution order ([] for bare names / anything unsafe). */
export function jsCandidates(fromPath: string, spec: string): string[] {
  if (!/^\.\.?(?:\/|$)/.test(spec)) return [];
  const clean = spec.replace(/[?#].*$/, '');
  const base = safeJoin(dirOf(fromPath), clean);
  if (!base) return [];
  const out: string[] = [];
  if (KNOWN_EXT.test(base)) {
    out.push(base);
    // TypeScript ESM: `./x.js` written for `./x.ts`.
    const m = /\.(m|c)?jsx?$/.exec(base);
    if (m) {
      const stem = base.slice(0, -m[0].length);
      for (const e of m[1] ? [`.${m[1]}ts`] : ['.ts', '.tsx']) out.push(stem + e);
    }
    return out;
  }
  for (const e of SCRIPT_EXTS) out.push(base + e);
  for (const e of SCRIPT_EXTS) out.push(`${base}/index${e}`);
  return out;
}

// --------------------------------------------------------------------------- Python (relative + top-level)

export interface PyImport {
  local: string;
  imported: string;
  /** Leading dots (0 = absolute) and the dotted module after them. */
  dots: number;
  module: string;
  line: number;
}

// The module must start with a word character: `(\.*)([\w.]*)` could split a run of dots any way (quadratic).
// Never empty between the two blank runs (`from    import` would let them trade blanks).
const PY_FROM_RE = /^[ \t]*from[ \t]+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)[ \t]+import[ \t]+(?:\(([^)]{0,2000})\)|([^\n#]{0,1000}))/gm;

export function pyImports(content: string): PyImport[] {
  const out: PyImport[] = [];
  const lineOf = lineIndex(content);
  PY_FROM_RE.lastIndex = 0;
  for (let m = PY_FROM_RE.exec(content); m; m = PY_FROM_RE.exec(content)) {
    const line = lineOf(m.index);
    const dots = /^\.*/.exec(m[1])![0].length;
    for (const [imported, local] of namedList((m[2] ?? m[3] ?? '').replace(/\\\n/g, ' '), AS_RE)) {
      if (imported !== '*') out.push({ local, imported, dots, module: m[1].slice(dots), line });
    }
  }
  return out;
}

/** Module files for `from <dots><module> import <name>` (the name may itself be a submodule). */
export function pyCandidates(fromPath: string, imp: Pick<PyImport, 'dots' | 'module'>, name?: string): string[] {
  let dir: string | null;
  if (imp.dots) {
    dir = dirOf(fromPath);
    for (let i = 1; i < imp.dots; i++) {
      if (!dir) return [];
      dir = dirOf(dir);
    }
  } else dir = '';
  const rel = imp.module ? imp.module.split('.').join('/') : '';
  const out: string[] = [];
  const add = (p: string | null) => p && !out.includes(p) && out.push(p);
  const bases = imp.dots ? [dir] : ['', 'src'];
  for (const b of bases) {
    if (rel) {
      add(safeJoin(b ?? '', `${rel}.py`));
      add(safeJoin(b ?? '', rel, '__init__.py'));
    } else if (b !== null) add(safeJoin(b, '__init__.py'));
    if (name) {
      add(safeJoin(b ?? '', rel, `${name}.py`));
      add(safeJoin(b ?? '', rel, name, '__init__.py'));
    }
  }
  return out;
}
