// Settings overlay (Mod-,). Rendered from the declarative registry (settings-registry.ts):
// every control applies live and persists through updateSettings() → backend.saveSettings().
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Settings } from '@shared/api';
import { app } from './app';
import { addIcons, Icon } from './icons';
import './icon-pack'; // shell icons the first screen doesn't draw (check, refresh, pencil, …)
import { BuildFooter } from './build-info';
import { listCommands, onCommandsChanged, prettyKey } from './commands';
import { flushSettings, setViewMode, updateSettings, ZOOM_STEPS } from './settings';
import { SECTIONS, SETTINGS, filterSettings, isChanged, parseList, parseNumber, resetPatch, shortcutRows, valueOf, type Choice, type SectionId, type SettingDef } from './settings-registry';
import './overlays.css'; // steppers
import './settings-ui.css';
import { primeClassic } from './classic-loader';
import { lazyComponent } from './lazy';

// Settings → Browser mode: live server state + start / stop (the desktop-only web-server-ui chunk).
const WebServerPanel = lazyComponent(() => import('../webserver/web-server-ui').then((m) => m.SettingsPanel));
// Settings → Security updates: last check, "Check now", what is sent (the desktop-only updates-ui chunk).
const UpdatesPanel = lazyComponent(() => import('../updates/updates-ui').then((m) => m.SettingsPanel));
/** Desktop-only sections (Browser mode) do not exist in the browser build. */
const visibleSections = () => (app.backend.kind === 'electron' ? SECTIONS : SECTIONS.filter((sec) => !sec.desktopOnly));

let pendingSection: SectionId | null = null;
/** The next Settings open scrolls to this section (e.g. the web server dialog's "Port and access…"). */
export const requestSection = (id: SectionId) => void (pendingSection = id);

// Icons only this lazily loaded chunk draws (see addIcons).
addIcons({ shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|M12 8v4|M12 16h.01', history: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8|M3 3v5h5|M12 7v5l4 2', monitor: 'M3 4h18v12H3z|M8 20h8|M12 16v4', keyboard: 'M2 6h20v12H2z|M6 10h.01|M10 10h.01|M14 10h.01|M18 10h.01|M7 14h10', printer: 'M6 9V3h12v6|M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2|M6 14h12v7H6z', globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z' });

type Values = Record<string, unknown>;

function apply(def: SettingDef, value: unknown, debounceMs = 0) {
  // View mode has its own entry point (remembers the last edit mode for Mod-e / Mod-\).
  if (def.key === 'viewMode') setViewMode(value as Settings['viewMode']);
  else updateSettings({ [def.key]: value } as Partial<Settings>, debounceMs);
  indexSettingChanged(def.key);
}

/** Settings that change what the indexers read: rebuild once the backend has them (debounced: typing a number). */
const INDEX_KEYS = new Set(['search.respectGitignore', 'search.skipLockfiles', 'search.skipMinified', 'search.maxFileSizeKB', 'search.workers', 'excludeGlobs', 'showHiddenFiles']);
let staleTimer: ReturnType<typeof setTimeout> | null = null;
function indexSettingChanged(key: string) {
  if (!INDEX_KEYS.has(key)) return;
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => void flushSettings().then(() => app.events.emit('index:stale')), 700);
}

const ZOOM_CHOICES: Choice[] = ZOOM_STEPS.map((z) => ({ v: z, label: `${Math.round(z * 100)}%` }));

function choicesFor(def: SettingDef, current: unknown): Choice[] {
  if (def.control.type !== 'select' && def.control.type !== 'segmented') return [];
  const base = def.key === 'zoom' ? ZOOM_CHOICES : def.control.options;
  // A hand-edited settings file may hold a value we do not offer: show it rather than lie.
  return base.some((o) => o.v === current) ? base : [...base, { v: current, label: def.key === 'zoom' ? `${Math.round(Number(current) * 100)}%` : String(current) }];
}

function describeDefault(def: SettingDef): string {
  const d = def.default;
  if (def.control.type === 'toggle') return d ? 'on' : 'off';
  if (def.control.type === 'color') return def.control.swatches.find((o) => o.v === d)?.label ?? String(d);
  if (def.control.type === 'font') return def.control.presets.find((o) => o.v === d)?.label ?? String(d);
  if (def.control.type === 'select' || def.control.type === 'segmented') return choicesFor(def, d).find((o) => o.v === d)?.label ?? String(d);
  if (Array.isArray(d)) return d.join(', ');
  if (d === null || d === '') return 'empty';
  return String(d) + (def.control.type === 'number' && def.control.unit ? ` ${def.control.unit}` : '');
}

function Control({ def, s, disabled }: { def: SettingDef; s: Values; disabled: boolean }) {
  const c = def.control;
  const value = valueOf(def, s);
  switch (c.type) {
    case 'toggle': {
      const on = value === true;
      return (
        <button id={def.id} class={`se-switch${on ? ' on' : ''}`} role="switch" aria-checked={on} data-setting={def.key} disabled={disabled} onClick={() => apply(def, !on)}>
          <span class="se-switch-knob" />
        </button>
      );
    }
    case 'segmented':
      return (
        <div id={def.id} class="se-seg" role="radiogroup" aria-label={def.label} data-setting={def.key}>
          {choicesFor(def, value).map((o) => (
            <button class={`se-seg-btn${value === o.v ? ' active' : ''}`} role="radio" aria-checked={value === o.v} data-value={String(o.v)} disabled={disabled} onClick={() => apply(def, o.v)}>
              {o.icon && <Icon name={o.icon} size={14} />}
              {o.label}
            </button>
          ))}
        </div>
      );
    case 'select': {
      const options = choicesFor(def, value);
      // Option values are indexes: choices can be null / boolean / number, which <option value> cannot carry.
      return (
        <select
          id={def.id}
          class="se-select"
          data-setting={def.key}
          disabled={disabled}
          value={String(options.findIndex((o) => o.v === value))}
          onChange={(e) => apply(def, options[Number((e.currentTarget as HTMLSelectElement).value)]?.v ?? def.default)}
        >
          {options.map((o, i) => (
            <option value={String(i)}>{o.label}</option>
          ))}
        </select>
      );
    }
    case 'number': {
      const nullable = def.default === null;
      const cur = typeof value === 'number' ? value : null;
      const step = c.step ?? 1;
      // Rounded: 1.65 + 0.05 must not become 1.7000000000000002.
      const bump = (dir: 1 | -1) => apply(def, Math.min(c.max, Math.max(c.min, Math.round(((cur ?? c.min) + dir * step) * 100) / 100)));
      const input = (
        <input
          id={def.id}
          class="se-input narrow"
          type="number"
          data-setting={def.key}
          min={c.min}
          max={c.max}
          step={step}
          placeholder={c.placeholder}
          disabled={disabled}
          value={cur ?? ''}
          onInput={(e) => {
            // Half-typed values ("1" on the way to "120") are simply not applied yet.
            const v = parseNumber((e.currentTarget as HTMLInputElement).value, c, nullable);
            if (v !== undefined && v !== cur) apply(def, v, 300);
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLInputElement).value = cur === null ? '' : String(cur);
          }}
        />
      );
      if (!c.stepper)
        return (
          <div class="se-set-unit">
            {input}
            {c.unit && <span>{c.unit}</span>}
          </div>
        );
      return (
        <div class="se-stepper">
          <button class="se-icon-btn" aria-label="Smaller" disabled={disabled} onClick={() => bump(-1)}>
            −
          </button>
          {input}
          <button class="se-icon-btn" aria-label="Larger" disabled={disabled} onClick={() => bump(1)}>
            +
          </button>
        </div>
      );
    }
    case 'text':
      return (
        <input
          id={def.id}
          class={`se-input${c.mono ? ' mono' : ''}`}
          data-setting={def.key}
          placeholder={c.placeholder}
          spellcheck={false}
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onInput={(e) => apply(def, (e.currentTarget as HTMLInputElement).value, 400)}
        />
      );
    case 'color':
      return <ColorControl def={def} value={typeof value === 'string' ? value : ''} swatches={c.swatches} disabled={disabled} />;
    case 'font':
      return <FontControl def={def} value={typeof value === 'string' ? value : ''} presets={c.presets} placeholder={c.placeholder} disabled={disabled} />;
    case 'list':
      // Keyed on the committed value: a reset (or an external change) replaces the draft.
      return <ListControl key={(value as string[]).join('\n')} def={def} value={Array.isArray(value) ? (value as string[]) : []} disabled={disabled} />;
  }
}

/** Swatch grid + a custom colour well. '' (first swatch) = the theme's own accent. */
function ColorControl({ def, value, swatches, disabled }: { def: SettingDef; value: string; swatches: Choice[]; disabled: boolean }) {
  const v = value.toLowerCase();
  const custom = v !== '' && !swatches.some((o) => o.v === v);
  return (
    <div id={def.id} class="se-swatches" role="radiogroup" aria-label={def.label} data-setting={def.key}>
      {swatches.map((o) => (
        <button
          class={`se-swatch${o.v === v ? ' active' : ''}`}
          role="radio"
          aria-checked={o.v === v}
          aria-label={o.label}
          title={o.label}
          data-value={String(o.v)}
          disabled={disabled}
          // The default swatch shows the theme's built-in accent, whatever is currently applied.
          style={{ '--swatch': o.v ? String(o.v) : 'var(--ft-blue)' }}
          onClick={() => apply(def, o.v)}
        >
          {o.v === v && <Icon name="check" size={13} />}
        </button>
      ))}
      <label class={`se-swatch custom${custom ? ' active' : ''}`} title="Custom colour…" style={custom ? { '--swatch': v } : undefined}>
        <input
          type="color"
          aria-label="Custom accent colour"
          data-testid="accent-custom"
          disabled={disabled}
          value={custom ? v : '#7aa2f7'}
          // Fires continuously while dragging in the OS picker: apply live, save once it settles.
          onInput={(e) => apply(def, (e.currentTarget as HTMLInputElement).value.toLowerCase(), 300)}
        />
        {custom ? <Icon name="check" size={13} /> : <Icon name="plus" size={13} />}
      </label>
    </div>
  );
}

/** Preset fonts + "Custom…" (free text: any installed font or a full CSS font-family list). */
function FontControl({ def, value, presets, placeholder, disabled }: { def: SettingDef; value: string; presets: Choice[]; placeholder?: string; disabled: boolean }) {
  const preset = presets.findIndex((o) => o.v === value);
  // "Custom…" picked but nothing typed yet: the stored value is still a preset.
  const [wantCustom, setWantCustom] = useState(false);
  const custom = preset === -1 || wantCustom;
  const text = useRef<HTMLInputElement>(null);
  return (
    <div class="se-font-control">
      <select
        id={def.id}
        class="se-select"
        data-setting={def.key}
        disabled={disabled}
        value={custom ? 'custom' : String(preset)}
        onChange={(e) => {
          const val = (e.currentTarget as HTMLSelectElement).value;
          setWantCustom(val === 'custom');
          if (val === 'custom') requestAnimationFrame(() => text.current?.focus());
          else apply(def, presets[Number(val)]?.v ?? def.default);
        }}
      >
        {presets.map((o, i) => (
          <option value={String(i)}>{o.label}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <input
          ref={text}
          class="se-input"
          data-setting-text={def.key}
          aria-label="Custom font"
          placeholder={placeholder}
          spellcheck={false}
          disabled={disabled}
          value={preset === -1 ? value : ''}
          onInput={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            // An emptied box stays open (still "Custom"); once it holds text the stored value says so itself.
            setWantCustom(v === '');
            apply(def, v, 400);
          }}
        />
      )}
    </div>
  );
}

function ListControl({ def, value, disabled }: { def: SettingDef; value: string[]; disabled: boolean }) {
  const [draft, setDraft] = useState(value.join(', '));
  return (
    <textarea
      id={def.id}
      class="se-input area"
      data-setting={def.key}
      rows={2}
      spellcheck={false}
      disabled={disabled}
      placeholder={def.control.type === 'list' ? def.control.placeholder : undefined}
      value={draft}
      onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
      onBlur={() => {
        const list = parseList(draft);
        if (list.join('\n') !== value.join('\n')) apply(def, list);
      }}
    />
  );
}

/** Window frame: chosen when the window is created → restart (through the normal close flow, so edits are safe). */
async function restartNow() {
  await flushSettings(); // the new instance must read the new frame
  app.overlay.value = null;
  await app.backend.relaunch?.();
}

function RestartNotice() {
  return (
    <div class="se-set-notice" role="status" data-testid="restart-notice">
      <Icon name="refresh" size={14} />
      <span>Restart sec-edit to switch the window frame. Unsaved changes are saved or asked about first.</span>
      <button class="se-btn small primary" data-testid="restart-now" onClick={() => void restartNow()}>
        Restart now
      </button>
    </div>
  );
}

function SettingRow({ def, s }: { def: SettingDef; s: Values }) {
  const desktopOff = !!def.desktopOnly && !app.backend.setZoom;
  const disabled = desktopOff || (def.enabledWhen ? !def.enabledWhen(s) : false);
  const changed = isChanged(def, s);
  const wide = def.control.type === 'list';
  // The window keeps the frame it was created with until a restart.
  const restart = def.key === 'windowFrame' && !!app.backend.frame && !!app.backend.relaunch && valueOf(def, s) !== app.backend.frame;
  return (
    <div class={`se-set-row${changed ? ' changed' : ''}${disabled ? ' disabled' : ''}${wide ? ' wide' : ''}`} data-row={def.key} title={def.key}>
      <label class="se-set-label" for={def.id}>
        <span class="se-set-name">
          {def.label}
          {changed && <span class="se-set-dot" aria-label="Changed from default" />}
        </span>
        <span class="se-set-hint">{desktopOff ? (def.key === 'zoom' ? 'Desktop app only — use the browser zoom here.' : 'Desktop app only.') : def.description}</span>
      </label>
      <div class="se-set-control">
        <Control def={def} s={s} disabled={disabled} />
      </div>
      <div class="se-set-reset">
        {changed && !desktopOff && (
          <button
            class="se-icon-btn"
            data-reset={def.key}
            aria-label={`Reset ${def.label} to default`}
            title={`Reset to default (${describeDefault(def)})`}
            onClick={(e) => {
              // The button unmounts with the reset; keep the keyboard focus inside the dialog.
              const row = (e.currentTarget as HTMLElement).closest('.se-set-row');
              if (def.key === 'viewMode') setViewMode(def.default as Settings['viewMode']);
              else updateSettings(resetPatch(def) as Partial<Settings>);
              indexSettingChanged(def.key);
              requestAnimationFrame(() => row?.querySelector<HTMLElement>('.se-set-control button:not([disabled]), .se-set-control input, .se-set-control select, .se-set-control textarea')?.focus());
            }}
          >
            <Icon name="history" size={14} />
          </button>
        )}
      </div>
      {restart && <RestartNotice />}
    </div>
  );
}

const ARROWS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
const keyLabel = (k: string) => prettyKey(k).replace(/Arrow(Up|Down|Left|Right)/g, (m) => ARROWS[m]);

function Shortcuts({ query }: { query: string }) {
  const [, tick] = useState(0);
  // Lazy feature modules register their commands after boot.
  useEffect(() => onCommandsChanged(() => tick((n) => n + 1)) as () => void, []);
  const rows = shortcutRows(listCommands({ all: true }), query, prettyKey);
  if (!rows.length) return null;
  let last = '';
  return (
    <section data-section="shortcuts">
      <h3>Keyboard shortcuts</h3>
      <p class="se-set-blurb">Read-only. Every command is also in the palette (Ctrl+Shift+P).</p>
      <table class="se-keytable" data-testid="shortcuts">
        <tbody>
          {rows.map((r) => {
            const head = r.category !== last;
            last = r.category;
            return (
              <>
                {head && (
                  <tr class="se-keytable-cat">
                    <th colSpan={2}>{r.category}</th>
                  </tr>
                )}
                <tr data-command={r.id}>
                  <td>{r.title}</td>
                  <td class="se-keytable-keys">
                    {r.keys.map((k, i) => (
                      <>
                        {i > 0 && <span class="se-keytable-or">or</span>}
                        <kbd>{keyLabel(k)}</kbd>
                      </>
                    ))}
                  </td>
                </tr>
              </>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function SettingsOverlay() {
  const s = app.settings.value as Values;
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<SectionId>('appearance');
  // Captured on first render (before our autofocus effect) so Escape returns focus where it was.
  const returnFocus = useRef<Element | null>(document.activeElement);
  const close = () => {
    app.overlay.value = null;
    requestAnimationFrame(() => {
      const prev = returnFocus.current as HTMLElement | null;
      if (prev && prev !== document.body && prev.isConnected) prev.focus();
      else app.editor?.focus();
    });
  };
  // Settings is where the sidebar style is switched: have classic's parts ready so it lands in one frame.
  useEffect(() => void primeClassic().catch(() => {}), []);
  useEffect(() => {
    search.current?.focus();
  }, []);

  const q = query.trim();
  const sections = visibleSections();
  const matches = useMemo(() => filterSettings(q, SETTINGS.filter((d) => sections.some((sec) => sec.id === d.section))), [q]);
  const bySection = (id: SectionId) => matches.filter((d) => d.section === id);
  const shortcutCount = q ? shortcutRows(listCommands({ all: true }), q, prettyKey).length : 1;
  const count = (id: SectionId) => (id === 'shortcuts' ? shortcutCount : bySection(id).length);
  const nothing = q !== '' && matches.length === 0 && shortcutCount === 0;
  const changedCount = SETTINGS.filter((d) => isChanged(d, s)).length;

  const sectionEl = (id: SectionId) => body.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
  // Rect-based so it does not depend on which ancestor happens to be the offsetParent.
  const topOf = (el: HTMLElement, pane: HTMLElement) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
  const goto = (id: SectionId) => {
    const el = sectionEl(id);
    if (!el || !body.current) return;
    spyPaused.current = true; // the click decides; short trailing sections cannot reach the top
    body.current.scrollTop = topOf(el, body.current);
    setActive(id);
  };
  // Scroll spy: the nav highlights the section at the top of the pane.
  const spyPaused = useRef(false);
  const onScroll = () => {
    const pane = body.current;
    if (!pane) return;
    if (spyPaused.current) return void (spyPaused.current = false);
    let cur: SectionId | null = null;
    for (const sec of sections) {
      const el = sectionEl(sec.id);
      if (!el) continue;
      cur ??= sec.id;
      if (topOf(el, pane) <= pane.scrollTop + 40) cur = sec.id;
    }
    if (cur && cur !== active) setActive(cur);
  };
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
    onScroll();
  }, [q]);
  useEffect(() => {
    const id = pendingSection;
    pendingSection = null;
    if (id) goto(id);
  }, []);

  return (
    <div
      class="se-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <div ref={panel} class="se-settings se-prefs" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings">
        <div class="se-settings-head">
          <Icon name="settings" size={18} />
          <h2>Settings</h2>
          <div class="se-prefs-search">
            <Icon name="search" size={14} />
            <input
              ref={search}
              class="se-input"
              type="text"
              role="searchbox"
              data-testid="settings-search"
              aria-label="Search settings"
              placeholder="Search settings and shortcuts…"
              spellcheck={false}
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
            />
            {query && (
              <button
                class="se-icon-btn tiny"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  search.current?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
          <span class="se-settings-note">Saved automatically</span>
          <button class="se-icon-btn" aria-label="Close settings" title="Close (Esc)" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div class="se-prefs-main">
          <nav class="se-prefs-nav" aria-label="Sections">
            {sections.map((sec) => {
              const n = count(sec.id);
              return (
                <button class={`se-prefs-nav-item${active === sec.id && n > 0 ? ' active' : ''}`} data-nav={sec.id} disabled={n === 0} aria-current={active === sec.id ? 'true' : undefined} onClick={() => goto(sec.id)}>
                  <Icon name={sec.icon} size={15} />
                  <span>{sec.title}</span>
                  {q && n > 0 && <span class="se-prefs-count">{n}</span>}
                </button>
              );
            })}
            {changedCount > 0 && (
              <div class="se-prefs-changed" data-testid="settings-changed-count">
                <span class="se-set-dot" /> {changedCount} changed
              </div>
            )}
            <BuildFooter />
          </nav>
          <div ref={body} class="se-settings-body" onScroll={onScroll}>
            {sections.filter((sec) => sec.id !== 'shortcuts').map((sec) => {
              const rows = bySection(sec.id);
              if (!rows.length) return null;
              return (
                <section data-section={sec.id}>
                  <h3>{sec.title}</h3>
                  {sec.blurb && <p class="se-set-blurb">{sec.blurb}</p>}
                  {sec.id === 'webserver' && <WebServerPanel />}
                  {sec.id === 'updates' && <UpdatesPanel />}
                  {rows.map((def, i) => (
                    <>
                      {def.group && def.group !== rows[i - 1]?.group && <h4 class="se-set-group">{def.group}</h4>}
                      <SettingRow key={def.key} def={def} s={s} />
                    </>
                  ))}
                </section>
              );
            })}
            <Shortcuts query={q} />
            {nothing && (
              <div class="se-prefs-empty" data-testid="settings-empty">
                <strong>No settings match “{q}”</strong>
                <button
                  class="se-link-btn"
                  onClick={() => {
                    setQuery('');
                    search.current?.focus();
                  }}
                >
                  Clear search
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
