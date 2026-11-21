// What is under the cursor for Go to definition: the identifier (language-aware word characters) and
// hints from the text around it — member access (`$this->x`, `self::x`, `this.x`), a receiver
// (`Foo::bar`, `Foo.bar`), type positions (`new X`, `extends X`, `: X`), calls (`x(`). One line, pure.
import { familyOf } from '../symbols';

export interface Ident {
  name: string;
  /** Columns of the name within the line. */
  from: number;
  to: number;
  /** PHP: the qualified name around it (`\App\Models\User` when the cursor is on `User`). */
  qualified?: string;
}

export type Want = 'class' | 'callable' | 'method' | 'property' | 'member' | 'mixin' | 'any';

export interface Hint {
  /** member = `->x` / `.x` / `self::x`; plain = a bare name. */
  mode: 'member' | 'plain';
  /** 'this' | 'super' (parent::, super.) | a written receiver name | '' (an expression we can't type). */
  receiver?: string;
  want: Want;
  call: boolean;
  /** The line is an import statement (PHP `use`, JS `import`, Python `from … import`). */
  importLine: boolean;
}

const isWordCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127;

function wordTest(lang: string): (ch: string) => boolean {
  const fam = familyOf(lang);
  if (fam === 'css') return (ch) => isWordCode(ch.charCodeAt(0)) || ch === '-';
  if (lang === 'shell') return (ch) => isWordCode(ch.charCodeAt(0)) || ch === '-';
  if (fam === 'php') return (ch) => isWordCode(ch.charCodeAt(0));
  return (ch) => isWordCode(ch.charCodeAt(0)) || ch === '$';
}

/** The identifier at `col` (or ending right before it). null on blanks, punctuation and numbers. */
export function identAt(line: string, col: number, lang: string): Ident | null {
  const w = wordTest(lang);
  let at = Math.min(Math.max(0, col), line.length);
  if (line[at] === '$' && familyOf(lang) === 'php' && at + 1 < line.length && w(line[at + 1])) at++; // on the sigil of `$name`
  if (!(at < line.length && w(line[at])) && at > 0 && w(line[at - 1])) at--;
  if (at >= line.length || !w(line[at])) return null;
  let from = at;
  let to = at + 1;
  while (from > 0 && w(line[from - 1])) from--;
  while (to < line.length && w(line[to])) to++;
  const fam = familyOf(lang);
  // Sigils that belong to the name: SCSS `$x`, Less `@x`, JS `#private`.
  if (from > 0 && ((fam === 'css' && (line[from - 1] === '$' || line[from - 1] === '@')) || (fam === 'js' && line[from - 1] === '#'))) from--;
  let name = line.slice(from, to);
  if (fam === 'css' && name.startsWith('-') && !name.startsWith('--')) name = name.replace(/^-+/, '');
  if (!name || /^[\d$#@-]*$/.test(name) || /^\d/.test(name)) return null;
  const id: Ident = { name, from: to - name.length, to };
  if (fam === 'php') {
    let q = id.from;
    while (q > 0 && (isWordCode(line.charCodeAt(q - 1)) || line[q - 1] === '\\')) q--;
    let e = to;
    while (e < line.length && (line[e] === '\\' || isWordCode(line.charCodeAt(e)))) e++;
    const qual = line.slice(q, e).replace(/\\+$/, '');
    if (qual.includes('\\')) id.qualified = qual;
  }
  return id;
}

const CLASS_BEFORE = /(?:\bnew|\bextends|\bimplements|\binstanceof|\binsteadof|\bcatch\s*\(|\bas|\bsatisfies|\bkeyof|\bthrows|\bimport\s+type|#\[)\s*(?:[\\\w$.]+\s*,\s*)*$/;
const TYPE_BEFORE = /(?:[:<|&?]|\)\s*:|\bis)\s*$/;

/** Context is read this far around the name: hint regexes stay cheap on minified lines. */
const WINDOW = 300;

/** Hints from the text around an identifier. */
export function hintAt(line: string, id: Ident, lang: string): Hint {
  const fam = familyOf(lang);
  const start = id.qualified ? line.lastIndexOf(id.qualified, id.from) : id.from;
  const before = line.slice(Math.max(0, start - WINDOW), Math.max(0, start));
  const after = line.slice(id.to, id.to + WINDOW);
  const call = /^\s*\(/.test(after) || (fam === 'php' && /^\s*\\?[\w\\]*\s*\(/.test(after) && !!id.qualified);
  const trimmed = before.replace(/\s+$/, '');
  const head = line.slice(0, WINDOW);
  const importLine = fam === 'php' ? /^\s*use\s/i.test(head) : fam === 'js' ? /^\s*(?:import\b|export\s.*\bfrom\b)/.test(head) : fam === 'python' ? /^\s*(?:from\s|import\s)/.test(head) : false;
  const h: Hint = { mode: 'plain', want: 'any', call, importLine };

  if (fam === 'php') {
    if (/(?:->|\?->)$/.test(trimmed)) {
      const r = /(\$?[\w]+)\s*\??->$/.exec(trimmed);
      return { ...h, mode: 'member', receiver: r && /^\$this$/i.test(r[1]) ? 'this' : '', want: call ? 'method' : 'property' };
    }
    const st = /(\\?[\w\\]+)\s*::\s*\$?$/.exec(trimmed);
    if (st) {
      const recv = st[1].toLowerCase();
      const receiver = recv === 'self' || recv === 'static' ? 'this' : recv === 'parent' ? 'super' : st[1];
      return { ...h, mode: 'member', receiver, want: call ? 'method' : 'member' };
    }
    if (/^(self|static)$/i.test(id.name) && !id.qualified) return { ...h, mode: 'member', receiver: 'this', want: 'class' };
    if (/^parent$/i.test(id.name) && !id.qualified) return { ...h, mode: 'member', receiver: 'super', want: 'class' };
    if (/^\s*::/.test(after) || /^\s+\$\w/.test(after) || CLASS_BEFORE.test(before) || /(?:^|[(,|?]|\)\s*:)\s*\??$/.test(trimmed) && /^\s*(?:\$|\|)/.test(after)) return { ...h, want: 'class' };
    if (TYPE_BEFORE.test(trimmed) && !call) return { ...h, want: 'class' };
    if (/^\s*use\s/i.test(before) || importLine) return { ...h, want: 'class' };
    return { ...h, want: call ? 'callable' : /^[A-Z]/.test(id.name) ? 'class' : 'any' };
  }

  if (fam === 'css') {
    if (id.name.startsWith('--') || id.name.startsWith('$') || id.name.startsWith('@')) return { ...h, want: 'property' };
    if (/@include\s+$/.test(before)) return { ...h, want: 'mixin' };
    return { ...h, want: call ? 'callable' : 'any' };
  }

  // Dot languages (JS / TS, Python, Java, Go, …).
  const dot = /(?:\?\.|\.)$/.test(trimmed);
  if (dot || (lang === 'lua' && /:$/.test(trimmed)) || (fam === 'c' && /(?:->|::)$/.test(trimmed))) {
    const r = /([\w$]+)\s*(?:\(\s*\))?\s*(?:\?\.|\.|:|->|::)$/.exec(trimmed);
    const w = r?.[1] ?? '';
    const isCallResult = /\)\s*(?:\?\.|\.)$/.test(trimmed);
    let receiver = isCallResult && w !== 'super' ? '' : w;
    if (receiver === 'this' || (fam === 'python' && (receiver === 'self' || receiver === 'cls'))) receiver = 'this';
    else if (receiver === 'super') receiver = 'super';
    return { ...h, mode: 'member', receiver, want: call ? 'method' : 'member' };
  }
  if (CLASS_BEFORE.test(before)) return { ...h, want: 'class' };
  if (fam === 'js' && /<\/?$/.test(trimmed) && /^[A-Z]/.test(id.name)) return { ...h, want: 'any' }; // a JSX component
  if (fam === 'js' && TYPE_BEFORE.test(trimmed) && !call && /^[A-Z]/.test(id.name)) return { ...h, want: 'class' };
  return { ...h, want: call ? 'callable' : 'any' };
}
