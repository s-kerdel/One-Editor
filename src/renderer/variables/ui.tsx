// {{variables}} UI (lazy chunk): status-bar pills (environment, target), the chip editor, the
// missing-values form and the "Copy / Run for targets…" dialog. Dialogs use the shell's overlay slot
// and its .se-dialog styling; switchers use the shared picker (Popups chunk).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { app } from '../app/app';
import { Icon } from '../app/icons';
import * as ui from '../app/ui';
import { activeEnv, activeTarget, dangerPattern, fileData, frontmatterText, nearestFile, noteMeta, setWsState, version } from './store';
import { envNames, isDangerEnv, targetFields, targetNames } from './resolve';

// ---- modal helper -------------------------------------------------------------------------------

/** Shows `render` in the overlay slot until it calls `close(value)`; focus goes back where it was. */
export function openModal<T>(render: (close: (v: T | null) => void) => JSX.Element): Promise<T | null> {
  const back = document.activeElement as HTMLElement | null;
  return new Promise((resolve) => {
    let done = false;
    const close = (v: T | null) => {
      if (done) return;
      done = true;
      if (app.overlay.value === Modal) app.overlay.value = null;
      resolve(v);
      queueMicrotask(() => (back && back.isConnected && back !== document.body ? back.focus() : app.editor?.focus()));
    };
    function Modal() {
      return render(close);
    }
    app.overlay.value = Modal;
  });
}

const stop = (e: Event) => e.stopPropagation();

// ---- status bar ---------------------------------------------------------------------------------

/** Context of the status-bar pills: the active note (or the folder root without one). */
function pillContext() {
  version.value; // re-render on data / selection changes
  const path = app.activePath.value;
  const varsPath = nearestFile(path ?? '_.md');
  const file = fileData(varsPath);
  const meta = path ? noteMeta(frontmatterText(path)) : null;
  return { path, varsPath, file, meta, env: meta?.env ?? activeEnv(), target: meta?.target ?? activeTarget() };
}

export function openEnvPicker(anchor?: Element | null) {
  const c = pillContext();
  const cur = activeEnv();
  ui.picker.value = {
    title: c.meta?.env ? `Switch environment (this note uses ${c.meta.env})` : 'Switch environment',
    anchor,
    items: [
      { label: 'No environment', detail: 'top-level vars only', checked: !cur, run: () => setWsState({ env: null }) },
      ...envNames(c.file).map((e, i) => ({ label: e, detail: isDangerEnv(e, dangerPattern()) ? 'production' : undefined, checked: e === cur, separator: i === 0, run: () => setWsState({ env: e }) })),
    ],
  };
}

export function openTargetPicker(anchor?: Element | null) {
  const c = pillContext();
  const cur = activeTarget();
  ui.picker.value = {
    title: c.meta?.target ? `Switch target (this note uses ${c.meta.target})` : 'Switch target',
    anchor,
    items: [
      { label: 'No target', checked: !cur, run: () => setWsState({ target: null }) },
      ...targetNames(c.file, c.env).map((t, i) => ({ label: t, detail: targetSummary(c.file, c.env, t), checked: t === cur, separator: i === 0, run: () => setWsState({ target: t }) })),
    ],
  };
}

export function targetSummary(file: ReturnType<typeof fileData>, env: string | null, t: string): string {
  const f = targetFields(file, env, t);
  if (!f) return '';
  return [f.get('ip')?.value ?? f.get('host')?.value, f.get('os')?.value].filter(Boolean).join(' · ');
}

const Crosshair = () => (
  <svg class="se-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8" />
    <path d="M12 2v5M12 17v5M2 12h5M17 12h5" />
  </svg>
);

export function VarsStatus() {
  const c = pillContext();
  const envs = envNames(c.file);
  const targets = targetNames(c.file, c.env);
  if (!envs.length && !targets.length && !c.env && !c.target) return null;
  const danger = isDangerEnv(c.env, dangerPattern());
  const fromNote = (k: 'env' | 'target') => (c.meta?.[k] ? ', set by this note’s frontmatter' : '');
  return (
    <>
      {(envs.length > 0 || c.env) && (
        <button
          class={`se-status-item se-status-btn se-vars-pill${danger ? ' is-danger' : ''}${c.meta?.env ? ' is-note' : ''}`}
          data-testid="vars-env"
          aria-haspopup="listbox"
          title={`Environment: ${c.env ?? 'none'}${fromNote('env')}${danger ? ' (production!)' : ''}. Click to switch`}
          onClick={(e) => openEnvPicker(e.currentTarget)}
        >
          env: {c.env ?? 'none'}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
      {(targets.length > 0 || c.target) && (
        <button
          class={`se-status-item se-status-btn se-vars-pill${c.meta?.target ? ' is-note' : ''}`}
          data-testid="vars-target"
          aria-haspopup="listbox"
          title={`Target: ${c.target ?? 'none'}${c.target ? ` (${targetSummary(c.file, c.env, c.target) || 'not defined here'})` : ''}${fromNote('target')}. Click to switch`}
          onClick={(e) => openTargetPicker(e.currentTarget)}
        >
          <Crosshair />
          {c.target ?? 'no target'}
          <Icon name="chevronDown" size={11} />
        </button>
      )}
    </>
  );
}

// ---- chip editor --------------------------------------------------------------------------------

export interface ChipEditSpec {
  name: string;
  /** Current value (never a secret's). */
  value: string;
  secret: boolean;
  /** Where it will be written, e.g. "variables.md · env lab". */
  where: string[];
  /** Index into `where` preselected. */
  whereIndex: number;
  /** Offer "keep in the vault" (new definitions only). */
  canMakeSecret: boolean;
  hasVaultValue: boolean;
  shadowNote?: string;
}

export interface ChipEditResult {
  value: string;
  whereIndex: number;
  secret: boolean;
  remove?: boolean;
}

export function editChipDialog(anchor: HTMLElement, spec: ChipEditSpec): Promise<ChipEditResult | null> {
  const r = anchor.getBoundingClientRect();
  return openModal<ChipEditResult>((close) => <ChipEditor rect={r} spec={spec} close={close} />);
}

function ChipEditor({ rect, spec, close }: { rect: DOMRect; spec: ChipEditSpec; close: (v: ChipEditResult | null) => void }) {
  const [value, setValue] = useState(spec.value);
  const [where, setWhere] = useState(spec.whereIndex);
  const [secret, setSecret] = useState(spec.secret);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 320;
    const h = box.current?.offsetHeight ?? 160;
    setPos({ left: Math.max(8, Math.min(innerWidth - w - 8, rect.left)), top: rect.bottom + 6 + h > innerHeight ? Math.max(8, rect.top - h - 6) : rect.bottom + 6 });
  }, []);
  useLayoutEffect(() => {
    if (pos) (input.current?.focus(), input.current?.select());
  }, [pos]);
  const submit = (e?: Event) => {
    e?.preventDefault();
    close({ value, whereIndex: where, secret });
  };
  return (
    <>
      <div class="se-picker-backdrop" onMouseDown={() => close(null)} />
      <div
        ref={box}
        class="se-var-editor"
        role="dialog"
        aria-label={`Edit ${spec.name}`}
        data-testid="var-editor"
        style={{ left: `${pos?.left ?? 0}px`, top: `${pos?.top ?? 0}px`, visibility: pos ? 'visible' : 'hidden' }}
        onKeyDown={(e) => {
          stop(e);
          if (e.key === 'Escape') (e.preventDefault(), close(null));
        }}
      >
      <form onSubmit={submit}>
        <div class="se-var-editor-head">
          <code>{`{{${spec.name}}}`}</code>
          {spec.secret && <span class="se-var-badge">secret</span>}
        </div>
        <input
          ref={input}
          class="se-input"
          aria-label="Value"
          type={(secret ? 'password' : 'text') as 'text'}
          placeholder={secret ? (spec.hasVaultValue ? '•••• (set, type to replace)' : 'Secret value') : 'Value'}
          spellcheck={false}
          autoComplete="off"
          value={value}
          onInput={(e) => setValue((e.currentTarget as HTMLInputElement).value)}
        />
        {spec.where.length > 1 ? (
          <label class="se-var-editor-row">
            Save to
            <select class="se-input" aria-label="Save to" value={String(where)} onChange={(e) => setWhere(Number((e.currentTarget as HTMLSelectElement).value))}>
              {spec.where.map((w, i) => (
                <option value={String(i)}>{w}</option>
              ))}
            </select>
          </label>
        ) : (
          <div class="se-var-editor-row se-var-editor-where">Saves to {spec.where[0]}</div>
        )}
        {spec.shadowNote && <div class="se-var-editor-row se-var-editor-where">{spec.shadowNote}</div>}
        {spec.canMakeSecret && (
          <label class="se-var-editor-check">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret((e.currentTarget as HTMLInputElement).checked)} />
            Secret: keep the value in the {app.backend.kind === 'electron' ? 'encrypted vault' : 'session (desktop app: encrypted vault)'}
          </label>
        )}
        <div class="se-dialog-buttons">
          {spec.secret && spec.hasVaultValue && (
            <button type="button" class="se-btn danger" onClick={() => close({ value: '', whereIndex: where, secret: true, remove: true })}>
              Remove secret
            </button>
          )}
          <button type="button" class="se-btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" class="se-btn primary" disabled={spec.secret && !value}>
            Save
          </button>
        </div>
      </form>
      </div>
    </>
  );
}

// ---- missing values -----------------------------------------------------------------------------

export interface FormField {
  name: string;
  value: string;
  secret: boolean;
  /** Already has a default / remembered value (shown as such). */
  hint?: string;
}

export interface FormResult {
  values: Map<string, string>;
  save: boolean;
}

export function missingForm(fields: FormField[], action: string, fileLabel: string): Promise<FormResult | null> {
  return openModal<FormResult>((close) => <MissingForm fields={fields} action={action} fileLabel={fileLabel} close={close} />);
}

function MissingForm({ fields, action, fileLabel, close }: { fields: FormField[]; action: string; fileLabel: string; close: (v: FormResult | null) => void }) {
  const [values, setValues] = useState(() => new Map(fields.map((f) => [f.name, f.value])));
  const [save, setSave] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => first.current?.focus(), []);
  const empty = fields.filter((f) => !values.get(f.name));
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div
        class="se-dialog se-vars-form"
        role="dialog"
        aria-modal="true"
        aria-label="Fill in variables"
        data-testid="vars-form"
        onKeyDown={(e) => {
          stop(e);
          if (e.key === 'Escape') (e.preventDefault(), close(null));
        }}
      >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!empty.length) close({ values, save });
        }}
      >
        <h2 class="se-dialog-title">
          {fields.length === 1 ? `1 value is missing` : `${fields.length} values are missing`}
        </h2>
        <p class="se-dialog-msg">Fill them in to {action.toLowerCase()} the command. They are remembered for this folder.</p>
        <div class="se-vars-fields">
          {fields.map((f, i) => (
            <label class="se-vars-field">
              <span class="se-vars-field-name">
                {f.name}
                {f.secret && <Icon name="lock" size={11} />}
              </span>
              <input
                ref={i === 0 ? first : undefined}
                class="se-input"
                name={f.name}
                type={(f.secret ? 'password' : 'text') as 'text'}
                spellcheck={false}
                autoComplete="off"
                placeholder={f.hint}
                value={values.get(f.name) ?? ''}
                onInput={(e) => setValues(new Map(values).set(f.name, (e.currentTarget as HTMLInputElement).value))}
              />
            </label>
          ))}
        </div>
        <label class="se-vars-check">
          <input type="checkbox" checked={save} onChange={(e) => setSave((e.currentTarget as HTMLInputElement).checked)} />
          Save to {fileLabel}
          <span class="se-vars-check-hint">{fields.some((f) => f.secret) ? ' (secrets go to the vault, not the file)' : ''}</span>
        </label>
        <div class="se-dialog-buttons">
          <button type="button" class="se-btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" class="se-btn primary" disabled={empty.length > 0}>
            {action}
          </button>
        </div>
      </form>
      </div>
    </div>
  );
}

// ---- multi-target -------------------------------------------------------------------------------

export interface TargetChoice {
  name: string;
  detail: string;
  warn?: string | null;
}

export interface TargetsResult {
  targets: string[];
  how: 'copy' | 'run';
}

export function targetsDialog(choices: TargetChoice[], canRun: boolean, preselect: string | null): Promise<TargetsResult | null> {
  return openModal<TargetsResult>((close) => <TargetsDialog choices={choices} canRun={canRun} preselect={preselect} close={close} />);
}

function TargetsDialog({ choices, canRun, preselect, close }: { choices: TargetChoice[]; canRun: boolean; preselect: string | null; close: (v: TargetsResult | null) => void }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(preselect ? [preselect] : []));
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? choices.filter((c) => c.name.toLowerCase().includes(q) || c.detail.toLowerCase().includes(q)) : choices;
  }, [query, choices]);
  const toggle = (n: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(n);
    else next.delete(n);
    setPicked(next);
  };
  const list = choices.filter((c) => picked.has(c.name)).map((c) => c.name);
  const n = list.length;
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
      <div
        class="se-dialog se-vars-targets"
        role="dialog"
        aria-modal="true"
        aria-label="Copy or run for targets"
        data-testid="vars-targets"
        onKeyDown={(e) => {
          stop(e);
          if (e.key === 'Escape') close(null);
          else if (e.key === 'Enter' && n && (e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type === 'search') close({ targets: list, how: 'copy' });
        }}
      >
        <h2 class="se-dialog-title">Copy / Run for targets</h2>
        <input ref={search} class="se-input" type="search" placeholder="Filter targets…" aria-label="Filter targets" value={query} onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
        <div class="se-vars-target-tools">
          <button type="button" class="se-btn small" onClick={() => setPicked(new Set([...picked, ...shown.map((c) => c.name)]))}>
            Select all
          </button>
          <button type="button" class="se-btn small" onClick={() => setPicked(new Set())}>
            None
          </button>
        </div>
        <div class="se-vars-target-list" role="group" aria-label="Targets">
          {shown.map((c) => (
            <label class="se-vars-target-row">
              <input type="checkbox" checked={picked.has(c.name)} onChange={(e) => toggle(c.name, (e.currentTarget as HTMLInputElement).checked)} />
              <span class="se-vars-target-name">{c.name}</span>
              <span class="se-vars-target-detail">{c.detail}</span>
              {c.warn && (
                <span class="se-var-os" title={c.warn}>
                  <Icon name="alert" size={11} /> {c.warn}
                </span>
              )}
            </label>
          ))}
          {!shown.length && <div class="se-picker-empty">No match</div>}
        </div>
        <div class="se-dialog-buttons">
          <button type="button" class="se-btn" onClick={() => close(null)}>
            Cancel
          </button>
          {canRun && (
            <button type="button" class="se-btn" disabled={!n} onClick={() => close({ targets: list, how: 'run' })}>
              Open {n || ''} terminal{n === 1 ? '' : 's'}
            </button>
          )}
          <button type="button" class="se-btn primary" disabled={!n} onClick={() => close({ targets: list, how: 'copy' })}>
            Copy {n || ''} command{n === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}
