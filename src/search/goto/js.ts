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

/** What is parsed of a file: the head that holds its imports, never a megabyte-long tail. */
export const PARSE_MAX = 2_000_000;
const head = (t: string) => (t.length > PARSE_MAX ? t.slice(0, PARSE_MAX) : t);

const isBlank = (c: number) => c <= 32 || c === 0xa0 || c === 0xfeff || c === 0x2028 || c === 0x2029;
const isIdent = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;

/** Everything Go to definition reads from a module's text, in one scan. */
export interface JsModule {
  imports: JsImport[];
  reexports: JsReexport[];
  /** `export { local as exported }` lists without `from`. */
  locals: Array<{ local: string; exported: string; line: number }>;
  /** The first `export default …`: the local name it exports (null = an expression). */
  defaultExport: { name: string | null; line: number } | null;
}

// Statement starts: `^`, `;`, `}` or a newline, then blanks of that line only.
const STMT_RE = /(?:^|[;}\n])[ \t]*(import|export)\b/g;
// The end of an import / export clause: it holds no quote and no `;`.
const STOP_RE = /[;'"`]/g;
// `require('x')`, `import('x')`: bound to a name or a destructuring by what precedes them.
const CALL_RE = /\b(?:require|import)[ \t]*\([ \t]*(['"])([^'"\n]{1,500})\1[ \t]*\)/g;
const DEFAULT_RE = /default[ \t]+(?:abstract[ \t]+)?(?:(?:class|function\*?|async[ \t]+function\*?)[ \t]+([\w$]+)|([\w$]+)[ \t]*(?:;[ \t]*)?(?:\r?\n|$))?/y;
const FROM_AFTER_RE = /\s*from\s*(?=['"])/y;

/**
 * One linear pass. Each statement start is looked at once; where its clause ends (the next quote or `;`,
 * the next `}`) comes from pointers that only move forward, and the `from` check is remembered per quote,
 * so a file of 20,000 unfinished `import a` lines costs one scan, not one window per line. A statement
 * that was understood moves the scan past its end (nothing valid starts inside an import clause).
 */
export function jsModule(content: string): JsModule {
  const text = head(content);
  const n = text.length;
  const lineOf = lineIndex(text);
  const out: JsModule = { imports: [], reexports: [], locals: [], defaultExport: null };
  let stop = -1;
  const stopAt = (p: number) => {
    if (stop < p) {
      STOP_RE.lastIndex = p;
      const m = STOP_RE.exec(text);
      stop = m ? m.index : n;
    }
    return stop;
  };
  let brace = -1;
  const braceAt = (p: number) => {
    if (brace < p) {
      const k = text.indexOf('}', p);
      brace = k < 0 ? n : k;
    }
    return brace;
  };
  // The `from` right before the quote at `q` (blanks between), remembered: statements sharing that quote ask once.
  let fromQ = -1;
  let fromAt = -1;
  const fromBefore = (q: number) => {
    if (fromQ !== q) {
      fromQ = q;
      let j = q - 1;
      while (j >= 0 && isBlank(text.charCodeAt(j))) j--;
      fromAt = j >= 3 && text.startsWith('from', j - 3) && !(j >= 4 && isIdent(text.charCodeAt(j - 4))) ? j - 3 : -1;
    }
    return fromAt;
  };
  const specAt = (q: number): { spec: string; end: number } | null => {
    const quote = text.charCodeAt(q);
    if (quote !== 39 && quote !== 34) return null;
    for (let j = q + 1; j < n && j - q <= 501; j++) {
      const c = text.charCodeAt(j);
      if (c === quote) return j > q + 1 ? { spec: text.slice(q + 1, j), end: j + 1 } : null;
      if (c === 10) return null;
    }
    return null;
  };
  const skipBlanks = (p: number) => {
    while (p < n && (text.charCodeAt(p) === 32 || text.charCodeAt(p) === 9)) p++;
    return p;
  };

  let resume = 0;
  STMT_RE.lastIndex = 0;
  for (let m = STMT_RE.exec(text); m; m = STMT_RE.exec(text)) {
    const at = m.index + m[0].length;
    if (at <= resume) continue; // inside a statement already read
    const line = lineOf(at - m[1].length);
    if (m[1] === 'import') {
      const c = text.charCodeAt(at);
      if (c === 40 || c === 46) continue; // import(…) / import.meta
      const q = stopAt(at);
      const f = q < n ? fromBefore(q) : -1;
      const sp = f >= at ? specAt(q) : null;
      if (!sp) continue; // a side-effect import, or no import at all
      importClause(text.slice(at, f), sp.spec, line, out.imports);
      resume = sp.end;
      continue;
    }
    let p = skipBlanks(at);
    if (text.startsWith('type', p) && !isIdent(text.charCodeAt(p + 4))) p = skipBlanks(p + 4);
    const c = text.charCodeAt(p);
    if (c === 42) {
      // export * from 'x' / export * as ns from 'x'
      const q = stopAt(p);
      const f = q < n ? fromBefore(q) : -1;
      const sp = f > p ? specAt(q) : null;
      if (!sp) continue;
      const rest = text.slice(p + 1, f).trim();
      const as = /^as\s+([\w$]+)$/.exec(rest);
      if (rest && !as) continue;
      out.reexports.push({ names: as ? [{ local: '*', exported: as[1] }] : null, spec: sp.spec });
      resume = sp.end;
    } else if (c === 123) {
      const b = braceAt(p + 1);
      if (b >= n) continue;
      const list = text.slice(p + 1, b);
      FROM_AFTER_RE.lastIndex = b + 1;
      const sp = FROM_AFTER_RE.exec(text) ? specAt(FROM_AFTER_RE.lastIndex) : null;
      if (sp) {
        out.reexports.push({ names: namedList(list, AS_RE).map(([local, exported]) => ({ local, exported })), spec: sp.spec });
        resume = sp.end;
      } else {
        for (const [local, exported] of namedList(list, AS_RE)) out.locals.push({ local, exported, line });
        resume = b;
      }
    } else if (!out.defaultExport && text.startsWith('default', p)) {
      DEFAULT_RE.lastIndex = p;
      const d = DEFAULT_RE.exec(text);
      if (d) out.defaultExport = { name: d[1] ?? d[2] ?? null, line };
    }
  }

  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(text); m; m = CALL_RE.exec(text)) {
    const b = bindingBefore(text, m.index);
    if (!b) continue;
    const line = lineOf(m.index);
    if (typeof b === 'string') out.imports.push({ local: b, imported: '*', spec: m[2], line });
    else for (const [imported, local] of b) out.imports.push({ local, imported, spec: m[2], line });
  }
  return out;
}

/** `a`, `a, { b as c }`, `* as ns`, `type { X }` (+ `from` stripped) → imports. */
function importClause(clause: string, spec: string, line: number, out: JsImport[]) {
  const c = clause.trim().replace(/^type\s+(?=[\w${*])/, '');
  const ns = /\*\s*as\s+([\w$]+)/.exec(c);
  if (ns) out.push({ local: ns[1], imported: '*', spec, line });
  const named = /\{([^}]*)\}/.exec(c);
  if (named) for (const [imported, local] of namedList(named[1], AS_RE)) out.push({ local, imported, spec, line });
  const def = /^([\w$]+)/.exec(c.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[\w$]+/, '').trim());
  if (def) out.push({ local: def[1], imported: 'default', spec, line });
}

/**
 * What a `require()` / `import()` call at `at` is bound to: `const x =` → 'x', `const { a, b: c } =` → pairs.
 * Looks back at most ~1 kB (the window is sliced first: no search runs back through the whole file).
 */
function bindingBefore(text: string, at: number): string | Array<[string, string]> | null {
  const lo = Math.max(0, at - 1100);
  let j = at - 1;
  const back = () => {
    while (j >= lo && isBlank(text.charCodeAt(j))) j--;
  };
  back();
  if (j >= lo + 4 && text.startsWith('await', j - 4) && !isIdent(text.charCodeAt(j - 5))) {
    j -= 5;
    back();
  }
  if (text.charCodeAt(j) !== 61 || '=!<>'.includes(text[j - 1] ?? '')) return null; // `=`, not `==` / `=>`
  j--;
  back();
  let binding: string | Array<[string, string]>;
  if (text.charCodeAt(j) === 125) {
    const open = text.slice(lo, j).lastIndexOf('{');
    if (open < 0) return null;
    binding = namedList(text.slice(lo + open + 1, j), COLON_RE);
    j = lo + open - 1;
  } else {
    const e = j + 1;
    while (j >= lo && isIdent(text.charCodeAt(j))) j--;
    binding = text.slice(j + 1, e);
    if (!binding || /^\d/.test(binding)) return null;
  }
  back();
  const kw = /(?:^|[^\w$])(?:const|let|var)$/.exec(text.slice(Math.max(lo, j - 5), j + 1));
  return kw ? binding : null;
}

/** Every import of a module file: static, `require()`, `await import()` bound to a name. */
export function jsImports(content: string): JsImport[] {
  return jsModule(content).imports;
}

export function jsReexports(content: string): JsReexport[] {
  return jsModule(content).reexports;
}

/** `export default Foo`, `export default class Foo`, `export { x as default }` → the local name (or null). */
export function jsDefaultExport(content: string, mod = jsModule(content)): { name: string | null; line: number } | null {
  if (mod.defaultExport) return mod.defaultExport;
  const l = mod.locals.find((x) => x.exported === 'default');
  return l ? { name: l.local, line: l.line } : null;
}

/** `export { local as exported }` (no `from`): the local name behind an exported one. */
export function jsLocalExport(content: string, exported: string, mod = jsModule(content)): string | null {
  return mod.locals.find((x) => x.exported === exported)?.local ?? null;
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

// The head of a `from … import` line (line-local). The module is never empty between the two blank runs.
const PY_HEAD_RE = /^[ \t]*from[ \t]+(\.+(?:[A-Za-z_][\w.]*)?|[A-Za-z_][\w.]*)[ \t]+import[ \t]+/gm;

/** `from … import …` lines (parenthesised lists across lines too). Linear: the `)` comes from a forward-only pointer. */
export function pyImports(content: string): PyImport[] {
  const text = head(content);
  const out: PyImport[] = [];
  const lineOf = lineIndex(text);
  let close = -1;
  let resume = 0;
  PY_HEAD_RE.lastIndex = 0;
  for (let m = PY_HEAD_RE.exec(text); m; m = PY_HEAD_RE.exec(text)) {
    if (m.index < resume) continue;
    const p = m.index + m[0].length;
    let list: string;
    if (text.charCodeAt(p) === 40) {
      if (close < p) {
        const k = text.indexOf(')', p);
        close = k < 0 ? text.length : k;
      }
      if (close >= text.length) continue;
      list = text.slice(p + 1, close);
      resume = close;
    } else {
      const e = text.indexOf('\n', p);
      list = text.slice(p, e < 0 ? text.length : e);
      const hash = list.indexOf('#');
      if (hash >= 0) list = list.slice(0, hash);
    }
    const line = lineOf(m.index);
    const dots = /^\.*/.exec(m[1])![0].length;
    for (const [imported, local] of namedList(list.replace(/\\\n/g, ' '), AS_RE)) {
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
