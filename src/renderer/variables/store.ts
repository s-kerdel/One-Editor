// Runtime state of {{variables}} (lazy chunk): parsed variables.md files, the active environment +
// target per workspace, remembered form values, and the secrets vault client.
// Per-workspace state lives in localStorage keyed by the folder (Electron keeps it in the app's data
// folder; browser mode on its sticky port) — not in settings.json, which holds user settings only.
import { signal } from '@preact/signals';
import { basename, dirname, stem } from '@shared/paths';
import { VAULT_LIMITS, type VaultReply, type VaultStatus } from '@shared/vault';
import { app } from '../app/app';
import { noteEdited } from '../app/documents';
import { refreshVariables } from './cm';
import { parseNoteMeta, parseVariablesFile, type NoteMeta, type VarsFile } from './parse';
import { DEFAULT_DANGER, parseFenceInfo, type Scope } from './resolve';
import { applyChange, type TextChange } from './write';

/** Bumps whenever anything a chip / pill / preview shows may have changed. */
export const version = signal(0);

export const setting = <T>(key: string, dflt: T): T => {
  const v = app.settings.value[key];
  return v === undefined || v === null || v === '' ? dflt : (v as T);
};
export const fileName = () => String(setting('variables.fileName', 'variables.md')).trim() || 'variables.md';
export const showValues = () => setting<boolean>('variables.showValues', true) !== false;
export const dangerPattern = () => String(setting('variables.dangerEnvs', DEFAULT_DANGER));
export const isVarsFile = (path: string) => basename(path).toLowerCase() === fileName().toLowerCase();

let bumpQueued = false;
export function bump(): void {
  if (bumpQueued) return;
  bumpQueued = true;
  queueMicrotask(() => {
    bumpQueued = false;
    version.value++;
    refreshVariables();
    app.events.emit('variables:changed');
  });
}

// ---- variables.md files -------------------------------------------------------------------------

interface Entry {
  text: string;
  /** Latest parse (its diagnostics drive the lint markers). */
  parsed: VarsFile;
  /** Last parse without YAML errors: what resolution uses while the file is broken. */
  good: VarsFile;
}
const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<void>>();
let nearestMemo = new Map<string, string | null>();
let memoFiles: readonly string[] | null = null;
let memoName = '';
const warned = new Set<string>();

/** Nearest variables.md walking up from the note's folder (like .editorconfig); null = none. */
export function nearestFile(notePath: string): string | null {
  const files = app.files.value;
  const name = fileName();
  if (files !== memoFiles || name !== memoName) {
    memoFiles = files;
    memoName = name;
    nearestMemo = new Map();
  }
  let dir = dirname(notePath);
  const hit = nearestMemo.get(dir);
  if (hit !== undefined) return hit;
  const lower = name.toLowerCase();
  const byDir = new Map<string, string>();
  for (const f of files) if (basename(f).toLowerCase() === lower) byDir.set(dirname(f), f);
  const start = dir;
  for (;;) {
    const f = byDir.get(dir);
    if (f) return nearestMemo.set(start, f), f;
    if (!dir) break;
    dir = dirname(dir);
  }
  nearestMemo.set(start, null);
  return null;
}

function lineOf(text: string, pos: number) {
  let n = 1;
  for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

export function ingest(path: string, text: string): void {
  const parsed = parseVariablesFile(path, text);
  const prev = entries.get(path);
  if (prev && prev.text === text) return;
  const good = parsed.ok ? parsed : (prev?.good ?? parsed);
  entries.set(path, { text, parsed, good });
  if (!parsed.ok) {
    const e = parsed.diagnostics[0];
    const key = `${path}:${e?.message}`;
    if (!warned.has(key)) {
      warned.add(key);
      app.toast(`${path}: YAML error on line ${e ? lineOf(text, e.from) : '?'}. Using the last good version`, 'error', 6000);
    }
  } else warned.forEach((k) => k.startsWith(`${path}:`) && warned.delete(k));
  bump();
}

export function load(path: string): Promise<void> {
  const open = app.docs.get(path);
  if (open) {
    ingest(path, app.editor?.getContent(path) ?? open.content);
    return Promise.resolve();
  }
  let p = loading.get(path);
  if (!p) {
    p = app.backend
      .readFile(path)
      .then((f) => ingest(path, f.content))
      .catch(() => void entries.delete(path))
      .finally(() => loading.delete(path));
    loading.set(path, p);
  }
  return p;
}

/** Parsed (last good) file; starts loading it when not cached yet. */
export function fileData(path: string | null): VarsFile | null {
  if (!path) return null;
  const e = entries.get(path);
  if (!e) void load(path);
  return e?.good ?? null;
}

export const diagnosticsOf = (path: string) => entries.get(path)?.parsed.diagnostics ?? [];
export const rawText = (path: string) => entries.get(path)?.text;

export async function prepare(notePath: string): Promise<void> {
  const f = nearestFile(notePath);
  if (f && !entries.has(f)) await load(f);
}

// ---- note frontmatter (the note always wins) ----------------------------------------------------

const metaCache = new Map<string, NoteMeta | null>();
export function noteMeta(fm: string): NoteMeta | null {
  if (!fm) return null;
  if (metaCache.has(fm)) return metaCache.get(fm)!;
  const m = parseNoteMeta(fm);
  if (metaCache.size > 200) metaCache.clear();
  metaCache.set(fm, m);
  return m;
}

/** Frontmatter text of an open (or cached) note. */
export function frontmatterText(path: string): string {
  // The doc's content string is kept in sync on every edit: no full-document toString() per call
  // (the status-bar pills ask on every cursor move).
  const text = (app.docs.get(path)?.content ?? app.editor?.getContent(path) ?? '').slice(0, 64 * 1024);
  if (!/^---[ \t]*\r?\n/.test(text)) return '';
  const m = /\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text.slice(3));
  return m ? text.slice(0, 3 + m.index + m[0].length) : '';
}

// ---- per-workspace state (active env / target, remembered values) -------------------------------

interface WsState {
  env?: string | null;
  target?: string | null;
  values?: Record<string, string>;
}
const stateKey = () => `sec-edit-vars:${app.workspace.value?.root ?? ''}`;
let stateMemo: { key: string; s: WsState } | null = null;

export function wsState(): WsState {
  const key = stateKey();
  if (stateMemo?.key === key) return stateMemo.s;
  let s: WsState = {};
  try {
    s = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {}
  stateMemo = { key, s };
  return s;
}

export function setWsState(patch: Partial<WsState>): void {
  const s = { ...wsState(), ...patch };
  stateMemo = { key: stateKey(), s };
  try {
    localStorage.setItem(stateKey(), JSON.stringify(s));
  } catch {}
  bump();
}

export const activeEnv = () => wsState().env ?? null;
export const activeTarget = () => wsState().target ?? null;
export const remembered = (): ReadonlyMap<string, string> => new Map(Object.entries(wsState().values ?? {}));
export function remember(values: Map<string, string>): void {
  if (!values.size) return;
  const all = { ...(wsState().values ?? {}) };
  for (const [k, v] of values) all[k] = v;
  setWsState({ values: all });
}
export function forget(name: string): void {
  const all = { ...(wsState().values ?? {}) };
  delete all[name];
  setWsState({ values: all });
}

// ---- scope ---------------------------------------------------------------------------------------

/** Absolute folder of the variables.md: default vault keys stay the same whether the parent or the project is open. */
export function vaultScope(varsPath: string | null): string {
  const root = (app.workspace.value?.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = varsPath ? dirname(varsPath) : '';
  const abs = dir ? `${root}/${dir}` : root;
  return app.backend?.os === 'linux' ? abs : abs.toLowerCase();
}

export function scopeFor(path: string, fm: string | null, info: string | null): Scope {
  const varsPath = nearestFile(path);
  const file = fileData(varsPath);
  const note = isVarsFile(path) ? null : noteMeta(fm ?? frontmatterText(path));
  const fence = parseFenceInfo(info);
  return {
    file,
    note,
    env: fence.env ?? note?.env ?? activeEnv(),
    target: fence.target ?? note?.target ?? activeTarget(),
    fence: fence.vars,
    builtins: { title: stem(path), now: new Date(), dateFormat: setting('templates.dateFormat', 'YYYY-MM-DD'), timeFormat: setting('templates.timeFormat', 'HH:mm') },
    vaultScope: vaultScope(varsPath),
  };
}

// ---- writing (click-edit, "Save to variables.md") -------------------------------------------------

/** Applies a text change to `path`: through the editor when the note is open (undo, autosave), else on disk. */
export async function writeChange(path: string, change: (text: string) => TextChange | null): Promise<void> {
  const open = app.docs.get(path);
  if (open) {
    const text = app.editor?.getContent(path) ?? open.content;
    const c = change(text);
    if (!c) return;
    if (app.editor?.applyChanges && app.editor.getContent(path) !== undefined) app.editor.applyChanges(path, [c]);
    else noteEdited(path, applyChange(text, c));
    if (isVarsFile(path)) ingest(path, app.editor?.getContent(path) ?? applyChange(text, c));
    return;
  }
  const exists = app.files.value.includes(path);
  const f = exists ? await app.backend.readFile(path) : null;
  const text = f?.content ?? '';
  const c = change(text);
  if (!c) return;
  const next = applyChange(text, c);
  if (f) await app.backend.writeFile(path, next, { expectedMtime: f.mtime, eol: f.eol });
  else {
    await app.backend.createFile(path, next);
    const tree = await app.backend.listTree();
    app.tree.value = tree;
    app.events.emit('tree:changed', tree);
  }
  if (isVarsFile(path)) ingest(path, next);
  app.events.emit('file:updated', path, next);
}

// ---- vault ---------------------------------------------------------------------------------------

interface Bridge {
  status(): Promise<unknown>;
  has(keys: string[]): Promise<unknown>;
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  remove(key: string): Promise<unknown>;
}
const bridge = (globalThis as { secEditBridge?: { vault?: Bridge } }).secEditBridge?.vault;
/** Browser mode: secrets typed in the app are kept in memory for this session only (never sent to the server). */
const memory = new Map<string, string>();
const known = new Map<string, boolean>();
let pendingHas = new Set<string>();

async function call<T>(p: Promise<unknown>): Promise<T> {
  const r = (await p) as VaultReply<T>;
  if (!r || typeof r !== 'object') throw new Error('No answer from the vault');
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

/** Desktop vault, or session memory (browser mode, or a desktop without OS secure storage). */
let mode: Promise<'vault' | 'memory'> | null = null;
function vaultMode(): Promise<'vault' | 'memory'> {
  return (mode ??= !bridge
    ? Promise.resolve('memory' as const)
    : call<VaultStatus>(bridge.status()).then(
        (s) => (s.available ? ('vault' as const) : ('memory' as const)),
        () => 'memory' as const,
      ));
}
let warnedMemory = false;
let modeNow: 'vault' | 'memory' | null = bridge ? null : 'memory';
void vaultMode().then((m) => (modeNow = m));

export const vault = {
  desktop: !!bridge,
  async status(): Promise<VaultStatus> {
    if (!bridge) return { available: true, backend: 'memory' };
    return call<VaultStatus>(bridge.status()).catch(() => ({ available: false, reason: 'Vault not reachable' }));
  },
  /** Sync for chips: true / false once known, undefined while being checked (checks are batched). */
  has(key: string): boolean | undefined {
    if (modeNow === 'memory') return memory.has(key);
    const k = known.get(key);
    if (k !== undefined) return k;
    if (!pendingHas.size)
      queueMicrotask(async () => {
        const keys = [...pendingHas].slice(0, VAULT_LIMITS.maxBatch);
        pendingHas = new Set();
        if ((await vaultMode()) === 'memory') return bump();
        await call<string[]>(bridge!.has(keys)).then(
          (found) => {
            for (const k of keys) known.set(k, found.includes(k));
            bump();
          },
          () => keys.forEach((k) => known.set(k, false)),
        );
      });
    pendingHas.add(key);
    return undefined;
  },
  async get(key: string): Promise<string | undefined> {
    if ((await vaultMode()) === 'memory') return memory.get(key);
    const v = await call<string | null>(bridge!.get(key));
    known.set(key, v !== null);
    return v ?? undefined;
  },
  async set(key: string, value: string): Promise<void> {
    if ((await vaultMode()) === 'memory') {
      memory.set(key, value);
      // Desktop without an OS keyring (some Linux setups): say once that nothing is persisted.
      if (bridge && !warnedMemory) (warnedMemory = true), app.toast('No secure storage on this system: secrets are kept until the app closes', 'info', 7000);
    } else await call<void>(bridge!.set(key, value));
    known.set(key, true);
    bump();
  },
  async remove(key: string): Promise<void> {
    if ((await vaultMode()) === 'memory') memory.delete(key);
    else await call<void>(bridge!.remove(key));
    known.set(key, false);
    bump();
  },
};

// ---- invalidation --------------------------------------------------------------------------------

export function installStore(): void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  app.events.on('doc:changed', (p, content) => {
    if (!isVarsFile(p)) return;
    clearTimeout(timers.get(p));
    timers.set(p, setTimeout(() => ingest(p, content), 150));
  });
  app.events.on('file:updated', (p, content) => {
    if (!isVarsFile(p)) return;
    if (content === undefined) {
      entries.delete(p);
      bump();
    } else if (!app.docs.get(p)?.dirty.value) ingest(p, content);
  });
  app.events.on('file:renamed', (from) => {
    if (entries.delete(from)) bump();
  });
  app.events.on('tree:changed', () => bump());
  app.events.on('workspace:opened', () => {
    entries.clear();
    stateMemo = null;
    known.clear();
    memory.clear();
    bump();
  });
  app.events.on('active:changed', (p) => p && void prepare(p));
  let sig = '';
  app.events.on('settings:changed', (s) => {
    const next = ['variables.fileName', 'variables.showValues', 'variables.dangerEnvs', 'templates.folder', 'templates.dateFormat', 'templates.timeFormat'].map((k) => String(s[k] ?? '')).join('\n');
    if (next === sig) return;
    sig = next;
    bump();
  });
  const p = app.activePath.value;
  if (p) void prepare(p);
}
