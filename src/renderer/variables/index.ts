// {{variables}} — lazy chunk (loaded on idle when the folder uses them, or on the first action).
// Plugs a provider into the editor (./cm), the render hook into preview + export (app.variables),
// the status-bar pills (./slot) and the palette commands.
import '../app/overlays.css'; // dialog / picker base (shell; .se-vars-targets resizes it)
import './variables.css';
import { setDiagnostics } from '@codemirror/lint';
import type { EditorView } from '@codemirror/view';
import { app } from '../app/app';
import { registerCommands } from '../app/commands';
import { updateSettings } from '../app/settings';
import { docPath } from '../editor/host';
import type { CodeCtx, VariablesApi, VarsProvider } from './api';
import { codeAtCursor, setVarsProvider } from './cm';
import { varsStatus } from './slot';
import * as S from './store';
import { describe, envNames, expandForTargets, lookup, MASK, osMismatch, parseFenceInfo, resolveText, targetFields, targetNames, vaultKeyFor, type Lookup, type Missing, type Scope } from './resolve';
import { addSecretName, setValue } from './write';
import { editChipDialog, missingForm, openEnvPicker, openTargetPicker, targetsDialog, targetSummary, VarsStatus } from './ui';
import type { VarDef } from './parse';

const short = (s: string, n = 60) => {
  const one = s.replace(/\n/g, ' ⏎ ');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const inTemplates = (path: string) => {
  const dir = String(S.setting('templates.folder', 'templates')).replace(/^\/+|\/+$/g, '');
  return !!dir && (path === dir || path.startsWith(`${dir}/`));
};

const fileLabelFor = (path: string) => S.nearestFile(path) ?? S.fileName();

// ---- provider (live mode) -----------------------------------------------------------------------

function chipFor(path: string, fm: string, info: string | null, name: string, dflt: string | undefined) {
  const s = S.scopeFor(path, fm, info);
  const l = lookup(s, name, dflt);
  const where = describe(l, s);
  if (l.secret) {
    const has = l.vaultKey ? S.vault.has(l.vaultKey) : false;
    const set = has !== false || l.value !== null; // unknown yet → assume set (no warning flash)
    return {
      text: set ? MASK : `🔒 ${name}`,
      cls: set ? ('secret' as const) : ('secret-missing' as const),
      tip: [`${name} = ${set ? `${MASK} (secret)` : 'secret not set. Click to set it'}`, where, set ? 'Hold Alt to reveal · click to change' : `vault key ${l.vaultKey}`],
    };
  }
  if (l.value === null || l.kind === 'default') {
    const rem = S.remembered().get(name);
    if (rem !== undefined) return { text: short(rem), cls: 'ok' as const, tip: [`${name} = ${short(rem, 200)}`, 'remembered value (typed when copying). Click to save it'] };
  }
  if (l.value === null) {
    const file = S.nearestFile(path);
    return { text: `{{${name}}}?`, cls: 'missing' as const, tip: [`${name} is not defined`, file ? `not in ${file} or this note. Click to add it` : `no ${S.fileName()} found. Click to create one`] };
  }
  const value = l.value.includes('{{') ? resolveText(l.value, s, { mode: 'display' }).text : l.value;
  const tip = [`${name} = ${short(value, 200)}`, where];
  if (l.shadowed) tip.push(`overridden in this note (${l.shadowed.where} has ${l.shadowed.secret ? MASK : (l.shadowed.value ?? 'no value')})`);
  return { text: short(value), cls: l.kind === 'default' ? ('default' as const) : ('ok' as const), tip };
}

function completionsFor(path: string, fm: string, info: string | null) {
  const s = S.scopeFor(path, fm, info);
  const out = new Map<string, { label: string; detail: string; info?: string; boost?: number }>();
  const add = (name: string, boost: number) => {
    if (out.has(name)) return;
    const l = lookup(s, name);
    if (l.kind === null && !l.secret) return;
    out.set(name, { label: name, detail: l.secret ? MASK : short(l.value ?? '', 40), info: describe(l, s), boost });
  };
  s.fence.forEach((_v, k) => add(k, 6));
  s.note?.vars.forEach((_v, k) => add(k, 5));
  if (s.target) targetFields(s.file, s.env, s.target)?.forEach((_v, k) => add(k, 4));
  if (s.env) s.file?.envs.get(s.env)?.vars.forEach((_v, k) => add(k, 3));
  s.file?.vars.forEach((_v, k) => add(k, 2));
  for (const t of targetNames(s.file, s.env)) targetFields(s.file, s.env, t)?.forEach((_v, k) => add(`${t}.${k}`, 0));
  for (const b of ['date', 'time', 'title', 'target', 'env']) add(b, -1);
  return [...out.values()];
}

/** Where a value can be written: the existing definition, else the sensible new places. */
function placesFor(path: string, s: Scope, l: Lookup): Array<{ label: string; where: 'file' | 'note'; file: string; path: string[]; env: string | null; target: string | null }> {
  const varsFile = S.nearestFile(path) ?? S.fileName();
  if (l.def && (l.kind === 'note' || l.kind === 'target' || l.kind === 'env' || l.kind === 'file')) {
    return [{ label: l.kind === 'note' ? 'this note (frontmatter)' : describe(l, s), where: l.kind === 'note' ? 'note' : 'file', file: l.kind === 'note' ? path : varsFile, path: l.def.path, env: l.def.env, target: l.def.target }];
  }
  const out: ReturnType<typeof placesFor> = [];
  const dot = l.name.lastIndexOf('.');
  if (dot > 0 && targetFields(s.file, s.env, l.name.slice(0, dot))) {
    const t = targetNames(s.file, s.env).find((x) => x.toLowerCase() === l.name.slice(0, dot).toLowerCase())!;
    const top = s.file?.targets.has(t);
    const field = l.name.slice(dot + 1);
    return [{ label: `${varsFile} · target ${t}`, where: 'file', file: varsFile, path: top ? ['targets', t, field] : ['envs', s.env!, 'targets', t, field], env: top ? null : s.env, target: t }];
  }
  out.push({ label: varsFile, where: 'file', file: varsFile, path: ['vars', l.name], env: null, target: null });
  if (s.env) out.push({ label: `${varsFile} · env ${s.env}`, where: 'file', file: varsFile, path: ['envs', s.env, 'vars', l.name], env: s.env, target: null });
  if (s.target && s.file?.targets.has(s.target)) out.push({ label: `${varsFile} · target ${s.target}`, where: 'file', file: varsFile, path: ['targets', s.target, l.name], env: null, target: s.target });
  if (!S.isVarsFile(path)) out.push({ label: 'this note (frontmatter)', where: 'note', file: path, path: ['vars', l.name], env: null, target: null });
  return out;
}

const fail = (err: unknown) => app.toast(String((err as Error)?.message ?? err), 'error', 6000);

/** Writes a value where `place` says; secrets go to the vault and the file only gets a `vault` marker. */
async function writeValue(place: ReturnType<typeof placesFor>[number], name: string, value: string, o: { secret: boolean; isNew: boolean; vaultKey?: string | null }) {
  if (o.secret) {
    const def: VarDef = { name: place.path[place.path.length - 1], value: null, secret: true, vaultKey: null, path: place.path, loc: null, env: place.env, target: place.target };
    await S.vault.set(o.vaultKey ?? vaultKeyFor(def, S.vaultScope(S.nearestFile(place.file) ?? place.file)), value);
    if (!o.isNew) return;
    if (place.where === 'file' && place.path.length === 2 && place.path[0] === 'vars') await S.writeChange(place.file, (t) => addSecretName(t, name));
    else await S.writeChange(place.file, (t) => setValue(t, place.where, place.path, 'vault'));
    return;
  }
  await S.writeChange(place.file, (t) => setValue(t, place.where, place.path, value));
  if (S.remembered().has(name)) S.forget(name);
}

async function editChip(anchor: HTMLElement, path: string, fm: string, info: string | null, name: string) {
  const s = S.scopeFor(path, fm, info);
  const l = lookup(s, name);
  if (l.kind === 'fence') return void app.toast(`${name} comes from the code block’s {…} attribute. Edit it there`, 'info');
  const places = placesFor(path, s, l);
  const isNew = !(l.def && l.kind !== 'builtin' && l.kind !== 'default');
  const has = l.vaultKey ? S.vault.has(l.vaultKey) === true : false;
  const res = await editChipDialog(anchor, {
    name,
    value: l.secret ? '' : (l.kind === 'builtin' || l.kind === 'default' ? '' : (l.value ?? S.remembered().get(name) ?? '')),
    secret: l.secret,
    where: places.map((p) => p.label),
    whereIndex: 0,
    canMakeSecret: isNew,
    hasVaultValue: has,
    shadowNote: l.shadowed ? `Overrides ${l.shadowed.where} (${l.shadowed.secret ? MASK : (l.shadowed.value ?? 'no value')})` : undefined,
  });
  if (!res) return;
  try {
    if (res.remove && l.vaultKey) return void (await S.vault.remove(l.vaultKey));
    await writeValue(places[res.whereIndex] ?? places[0], name, res.value, { secret: res.secret, isNew, vaultKey: l.vaultKey });
  } catch (err) {
    fail(err);
  }
}

function lintView(view: EditorView) {
  const path = view.state.facet(docPath);
  S.ingest(path, view.state.doc.toString());
  const len = view.state.doc.length;
  const diags = S.diagnosticsOf(path).map((d) => ({ from: Math.min(d.from, len), to: Math.min(Math.max(d.to, d.from), len), severity: d.severity, message: d.message, source: S.fileName() }));
  view.dispatch(setDiagnostics(view.state, diags));
}

const provider: VarsProvider = {
  get showValues() {
    return S.showValues();
  },
  skipChips: (path) => S.isVarsFile(path) || inTemplates(path),
  isVarsFile: S.isVarsFile,
  chip: chipFor,
  codeHeader(path, fm, info) {
    const s = S.scopeFor(path, fm, info);
    const lang = parseFenceInfo(info).lang;
    const os = s.target ? targetFields(s.file, s.env, s.target)?.get('os')?.value : null;
    return { os: osMismatch(lang, os), multi: targetNames(s.file, s.env).length > 0 };
  },
  completions: completionsFor,
  editChip: (a, p, fm, i, n) => void editChip(a, p, fm, i, n),
  async reveal(path, fm, info, name) {
    const l = lookup(S.scopeFor(path, fm, info), name);
    if (!l.secret) return l.value;
    return (l.vaultKey ? await S.vault.get(l.vaultKey).catch(() => undefined) : undefined) ?? l.value;
  },
  lintView,
};

// ---- actions (copy / run / for targets) ---------------------------------------------------------

/** Resolves code for an action: secrets from the vault (only now), missing values via the form. */
async function actionText(code: string, ctx: CodeCtx, verb: 'Copy' | 'Run', targets?: string[]): Promise<{ text: string; parts?: Array<{ target: string; text: string }> } | null> {
  await S.prepare(ctx.path);
  const scope = S.scopeFor(ctx.path, S.frontmatterText(ctx.path), ctx.info);
  const lang = parseFenceInfo(ctx.info).lang;
  const input = new Map(S.remembered());
  const secrets = new Map<string, string>();
  const opts = { mode: 'action' as const, input, secret: (k: string) => secrets.get(k) };
  const run = () => (targets ? expandForTargets(code, scope, targets, lang, opts) : { ...resolveText(code, scope, opts), parts: undefined });
  let r = run();
  for (const k of r.secretKeys) {
    const v = await S.vault.get(k).catch(() => undefined);
    if (v !== undefined) secrets.set(k, v);
  }
  r = run();
  if (r.missing.length) {
    const all: Missing[] = [...r.missing, ...r.defaulted];
    const fields = all.map((m) => ({ name: m.name, value: (m.secret ? '' : input.get(m.name)) ?? m.dflt ?? '', secret: m.secret, hint: m.dflt ? `default: ${m.dflt}` : m.secret ? 'secret (kept in the vault)' : undefined }));
    const res = await missingForm(fields, verb, fileLabelFor(ctx.path));
    if (!res) return null;
    const keep = new Map<string, string>();
    for (const [name, value] of res.values) {
      const m = all.find((x) => x.name === name)!;
      if (m.secret && m.vaultKey) {
        secrets.set(m.vaultKey, value);
        await S.vault.set(m.vaultKey, value).catch(fail);
      } else {
        input.set(name, value);
        keep.set(name, value);
      }
    }
    S.remember(keep);
    if (res.save) {
      for (const m of all) {
        const value = res.values.get(m.name);
        // Secrets are declared already (that is how we know they are secret): their value went to the vault.
        if (value === undefined || m.secret) continue;
        const l = lookup(scope, m.name);
        const place = placesFor(ctx.path, scope, l)[0];
        if (place) await writeValue(place, m.name, value, { secret: false, isNew: !l.def }).catch(fail);
      }
    }
    r = run();
  }
  return { text: r.text, parts: 'parts' in r ? r.parts : undefined };
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** A new terminal tab with `text` pasted (Enter is never pressed). */
async function newTerminalWith(text: string, lang: string): Promise<boolean> {
  if ((globalThis as { secEditBridge?: { terminal?: unknown } }).secEditBridge?.terminal) {
    const t = await import('../terminal/entry');
    const s = await t.newTerminal();
    const m = await t.showTerminal({ focus: false, autoStart: false });
    if (s) await m.whenReady(s);
    return m.run(text, { lang, pressEnter: false });
  }
  return (await app.runInTerminal?.(text, { lang, pressEnter: false })) ?? false;
}

export const api: VariablesApi = {
  renderHook(path, opts) {
    if (opts?.export ? S.setting<boolean>('variables.resolveOnExport', true) === false : !S.showValues()) return null;
    if (S.isVarsFile(path) || inTemplates(path)) return null; // definitions / templates stay raw
    const fm = S.frontmatterText(path);
    return (text, info) => (text.includes('{{') ? resolveText(text, S.scopeFor(path, fm, info), { mode: 'display' }).text : text);
  },
  async copyCode(code, ctx) {
    const r = await actionText(code, ctx, 'Copy').catch((err) => (fail(err), null));
    if (!r) return false;
    await writeClipboard(r.text);
    return true;
  },
  async runCode(code, ctx) {
    if (!app.runInTerminal) return void app.toast('Run in terminal needs the desktop app', 'info'), false;
    const r = await actionText(code, ctx, 'Run').catch((err) => (fail(err), null));
    if (!r) return false;
    return app.runInTerminal(r.text, { lang: parseFenceInfo(ctx.info).lang });
  },
  async forTargets(code, ctx) {
    await S.prepare(ctx.path);
    const s = S.scopeFor(ctx.path, S.frontmatterText(ctx.path), ctx.info);
    const lang = parseFenceInfo(ctx.info).lang;
    const names = targetNames(s.file, s.env);
    if (!names.length) return void app.toast(`No targets in ${fileLabelFor(ctx.path)}`, 'info');
    const choices = names.map((n) => ({ name: n, detail: targetSummary(s.file, s.env, n), warn: osMismatch(lang, targetFields(s.file, s.env, n)?.get('os')?.value) }));
    const pick = await targetsDialog(choices, !!app.runInTerminal, s.target);
    if (!pick) return;
    const r = await actionText(code, ctx, pick.how === 'copy' ? 'Copy' : 'Run', pick.targets).catch((err) => (fail(err), null));
    if (!r) return;
    if (pick.how === 'copy') {
      await writeClipboard(r.text);
      app.toast(`Copied ${pick.targets.length} command${pick.targets.length === 1 ? '' : 's'}`, 'success', 2500);
      return;
    }
    for (const p of r.parts ?? []) await newTerminalWith(p.text, lang).catch(fail);
  },
  hasTargets(path) {
    const s = S.scopeFor(path, S.frontmatterText(path), null);
    return targetNames(s.file, s.env).length > 0;
  },
  prepare: S.prepare,
  async saveValues(path, values) {
    await S.prepare(path);
    const renames = new Map<string, string>();
    const varsFile = S.nearestFile(path) ?? S.fileName();
    for (const v of values) {
      const scope = S.scopeFor(path, S.frontmatterText(path), null);
      // Same value already there → reuse the name; a different one → next free name (never overwrite).
      let name = v.name;
      for (let k = 2; ; k++) {
        const l = lookup(scope, name);
        if (l.kind === null || l.kind === 'builtin' || l.kind === 'default') break;
        const cur = l.secret ? ((l.vaultKey ? await S.vault.get(l.vaultKey).catch(() => undefined) : undefined) ?? l.value) : l.value;
        if (cur === v.value) break;
        name = `${v.name}${k}`;
      }
      if (name !== v.name) renames.set(v.name, name);
      const l = lookup(scope, name);
      if (l.kind !== null && l.kind !== 'builtin' && l.kind !== 'default') continue; // same value exists
      const place = { label: varsFile, where: 'file' as const, file: varsFile, path: ['vars', name], env: null, target: null };
      await writeValue(place, name, v.value, { secret: v.secret, isNew: true });
    }
    return renames;
  },
};

// ---- commands -----------------------------------------------------------------------------------

async function openVariablesFile() {
  const p = app.activePath.value;
  const near = p ? S.nearestFile(p) : S.nearestFile('_.md');
  if (near) return app.openFile(near);
  const name = S.fileName();
  try {
    await S.writeChange(name, (t) => setValue(t, 'file', ['vars', 'example'], 'value'));
    await app.openFile(name);
  } catch (err) {
    fail(err);
  }
}

export function installVariables(): void {
  S.installStore();
  app.variables = api;
  setVarsProvider(provider);
  varsStatus.value = VarsStatus;
  S.bump(); // a preview rendered before the chunk arrived shows raw placeholders until now
  const status = () => document.querySelector<HTMLElement>('[data-testid="vars-env"]');
  const hasEnvs = () => envNames(S.fileData(S.nearestFile(app.activePath.value ?? '_.md'))).length > 0;
  const hasTargets = () => (app.activePath.value ? api.hasTargets(app.activePath.value) : false);
  registerCommands([
    {
      id: 'variables.toggleValues',
      title: 'Show values / Show placeholders',
      category: 'Variables',
      keywords: ['placeholders', 'chips', 'raw', '{{', 'resolve'],
      run: () => updateSettings({ 'variables.showValues': !S.showValues() }),
    },
    { id: 'variables.switchEnv', title: 'Switch environment…', category: 'Variables', keywords: ['env', 'lab', 'prod', 'stage'], when: hasEnvs, run: () => openEnvPicker(status()) },
    {
      id: 'variables.switchTarget',
      title: 'Switch target…',
      category: 'Variables',
      keywords: ['host', 'server', 'machine', 'target'],
      when: hasTargets,
      run: () => openTargetPicker(document.querySelector('[data-testid="vars-target"]')),
    },
    { id: 'variables.openFile', title: `Open ${S.fileName()}`, category: 'Variables', keywords: ['variables', 'targets', 'environments', 'yaml'], run: () => void openVariablesFile() },
    {
      id: 'variables.forTargets',
      title: 'Copy / Run code block for targets…',
      category: 'Variables',
      keywords: ['multi', 'hosts', 'servers', 'batch'],
      when: () => !!codeAtCursor() && hasTargets(),
      run: () => {
        const c = codeAtCursor();
        if (c) void api.forTargets(c.code, c.ctx);
      },
    },
  ]);
}

export type { Lookup };
