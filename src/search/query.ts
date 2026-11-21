// Query language. Designed so that pasted shell commands / code are searched LITERALLY:
//   kubectl get pods -o wide        → 5 literal terms (-o is a short flag, not an exclusion)
//   git push --force-with-lease     → literal (-- never means "exclude")
//   php artisan migrate:fresh       → literal (only known filter keys are filters)
// Operators:  "exact phrase"  -exclude  a OR b  /regex/i  \-literal
// Filters:    path: file: ext: lang: in: tag: case:   (prefix with - to negate, e.g. -path:archive)

export type FilterKey = 'path' | 'file' | 'ext' | 'lang' | 'in' | 'tag' | 'case';
export const FILTER_KEYS: FilterKey[] = ['path', 'file', 'ext', 'lang', 'in', 'tag', 'case'];

export interface Filter {
  key: FilterKey;
  value: string;
  negated: boolean;
}

export interface TextAtom {
  kind: 'text';
  value: string;
  quoted: boolean;
  caseSensitive: boolean;
}

export interface RegexAtom {
  kind: 'regex';
  source: string;
  flags: string; // without g/m (added by the engine)
  caseSensitive: boolean;
}

export type Atom = TextAtom | RegexAtom;

/** OR-group of atoms; the query is the AND of its clauses. */
export interface Clause {
  atoms: Atom[];
  negated: boolean;
}

export interface ParsedQuery {
  raw: string;
  clauses: Clause[];
  filters: Filter[];
  /** Query with filter tokens removed (used for verbatim matching, highlighting, replace). */
  text: string;
  error?: string;
  warnings: string[];
  /** True when the query used operators (quotes, -exclusion, OR, /regex/). */
  hasOperators: boolean;
  /** Effective forced case from opts or a case: filter (undefined = smart per atom). */
  forcedCase?: boolean;
}

export interface ParseOptions {
  /** Whole query (minus filters) is one regex (UI regex toggle). */
  regex?: boolean;
  /** Whole query (minus filters) is one literal string (replace mode). */
  literal?: boolean;
  /** true = case-sensitive, false = insensitive, 'smart'/undefined = sensitive only if the atom has uppercase. */
  caseSensitive?: boolean | 'smart';
  /** No regular expressions at all: `/…/` is plain text and `regex` is ignored (MCP: a client's regex
   *  would run unbounded on this thread). */
  noRegex?: boolean;
}

export const VALID_IN = ['code', 'block', 'fence', 'inline', 'text', 'heading', 'frontmatter', 'fm', 'meta', 'yaml', 'link', 'path'] as const;

const UPPER = /\p{Lu}/u;
const isWs = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

export function hasUpper(s: string): boolean {
  return UPPER.test(s);
}

function regexHasUpper(source: string): boolean {
  // Ignore escapes like \W \S \D \B \p{Lu} which are not literal uppercase letters.
  return UPPER.test(source.replace(/\\[pPu]\{[^}]*\}|\\./g, ''));
}

/** `-x` exclusions vs. literal CLI flags. Literal when it looks like a flag or a number. */
function looksLikeFlag(word: string): boolean {
  // word is WITHOUT the leading '-'
  if (/^[A-Za-z0-9]{1,3}$/.test(word)) return true; // -o -rf -it -la -xvf
  if (/^\d/.test(word)) return true; // -1, -10m
  if (word.includes('=')) return true; // -Dfoo=bar
  if (/^[A-Z]/.test(word) && word.length <= 6) return true; // -Xmx2g, -SkipCheck ... uppercase flags
  return false;
}

interface Tok {
  kind: 'word' | 'phrase' | 'regex';
  value: string;
  flags?: string;
  negated: boolean;
  start: number;
  end: number;
  filter?: FilterKey;
}

const FILTER_RE = /^(path|file|ext|lang|in|tag|case):/i;
const NEG_START = /^[\p{L}\p{N}_"\/]$/u;

function readRegex(q: string, s: number): { source: string; flags: string; end: number } | null {
  // s points at the opening '/'
  let j = s + 1;
  let inClass = false;
  while (j < q.length) {
    const c = q[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
    j++;
  }
  if (j >= q.length || j === s + 1) return null;
  let k = j + 1;
  while (k < q.length && /[a-z]/i.test(q[k])) k++;
  const flags = q.slice(j + 1, k);
  if (!/^[imsuy]*$/.test(flags)) return null;
  if (k < q.length && !isWs(q[k])) return null;
  return { source: q.slice(s + 1, j), flags, end: k };
}

function readPhrase(q: string, s: number): { value: string; end: number } {
  // s points at the opening quote; unterminated phrases run to the end (live typing).
  let out = '';
  let j = s + 1;
  while (j < q.length) {
    const c = q[j];
    if (c === '\\' && (q[j + 1] === '"' || q[j + 1] === '\\')) {
      out += q[j + 1];
      j += 2;
      continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    out += c;
    j++;
  }
  return { value: out, end: j };
}

function tokenize(q: string, noRegex = false): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < q.length) {
    while (i < q.length && isWs(q[i])) i++;
    if (i >= q.length) break;
    const start = i;
    let negated = false;
    let s = i;
    // `-` negates only before a word, quote or regex: `->where()`, `-$x`, `--flag` stay literal.
    if (q[i] === '-' && i + 1 < q.length && NEG_START.test(q[i + 1])) {
      negated = true;
      s = i + 1;
    }
    if (q[s] === '"') {
      const p = readPhrase(q, s);
      toks.push({ kind: 'phrase', value: p.value, negated, start, end: p.end });
      i = p.end;
      continue;
    }
    if (q[s] === '/' && !noRegex) {
      const r = readRegex(q, s);
      if (r) {
        toks.push({ kind: 'regex', value: r.source, flags: r.flags, negated, start, end: r.end });
        i = r.end;
        continue;
      }
    }
    // word (with optional key:"quoted value")
    let j = s;
    const fm = FILTER_RE.exec(q.slice(s, s + 6));
    if (fm && q[s + fm[0].length] === '"') {
      const p = readPhrase(q, s + fm[0].length);
      toks.push({ kind: 'word', value: q.slice(s, s + fm[0].length) + p.value, negated, start, end: p.end, filter: fm[1].toLowerCase() as FilterKey });
      i = p.end;
      continue;
    }
    while (j < q.length && !isWs(q[j])) j++;
    let word = q.slice(s, j);
    const tok: Tok = { kind: 'word', value: word, negated, start, end: j };
    const f = FILTER_RE.exec(word);
    if (f && !/^file:\/\//i.test(word)) tok.filter = f[1].toLowerCase() as FilterKey;
    else if (negated && looksLikeFlag(word)) {
      tok.negated = false;
      tok.value = '-' + word;
    } else if (!negated && word.startsWith('\\') && /^\\[-"\/\\]/.test(word)) {
      tok.value = word.slice(1); // \-foo → literal "-foo"
    }
    toks.push(tok);
    i = j;
  }
  // A lone "-foo" (nothing else to search for) is far more likely a literal than "everything except foo".
  const positives = toks.filter((t) => !t.negated && !t.filter);
  if (!positives.length) {
    for (const t of toks) {
      if (t.negated && !t.filter && t.kind === 'word') {
        t.negated = false;
        t.value = '-' + t.value;
      }
    }
  }
  return toks;
}

function filterValue(tok: Tok): string {
  return tok.value.slice(tok.value.indexOf(':') + 1);
}

function parseCase(v: string): boolean | undefined {
  const s = v.toLowerCase();
  if (['yes', 'y', 'true', 'on', '1', 'sensitive', 'match'].includes(s)) return true;
  if (['no', 'n', 'false', 'off', '0', 'insensitive', 'ignore'].includes(s)) return false;
  return undefined;
}

const SAFE_FILTER_VALUE = /^[^\\()[\]{}|^$+]+$/;

/** Split off filter tokens for regex / literal modes (only whitespace-separated, unambiguous tokens). */
function extractFilters(q: string): { rest: string; filters: Filter[] } {
  const filters: Filter[] = [];
  const parts = q.split(/(\s+)/);
  const keep: string[] = [];
  for (const p of parts) {
    const m = /^(-?)(path|file|ext|lang|in|tag|case):(.+)$/i.exec(p);
    if (m && SAFE_FILTER_VALUE.test(m[3]) && !/^\/\//.test(m[3])) {
      filters.push({ key: m[2].toLowerCase() as FilterKey, value: m[3], negated: m[1] === '-' });
      keep.push(' ');
    } else keep.push(p);
  }
  return { rest: keep.join('').trim(), filters };
}

export function parseQuery(raw: string, opts: ParseOptions = {}): ParsedQuery {
  const warnings: string[] = [];
  let forcedCase: boolean | undefined = opts.caseSensitive === true ? true : opts.caseSensitive === false ? false : undefined;
  const pq: ParsedQuery = { raw, clauses: [], filters: [], text: '', warnings, hasOperators: false };

  const finishFilters = () => {
    for (const f of pq.filters) {
      if (f.key === 'case') {
        const c = parseCase(f.value);
        if (c === undefined) warnings.push(`case: expects yes/no (got "${f.value}")`);
        else if (opts.caseSensitive === undefined || opts.caseSensitive === 'smart') forcedCase = c;
      } else if (f.key === 'in' && !(VALID_IN as readonly string[]).includes(f.value.toLowerCase())) {
        warnings.push(`Unknown in:${f.value} — use in:code, in:text, in:heading, in:frontmatter, in:link`);
      }
    }
    pq.forcedCase = forcedCase;
  };
  const caseFor = (value: string, isRegex = false) => forcedCase ?? (isRegex ? regexHasUpper(value) : hasUpper(value));

  if ((opts.regex && !opts.noRegex) || opts.literal) {
    const ex = extractFilters(raw);
    // Without filters keep the text exactly (a trailing space can matter when replacing).
    const rest = ex.filters.length || !raw.trim() ? ex.rest : raw;
    const filters = ex.filters;
    pq.filters = filters;
    pq.text = rest;
    finishFilters();
    if (!rest) return pq;
    if (opts.regex && !opts.noRegex) {
      const atom: RegexAtom = { kind: 'regex', source: rest, flags: '', caseSensitive: caseFor(rest, true) };
      const err = validateRegex(atom);
      if (err) pq.error = err;
      pq.clauses.push({ atoms: [atom], negated: false });
    } else {
      pq.clauses.push({ atoms: [{ kind: 'text', value: rest, quoted: true, caseSensitive: caseFor(rest) }], negated: false });
    }
    return pq;
  }

  const toks = tokenize(raw, opts.noRegex);
  let text = '';
  let prevEnd = -1;
  for (const t of toks) {
    if (t.filter) {
      const value = filterValue(t);
      if (value) pq.filters.push({ key: t.filter, value, negated: t.negated });
      continue;
    }
    // Tokens that touch in the query stay glued (`-v "$PWD":/app`), or the verbatim match would be lost.
    text += (prevEnd === -1 || t.start === prevEnd ? '' : ' ') + raw.slice(t.start, t.end);
    prevEnd = t.end;
  }
  pq.text = text;
  finishFilters();

  const atomToks = toks.filter((t) => !t.filter);
  for (let i = 0; i < atomToks.length; i++) {
    const t = atomToks[i];
    const isOr = t.kind === 'word' && !t.negated && t.value === 'OR';
    if (isOr && pq.clauses.length && i + 1 < atomToks.length && !pq.clauses[pq.clauses.length - 1].negated && !atomToks[i + 1].negated) {
      const next = atomToks[++i];
      const atom = makeAtom(next, caseFor);
      if (atom) pq.clauses[pq.clauses.length - 1].atoms.push(atom);
      pq.hasOperators = true;
      continue;
    }
    const atom = makeAtom(t, caseFor);
    if (!atom) continue;
    if (t.negated || t.kind !== 'word') pq.hasOperators = true;
    pq.clauses.push({ atoms: [atom], negated: t.negated });
  }
  for (const c of pq.clauses) {
    for (const a of c.atoms) {
      if (a.kind === 'regex') {
        const err = validateRegex(a);
        if (err && !pq.error) pq.error = err;
      }
    }
  }
  return pq;
}

function makeAtom(t: Tok, caseFor: (v: string, isRegex?: boolean) => boolean): Atom | null {
  if (t.kind === 'regex') {
    const explicitI = t.flags!.includes('i');
    return { kind: 'regex', source: t.value, flags: t.flags!.replace(/[gm]/g, ''), caseSensitive: explicitI ? false : caseFor(t.value, true) };
  }
  if (!t.value) return null;
  return { kind: 'text', value: t.value, quoted: t.kind === 'phrase', caseSensitive: caseFor(t.value) };
}

export function validateRegex(a: RegexAtom): string | undefined {
  try {
    compileRegex(a);
    return undefined;
  } catch (err) {
    // V8: "Invalid regular expression: /(x/gim: Unterminated group" → keep only the reason
    return `Invalid regular expression: ${(err as Error).message.replace(/^Invalid regular expression: (\/.*\/[a-z]*: )?/, '')}`;
  }
}

export function compileRegex(a: RegexAtom): RegExp {
  let flags = a.flags.replace(/i/g, '');
  if (!a.caseSensitive) flags += 'i';
  return new RegExp(a.source, flags + 'gm');
}

/** Positive (non-negated) atoms. */
export function positiveAtoms(pq: ParsedQuery): Atom[] {
  return pq.clauses.filter((c) => !c.negated).flatMap((c) => c.atoms);
}

/** One regex that highlights every positive atom (for the editor's in-file highlighting). */
export function highlightPattern(pq: ParsedQuery): { search: string; regexp: boolean; caseSensitive: boolean } | null {
  const atoms = positiveAtoms(pq);
  if (!atoms.length) return null;
  if (atoms.length === 1 && atoms[0].kind === 'text') return { search: atoms[0].value, regexp: false, caseSensitive: atoms[0].caseSensitive };
  const parts = atoms.map((a) => (a.kind === 'regex' ? `(?:${a.source})` : a.value.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&')));
  return { search: parts.join('|'), regexp: true, caseSensitive: atoms.every((a) => a.caseSensitive) };
}

/** Human-readable chips describing how the query was understood. */
export interface QueryChip {
  kind: 'term' | 'phrase' | 'regex' | 'exclude' | 'or' | 'filter' | 'nfilter';
  label: string;
}

export function describeQuery(pq: ParsedQuery): QueryChip[] {
  const out: QueryChip[] = [];
  for (const c of pq.clauses) {
    const label = c.atoms.map((a) => (a.kind === 'regex' ? `/${a.source}/${a.caseSensitive ? '' : 'i'}` : a.quoted ? `"${a.value}"` : a.value)).join(' OR ');
    if (c.negated) out.push({ kind: 'exclude', label });
    else if (c.atoms.length > 1) out.push({ kind: 'or', label });
    else out.push({ kind: c.atoms[0].kind === 'regex' ? 'regex' : (c.atoms[0] as TextAtom).quoted ? 'phrase' : 'term', label });
  }
  for (const f of pq.filters) out.push({ kind: f.negated ? 'nfilter' : 'filter', label: `${f.key}:${f.value}` });
  return out;
}
