// Code symbols — ONE implementation for every consumer:
//   outline()      "go to heading/symbol in file" (palette `@`, MCP get_outline): Markdown headings, or a
//                  cheap per-line regex scan for code files (functions, classes, methods…);
//   codeSymbols()  the file overview: that scan plus brace-depth nesting and JS/TS class members;
//   extractDefs()  the workspace symbol index and Go to definition: codeSymbols() plus what navigation
//                  needs (enclosing class, class end line, `extends`, PHP namespace / traits) and a few
//                  index-only kinds the overview never shows (PHP properties / constants / enum cases,
//                  JS/TS class fields: `extra`).
// Pure and linear. Every pattern is anchored and built so that no two adjacent parts can match the same
// characters (no ambiguous `\s*(…|\s)*`): lines are capped at 400 characters and each pattern stays
// linear on them (tests/unit/search/symbols.test.ts feeds pathological lines).
import { languageForPath } from '@shared/languages';
import { isMarkdown } from '@shared/paths';
import { parseStructure } from './markdown';
import type { DefHit } from './defs';

export interface OutlineItem {
  line: number;
  level: number; // heading level, or 1 for top-level symbols / 2 for indented members
  text: string;
  kind: 'heading' | 'symbol';
  detail?: string; // e.g. 'function', 'class'
}

export interface CodeSymbol {
  line: number;
  level: number; // 1 = top level; deeper = nested
  text: string;
  detail?: string;
}

/** A definition (index / Go to definition). Lines and columns are 0-based. */
export interface Def {
  name: string;
  kind: string;
  line: number;
  col: number;
  /** Outline level (as codeSymbols). */
  level: number;
  /** Enclosing class-like (or Go receiver type, C++ `Foo::`, Lua table). */
  container?: string;
  /** Class-likes: last line of the body. */
  end?: number;
  /** Class-likes: the parent class as written (`extends Base`, `class A(Base)`, `: Base`). */
  ext?: string;
  /** PHP class-likes: traits used in the body. */
  uses?: string[];
  /** PHP: namespace in effect. */
  ns?: string;
  /** Index-only kinds (never in the outline / overview). */
  extra?: boolean;
}

export const MAX_LINE = 400;
const MAX_SYMBOLS = 2000;
const MAX_EXTRAS = 2000;

/** Kinds that name a type: `new X`, `X::`, `extends X`, type positions. */
export const CLASS_KINDS = new Set(['class', 'interface', 'trait', 'enum', 'struct', 'type', 'record', 'object', 'protocol', 'actor', 'union', 'mixin', 'typedef', 'namespace', 'extension']);

// --------------------------------------------------------------------------- patterns

type Pattern = {
  re: RegExp;
  /** Fixed kind, or the capture group index holding it. */
  kind: string | number;
  /** Capture group with the name (default: the last group). */
  name?: number;
  /** Post-check (keywords, declarations…): false = try the next pattern. Returns the kind to use, or true. */
  check?: (m: RegExpExecArray, line: string) => boolean | string;
  /** Turns the captured name into [name, container]. */
  split?: (raw: string) => [string, string | undefined];
  extra?: true;
  // Cheap gates, checked before the regex runs (most lines fail them):
  /** The line's first word ([A-Za-z]+ after the blanks) must be one of these… */
  starts?: Set<string>;
  /** …or the line starts with a non-letter (`@`, `[`, `$`, `-`, `_`). */
  sigil?: true;
  /** The line must contain this text. */
  needs?: string;
};

const words = (...lists: string[]) => new Set(lists.join('|').split('|'));

// The scan every file has always had (order and semantics kept: the first matching pattern decides,
// a keyword name drops the line). Languages below add their own patterns in front.
const GENERIC: Array<[RegExp, string]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|final\s+)?(class|interface|trait|enum|struct|type)\s+([A-Za-z_$][\w$]*)/, '$1'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'], // \b: not `functionality`
  // PHP. Each modifier takes its own blank: `\s*` next to `(…|\s)*` was ambiguous (quadratic on a line of spaces).
  [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'], // Python
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'], // Rust
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'], // Go
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
  [/^\s*(?:CREATE|create)\s+(?:OR\s+REPLACE\s+|or\s+replace\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|table|view|function|procedure|index)\s+(?:IF\s+NOT\s+EXISTS\s+|if\s+not\s+exists\s+)?([\w."`]+)/, 'sql'],
];
const GENERIC_SKIP = /^(if|for|while|switch|return|catch)$/;
/** Every generic pattern starts (after `^\s*`) with one of these words: other lines skip them all, same result. */
const GENERIC_STARTS = words('export|default|abstract|final|class|interface|trait|enum|struct|type|async|function|public|private|protected|static|def|pub|fn|func|const|let|var|CREATE|create');

/** Statement words that are never a return type (`return foo(x)`, `else if (…)`, `new Foo(…)`). */
const NOT_A_TYPE = new Set(['return', 'new', 'throw', 'else', 'case', 'goto', 'yield', 'await', 'assert', 'package', 'import', 'do', 'in', 'instanceof', 'typeof', 'sizeof', 'delete', 'using', 'namespace', 'co_return', 'co_await', 'co_yield', 'if', 'for', 'while', 'switch', 'catch', 'when', 'is', 'as', 'not', 'and', 'or', 'echo', 'print', 'raise', 'var', 'let', 'val', 'def', 'fn', 'func', 'fun', 'function', 'lock', 'fixed', 'checked', 'unchecked', 'from', 'select', 'where', 'out', 'ref', 'params', 'try', 'finally', 'with', 'struct', 'enum', 'union', 'class']);
const NOT_A_NAME = /^(if|for|while|switch|return|catch|function|else|do|try|new|typeof|await|super|this|throw|with|yield|delete|void|sizeof|func|var|let|val|in|is|as|case|default|elif|elsif|foreach|until|unless|and|or|not|then|fi|done|esac)$/;

/** A definition head, not a call / prototype / field: no `;` at the end, unless a body follows (`=> x;`, `{ … };`). */
const notDeclaration = (line: string) => !/;\s*$/.test(line) || /=>|\{/.test(line);

// Java / C# / Dart: `[modifiers] Type name(` — group 1 modifiers, 2 type, 3 name.
function typedHead(mods: string): RegExp {
  return new RegExp(
    String.raw`^\s*(?:@\w+\s+)*((?:(?:${mods})\s+)*)(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>\s*)?([A-Za-z_$][\w$.]*(?:<[^()=;{}]*>)?\??(?:\s*\[[,\s]*\])*\??)\s+([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>\s*)?\(`,
  );
}
const JAVA_MODS = 'public|protected|private|static|final|abstract|synchronized|native|default|strictfp|transient';
const CS_MODS = 'public|protected|private|internal|static|virtual|override|abstract|sealed|async|extern|unsafe|new|partial|readonly';
const DART_MODS = 'static|final|const|external|factory|abstract|covariant|late';
const MODIFIER_WORDS = new Set([...JAVA_MODS.split('|'), ...CS_MODS.split('|'), ...DART_MODS.split('|')]);

/** Typed heads: a modifier as "type" is a constructor (`public Foo(`); a statement word is no head. */
const typedCheck =
  (fnKind: string) =>
  (m: RegExpExecArray, line: string): boolean | string => {
    const type = m[2];
    if (NOT_A_TYPE.has(type) || NOT_A_NAME.test(m[3])) return false;
    if (MODIFIER_WORDS.has(type)) return 'constructor';
    // `abstract void run();` / interface methods are definitions too; other `;` endings are calls / fields.
    if (!notDeclaration(line) && !/\babstract\b/.test(m[1])) return false;
    return fnKind;
  };

const lastSegment = (sep: RegExp) => (raw: string): [string, string | undefined] => {
  const parts = raw.split(sep).filter(Boolean);
  const name = parts.pop() ?? raw;
  return [name, parts.length ? parts.join('.') : undefined];
};

const NONE = new Set<string>();
const CSS_CUSTOM: Pattern = { re: /^\s*(--[A-Za-z_-][\w-]*)\s*:/, kind: 'property', starts: NONE, sigil: true };

const LANG_PATTERNS: Record<string, Pattern[]> = {
  java: [
    {
      re: /^\s*(?:@\w+\s+)*(?:(?:public|protected|private|static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/,
      kind: 1,
      check: (m) => (m[1] === '@interface' ? 'interface' : true),
      starts: words('public|protected|private|static|final|abstract|sealed|non|strictfp|class|interface|enum|record'),
      sigil: true,
    },
    { re: typedHead(JAVA_MODS), kind: 'method', name: 3, check: typedCheck('method'), needs: '(' },
  ],
  csharp: [
    {
      re: /^\s*(?:\[[^\]]*\]\s*)*(?:(?:public|protected|private|internal|static|sealed|abstract|partial|readonly|unsafe|new|file|ref)\s+)*(class|interface|struct|enum|record)\s+(?:(?:class|struct)\s+)?([A-Za-z_]\w*)/,
      kind: 1,
      starts: words('public|protected|private|internal|static|sealed|abstract|partial|readonly|unsafe|new|file|ref|class|interface|struct|enum|record'),
      sigil: true,
    },
    { re: typedHead(CS_MODS), kind: 'method', name: 3, check: typedCheck('method'), needs: '(' },
    {
      re: /^\s*((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly|required)\s+)+)([A-Za-z_][\w.]*(?:<[^()=;{}]*>)?\??(?:\[[,\s]*\])*)\s+([A-Za-z_]\w*)\s*(?:\{\s*(?:get|set|init)\b|=>)/,
      kind: 'property',
      name: 3,
      starts: words('public|protected|private|internal|static|virtual|override|abstract|sealed|new|readonly|required'),
    },
  ],
  kotlin: [
    {
      re: /^\s*(?:@\w+\s+)*(?:(?:public|private|protected|internal|open|override|abstract|final|suspend|inline|noinline|crossinline|operator|infix|tailrec|external|data|sealed|enum|annotation|inner|value|companion|actual|expect|const|lateinit|fun)\s+)*(fun|class|interface|object|typealias)\s+(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?([A-Za-z_]\w*(?:<[^<>()]*>)?(?:\.[A-Za-z_]\w*)*)/,
      kind: 1,
      check: (m) => (m[1] === 'fun' ? 'function' : m[1] === 'typealias' ? 'type' : true),
      // `fun String.trimAll()` / `fun <T> List<T>.second()`: the name is the last segment.
      split: (raw) => [raw.replace(/<[^<>()]*>/g, '').split('.').pop() ?? raw, undefined],
      starts: words('public|private|protected|internal|open|override|abstract|final|suspend|inline|noinline|crossinline|operator|infix|tailrec|external|data|sealed|enum|annotation|inner|value|companion|actual|expect|const|lateinit|fun|class|interface|object|typealias'),
      sigil: true,
    },
  ],
  swift: [
    { re: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating|nonmutating|convenience|required|dynamic|optional|nonisolated|isolated)\s+)*func\s+([A-Za-z_]\w*)/, kind: 'function', needs: 'func' },
    { re: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|override|convenience|required)\s+)*(init)[?!]?\s*[(<]/, kind: 'constructor', needs: 'init' },
    {
      re: /^\s*(?:@\w+\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(class|struct|enum|protocol|extension|actor|typealias)\s+([A-Za-z_]\w*)/,
      kind: 1,
      check: (m) => (m[1] === 'typealias' ? 'type' : true),
      starts: words('public|private|fileprivate|internal|open|final|indirect|class|struct|enum|protocol|extension|actor|typealias'),
      sigil: true,
    },
  ],
  dart: [
    {
      re: /^\s*(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*(class|mixin|enum|extension|typedef)\s+([A-Za-z_$][\w$]*)/,
      kind: 1,
      check: (m, l) => m[2] !== 'on' && (m[1] !== 'extension' || /\bon\b/.test(l)),
      starts: words('abstract|sealed|base|final|interface|mixin|class|enum|extension|typedef'),
    },
    { re: /^\s*(?:(?:static|external)\s+)*(?:[A-Za-z_$][\w$]*(?:<[^()=;{}]*>)?\??\s+)?(get|set)\s+([A-Za-z_$][\w$]*)/, kind: 1, check: (m) => (m[1] === 'get' ? 'getter' : 'setter'), needs: 'et ' },
    { re: typedHead(DART_MODS), kind: 'function', name: 3, check: typedCheck('function'), needs: '(' },
  ],
  c: [],
  cpp: [],
  shell: [
    // `name() {` and `function name` (names may hold - . :)
    { re: /^\s*(?:function\s+([A-Za-z_][\w.:-]*)(?:\s*\(\s*\))?|([A-Za-z_][\w.:-]*)\s*\(\s*\))\s*(?:\{|\(|$)/, kind: 'function', check: (m) => !NOT_A_NAME.test(m[1] ?? m[2]) },
  ],
  lua: [
    { re: /^\s*(?:local\s+)?function\s+([A-Za-z_]\w*(?:[.:][A-Za-z_]\w*)*)\s*\(/, kind: 'function', split: lastSegment(/[.:]/), needs: 'function' },
    { re: /^\s*(?:local\s+)?([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*=\s*function\b/, kind: 'function', split: lastSegment(/\./), needs: 'function' },
  ],
  scss: [{ re: /^\s*@(mixin|function)\s+([A-Za-z_-][\w-]*)/, kind: 1, starts: NONE, sigil: true }, { re: /^\s*(\$[A-Za-z_-][\w-]*)\s*:/, kind: 'variable', starts: NONE, sigil: true }, CSS_CUSTOM],
  less: [{ re: /^\s*(@[A-Za-z_-][\w-]*)\s*:/, kind: 'variable', starts: NONE, sigil: true }, CSS_CUSTOM],
  css: [CSS_CUSTOM],
  php: [
    // Index-only (the overview / outline never showed these): properties (promoted ones too), constants, enum cases.
    { re: /^\s*(?:(?:public|protected|private|var|static|readonly)\s+)+(?:\??[A-Za-z_\\][\w\\|]*\s+)?\$([A-Za-z_]\w*)/, kind: 'property', extra: true, starts: words('public|protected|private|var|static|readonly') },
    { re: /^\s*(?:(?:public|protected|private|final)\s+)*const\s+(?:[A-Za-z_\\][\w\\|]*\s+)?([A-Za-z_]\w*)\s*=/, kind: 'const', extra: true, starts: words('public|protected|private|final|const') },
    { re: /^\s*case\s+([A-Za-z_]\w*)\s*[=;]/, kind: 'case', extra: true, starts: words('case') },
  ],
};

// C / C++ heads: `[template<…>] type tokens name(` / `Foo::bar(` — group 1 type tokens, 2 (qualified) name.
// Type tokens and their separators use disjoint characters, so the split is unambiguous.
const C_TYPE_RE = /^\s*(?:template\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?(?:typedef\s+)?(struct|union|enum|class|namespace)\s+(?:(?:class|struct)\s+)?([A-Za-z_]\w*)\s*(?:[:{]|final\b|$)/;
const C_FUNC_RE = /^\s*(?:template\s*<[^<>]*(?:<[^<>]*>[^<>]*)*>\s*)?((?:[A-Za-z_][\w:<>,]*[\s*&]+)*)((?:[A-Za-z_]\w*(?:<[^<>()]*>)?::)*~?[A-Za-z_]\w*)\s*\(/;
const C_PATTERNS: Pattern[] = [
  { re: C_TYPE_RE, kind: 1, starts: words('template|typedef|struct|union|enum|class|namespace') },
  {
    re: C_FUNC_RE,
    kind: 'function',
    name: 2,
    needs: '(',
    check: (m, line) => {
      const type = m[1].trim();
      const qualified = m[2].includes('::');
      const first = type.split(/[\s*&]+/)[0];
      if (!type && !qualified) return false; // a call: `foo(x)`
      if (first && (NOT_A_TYPE.has(first) || /^(public|private|protected)$/.test(first))) return false;
      if (/<<|>>/.test(type) || !notDeclaration(line)) return false;
      return qualified ? 'method' : true;
    },
    split: (raw) => {
      const parts = raw.split('::');
      const name = parts.pop()!;
      return [name, parts.length ? parts[parts.length - 1].replace(/<[^<>()]*>$/, '') : undefined]; // `Box<T>::get` → Box
    },
  },
];
LANG_PATTERNS.c = C_PATTERNS;
LANG_PATTERNS.cpp = C_PATTERNS;

/** Languages whose own patterns replace the generic scan (it mis-reads them: `function a.b`, `struct x *p;`). */
const NO_GENERIC = new Set(['java', 'csharp', 'kotlin', 'swift', 'dart', 'c', 'cpp', 'shell', 'lua', 'css', 'scss', 'less']);

const BRACE_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'php', 'java', 'csharp', 'go', 'rust', 'c', 'cpp', 'kotlin', 'swift', 'dart', 'css', 'scss', 'less']);
const JS_LIKE = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

interface Raw {
  line: number;
  col: number;
  name: string;
  kind: string;
  /** Indented (outline level 2). */
  indented: boolean;
  container?: string;
  extra?: true;
}

/** JavaScript's `\s` (what every pattern's `^\s*` skips). */
function isBlank(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/**
 * Index of the first non-blank character when it may start a definition (letters, `_ $ @ - [`), else -1:
 * every pattern needs one of those right after its `^\s*`, so other lines are skipped without a regex.
 */
function mayDefine(l: string): number {
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (isBlank(c)) continue;
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c === 64 || c === 45 || c === 91) return i;
    return -1;
  }
  return -1;
}

/** The ASCII letters starting at `i` ('' when the line starts with `_ $ @ - [`). */
function firstWord(l: string, i: number): string {
  let j = i;
  for (; j < l.length; j++) {
    const c = l.charCodeAt(j);
    if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) break;
  }
  return l.slice(i, j);
}

/** Same pattern with match indices, compiled on first use and run only on lines that already matched. */
const withIndices = new Map<RegExp, RegExp>();
function groupStart(re: RegExp, line: string, g: number): number {
  let r = withIndices.get(re);
  if (!r) withIndices.set(re, (r = new RegExp(re.source, re.flags + 'd')));
  return r.exec(line)?.indices?.[g]?.[0] ?? 0;
}

/** Index of the last capture group that took part in the match (alternatives: `a(x)|b(y)`). */
function lastGroup(m: RegExpExecArray): number {
  for (let g = m.length - 1; g > 0; g--) if (m[g] !== undefined) return g;
  return 0;
}

/** The per-line scan (outline's): language patterns first, then the generic ones. `cols`: exact name columns. */
function lineScan(lang: string, lines: readonly string[], extras: boolean, cols: boolean): Raw[] {
  const own = LANG_PATTERNS[lang] ?? [];
  const generic = !NO_GENERIC.has(lang);
  const out: Raw[] = [];
  let symbols = 0;
  let extraCount = 0;
  for (let i = 0; i < lines.length && symbols < MAX_SYMBOLS; i++) {
    const l = lines[i];
    if (l.length > MAX_LINE) continue;
    const at = mayDefine(l);
    if (at < 0) continue;
    const word = firstWord(l, at);
    let done = false;
    for (const p of own) {
      if (p.extra && (!extras || extraCount >= MAX_EXTRAS)) continue;
      if (p.starts && !(p.starts.has(word) || (p.sigil && !word))) continue;
      if (p.needs && !l.includes(p.needs)) continue;
      const m = p.re.exec(l);
      if (!m) continue;
      const verdict = p.check ? p.check(m, l) : true;
      if (verdict === false) continue;
      const g = p.name ?? lastGroup(m);
      const rawName = m[g];
      if (!rawName) continue;
      const [name, container] = p.split ? p.split(rawName) : [rawName, undefined];
      if (NOT_A_NAME.test(name)) continue;
      const kind = typeof verdict === 'string' ? verdict : typeof p.kind === 'number' ? m[p.kind] : p.kind;
      const col = cols ? groupStart(p.re, l, g) + Math.max(0, rawName.lastIndexOf(name)) : 0;
      const r: Raw = { line: i, col, name, kind, indented: /^\s/.test(l) };
      if (container) r.container = container;
      if (p.extra) {
        r.extra = true;
        extraCount++;
      } else symbols++;
      out.push(r);
      done = true;
      break;
    }
    if (done || !generic || !(GENERIC_STARTS.has(word) || word.startsWith('function'))) continue;
    for (const [re, kind] of GENERIC) {
      const m = re.exec(l);
      if (!m) continue;
      const g = m[2] !== undefined ? 2 : 1;
      const name = m[g];
      if (GENERIC_SKIP.test(name)) break;
      out.push({ line: i, col: cols ? groupStart(re, l, g) : 0, name, kind: kind === '$1' ? m[1] : kind, indented: /^\s/.test(l) });
      symbols++;
      break;
    }
  }
  return out;
}

const langOf = (path: string) => languageForPath(path)?.id ?? '';

export function outline(path: string, content: string): OutlineItem[] {
  if (isMarkdown(path)) {
    return parseStructure(path, content).headings.filter((h) => h.text).map((h) => ({ line: h.line, level: h.level, text: h.text, kind: 'heading' as const }));
  }
  return lineScan(langOf(path), content.split('\n'), false, false).map((r) => ({ line: r.line, level: r.indented ? 2 : 1, text: r.name, kind: 'symbol' as const, detail: r.kind }));
}

// --------------------------------------------------------------------------- nesting (overview + index)

/** Characters the code state reacts to (besides the newline). */
const SPECIAL = new Uint8Array(128);
for (const ch of '{}"\'`/#') SPECIAL[ch.charCodeAt(0)] = 1;

/**
 * `{}` depth at the start of every line, skipping strings and comments (`#` comments for PHP only,
 * and not PHP 8 `#[attributes]`). Regex literals aren't recognised — rare enough in practice.
 * One pass; comments are crossed with indexOf. (Kept exactly as before: a backslash inside a string
 * also skips a following newline, so that line's depth is not recorded — the overview depends on it.)
 */
export function braceDepths(content: string, hashComments = false): Int32Array {
  let lines = 1;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) lines++;
  const out = new Int32Array(lines);
  const n = content.length;
  let depth = 0;
  let line = 0;
  /** Index of the newline ending the comment that starts at `j` (or the end). */
  const lineEnd = (j: number) => {
    const k = content.indexOf('\n', j);
    return k < 0 ? n : k;
  };
  let i = 0;
  while (i < n) {
    const c = content.charCodeAt(i);
    if (c === 10) {
      out[++line] = depth;
      i++;
    } else if (c >= 128 || SPECIAL[c] === 0) i++;
    else if (c === 123) {
      depth++;
      i++;
    } else if (c === 125) {
      if (depth > 0) depth--;
      i++;
    } else if (c === 47) {
      const d = content.charCodeAt(i + 1);
      if (d === 47) i = lineEnd(i + 2);
      else if (d === 42) {
        const star = content.indexOf('*/', i + 2);
        const end = star < 0 ? n : star;
        for (let k = content.indexOf('\n', i + 2); k !== -1 && k < end; k = content.indexOf('\n', k + 1)) out[++line] = depth;
        i = star < 0 ? n : star + 2;
      } else i++;
    } else if (c === 35) {
      i = hashComments && content.charCodeAt(i + 1) !== 91 ? lineEnd(i + 1) : i + 1;
    } else {
      // A string: '…' and "…" end at the newline (the loop above records it), `…` spans lines.
      let j = i + 1;
      while (j < n) {
        const s = content.charCodeAt(j);
        if (s === 92) {
          if (content.charCodeAt(j + 1) === 10) out[++line] = depth; // `\` + newline continues the string
          j += 2;
        } else if (s === c) {
          j++;
          break;
        } else if (s === 10) {
          if (c !== 96) break;
          out[++line] = depth;
          j++;
        } else j++;
      }
      i = j;
    }
  }
  return out;
}

// `  async foo<T>(a: T): Promise<void> {`, `  get size() {`, `  constructor(…) {`
const METHOD_RE = /^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;
// `  handle = async (e) => {` — arrow-function class fields.
const FIELD_FN_RE = /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
// `  private items: Item[] = [];`, `  count = 0;`, `  #secret;` — plain fields (index only).
const FIELD_RE = /^\s*(?:(?:public|private|protected|static|readonly|declare|override|accessor)\s+)*(#?[A-Za-z_$][\w$]*)[?!]?\s*(?::[^=;(]+)?(?:=|;|$)/;
const CONST_RE = /^(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const JS_NOT_A_NAME = /^(if|for|while|switch|return|catch|function|else|do|try|new|typeof|await|super|this|throw|with|yield|delete|void)$/;

/** Members of each class: lines one brace level inside its body that declare a method / arrow field (/ field). */
function jsMembers(lines: readonly string[], depths: Int32Array, classes: ReadonlyArray<{ line: number }>, extras: boolean): Raw[] {
  const out: Raw[] = [];
  for (const c of classes) {
    const d = depths[c.line];
    let opened = false;
    for (let i = c.line + 1; i < lines.length; i++) {
      if (depths[i] <= d) {
        if (opened || i > c.line + 3) break; // body closed, or `class X {}` / no body
        continue;
      }
      opened = true;
      const l = lines[i];
      if (depths[i] !== d + 1 || l.length > MAX_LINE || !l.trim()) continue;
      const method = METHOD_RE.exec(l);
      const m = method ?? FIELD_FN_RE.exec(l);
      if (m) {
        if (JS_NOT_A_NAME.test(m[1])) continue;
        out.push({ line: i, col: extras ? groupStart(method ? METHOD_RE : FIELD_FN_RE, l, 1) : 0, name: m[1], kind: m[1] === 'constructor' ? 'constructor' : 'method', indented: true });
        continue;
      }
      const f = extras ? FIELD_RE.exec(l) : null;
      if (f && !JS_NOT_A_NAME.test(f[1])) out.push({ line: i, col: groupStart(FIELD_RE, l, 1), name: f[1], kind: 'property', indented: true, extra: true });
    }
  }
  return out;
}

/** Shared pipeline: the scan, members, levels. `extras` = also the index-only kinds. */
function scan(path: string, content: string, extras: boolean): { lang: string; lines: string[]; raws: Raw[]; levels: number[]; depths: Int32Array | null } {
  const lang = langOf(path);
  const lines = content.split('\n');
  let raws = lineScan(lang, lines, extras, extras);
  if (!BRACE_LANGS.has(lang)) return { lang, lines, raws, levels: raws.map((r) => (r.indented ? 2 : 1)), depths: null }; // Python & co.: indentation is the structure
  const depths = braceDepths(content, lang === 'php');
  if (JS_LIKE.has(lang)) {
    const extra = jsMembers(
      lines,
      depths,
      raws.filter((s) => s.kind === 'class'),
      extras,
    );
    for (let i = 0; i < lines.length; i++) {
      const m = depths[i] === 0 && lines[i].length <= MAX_LINE ? CONST_RE.exec(lines[i]) : null;
      if (m) extra.push({ line: i, col: extras ? groupStart(CONST_RE, lines[i], 1) : 0, name: m[1], kind: 'const', indented: false });
    }
    if (extra.length) {
      const taken = new Set(raws.map((s) => s.line));
      raws = [...raws, ...extra.filter((s) => !taken.has(s.line) && (taken.add(s.line), true))].sort((a, b) => a.line - b.line);
    }
  }
  return { lang, lines, raws, levels: raws.map((s) => Math.min(depths[s.line] ?? 0, 5) + 1), depths };
}

export function codeSymbols(path: string, content: string): CodeSymbol[] {
  const { raws, levels } = scan(path, content, false);
  return raws.map((r, i) => ({ line: r.line, level: levels[i], text: r.name, detail: r.kind }));
}

// --------------------------------------------------------------------------- definitions (index)

const EXTENDS_RE = /\bextends\s+(\\?[A-Za-z_$][\w$\\.]*)/;
const COLON_BASE_RE = /^[^:]*\b(?:class|struct|object|interface)\s+[A-Za-z_]\w*(?:<[^<>]*>)?(?:\([^)]*\))?\s*:\s*(?:(?:public|protected|private|virtual)\s+)*([A-Za-z_][\w.:]*)/;
const PY_BASE_RE = /^\s*class\s+[A-Za-z_]\w*\s*\(\s*([A-Za-z_][\w.]*)/;
const PHP_USE_TRAIT = /^\s*use\s+(\\?[A-Za-z_][\w\\]*(?:\s*,\s*\\?[A-Za-z_][\w\\]*)*)\s*[;{]/;
const PHP_NAMESPACE = /^\s*namespace\s+([A-Za-z_][\w\\]*)\s*[;{]/;

function baseOf(lang: string, line: string): string | undefined {
  if (line.length > MAX_LINE) return undefined;
  if (lang === 'python') {
    const m = PY_BASE_RE.exec(line);
    return m && m[1] !== 'object' ? m[1] : undefined;
  }
  const m = EXTENDS_RE.exec(line) ?? (lang === 'csharp' || lang === 'kotlin' || lang === 'swift' || lang === 'cpp' ? COLON_BASE_RE.exec(line) : null);
  return m?.[1];
}

/** Indentation width (tabs = 4) of a non-blank line; -1 for blank lines. */
function indentOf(l: string): number {
  let w = 0;
  for (let i = 0; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c === 32) w++;
    else if (c === 9) w += 4;
    else return c === 13 ? -1 : w;
  }
  return -1;
}

/** Every definition of a code file, with what navigation needs. Pure, linear. */
export function extractDefs(path: string, content: string): Def[] {
  const { lang, lines, raws, levels, depths } = scan(path, content, true);
  const defs: Def[] = raws.map((r, i) => {
    const d: Def = { name: r.name, kind: r.kind, line: r.line, col: r.col, level: levels[i] };
    if (r.container) d.container = r.container;
    if (r.extra) d.extra = true;
    return d;
  });
  if (!defs.length) return defs;

  if (depths) {
    // Class bodies by brace depth: a member is a definition one level inside.
    const stack: Array<{ d: Def; depth: number }> = [];
    for (const d of defs) {
      const depth = depths[d.line];
      while (stack.length && (stack[stack.length - 1].depth >= depth || (stack[stack.length - 1].d.end ?? Infinity) < d.line)) stack.pop();
      const top = stack[stack.length - 1];
      if (top && !d.container && depth === top.depth + 1) d.container = top.d.name;
      if (CLASS_KINDS.has(d.kind) && d.kind !== 'namespace') {
        d.end = bodyEnd(depths, d.line, lines.length);
        stack.push({ d, depth });
      }
    }
  } else if (lang === 'python') {
    // Indentation: a class body is every following line indented deeper (blank lines included); its
    // members sit at the body's first indentation (a function nested in a method is no member).
    const stack: Array<{ d: Def; indent: number; body: number }> = [];
    let di = 0;
    for (let i = 0; i < lines.length && (di < defs.length || stack.length); i++) {
      const ind = indentOf(lines[i]);
      if (ind >= 0) {
        while (stack.length && ind <= stack[stack.length - 1].indent) stack.pop()!.d.end = prevNonBlank(lines, i);
        const top = stack[stack.length - 1];
        if (top && top.body < 0) top.body = ind;
      }
      while (di < defs.length && defs[di].line === i) {
        const d = defs[di++];
        const top = stack[stack.length - 1];
        if (top && !d.container && ind === top.body) d.container = top.d.name;
        if (d.kind === 'class') stack.push({ d, indent: Math.max(0, ind), body: -1 });
      }
    }
    for (const s of stack) s.d.end = lines.length - 1;
  }

  // Go methods: the receiver type is the container.
  if (lang === 'go') {
    for (const d of defs) {
      const m = /^\s*func\s*\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)/.exec(lines[d.line]);
      if (m) d.container = m[1];
    }
  }

  let ns: string | undefined;
  let nsLine = -1;
  const isPhp = lang === 'php' || lang === 'blade';
  for (const d of defs) {
    if (CLASS_KINDS.has(d.kind)) {
      const base = baseOf(lang, lines[d.line]);
      if (base) d.ext = base;
    }
    if (isPhp) {
      // Namespace in effect: the last `namespace X;` above the definition.
      for (let i = nsLine + 1; i <= d.line; i++) {
        const m = lines[i].length <= MAX_LINE ? PHP_NAMESPACE.exec(lines[i]) : null;
        if (m) ns = m[1];
        nsLine = i;
      }
      if (ns) d.ns = ns;
      if (CLASS_KINDS.has(d.kind) && depths) d.uses = traitsOf(lines, depths, d);
    }
  }
  return defs;
}

function prevNonBlank(lines: readonly string[], i: number): number {
  let j = i - 1;
  while (j > 0 && indentOf(lines[j]) < 0) j--;
  return j;
}

/** Last line of the body opened on (or right after) `line`: the line before depth falls back. */
function bodyEnd(depths: Int32Array, line: number, n: number): number {
  const d = depths[line];
  let opened = false;
  for (let i = line + 1; i < n; i++) {
    if (depths[i] > d) opened = true;
    else if (opened) return i - 1;
    else if (i > line + 3) return line; // `class X {}` / a declaration without a body
  }
  return opened ? n - 1 : line;
}

/** `use A, B;` lines directly inside a PHP class / trait body. */
function traitsOf(lines: readonly string[], depths: Int32Array, d: Def): string[] | undefined {
  const out: string[] = [];
  const end = d.end ?? d.line;
  const inner = depths[d.line] + 1;
  for (let i = d.line + 1; i <= end && i < lines.length; i++) {
    if (depths[i] !== inner || lines[i].length > MAX_LINE) continue;
    const m = PHP_USE_TRAIT.exec(lines[i]);
    if (m) out.push(...m[1].split(',').map((s) => s.trim()));
  }
  return out.length ? out : undefined;
}

// --------------------------------------------------------------------------- index contract (./defs)

/** Languages whose files get definitions in the index (everything else: none, no cost). */
export const DEF_LANGS = new Set([
  'php', 'blade', 'javascript', 'jsx', 'typescript', 'tsx', 'vue', 'css', 'scss', 'less', 'python', 'ruby', 'go', 'rust', 'java',
  'kotlin', 'csharp', 'c', 'cpp', 'swift', 'lua', 'dart', 'shell', 'sql', 'perl', 'r', 'powershell',
]);

// Files that count as one language for lookups: a PHP call never jumps into JavaScript, but a Blade
// template is PHP and a .vue file is JavaScript.
const FAMILY: Record<string, string> = { blade: 'php', jsx: 'js', javascript: 'js', typescript: 'js', tsx: 'js', vue: 'js', scss: 'css', less: 'css', cpp: 'c' };
export const familyOf = (lang: string) => FAMILY[lang] ?? lang;
export function familyLangs(lang: string): string[] {
  const f = familyOf(lang);
  const out = [...DEF_LANGS].filter((l) => familyOf(l) === f);
  return out.length ? out : [lang];
}

/** Total order of hits (path, line, col): identical whether one index or several shards answered. */
export function compareDefHits(a: DefHit, b: DefHit): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.col - b.col || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export const DEF_TEXT_MAX = 200;
export const DEF_LIMIT = 500;
