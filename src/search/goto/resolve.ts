// Go to definition — name-based, no language server. Given the identifier under the cursor and its
// line, in this order:
//   a. imports, exact: PHP `use` / namespace / fully qualified names (index by namespace, then PSR-4 —
//      which reaches vendor/, never indexed); JS/TS relative `import` / `export … from` / `require()` /
//      `import()`; Python relative `from .a import x`;
//   b. members: `$this->x()`, `self::` / `static::` / `parent::`, `this.x`, `super.x`, `self.x` → the
//      enclosing class, then its traits and `extends` chain (≤ 5 levels); `Foo::bar` / `Foo.bar` with a
//      resolvable `Foo` → `bar` in that class;
//   c. the same file, then the same language family across the workspace symbol index, narrowed by
//      context hints (`new X` → class-likes, `->x(` → methods, `x(` → functions). A PHP call never
//      lands in JavaScript.
// Pure: file access and the index come through GotoEnv (the app's backend RPC + search shards; a fake in
// tests). Every path taken from file contents passes safeRel()/safeJoin() before it is read.
import { languageForPath } from '@shared/languages';
import { basename } from '@shared/paths';
import { CLASS_KINDS, DEF_TEXT_MAX, extractDefs, familyLangs, familyOf } from '../symbols';
import type { DefHit, DefQuery } from '../defs';
import { hintAt, identAt, type Hint, type Ident } from './context';
import { phpContext, psr4Candidates, psr4FromAutoload, psr4FromComposer, resolveClassName, resolveFunctionNames, splitFqn, type Psr4Map } from './php';
import { jsCandidates, jsDefaultExport, jsImports, jsLocalExport, jsReexports, pyCandidates, pyImports } from './js';
import { dirOf, safeJoin, safeRel } from './paths';

export interface GotoEnv {
  /** Text of a workspace file (an open document's live text first); null = missing, unreadable or binary. */
  read(path: string): Promise<string | null>;
  /** The tree's spelling of a path when it lists it, null when it certainly doesn't exist, undefined = unknown. */
  known?(path: string): string | null | undefined;
  /** Exact-name lookup in the workspace symbol index (possibly partial while it builds). */
  lookup(q: DefQuery): Promise<DefHit[] | null>;
  /** The index is fully built (otherwise an empty answer may not be final). */
  complete?(): boolean;
  /** Cross-call cache (PSR-4 maps); the app clears it when files change. */
  memo?: Map<string, unknown>;
}

export interface GotoRequest {
  path: string;
  content: string;
  line: number;
  col: number;
}

export interface GotoResult {
  ident: Ident | null;
  hint?: Hint;
  hits: DefHit[];
  /** Nothing found while the index is still being built: try again once it is. */
  pending?: boolean;
  /** Every hit is the clicked definition itself. */
  self?: boolean;
}

const MAX_HITS = 60;
const MAX_DEPTH = 5;
const PROPERTY_KINDS = new Set(['property', 'const', 'case', 'variable']);

const langOf = (path: string) => languageForPath(path)?.id ?? '';
export const isClassHit = (h: DefHit) => CLASS_KINDS.has(h.kind) && h.kind !== 'namespace';
const eqName = (a: string, b: string, ci: boolean) => a === b || (ci && a.length === b.length && a.toLowerCase() === b.toLowerCase());
const caseInsensitive = (lang: string) => familyOf(lang) === 'php' || lang === 'sql';

/** One resolution: caches texts / definitions per file and remembers whether the index was complete. */
class Session {
  private texts = new Map<string, Promise<string | null>>();
  private defs = new Map<string, Promise<DefHit[] | null>>();
  /** The index was asked while incomplete. */
  incomplete = false;

  constructor(
    readonly env: GotoEnv,
    readonly req: GotoRequest,
  ) {
    this.texts.set(req.path, Promise.resolve(req.content));
  }

  /** The spelling of `path` that exists, or null. Untrusted paths are refused before any read. */
  async exists(path: string): Promise<string | null> {
    const p = safeRel(path);
    if (!p) return null;
    const k = this.env.known?.(p);
    if (k === null) return null;
    const real = k ?? p;
    return (await this.text(real)) === null ? null : real;
  }

  text(path: string): Promise<string | null> {
    const p = safeRel(path);
    if (!p) return Promise.resolve(null);
    let t = this.texts.get(p);
    if (!t) this.texts.set(p, (t = this.env.read(p).catch(() => null)));
    return t;
  }

  fileDefs(path: string): Promise<DefHit[] | null> {
    let d = this.defs.get(path);
    if (!d) this.defs.set(path, (d = this.text(path).then((t) => (t === null ? null : hitsOf(path, t)))));
    return d;
  }

  async lookup(q: DefQuery): Promise<DefHit[]> {
    if (this.env.complete && !this.env.complete()) this.incomplete = true;
    const r = await this.env.lookup(q).catch(() => null);
    if (r === null) this.incomplete = true;
    return r ?? [];
  }
}

/** Definitions of a file as hits (the resolver reads files the index may not hold: vendor/, unsaved text). */
export function hitsOf(path: string, content: string): DefHit[] {
  const lang = langOf(path);
  const lines = content.split('\n');
  return extractDefs(path, content).map((d) => {
    const t = (lines[d.line] ?? '').trim();
    const h: DefHit = { path, name: d.name, kind: d.kind, line: d.line, col: d.col, lang, text: t.length > DEF_TEXT_MAX ? t.slice(0, DEF_TEXT_MAX) + '…' : t };
    if (d.container) h.container = d.container;
    if (d.ns) h.ns = d.ns;
    if (d.ext) h.ext = d.ext;
    if (d.uses) h.uses = d.uses;
    if (d.end !== undefined) h.end = d.end;
    if (d.extra) h.extra = true;
    return h;
  });
}

const fileHit = (path: string, name = basename(path)): DefHit => ({ path, name, kind: 'file', line: 0, col: 0, lang: langOf(path), text: '' });

async function firstExisting(s: Session, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    const real = await s.exists(c);
    if (real) return real;
  }
  return null;
}

// --------------------------------------------------------------------------- entry

export async function resolveDefinition(req: GotoRequest, env: GotoEnv): Promise<GotoResult> {
  const lang = langOf(req.path);
  const lineText = req.content.split('\n', req.line + 1)[req.line] ?? '';
  const id = identAt(lineText, req.col, lang);
  if (!id) {
    const spec = await specUnderCursor(new Session(env, req), req, lineText, lang);
    return spec ? { ident: { name: spec.name, from: req.col, to: req.col }, hits: [spec] } : { ident: null, hits: [] };
  }
  const hint = hintAt(lineText, id, lang);
  const s = new Session(env, req);
  const spec = await specUnderCursor(s, req, lineText, lang);
  if (spec) return { ident: id, hint, hits: [spec] };

  let hits = await byContext(s, req, lang, id, hint);
  if (!hits.length) hits = await sameFileThenIndex(s, req, lang, id, hint);
  hits = rank(dedupe(hits), req);
  const isSelf = (h: DefHit) => h.path === req.path && h.line === req.line && h.col >= id.from - 1 && h.col <= id.to;
  const others = hits.filter((h) => !isSelf(h));
  const self = hits.length > 0 && !others.length;
  return { ident: id, hint, hits: self ? hits : others.slice(0, MAX_HITS), pending: s.incomplete && (self || !others.length), self };
}

/** The cursor is in the module string of an import / require: the module file itself. */
async function specUnderCursor(s: Session, req: GotoRequest, line: string, lang: string): Promise<DefHit | null> {
  const fam = familyOf(lang);
  if (fam !== 'js') return null;
  // Only around the cursor: a minified line can be megabytes long.
  const off = Math.max(0, req.col - 600);
  const part = line.slice(off, req.col + 600);
  const re = /(?:\bfrom[ \t]*|\b(?:require|import)[ \t]*\([ \t]*|^[ \t]*import[ \t]+)(['"])([^'"\n]{1,500})\1/g;
  for (let m = re.exec(part); m; m = re.exec(part)) {
    const start = off + m.index + m[0].length - m[2].length - 1;
    if (req.col < start - 1 || req.col > start + m[2].length + 1) continue;
    const file = await firstExisting(s, jsCandidates(req.path, m[2]));
    return file ? fileHit(file) : null;
  }
  return null;
}

// --------------------------------------------------------------------------- a + b: imports and members

async function byContext(s: Session, req: GotoRequest, lang: string, id: Ident, hint: Hint): Promise<DefHit[]> {
  const fam = familyOf(lang);
  if (hint.mode === 'member') {
    const cls = await receiverClass(s, req, lang, hint);
    if (cls) {
      // `self` / `static` / `parent` themselves, and `Foo::class`.
      if (hint.want === 'class' || (familyOf(lang) === 'php' && id.name.toLowerCase() === 'class')) return [cls];
      const own = await findMember(s, cls, id.name, 0, new Set());
      if (own.length) return own;
      // Members elsewhere (Go methods across a package, C++ out-of-class bodies): the index by container.
      const chain = await classChain(s, cls);
      const idx = (await s.lookup({ names: [id.name], langs: familyLangs(cls.lang) })).filter((h) => h.container && chain.some((c) => eqName(c, h.container!, caseInsensitive(cls.lang))));
      if (idx.length) return idx;
    }
    // `ns.foo()` on a JS namespace / module import: `foo` exported by that module.
    if (fam === 'js' && hint.receiver && hint.receiver !== 'this' && hint.receiver !== 'super') {
      const imp = jsImports(req.content).find((i) => i.local === hint.receiver);
      const file = imp ? await resolveJsSpec(s, req.path, imp.spec) : null;
      if (imp && file) {
        const r = imp.imported === '*' ? await findExport(s, file, id.name, 0, new Set()) : [];
        if (r.length) return r;
      }
    }
    return [];
  }
  if (fam === 'php') return phpByName(s, req, id, hint);
  if (fam === 'js') return jsByName(s, req, id, hint);
  if (fam === 'python') return pyByName(s, req, id);
  return [];
}

/** The class a member access refers to: the enclosing one (`this`), its parent (`super`), or a named one. */
async function receiverClass(s: Session, req: GotoRequest, lang: string, hint: Hint): Promise<DefHit | null> {
  if (hint.receiver === 'this' || hint.receiver === 'super') {
    const cur = enclosingClass((await s.fileDefs(req.path)) ?? [], req.line);
    if (!cur || hint.receiver === 'this') return cur;
    return cur.ext ? resolveClassRef(s, cur.ext, cur.path, cur.line) : null;
  }
  return hint.receiver ? resolveClassRef(s, hint.receiver, req.path, req.line) : null;
}

/** Innermost class-like whose body holds `line` (languages without body ends: the nearest one above). */
export function enclosingClass(defs: DefHit[], line: number): DefHit | null {
  let best: DefHit | null = null;
  let above: DefHit | null = null;
  for (const d of defs) {
    if (!isClassHit(d) || d.line > line) continue;
    if (d.end !== undefined ? d.end >= line : false) {
      if (!best || d.line >= best.line) best = d;
    }
    if (d.end === undefined && (!above || d.line >= above.line)) above = d;
  }
  return best ?? above;
}

/** A class name as written in `fromPath` → its definition (imports, namespace, same file, index). */
async function resolveClassRef(s: Session, written: string, fromPath: string, line: number): Promise<DefHit | null> {
  const lang = langOf(fromPath);
  const fam = familyOf(lang);
  const short = written.split(/\\|\.|::/).pop() ?? written;
  if (fam === 'php') {
    const text = await s.text(fromPath);
    if (text !== null) {
      const r = await phpClass(s, resolveClassName(written, phpContext(text, line)), fromPath);
      if (r.length) return r[0];
    }
  } else if (fam === 'js') {
    const text = await s.text(fromPath);
    const head = written.split('.')[0];
    const imp = text === null ? undefined : jsImports(text).find((i) => i.local === head);
    const file = imp ? await resolveJsSpec(s, fromPath, imp.spec) : null;
    if (imp && file) {
      const name = imp.imported === '*' ? (written.split('.')[1] ?? '') : imp.imported;
      const r = name ? await findExport(s, file, name, 0, new Set()) : [];
      const cls = r.find(isClassHit);
      if (cls) return cls;
    }
  } else if (fam === 'python') {
    const text = await s.text(fromPath);
    const imp = text === null ? undefined : pyImports(text).find((i) => i.local === short);
    if (imp) {
      const r = await pyImported(s, fromPath, imp);
      const cls = r.find(isClassHit);
      if (cls) return cls;
    }
  }
  const ci = caseInsensitive(lang);
  const own = ((await s.fileDefs(fromPath)) ?? []).filter((h) => isClassHit(h) && eqName(h.name, short, ci));
  if (own.length) return own[0];
  const idx = (await s.lookup({ names: [short], langs: familyLangs(lang) })).filter((h) => isClassHit(h) && eqName(h.name, short, ci));
  return idx.length ? rank(idx, s.req)[0] : null;
}

/** `name` declared in class `cls` — else in its traits, then up the `extends` chain. */
async function findMember(s: Session, cls: DefHit, name: string, depth: number, seen: Set<string>): Promise<DefHit[]> {
  const key = `${cls.path}:${cls.line}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const ci = caseInsensitive(cls.lang);
  const defs = (await s.fileDefs(cls.path)) ?? [];
  const own = defs.filter((d) => d.container && eqName(d.container, cls.name, ci) && eqName(d.name, name, ci) && (cls.end === undefined || (d.line > cls.line && d.line <= cls.end)));
  if (own.length || depth >= MAX_DEPTH) return own;
  for (const t of cls.uses ?? []) {
    const tc = await resolveClassRef(s, t, cls.path, cls.line);
    const r = tc ? await findMember(s, tc, name, depth + 1, seen) : [];
    if (r.length) return r;
  }
  if (!cls.ext) return [];
  const parent = await resolveClassRef(s, cls.ext, cls.path, cls.line);
  return parent ? findMember(s, parent, name, depth + 1, seen) : [];
}

/** Names of `cls` and its ancestors (for index lookups by container). */
async function classChain(s: Session, cls: DefHit): Promise<string[]> {
  const out = [cls.name];
  let cur: DefHit | null = cls;
  for (let i = 0; cur?.ext && i < MAX_DEPTH; i++) {
    cur = await resolveClassRef(s, cur.ext, cur.path, cur.line);
    if (cur && !out.includes(cur.name)) out.push(cur.name);
  }
  return out;
}

// ---- PHP

async function phpByName(s: Session, req: GotoRequest, id: Ident, hint: Hint): Promise<DefHit[]> {
  const ctx = phpContext(req.content, req.line);
  const written = id.qualified ?? id.name;
  if (hint.importLine) {
    // Inside a `use` statement names are fully qualified: the import on this line that names the word.
    const lower = id.name.toLowerCase();
    const u = ctx.uses.find((x) => req.line >= x.line && req.line <= x.endLine && (x.alias.toLowerCase() === lower || x.fqn.toLowerCase().split('\\').includes(lower)));
    if (u) return u.kind === 'class' ? phpClass(s, u.fqn, req.path) : u.kind === 'function' ? phpFunction(s, [u.fqn]) : [];
  }
  if (hint.want === 'class' || (!hint.call && (id.qualified || /^[A-Z]/.test(id.name)))) {
    const r = await phpClass(s, resolveClassName(written, ctx), req.path);
    if (r.length) return r;
  }
  if (hint.call && hint.want !== 'class') return phpFunction(s, resolveFunctionNames(written, ctx));
  return [];
}

/** A fully qualified class: the index (by namespace), the current file, then PSR-4 (vendor/ included). */
async function phpClass(s: Session, fqn: string, fromPath: string): Promise<DefHit[]> {
  const { ns, short } = splitFqn(fqn);
  const inNs = (h: DefHit) => isClassHit(h) && eqName(h.name, short, true) && (h.ns ?? '').toLowerCase() === ns.toLowerCase();
  const own = ((await s.fileDefs(s.req.path)) ?? []).filter(inNs);
  if (own.length) return own;
  const idx = (await s.lookup({ names: [short], langs: ['php'] })).filter(inNs);
  if (idx.length) return idx;
  for (const file of psr4Candidates(fqn, await psr4Maps(s, fromPath))) {
    const real = await s.exists(file);
    if (!real) continue;
    const cls = ((await s.fileDefs(real)) ?? []).filter((h) => isClassHit(h) && eqName(h.name, short, true));
    return cls.length ? cls : [fileHit(real, short)];
  }
  return [];
}

/** Functions by fully qualified name (`use function`, the namespace, then the global one). */
async function phpFunction(s: Session, fqns: string[]): Promise<DefHit[]> {
  for (const fqn of fqns) {
    const { ns, short } = splitFqn(fqn);
    const r = (await s.lookup({ names: [short], langs: ['php', 'blade'] })).filter((h) => !isClassHit(h) && !h.container && (h.ns ?? '').toLowerCase() === ns.toLowerCase());
    if (r.length) return r;
  }
  return [];
}

/** PSR-4 roots for a file: the nearest composer.json above it (and the folder root's), with their vendor maps. */
async function psr4Maps(s: Session, fromPath: string): Promise<Psr4Map[]> {
  const composers: string[] = [];
  for (let dir = dirOf(fromPath); ; dir = dirOf(dir)) {
    const p = safeJoin(dir, 'composer.json');
    if (p && !composers.includes(p) && (await s.exists(p))) composers.push(p);
    if (!dir || composers.length >= 2) break;
  }
  const maps: Psr4Map[] = [];
  for (const c of composers) {
    const key = `psr4:${c}`;
    let m = s.env.memo?.get(key) as Psr4Map[] | undefined;
    if (!m) {
      m = [];
      const json = await s.text(c);
      if (json !== null) {
        const { map, vendorDir } = psr4FromComposer(json, c);
        m.push(map);
        const auto = vendorDir ? safeJoin(vendorDir, 'composer', 'autoload_psr4.php') : null;
        const text = auto ? await s.text(auto) : null;
        if (auto && text !== null) m.push(psr4FromAutoload(text, auto));
      }
      s.env.memo?.set(key, m);
    }
    maps.push(...m);
  }
  return maps;
}

// ---- JS / TS

async function resolveJsSpec(s: Session, fromPath: string, spec: string): Promise<string | null> {
  return firstExisting(s, jsCandidates(fromPath, spec));
}

async function jsByName(s: Session, req: GotoRequest, id: Ident, hint: Hint): Promise<DefHit[]> {
  const imps = jsImports(req.content);
  const imp = imps.find((i) => i.local === id.name) ?? (hint.importLine ? imps.find((i) => i.imported === id.name && i.line <= req.line) : undefined);
  if (!imp) return [];
  const file = await resolveJsSpec(s, req.path, imp.spec);
  if (!file) return [];
  if (imp.imported === '*') return [fileHit(file)];
  const r = await findExport(s, file, imp.imported, 0, new Set());
  return r.length ? r : [fileHit(file)];
}

/** What module `file` exports as `name` ('default' included), following re-exports (≤ 5 hops). */
async function findExport(s: Session, file: string, name: string, depth: number, seen: Set<string>): Promise<DefHit[]> {
  const key = `${file}\u0000${name}`;
  if (seen.has(key) || depth > MAX_DEPTH) return [];
  seen.add(key);
  const text = await s.text(file);
  if (text === null) return [];
  const defs = (await s.fileDefs(file)) ?? [];
  const top = (n: string) => defs.filter((h) => h.name === n && !h.container);
  if (name === 'default') {
    const d = jsDefaultExport(text);
    if (!d) return [fileHit(file)];
    if (d.name) {
      const t = top(d.name);
      if (t.length) return t;
      const imp = jsImports(text).find((i) => i.local === d.name);
      const f = imp ? await resolveJsSpec(s, file, imp.spec) : null;
      if (imp && f) {
        const r = await findExport(s, f, imp.imported, depth + 1, seen);
        if (r.length) return r;
      }
    }
    return [{ ...fileHit(file, 'default'), line: d.line, kind: 'export' }];
  }
  const direct = top(name);
  if (direct.length) return direct;
  const local = jsLocalExport(text, name);
  if (local && local !== name && top(local).length) return top(local);
  const imp = jsImports(text).find((i) => i.local === (local ?? name));
  const via = imp ? await resolveJsSpec(s, file, imp.spec) : null;
  if (imp && via) {
    const r = imp.imported === '*' ? [fileHit(via)] : await findExport(s, via, imp.imported, depth + 1, seen);
    if (r.length) return r;
  }
  for (const re of jsReexports(text)) {
    const n = re.names?.find((x) => x.exported === name);
    if (re.names && !n) continue;
    const f = await resolveJsSpec(s, file, re.spec);
    if (!f) continue;
    if (n?.local === '*') return [fileHit(f)];
    const r = await findExport(s, f, n ? n.local : name, depth + 1, seen);
    if (r.length) return r;
  }
  return defs.filter((h) => h.name === name);
}

// ---- Python

async function pyByName(s: Session, req: GotoRequest, id: Ident): Promise<DefHit[]> {
  const imp = pyImports(req.content).find((i) => i.local === id.name);
  return imp ? pyImported(s, req.path, imp) : [];
}

async function pyImported(s: Session, fromPath: string, imp: { dots: number; module: string; imported: string }): Promise<DefHit[]> {
  for (const f of pyCandidates(fromPath, imp, imp.imported)) {
    const real = await s.exists(f);
    if (!real) continue;
    if (real.endsWith(`/${imp.imported}.py`) || real === `${imp.imported}.py` || real.endsWith(`${imp.imported}/__init__.py`)) return [fileHit(real)];
    const top = ((await s.fileDefs(real)) ?? []).filter((h) => h.name === imp.imported && !h.container);
    if (top.length) return top;
  }
  return [];
}

// --------------------------------------------------------------------------- c: same file, then the index

/** Names only CSS-like files define (custom properties, SCSS / Less variables): look there from any file. */
const cssOnly = (name: string) => /^(--|\$|@)/.test(name);

async function sameFileThenIndex(s: Session, req: GotoRequest, lang: string, id: Ident, hint: Hint): Promise<DefHit[]> {
  const ci = caseInsensitive(lang);
  const langs = cssOnly(id.name) ? familyLangs('css') : familyLangs(lang);
  const own = narrow(((await s.fileDefs(req.path)) ?? []).filter((h) => eqName(h.name, id.name, ci)), hint, id);
  const ownElsewhere = own.filter((h) => !(h.line === req.line && h.col >= id.from - 1 && h.col <= id.to));
  if (ownElsewhere.length && hint.mode !== 'member' && langs.includes(lang)) return own;
  const idx = (await s.lookup({ names: [id.name], langs })).filter((h) => eqName(h.name, id.name, ci || cssOnly(id.name)));
  return narrow(dedupe([...own, ...idx]), hint, id);
}

/** Keep what fits the context, when anything does (a hint narrows, it never empties the list). */
export function narrow(hits: DefHit[], hint: Hint, id: Ident): DefHit[] {
  const prefer = (list: DefHit[], ok: (h: DefHit) => boolean) => {
    const k = list.filter(ok);
    return k.length ? k : list;
  };
  let r = prefer(hits, (h) => h.name === id.name);
  const member = (h: DefHit) => !!h.container && !isClassHit(h);
  switch (hint.want) {
    case 'class':
      r = prefer(r, isClassHit);
      break;
    case 'method':
      r = prefer(r, (h) => member(h) && !PROPERTY_KINDS.has(h.kind));
      break;
    case 'property':
      r = prefer(r, (h) => PROPERTY_KINDS.has(h.kind));
      r = prefer(r, member);
      break;
    case 'member':
      r = prefer(r, member);
      break;
    case 'callable':
      r = prefer(r, (h) => !isClassHit(h) && !PROPERTY_KINDS.has(h.kind));
      r = prefer(r, (h) => !h.container);
      break;
    case 'mixin':
      r = prefer(r, (h) => h.kind === 'mixin');
      break;
  }
  if (hint.want !== 'property' && hint.want !== 'member') r = prefer(r, (h) => !h.extra);
  // A Swift / Dart `extension X` is not where X is defined, when the type itself is known.
  if (r.some((h) => h.kind !== 'extension')) r = r.filter((h) => h.kind !== 'extension');
  return r;
}

const dedupe = (hits: DefHit[]) => {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const k = `${h.path}:${h.line}:${h.col}`;
    return !seen.has(k) && (seen.add(k), true);
  });
};

/** Same file first, then the nearest folders, then path order. */
export function rank(hits: DefHit[], req: { path: string }): DefHit[] {
  const from = req.path.split('/');
  const near = (p: string) => {
    const parts = p.split('/');
    let i = 0;
    while (i < parts.length - 1 && i < from.length - 1 && parts[i] === from[i]) i++;
    return i;
  };
  return [...hits].sort((a, b) => Number(b.path === req.path) - Number(a.path === req.path) || near(b.path) - near(a.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
