// Outline entries for "go to heading/symbol in file": Markdown headings, or a cheap regex-based
// symbol scan for code files (functions, classes, methods…). Pure.
import { isMarkdown } from '@shared/paths';
import { parseStructure } from './markdown';

export interface OutlineItem {
  line: number;
  level: number; // heading level, or 1 for top-level symbols / 2 for indented members
  text: string;
  kind: 'heading' | 'symbol';
  detail?: string; // e.g. 'function', 'class'
}

const SYMBOL_RES: Array<[RegExp, string]> = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+|final\s+)?(class|interface|trait|enum|struct|type)\s+([A-Za-z_$][\w$]*)/, '$1'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  // PHP. Each modifier takes its own blank: `\s*` next to `(…|\s)*` was ambiguous (quadratic on a line of spaces).
  [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?\s*([A-Za-z_]\w*)/, 'function'],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'def'], // Python
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, 'fn'], // Rust
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'func'], // Go
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, 'function'],
  [/^\s*(?:CREATE|create)\s+(?:OR\s+REPLACE\s+|or\s+replace\s+)?(?:TABLE|VIEW|FUNCTION|PROCEDURE|INDEX|table|view|function|procedure|index)\s+(?:IF\s+NOT\s+EXISTS\s+|if\s+not\s+exists\s+)?([\w."`]+)/, 'sql'],
];

export function outline(path: string, content: string): OutlineItem[] {
  if (isMarkdown(path)) {
    return parseStructure(path, content).headings.filter((h) => h.text).map((h) => ({ line: h.line, level: h.level, text: h.text, kind: 'heading' as const }));
  }
  const out: OutlineItem[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && out.length < 2000; i++) {
    const l = lines[i];
    if (l.length > 400) continue;
    for (const [re, kind] of SYMBOL_RES) {
      const m = re.exec(l);
      if (!m) continue;
      const name = m[2] ?? m[1];
      const detail = kind === '$1' ? m[1] : kind;
      if (/^(if|for|while|switch|return|catch)$/.test(name)) break;
      out.push({ line: i, level: /^\s/.test(l) ? 2 : 1, text: name, kind: 'symbol', detail });
      break;
    }
  }
  return out;
}
