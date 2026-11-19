// Frontmatter properties model: a deliberately small YAML subset (what Obsidian's properties editor
// writes: scalars, flow `[a, b]` and block `- a` lists). Edits rewrite only the lines of the property
// that changed, so comments, ordering and formatting of everything else survive untouched.
// Anything richer (nested maps, block scalars, anchors) is reported as `complex` and left alone.
// Pure (no DOM) → unit tested in Node.

export type PropType = 'text' | 'number' | 'checkbox' | 'date' | 'datetime' | 'list' | 'tags' | 'complex' | 'empty';
export type PropValue = string | number | boolean | string[] | null;

export interface Prop {
  key: string;
  type: PropType;
  value: PropValue;
  /** Line range [start, end) within the YAML body. */
  start: number;
  end: number;
  /** List written in flow style (`[a, b]`). */
  flow?: boolean;
  /** Raw value text (for complex values / display). */
  raw: string;
}

export interface ParsedProps {
  props: Prop[];
  /** False when the YAML has lines this model doesn't understand (the widget then shows raw YAML). */
  ok: boolean;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"\-?:,[\]{}&*!|>%@`][^:]*?|-[^\s:][^:]*?|\?[^\s:][^:]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const NUMBER_RE = /^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const RESERVED_RE = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
export const TAG_KEYS = new Set(['tags', 'tag']);
export const LIST_KEYS = new Set(['aliases', 'alias', 'cssclasses', 'cssclass']);

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_m, e: string) => {
      if (e[0] === 'x' || e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16));
      return ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' } as Record<string, string>)[e] ?? e;
    });
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Strips a trailing ` # comment` from an unquoted scalar. */
function stripComment(s: string): string {
  const i = s.search(/\s#/);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/** Splits a one-line flow sequence body ("a, 'b, c', \"d\"") respecting quotes. Null when malformed/nested. */
function splitFlow(inner: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (q) {
      cur += c;
      if (q === '"' && c === '\\') cur += inner[++i] ?? '';
      else if (c === q) {
        if (q === "'" && inner[i + 1] === "'") cur += inner[++i];
        else q = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      if (cur.trim()) return null; // quote in the middle of a plain scalar
      q = c;
      cur = c;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else if (c === '[' || c === ']' || c === '{' || c === '}') return null;
    else cur += c;
  }
  if (q) return null;
  if (cur.trim()) out.push(cur.trim());
  return out.map((x) => unquote(x));
}

function scalarType(plain: string): { type: PropType; value: PropValue } {
  if (plain === '' || plain === '~' || /^null$/i.test(plain)) return { type: 'empty', value: null };
  if (/^(true|false)$/i.test(plain)) return { type: 'checkbox', value: plain.toLowerCase() === 'true' };
  if (NUMBER_RE.test(plain) && !/^[-+]?0\d/.test(plain)) return { type: 'number', value: Number(plain) };
  if (DATE_RE.test(plain)) return { type: 'date', value: plain };
  if (DATETIME_RE.test(plain)) return { type: 'datetime', value: plain };
  return { type: 'text', value: plain };
}

/** Parses the text between the `---` fences. */
export function parseProps(body: string): ParsedProps {
  const lines = body.split('\n');
  const props: Prop[] = [];
  let ok = true;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const m = /^\s/.test(line) ? null : KEY_RE.exec(line);
    if (!m) {
      ok = false;
      i++;
      continue;
    }
    const key = unquote(m[1]);
    const rest = m[2] ?? '';
    // Continuation: indented lines, or "- item" lines directly under an empty `key:` (compact list).
    let j = i + 1;
    let last = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (!l.trim()) {
        j++;
        continue;
      }
      if (/^\s/.test(l) || (rest === '' && /^-(\s|$)/.test(l))) {
        j++;
        last = j;
        continue;
      }
      break;
    }
    const cont = lines.slice(i + 1, last);
    const raw = [rest, ...cont].join('\n');
    const prop: Prop = { key, type: 'text', value: null, start: i, end: last, raw };
    const lower = key.toLowerCase();
    if (rest.startsWith('[')) {
      const close = rest.lastIndexOf(']');
      const items = cont.length === 0 && close > 0 && !stripComment(rest.slice(close + 1)) ? splitFlow(rest.slice(1, close)) : null;
      if (items) Object.assign(prop, { type: TAG_KEYS.has(lower) ? 'tags' : 'list', value: items, flow: true });
      else prop.type = 'complex';
    } else if (rest === '' && cont.length) {
      const items: string[] = [];
      let simple = true;
      for (const c of cont) {
        if (!c.trim()) continue;
        const im = /^\s*-(?:[ \t]+(.*?))?[ \t]*$/.exec(c);
        if (!im || /^[[{]/.test(im[1] ?? '') || KEY_RE.test(im[1] ?? '') || /^[|>]/.test(im[1] ?? '')) {
          simple = false;
          break;
        }
        const v = im[1] ?? '';
        items.push(/^["']/.test(v) ? unquote(v) : stripComment(v));
      }
      if (simple) Object.assign(prop, { type: TAG_KEYS.has(lower) ? 'tags' : 'list', value: items });
      else prop.type = 'complex';
    } else if (rest === '') {
      Object.assign(prop, { type: TAG_KEYS.has(lower) ? 'tags' : LIST_KEYS.has(lower) ? 'list' : 'empty', value: TAG_KEYS.has(lower) || LIST_KEYS.has(lower) ? [] : null });
    } else if (/^[|>{&*!]/.test(rest) || cont.length) {
      prop.type = 'complex';
    } else if (/^["']/.test(rest)) {
      const q = rest[0];
      const endQ = q === '"' ? /^"(?:[^"\\]|\\.)*"/.exec(rest) : /^'(?:[^']|'')*'/.exec(rest);
      if (!endQ || stripComment(rest.slice(endQ[0].length))) prop.type = 'complex';
      else {
        const v = unquote(endQ[0]);
        if (TAG_KEYS.has(lower)) Object.assign(prop, { type: 'tags', value: splitTags(v) });
        else if (LIST_KEYS.has(lower)) Object.assign(prop, { type: 'list', value: [v] });
        else Object.assign(prop, { type: 'text', value: v });
      }
    } else {
      const plain = stripComment(rest);
      if (TAG_KEYS.has(lower)) Object.assign(prop, { type: 'tags', value: splitTags(plain) });
      else if (LIST_KEYS.has(lower)) Object.assign(prop, { type: 'list', value: plain ? [plain] : [] });
      else Object.assign(prop, scalarType(plain));
    }
    props.push(prop);
    i = last;
  }
  return { props, ok };
}

function splitTags(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, ''))
    .filter(Boolean);
}

/** YAML scalar for a string value, quoted only when a plain scalar would change meaning. */
export function formatScalar(s: string, flow = false): string {
  if (s === '') return '""';
  const needs =
    /^\s|\s$/.test(s) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:(\s|$)|\s#/.test(s) ||
    RESERVED_RE.test(s) ||
    NUMBER_RE.test(s) ||
    /^[-+]?0\d/.test(s) ||
    DATE_RE.test(s) ||
    DATETIME_RE.test(s) ||
    /[\u0000-\u001f\u007f\u2028\u2029\ufeff]/.test(s) ||
    (flow && /[,[\]{}]/.test(s));
  if (!needs) return s;
  return '"' + s.replace(/[\\"\u0000-\u001f\u007f\u2028\u2029\ufeff]/g, (c) => {
    const map: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\t': '\\t', '\r': '\\r' };
    return map[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  }) + '"';
}

export function formatKey(k: string): string {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_ .\-/]*$/u.test(k) && !/\s$/.test(k) && !RESERVED_RE.test(k) ? k : formatScalar(k);
}

/** Lines for one property. Typed values keep their YAML type (number/bool/date are written plain). */
export function propLines(key: string, value: PropValue, opts: { flow?: boolean; type?: PropType } = {}): string[] {
  const k = formatKey(key);
  if (value === null || value === '') return [`${k}:`];
  if (Array.isArray(value)) {
    if (!value.length) return [`${k}: []`];
    if (opts.flow) return [`${k}: [${value.map((v) => formatScalar(v, true)).join(', ')}]`];
    return [`${k}:`, ...value.map((v) => `  - ${formatScalar(v)}`)];
  }
  if (typeof value === 'boolean') return [`${k}: ${value}`];
  if (typeof value === 'number') return [`${k}: ${Number.isFinite(value) ? String(value) : formatScalar(String(value))}`];
  if ((opts.type === 'date' && DATE_RE.test(value)) || (opts.type === 'datetime' && DATETIME_RE.test(value))) return [`${k}: ${value}`];
  return [`${k}: ${formatScalar(value)}`];
}

function trimTrailingBlank(lines: string[]): number {
  let n = lines.length;
  while (n > 0 && !lines[n - 1].trim()) n--;
  return n;
}

/** Sets (or appends) `key`. Other lines are untouched. */
export function setProp(body: string, key: string, value: PropValue, opts: { flow?: boolean; type?: PropType } = {}): string {
  const lines = body === '' ? [] : body.split('\n');
  const { props } = parseProps(body);
  const p = props.find((x) => x.key === key);
  const out = propLines(key, value, { flow: opts.flow ?? p?.flow, type: opts.type ?? p?.type });
  if (p) lines.splice(p.start, p.end - p.start, ...out);
  else lines.splice(trimTrailingBlank(lines), 0, ...out);
  return lines.join('\n');
}

export function removeProp(body: string, key: string): string {
  const lines = body.split('\n');
  const p = parseProps(body).props.find((x) => x.key === key);
  if (!p) return body;
  lines.splice(p.start, p.end - p.start);
  return lines.join('\n');
}

/** Renames a key in place, keeping its value text exactly as written. */
export function renameProp(body: string, from: string, to: string): string {
  if (from === to) return body;
  const lines = body.split('\n');
  const p = parseProps(body).props.find((x) => x.key === from);
  if (!p) return body;
  const m = KEY_RE.exec(lines[p.start]);
  if (!m) return body;
  const colon = lines[p.start].indexOf(':', m[1].length);
  lines[p.start] = formatKey(to) + lines[p.start].slice(colon);
  return lines.join('\n');
}

/** Value typed by the user into a text field → a typed value for `type`. */
export function coerce(input: string, type: PropType): PropValue {
  const s = input.trim();
  if (type === 'number') return s === '' ? null : NUMBER_RE.test(s) ? Number(s) : s;
  if (type === 'checkbox') return /^(true|1|yes|on)$/i.test(s);
  if (type === 'list' || type === 'tags') return s.split(',').map((x) => x.trim().replace(type === 'tags' ? /^#/ : /^$/, '')).filter(Boolean);
  return input === '' ? null : input;
}

/** Guess a type for a brand-new property from its name (Obsidian defaults) and value. */
export function typeForNewKey(key: string): PropType {
  const k = key.toLowerCase();
  if (TAG_KEYS.has(k)) return 'tags';
  if (LIST_KEYS.has(k)) return 'list';
  if (/^(date|created|updated|modified|due|deadline|published)$/.test(k)) return 'date';
  if (/^(done|draft|publish|completed|archived)$/.test(k)) return 'checkbox';
  return 'text';
}

/** Body of a frontmatter block (`---\n…\n---` at the start of `doc`) and the replaceable region:
 *  [end of the opening fence, start of the closing fence). */
export function frontmatterBody(doc: string): { body: string; from: number; to: number } | null {
  if (!/^---[ \t]*\n/.test(doc)) return null;
  const first = doc.indexOf('\n');
  for (let pos = first + 1; pos <= doc.length; ) {
    const nl = doc.indexOf('\n', pos);
    const end = nl < 0 ? doc.length : nl;
    if (/^(---|\.\.\.)[ \t]*$/.test(doc.slice(pos, end))) return { body: pos - 1 > first ? doc.slice(first + 1, pos - 1) : '', from: first, to: pos };
    if (nl < 0) break;
    pos = nl + 1;
  }
  return null;
}

/** Replacement text for the region returned by frontmatterBody / the syntax tree (end of the opening
 *  fence → start of the closing fence). */
export function bodyReplacement(body: string): string {
  return body === '' ? '\n' : `\n${body}\n`;
}
