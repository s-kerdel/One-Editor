// variables.md parser (pure, unit-tested). The data is the first ```yaml fence of the note (YAML
// frontmatter as a fallback). Schema:
//   vars:    { name: value }
//   targets: { DC01: { ip: 10.0.0.10, user: administrator, os: windows } }
//   envs:    { lab: { vars: {...}, targets: {...}, secrets: [...] } }
//   secrets: [db_pass, DC01.password, password]   ← values live in the vault, never in the file
// Every definition keeps its value's offsets in the file, so click-to-edit can rewrite just that value.
// Never throws: bad input yields diagnostics (the caller keeps the last good parse).
import { parseDocument, isMap, isScalar, isSeq, type Document, type Node as YNode, type Pair, type YAMLMap } from 'yaml';

export interface Diagnostic {
  from: number;
  to: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

export interface VarDef {
  name: string;
  /** null = no value in the file (secret without a value, `vault` placeholder, empty). */
  value: string | null;
  secret: boolean;
  /** Explicit `vault:<key>`; null = default key (see vaultKeyFor in resolve.ts). */
  vaultKey: string | null;
  /** YAML path of the value, e.g. ['envs', 'lab', 'vars', 'ns'] or ['targets', 'DC01', 'ip']. */
  path: string[];
  /** Offsets of the value node in the whole file text (null when the value is absent). */
  loc: { from: number; to: number } | null;
  env: string | null;
  target: string | null;
}

export interface TargetDef {
  name: string;
  fields: Map<string, VarDef>;
}

export interface EnvDef {
  name: string;
  vars: Map<string, VarDef>;
  targets: Map<string, TargetDef>;
}

export interface YamlRegion {
  /** Offsets of the YAML text inside the file (fence body / frontmatter body). */
  from: number;
  to: number;
  kind: 'fence' | 'frontmatter';
}

export interface VarsFile {
  path: string;
  vars: Map<string, VarDef>;
  targets: Map<string, TargetDef>;
  envs: Map<string, EnvDef>;
  diagnostics: Diagnostic[];
  region: YamlRegion | null;
  /** false = YAML syntax errors: the caller should fall back to its last good parse. */
  ok: boolean;
}

export interface NoteMeta {
  vars: Map<string, VarDef>;
  target: string | null;
  env: string | null;
  region: YamlRegion | null;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*(yaml|yml)\b[^\n`]*$/i;
const VAULT_REF = /^(?:vault(?::(.+))?|🔒|\*{3,}|•{3,})$/u;
const KNOWN_TOP = new Set(['vars', 'targets', 'envs', 'secrets']);
const KNOWN_ENV = new Set(['vars', 'targets', 'secrets']);

/** Where the YAML data of a variables note is: the first ```yaml fence, else the frontmatter. */
export function findYamlRegion(text: string): YamlRegion | null {
  // Other fenced blocks are skipped whole, so a ```yaml shown inside a ````markdown example is not picked up.
  let fence: { close: RegExp; yaml: boolean; from: number } | null = null;
  for (let pos = 0; pos <= text.length; ) {
    const nl = text.indexOf('\n', pos);
    const end = nl < 0 ? text.length : nl;
    const line = text.slice(pos, end).replace(/\r$/, '');
    const next = nl < 0 ? text.length + 1 : nl + 1;
    if (fence) {
      if (fence.close.test(line)) {
        if (fence.yaml) return { from: fence.from, to: pos, kind: 'fence' };
        fence = null;
      }
    } else {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) fence = { close: new RegExp(`^ {0,3}\\${m[1][0]}{${m[1].length},}[ \\t]*$`), yaml: FENCE_OPEN.test(line), from: Math.min(next, text.length) };
    }
    pos = next;
  }
  if (fence?.yaml) return { from: fence.from, to: text.length, kind: 'fence' }; // unclosed: up to the end
  return frontmatterRegion(text);
}

/** Body of a leading `---` frontmatter block. */
export function frontmatterRegion(text: string): YamlRegion | null {
  if (!/^---[ \t]*\r?\n/.test(text)) return null;
  const start = text.indexOf('\n') + 1;
  const m = /^(?:---|\.\.\.)[ \t]*$/m.exec(text.slice(start));
  if (!m) return null;
  return { from: start, to: start + m.index, kind: 'frontmatter' };
}

/** Scalar → string; null for empty/null. Maps and lists are not values. */
function scalarText(node: unknown): string | null | undefined {
  if (node == null) return null;
  if (!isScalar(node)) return undefined;
  const v = node.value;
  if (v === null || v === undefined || v === '') return null;
  return typeof v === 'string' ? v : String(v);
}

interface Ctx {
  base: number;
  diags: Diagnostic[];
}

const rangeOf = (ctx: Ctx, n: { range?: [number, number, number] | null } | null | undefined): { from: number; to: number } | null =>
  n?.range ? { from: ctx.base + n.range[0], to: ctx.base + n.range[1] } : null;

function diag(ctx: Ctx, n: YNode | Pair | null | undefined, severity: Diagnostic['severity'], message: string) {
  const r = n && 'range' in n ? rangeOf(ctx, n as YNode) : n && 'key' in n ? rangeOf(ctx, (n as Pair).key as YNode) : null;
  ctx.diags.push({ from: r?.from ?? ctx.base, to: r?.to ?? ctx.base, severity, message });
}

/** Unique pairs of a map (first wins; duplicates get a warning). */
function pairs(ctx: Ctx, map: YAMLMap, where: string): Array<{ key: string; pair: Pair }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; pair: Pair }> = [];
  for (const pair of map.items) {
    const k = isScalar(pair.key) ? String(pair.key.value ?? '') : null;
    if (k === null || k === '') {
      diag(ctx, pair, 'error', `${where}: keys must be plain names`);
      continue;
    }
    if (seen.has(k)) {
      diag(ctx, pair, 'warning', `Duplicate “${k}” in ${where}: the first one is used`);
      continue;
    }
    seen.add(k);
    out.push({ key: k, pair });
  }
  return out;
}

function asMap(ctx: Ctx, node: unknown, pair: Pair, what: string): YAMLMap | null {
  if (node == null || (isScalar(node) && node.value == null)) return null;
  if (isMap(node)) return node;
  diag(ctx, pair, 'error', `${what} must be a map (name: value)`);
  return null;
}

function varDef(ctx: Ctx, name: string, pair: Pair, path: string[], env: string | null, target: string | null): VarDef | null {
  const text = scalarText(pair.value);
  if (text === undefined) {
    diag(ctx, pair, 'error', `“${name}” must be a single value (text or number), not a list or map`);
    return null;
  }
  const ref = text !== null ? VAULT_REF.exec(text.trim()) : null;
  return {
    name,
    value: ref ? null : text,
    secret: !!ref,
    vaultKey: ref?.[1]?.trim() || null,
    path,
    loc: rangeOf(ctx, pair.value as YNode) ?? null,
    env,
    target,
  };
}

function readVars(ctx: Ctx, map: YAMLMap | null, prefix: string[], env: string | null): Map<string, VarDef> {
  const out = new Map<string, VarDef>();
  if (!map) return out;
  for (const { key, pair } of pairs(ctx, map, prefix.join('.'))) {
    if (!/^[A-Za-z_][\w-]*$/.test(key)) diag(ctx, pair, 'warning', `“${key}” can’t be used as {{${key}}}: use letters, digits, _ or -`);
    const d = varDef(ctx, key, pair, [...prefix, key], env, null);
    if (d) out.set(key, d);
  }
  return out;
}

function readTargets(ctx: Ctx, map: YAMLMap | null, prefix: string[], env: string | null): Map<string, TargetDef> {
  const out = new Map<string, TargetDef>();
  if (!map) return out;
  for (const { key, pair } of pairs(ctx, map, prefix.join('.'))) {
    const fieldsMap = asMap(ctx, pair.value, pair, `Target “${key}”`);
    const fields = new Map<string, VarDef>();
    if (fieldsMap) {
      for (const f of pairs(ctx, fieldsMap, `${prefix.join('.')}.${key}`)) {
        const d = varDef(ctx, f.key, f.pair, [...prefix, key, f.key], env, key);
        if (d) fields.set(f.key, d);
      }
    }
    out.set(key, { name: key, fields });
  }
  return out;
}

function readSecrets(ctx: Ctx, node: unknown, pair: Pair): string[] {
  if (node == null) return [];
  const items = isSeq(node) ? node.items : isScalar(node) ? [node] : null;
  if (!items) {
    diag(ctx, pair, 'error', 'secrets must be a list of names, e.g. [db_pass, DC01.password]');
    return [];
  }
  const out: string[] = [];
  for (const it of items) {
    const s = scalarText(it);
    if (typeof s === 'string' && s.trim()) out.push(...s.split(/[\s,]+/).filter(Boolean));
    else diag(ctx, it as YNode, 'error', 'secrets: each entry must be a name');
  }
  return out;
}

function markSecret(ctx: Ctx, d: VarDef) {
  // A plain-text value still works (masked everywhere), but the file is the wrong place for it.
  if (d.value !== null && !d.secret && d.loc) ctx.diags.push({ ...d.loc, severity: 'warning', message: `“${d.name}” is a secret but its value is written here. Replace it with “vault” and set it from the app` });
  d.secret = true;
}

/** Marks defs listed in `secrets` (name, TARGET.field, or a field name of every target); unknown plain names become value-less vars. */
function applySecrets(ctx: Ctx, names: string[], vars: Map<string, VarDef>, targets: Map<string, TargetDef>, prefix: string[], env: string | null) {
  for (const raw of names) {
    const dot = raw.indexOf('.');
    if (dot > 0) {
      const t = [...targets.values()].find((x) => x.name.toLowerCase() === raw.slice(0, dot).toLowerCase());
      const field = raw.slice(dot + 1);
      const d = t?.fields.get(field);
      if (d) markSecret(ctx, d);
      else if (t) t.fields.set(field, { name: field, value: null, secret: true, vaultKey: null, path: [...prefix, 'targets', t.name, field], loc: null, env, target: t.name });
      continue;
    }
    let hit = false;
    for (const d of [vars.get(raw), ...[...targets.values()].map((t) => t.fields.get(raw))]) {
      if (d) markSecret(ctx, d), (hit = true);
    }
    if (!hit) vars.set(raw, { name: raw, value: null, secret: true, vaultKey: null, path: [...prefix, 'vars', raw], loc: null, env, target: null });
  }
}

function emptyFile(path: string, region: YamlRegion | null, diags: Diagnostic[], ok: boolean): VarsFile {
  return { path, vars: new Map(), targets: new Map(), envs: new Map(), diagnostics: diags, region, ok };
}

function parseRegion(text: string, region: YamlRegion): { doc: Document; ctx: Ctx } {
  const ctx: Ctx = { base: region.from, diags: [] };
  const doc = parseDocument(text.slice(region.from, region.to), { uniqueKeys: false, prettyErrors: false });
  for (const e of [...doc.errors, ...doc.warnings]) {
    const [a, b] = e.pos ?? [0, 0];
    ctx.diags.push({ from: region.from + a, to: region.from + Math.max(a + 1, b), severity: doc.errors.includes(e as never) ? 'error' : 'warning', message: e.message.split('\n')[0] });
  }
  return { doc, ctx };
}

/** Parses a variables note. `text` is the whole file. */
export function parseVariablesFile(path: string, text: string): VarsFile {
  const region = findYamlRegion(text);
  if (!region) return emptyFile(path, null, [], true);
  let parsed: ReturnType<typeof parseRegion>;
  try {
    parsed = parseRegion(text, region);
  } catch (err) {
    return emptyFile(path, region, [{ from: region.from, to: region.to, severity: 'error', message: String((err as Error)?.message ?? err) }], false);
  }
  const { doc, ctx } = parsed;
  if (doc.errors.length) return emptyFile(path, region, ctx.diags, false);
  const root = doc.contents;
  if (root == null || (isScalar(root) && root.value == null)) return emptyFile(path, region, ctx.diags, true);
  if (!isMap(root)) {
    diag(ctx, root as YNode, 'error', 'variables must be a YAML map with vars / targets / envs / secrets');
    return emptyFile(path, region, ctx.diags, true);
  }
  const file = emptyFile(path, region, ctx.diags, true);
  let secrets: string[] = [];
  const envSecrets = new Map<string, string[]>();
  for (const { key, pair } of pairs(ctx, root, 'the file')) {
    if (!KNOWN_TOP.has(key)) {
      diag(ctx, pair, 'warning', `Unknown key “${key}” (expected vars, targets, envs or secrets)`);
      continue;
    }
    if (key === 'vars') file.vars = readVars(ctx, asMap(ctx, pair.value, pair, 'vars'), ['vars'], null);
    else if (key === 'targets') file.targets = readTargets(ctx, asMap(ctx, pair.value, pair, 'targets'), ['targets'], null);
    else if (key === 'secrets') secrets = readSecrets(ctx, pair.value, pair);
    else {
      const envs = asMap(ctx, pair.value, pair, 'envs');
      for (const e of envs ? pairs(ctx, envs, 'envs') : []) {
        const em = asMap(ctx, e.pair.value, e.pair, `Environment “${e.key}”`);
        const env: EnvDef = { name: e.key, vars: new Map(), targets: new Map() };
        for (const sub of em ? pairs(ctx, em, `envs.${e.key}`) : []) {
          if (!KNOWN_ENV.has(sub.key)) diag(ctx, sub.pair, 'warning', `Unknown key “${sub.key}” in envs.${e.key} (expected vars, targets or secrets)`);
          else if (sub.key === 'vars') env.vars = readVars(ctx, asMap(ctx, sub.pair.value, sub.pair, `envs.${e.key}.vars`), ['envs', e.key, 'vars'], e.key);
          else if (sub.key === 'targets') env.targets = readTargets(ctx, asMap(ctx, sub.pair.value, sub.pair, `envs.${e.key}.targets`), ['envs', e.key, 'targets'], e.key);
          else envSecrets.set(e.key, readSecrets(ctx, sub.pair.value, sub.pair));
        }
        file.envs.set(e.key, env);
      }
    }
  }
  // Top-level secrets apply everywhere (inside environments too); an environment's own list only there.
  applySecrets(ctx, secrets, file.vars, file.targets, [], null);
  for (const env of file.envs.values()) {
    applySecrets(ctx, envSecrets.get(env.name) ?? [], env.vars, env.targets, ['envs', env.name], env.name);
    for (const d of [...env.vars.values(), ...[...env.targets.values()].flatMap((t) => [...t.fields.values()])]) {
      if (!d.secret && secrets.some((n) => n === d.name || (d.target && n.toLowerCase() === `${d.target}.${d.name}`.toLowerCase()))) markSecret(ctx, d);
    }
  }
  return file;
}

/** The note's own frontmatter: `vars:` map, `target:` and `env:` (the note always wins over variables.md). */
export function parseNoteMeta(text: string): NoteMeta | null {
  const region = frontmatterRegion(text);
  if (!region || !/(^|\n)(vars|target|env)[ \t]*:/.test(text.slice(region.from, region.to))) return null;
  let parsed: ReturnType<typeof parseRegion>;
  try {
    parsed = parseRegion(text, region);
  } catch {
    return null;
  }
  const { doc, ctx } = parsed;
  if (doc.errors.length || !isMap(doc.contents)) return null;
  const meta: NoteMeta = { vars: new Map(), target: null, env: null, region };
  for (const { key, pair } of pairs(ctx, doc.contents, 'frontmatter')) {
    if (key === 'vars') meta.vars = readVars(ctx, isMap(pair.value) ? pair.value : null, ['vars'], null);
    else if (key === 'target' || key === 'env') {
      const v = scalarText(pair.value);
      if (typeof v === 'string' && v.trim()) meta[key] = v.trim();
    }
  }
  return meta;
}
