// Replace planning (pure). Given a document and a search, compute minimal edits.
// Literal mode inserts the replacement verbatim; regex mode expands $1 $& $<name> $$ plus \n \t and
// VS Code-style case modifiers \U \L \u \l (\E ends \U/\L).
import { SearchEngine } from './engine';
import { compileRegex, parseQuery, type RegexAtom } from './query';
import { computeLineStarts, lineOfOffset } from './text';
import type { MatchRange, SearchOptions } from './types';

export interface ReplaceEdit {
  from: number;
  to: number;
  insert: string;
  line: number;
}

export interface ReplacePlan {
  edits: ReplaceEdit[];
  error?: string;
}

export function expandReplacement(template: string, m: RegExpExecArray | null): string {
  if (!m) return template;
  let out = '';
  let caseMode: 'U' | 'L' | null = null;
  let nextOne: 'u' | 'l' | null = null;
  const emit = (s: string) => {
    if (!s) return;
    if (nextOne) {
      s = (nextOne === 'u' ? s[0].toUpperCase() : s[0].toLowerCase()) + s.slice(1);
      nextOne = null;
    }
    if (caseMode === 'U') s = s.toUpperCase();
    else if (caseMode === 'L') s = s.toLowerCase();
    out += s;
  };
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    if (c === '\\' && i + 1 < template.length) {
      const n = template[i + 1];
      if (n === 'n') emit('\n');
      else if (n === 't') emit('\t');
      else if (n === '\\') emit('\\');
      else if (n === 'U' || n === 'L') caseMode = n;
      else if (n === 'E') caseMode = null;
      else if (n === 'u' || n === 'l') nextOne = n;
      else {
        emit(c);
        continue;
      }
      i++;
      continue;
    }
    if (c === '$' && i + 1 < template.length) {
      const n = template[i + 1];
      if (n === '$') {
        emit('$');
        i++;
        continue;
      }
      if (n === '&') {
        emit(m[0]);
        i++;
        continue;
      }
      if (n === '<') {
        const close = template.indexOf('>', i + 2);
        const name = close > 0 ? template.slice(i + 2, close) : '';
        if (name && m.groups && name in m.groups) {
          emit(m.groups[name] ?? '');
          i = close;
          continue;
        }
      }
      if (/\d/.test(n)) {
        // prefer two-digit group if it exists ($12), else one digit
        const two = template.slice(i + 1, i + 3);
        if (/^\d\d$/.test(two) && Number(two) < m.length) {
          emit(m[Number(two)] ?? '');
          i += 2;
          continue;
        }
        if (Number(n) < m.length && n !== '0') {
          emit(m[Number(n)] ?? '');
          i++;
          continue;
        }
      }
    }
    emit(c);
  }
  return out;
}

function execAt(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  const m = re.exec(text);
  return m && m.index === at ? m : null;
}

/** Edits to apply to `content`. `onlyLines` restricts to hits starting on those 0-based lines. */
export function planReplace(path: string, content: string, query: string, opts: SearchOptions, replacement: string, onlyLines?: number[]): ReplacePlan {
  const literal = !opts.regex;
  const eng = new SearchEngine();
  const r = eng.matchDoc(path, content, query, { ...opts, literal, fuzzy: false });
  if (r.error) return { edits: [], error: r.error };
  const ls = computeLineStarts(content);
  const only = onlyLines ? new Set(onlyLines) : null;
  const re = r.atom?.kind === 'regex' ? compileRegex(r.atom as RegexAtom) : null;
  const edits: ReplaceEdit[] = [];
  for (const h of r.hits) {
    const line = lineOfOffset(ls, h.start);
    if (only && !only.has(line)) continue;
    const insert = re ? expandReplacement(replacement, execAt(re, content, h.start)) : replacement;
    edits.push({ from: h.start, to: h.end, insert, line });
  }
  return { edits };
}

export function applyEdits(content: string, edits: Array<{ from: number; to: number; insert: string }>): string {
  const sorted = [...edits].sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const e of sorted) {
    if (e.from < pos) continue; // overlapping — skip
    out += content.slice(pos, e.from) + e.insert;
    pos = e.to;
  }
  return out + content.slice(pos);
}

/** Preview of one result line after replacement (regex groups evaluated against the line). */
export function previewLine(lineText: string, ranges: MatchRange[], query: string, opts: SearchOptions, replacement: string): Array<{ text: string; kind: 'keep' | 'del' | 'ins' }> {
  const parts: Array<{ text: string; kind: 'keep' | 'del' | 'ins' }> = [];
  let re: RegExp | null = null;
  if (opts.regex) {
    const pq = parseQuery(query, { regex: true, caseSensitive: opts.caseSensitive ?? 'smart' });
    const a = pq.clauses[0]?.atoms[0];
    if (a?.kind === 'regex' && !pq.error) re = compileRegex(a);
  }
  let pos = 0;
  for (const r of ranges) {
    if (r.start < pos) continue;
    if (r.start > pos) parts.push({ text: lineText.slice(pos, r.start), kind: 'keep' });
    const old = lineText.slice(r.start, r.end);
    parts.push({ text: old, kind: 'del' });
    const ins = re ? expandReplacement(replacement, execAt(re, lineText, r.start)) : replacement;
    if (ins) parts.push({ text: ins, kind: 'ins' });
    pos = r.end;
  }
  if (pos < lineText.length) parts.push({ text: lineText.slice(pos), kind: 'keep' });
  return parts;
}
