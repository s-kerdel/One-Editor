// Code-file symbols for the overview outline: the Ctrl+Shift+O scan (search/symbols — classes,
// functions, PHP methods, arrow consts, …) plus two things that line scan can't do:
//  - nesting by brace depth in brace languages (an unindented PHP method still sits in its class);
//  - JS/TS class members written without `function`, and plain top-level consts.
// Pure and linear: one pass over the text for depths, one per line for patterns.
import { languageForPath } from '@shared/languages';
import { outline } from '../../search/symbols';

export interface CodeSymbol {
  line: number;
  level: number; // 1 = top level; deeper = nested
  text: string;
  detail?: string;
}

const BRACE_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'php', 'java', 'csharp', 'go', 'rust', 'c', 'cpp', 'kotlin', 'swift', 'dart']);
const JS_LIKE = new Set(['typescript', 'tsx', 'javascript', 'jsx']);

/**
 * `{}` depth at the start of every line, skipping strings and comments (`#` comments for PHP only,
 * and not PHP 8 `#[attributes]`). Regex literals aren't recognised — rare enough in practice.
 */
export function braceDepths(content: string, hashComments = false): Int32Array {
  let lines = 1;
  for (let i = content.indexOf('\n'); i !== -1; i = content.indexOf('\n', i + 1)) lines++;
  const out = new Int32Array(lines);
  let depth = 0;
  let line = 0;
  let state: 0 | 1 | 2 | 3 = 0; // code, line comment, block comment, string
  let quote = 0;
  const n = content.length;
  for (let i = 0; i < n; i++) {
    const c = content.charCodeAt(i);
    if (c === 10) {
      if (state === 1 || (state === 3 && quote !== 96)) state = 0; // line comments and '…' / "…" end here
      out[++line] = depth;
      continue;
    }
    if (state === 1) continue;
    if (state === 2) {
      if (c === 42 && content.charCodeAt(i + 1) === 47) {
        state = 0;
        i++;
      }
      continue;
    }
    if (state === 3) {
      if (c === 92) i++; // escape
      else if (c === quote) state = 0;
      continue;
    }
    if (c === 123) depth++;
    else if (c === 125) depth = depth > 0 ? depth - 1 : 0;
    else if (c === 34 || c === 39 || c === 96) {
      state = 3;
      quote = c;
    } else if (c === 47) {
      const d = content.charCodeAt(i + 1);
      if (d === 47) state = 1;
      else if (d === 42) {
        state = 2;
        i++;
      }
    } else if (c === 35 && hashComments && content.charCodeAt(i + 1) !== 91) state = 1;
  }
  return out;
}

// `  async foo<T>(a: T): Promise<void> {`, `  get size() {`, `  constructor(…) {`
const METHOD_RE = /^\s*(?:(?:public|private|protected|static|readonly|async|override|abstract|declare|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/;
// `  handle = async (e) => {` — arrow-function class fields.
const FIELD_FN_RE = /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*(#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/;
const CONST_RE = /^(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/;
const NOT_A_NAME = /^(if|for|while|switch|return|catch|function|else|do|try|new|typeof|await|super|this|throw|with|yield|delete|void)$/;

/** Members of each class: lines one brace level inside its body that declare a method / arrow field. */
function jsMembers(lines: readonly string[], depths: Int32Array, classes: ReadonlyArray<{ line: number }>): CodeSymbol[] {
  const out: CodeSymbol[] = [];
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
      if (depths[i] !== d + 1 || l.length > 400 || !l.trim()) continue;
      const method = METHOD_RE.exec(l);
      const m = method ?? FIELD_FN_RE.exec(l);
      if (!m || NOT_A_NAME.test(m[1])) continue;
      out.push({ line: i, level: 0, text: m[1], detail: m[1] === 'constructor' ? 'constructor' : 'method' });
    }
  }
  return out;
}

export function codeSymbols(path: string, content: string): CodeSymbol[] {
  const lang = languageForPath(path)?.id ?? '';
  const base: CodeSymbol[] = outline(path, content).map((o) => ({ line: o.line, level: o.level, text: o.text, detail: o.detail }));
  if (!BRACE_LANGS.has(lang)) return base; // Python & co.: indentation (search's levels) is the structure
  const depths = braceDepths(content, lang === 'php');
  let all = base;
  if (JS_LIKE.has(lang)) {
    const lines = content.split('\n');
    const extra = jsMembers(
      lines,
      depths,
      base.filter((s) => s.detail === 'class'),
    );
    for (let i = 0; i < lines.length; i++) {
      const m = depths[i] === 0 && lines[i].length <= 400 ? CONST_RE.exec(lines[i]) : null;
      if (m) extra.push({ line: i, level: 0, text: m[1], detail: 'const' });
    }
    if (extra.length) {
      const taken = new Set(base.map((s) => s.line));
      all = [...base, ...extra.filter((s) => !taken.has(s.line) && (taken.add(s.line), true))].sort((a, b) => a.line - b.line);
    }
  }
  return all.map((s) => ({ ...s, level: Math.min(depths[s.line] ?? 0, 5) + 1 }));
}
