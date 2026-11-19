// {{placeholder}} resolution (pure, unit-tested).
// Which value wins — ONE place: lookup() below.
//   1. fence attribute   ```bash {target=WS01 env=lab ns=x}   (that block only)
//   2. the note's frontmatter   vars: / target: / env:
//   3. the nearest variables.md: active target's field → active env's var → top-level var
//   4. built-ins: {{date}} {{time}} {{title}} {{target}} {{env}}  → then {{name:default}}
// {{TARGET.field}} reads that target's row whatever target is active.
import { formatDate } from '../../knowledge/templates';
import type { NoteMeta, VarDef, VarsFile } from './parse';

export const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::([^{}\n]*))?\}\}/g;
export const MASK = '••••';
const BUILTINS = new Set(['date', 'time', 'title', 'target', 'env']);

export interface FenceInfo {
  lang: string;
  target: string | null;
  env: string | null;
  vars: Map<string, string>;
}

export interface Scope {
  /** Nearest variables.md (null = none on the way up). */
  file: VarsFile | null;
  note: NoteMeta | null;
  /** Effective selections (fence > note > status bar). */
  env: string | null;
  target: string | null;
  fence: Map<string, string>;
  builtins: { title: string; now: Date; dateFormat: string; timeFormat: string };
  /** Prefix of default vault keys: identifies the variables.md folder (absolute, so parent/child workspaces agree). */
  vaultScope: string;
}

export type SourceKind = 'fence' | 'note' | 'target' | 'env' | 'file' | 'builtin' | 'default' | 'input';

export interface Lookup {
  name: string;
  /** null = no value (missing, or a secret whose value is only in the vault). */
  value: string | null;
  secret: boolean;
  vaultKey: string | null;
  /** The definition a click-edit rewrites (note frontmatter or variables.md); null for fence / built-in / default. */
  def: VarDef | null;
  kind: SourceKind | null;
  /** variables.md value the note overrides (shown in the hover). */
  shadowed: { value: string | null; secret: boolean; where: string } | null;
}

/** `bash title="x" {target=Linux-WS env=lab ns=foo}` → lang + attributes (target/env select, the rest are vars). */
export function parseFenceInfo(info: string | null | undefined): FenceInfo {
  const raw = (info ?? '').trim();
  const out: FenceInfo = { lang: raw.split(/[\s{]/)[0].toLowerCase(), target: null, env: null, vars: new Map() };
  const braces = /\{([^}]*)\}/.exec(raw);
  if (!braces) return out;
  for (const m of braces[1].matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,}]+))/g)) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key === 'target') out.target = val || null;
    else if (key === 'env') out.env = val || null;
    else out.vars.set(key, val);
  }
  return out;
}

/** Names of the targets visible in `env` (top-level + that environment's own). */
export function targetNames(file: VarsFile | null, env: string | null): string[] {
  if (!file) return [];
  const out = [...file.targets.keys()];
  const own = env ? file.envs.get(env) : undefined;
  for (const k of own?.targets.keys() ?? []) if (!out.some((n) => n.toLowerCase() === k.toLowerCase())) out.push(k);
  return out;
}

export function envNames(file: VarsFile | null): string[] {
  return file ? [...file.envs.keys()] : [];
}

const findCI = <T>(m: Map<string, T> | undefined, k: string): T | undefined => {
  if (!m) return undefined;
  const hit = m.get(k);
  if (hit !== undefined) return hit;
  const lk = k.toLowerCase();
  for (const [key, v] of m) if (key.toLowerCase() === lk) return v;
  return undefined;
};

/** A target's fields in `env`: the environment's row overrides the top-level row field by field. */
export function targetFields(file: VarsFile | null, env: string | null, name: string): Map<string, VarDef> | null {
  if (!file) return null;
  const top = findCI(file.targets, name);
  const own = env ? findCI(file.envs.get(env)?.targets, name) : undefined;
  if (!top && !own) return null;
  const out = new Map(top?.fields ?? []);
  for (const [k, v] of own?.fields ?? []) out.set(k, v);
  return out;
}

export function vaultKeyFor(def: VarDef, vaultScope: string): string {
  if (def.vaultKey) return def.vaultKey;
  const local = `${def.env ? `${def.env}/` : ''}${def.target ? `${def.target}.` : ''}${def.name}`;
  return vaultScope ? `${vaultScope}::${local}` : local;
}

function fromDef(name: string, def: VarDef, kind: SourceKind, scope: Scope): Lookup {
  return { name, value: def.value, secret: def.secret, vaultKey: def.secret ? vaultKeyFor(def, scope.vaultScope) : null, def, kind, shadowed: null };
}

/** The variables.md layer for a plain name: active target's field → active env's var → top-level var. */
function fileLayer(name: string, scope: Scope): { def: VarDef; kind: SourceKind } | null {
  const f = scope.file;
  if (!f) return null;
  const field = scope.target ? targetFields(f, scope.env, scope.target)?.get(name) : undefined;
  if (field) return { def: field, kind: 'target' };
  const envVar = scope.env ? f.envs.get(scope.env)?.vars.get(name) : undefined;
  if (envVar) return { def: envVar, kind: 'env' };
  const top = f.vars.get(name);
  return top ? { def: top, kind: 'file' } : null;
}

/** THE precedence rule (see the header). `dflt` is the `:default` part of the placeholder. */
export function lookup(scope: Scope, name: string, dflt?: string): Lookup {
  const miss: Lookup = { name, value: null, secret: false, vaultKey: null, def: null, kind: null, shadowed: null };
  // {{TARGET.field}} — the longest target name that matches wins (names may contain dots).
  for (let i = name.lastIndexOf('.'); i > 0; i = name.lastIndexOf('.', i - 1)) {
    const fields = targetFields(scope.file, scope.env, name.slice(0, i));
    if (!fields) continue;
    const def = fields.get(name.slice(i + 1));
    return def ? fromDef(name, def, 'target', scope) : dflt !== undefined ? { ...miss, value: dflt, kind: 'default' } : miss;
  }
  const fence = scope.fence.get(name);
  if (fence !== undefined) return { ...miss, value: fence, kind: 'fence' };
  const file = fileLayer(name, scope);
  const note = scope.note?.vars.get(name);
  if (note) {
    const r = fromDef(name, note, 'note', scope);
    if (file) r.shadowed = { value: file.def.value, secret: file.def.secret, where: describeDef(file.def, scope) };
    return r;
  }
  if (file) return fromDef(name, file.def, file.kind, scope);
  if (BUILTINS.has(name)) {
    const b = scope.builtins;
    const value =
      name === 'title' ? b.title : name === 'target' ? scope.target : name === 'env' ? scope.env : formatDate(b.now, dflt?.trim() || (name === 'date' ? b.dateFormat : b.timeFormat));
    if (value) return { ...miss, value, kind: 'builtin' };
  }
  return dflt !== undefined ? { ...miss, value: dflt, kind: 'default' } : miss;
}

/** "variables.md · env lab", "variables.md · target DC01" … for hovers. */
export function describeDef(def: VarDef, scope: Pick<Scope, 'file'>): string {
  const file = scope.file?.path ?? 'variables.md';
  if (def.target) return `${file} · target ${def.target}${def.env ? ` (env ${def.env})` : ''}`;
  if (def.env) return `${file} · env ${def.env}`;
  return file;
}

export function describe(l: Lookup, scope: Scope): string {
  switch (l.kind) {
    case 'fence':
      return 'code block attribute';
    case 'note':
      return 'this note’s frontmatter';
    case 'builtin':
      return 'built-in';
    case 'default':
      return 'default in the placeholder';
    case 'input':
      return 'typed in';
    case null:
      return 'not defined';
    default:
      return l.def ? describeDef(l.def, scope) : '';
  }
}

export interface Missing {
  name: string;
  dflt?: string;
  secret: boolean;
  vaultKey: string | null;
  def: VarDef | null;
}

export interface ResolveOpts {
  /** display: secrets masked, missing kept raw. action: secrets from `secret()`, missing collected. */
  mode: 'display' | 'action';
  /** Vault value by key (action mode); undefined = not in the vault. */
  secret?: (key: string) => string | undefined;
  /** Values typed in the missing-values form. */
  input?: ReadonlyMap<string, string>;
  /** Display mode: what a secret shows (default ••••). */
  mask?: string;
}

export interface Resolved {
  text: string;
  /** Nothing defines them (secrets: no vault value). */
  missing: Missing[];
  /** Only their `:default` filled them — listed (prefilled) in the form when something else is missing. */
  defaulted: Missing[];
  /** Vault keys the text needs (action mode: fetch these, then resolve again). */
  secretKeys: string[];
}

/** Replaces every placeholder in `text`. Values may themselves contain placeholders (depth-limited, cycle-safe).
 *  Order after lookup(): `input` (typed / remembered) fills undefined names, then the placeholder's default. */
export function resolveText(text: string, scope: Scope, opts: ResolveOpts): Resolved {
  const missing = new Map<string, Missing>();
  const defaulted = new Map<string, Missing>();
  const keys = new Set<string>();
  const one = (src: string, depth: number, stack: string[]): string =>
    src.replace(PLACEHOLDER_RE, (all, name: string, dflt?: string) => {
      if (stack.includes(name) || depth > 4) return all;
      const l = lookup(scope, name, dflt);
      const info = (): Missing => ({ name, dflt, secret: l.secret, vaultKey: l.vaultKey, def: l.def });
      let v: string | null = l.kind === 'default' ? null : l.value;
      if (l.secret) {
        if (l.vaultKey) keys.add(l.vaultKey);
        if (opts.mode === 'display') return l.value !== null || l.vaultKey ? (opts.mask ?? MASK) : all;
        v = (l.vaultKey ? opts.secret?.(l.vaultKey) : undefined) ?? l.value;
      }
      if (v === null) v = opts.input?.get(name) ?? null;
      if (v === null && l.kind === 'default') {
        v = l.value;
        if (!defaulted.has(name)) defaulted.set(name, info());
      }
      if (v === null) {
        if (!missing.has(name)) missing.set(name, info());
        return all;
      }
      return v.includes('{{') ? one(v, depth + 1, [...stack, name]) : v;
    });
  return { text: one(text, 0, []), missing: [...missing.values()], defaulted: [...defaulted.values()], secretKeys: [...keys] };
}

/** Placeholder names in `text` (deduplicated, in order). */
export function placeholderNames(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]))];
}

const WINDOWS_LANGS = new Set(['powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch']);
const UNIX_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'ksh']);

export function osFamily(os: string | null | undefined): 'windows' | 'unix' | null {
  if (!os) return null;
  if (/win/i.test(os)) return 'windows';
  if (/linux|ubuntu|debian|rhel|red ?hat|centos|fedora|alma|rocky|suse|alpine|arch|unix|bsd|mac|darwin|osx/i.test(os)) return 'unix';
  return null;
}

/** "powershell on a linux target" style hint, or null when the block language suits the target's `os`. */
export function osMismatch(lang: string, os: string | null | undefined): string | null {
  const fam = osFamily(os);
  const l = lang.toLowerCase();
  if (fam === 'unix' && WINDOWS_LANGS.has(l)) return `${l} on a ${os} target`;
  if (fam === 'windows' && UNIX_LANGS.has(l)) return `${l} on a ${os} target`;
  return null;
}

export const DEFAULT_DANGER = 'prod|production|live';

/** Env names that get the danger tint (whole words, so "preprod" is not "prod"). */
export function isDangerEnv(env: string | null | undefined, pattern?: string | null): boolean {
  if (!env) return false;
  let re: RegExp;
  try {
    re = new RegExp(`(?:^|[^a-z0-9])(?:${pattern?.trim() || DEFAULT_DANGER})(?:[^a-z0-9]|$)`, 'i');
  } catch {
    re = new RegExp(`(?:^|[^a-z0-9])(?:${DEFAULT_DANGER})(?:[^a-z0-9]|$)`, 'i');
  }
  return re.test(env);
}

/** Line comment for the separator between per-target copies. */
export function commentFor(lang: string): string {
  const l = lang.toLowerCase();
  if (l === 'cmd' || l === 'bat' || l === 'batch') return 'REM';
  if (l === 'sql' || l === 'lua' || l === 'haskell') return '--';
  if (l === 'js' || l === 'javascript' || l === 'ts' || l === 'typescript' || l === 'go' || l === 'c' || l === 'cpp' || l === 'java' || l === 'csharp' || l === 'cs' || l === 'php') return '//';
  return '#';
}

/** One resolved copy of `code` per target, separated by a comment line naming the target. */
export function expandForTargets(code: string, scope: Scope, targets: string[], lang: string, opts: ResolveOpts): Resolved & { parts: Array<{ target: string; text: string }> } {
  const parts: Array<{ target: string; text: string }> = [];
  const missing: Missing[] = [];
  const defaulted: Missing[] = [];
  const keys = new Set<string>();
  for (const t of targets) {
    const r = resolveText(code, { ...scope, target: t }, opts);
    parts.push({ target: t, text: r.text });
    for (const m of r.missing) if (!missing.some((x) => x.name === m.name)) missing.push(m);
    for (const m of r.defaulted) if (!defaulted.some((x) => x.name === m.name)) defaulted.push(m);
    r.secretKeys.forEach((k) => keys.add(k));
  }
  const c = commentFor(lang);
  return { text: parts.map((p) => `${c} --- ${p.target} ---\n${p.text}`).join('\n\n'), parts, missing, defaulted, secretKeys: [...keys] };
}

/** Raw code + info string of the fenced block whose opening fence is on 0-based `line`. */
export function fenceAtLine(text: string, line: number): { info: string; code: string } | null {
  const lines = text.split('\n');
  const open = /^(\s*(?:>\s*)*)(`{3,}|~{3,})(.*)$/.exec(lines[line] ?? '');
  if (!open) return null;
  const close = new RegExp(`^\\s*(?:>\\s*)*\\${open[2][0]}{${open[2].length},}\\s*$`);
  const body: string[] = [];
  const strip = open[1].length;
  for (let i = line + 1; i < lines.length; i++) {
    if (close.test(lines[i])) break;
    body.push(lines[i].slice(Math.min(strip, /^\s*(?:>\s*)*/.exec(lines[i])![0].length)));
  }
  return { info: open[3].trim(), code: body.join('\n') };
}
