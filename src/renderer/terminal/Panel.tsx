// Bottom terminal panel. Header: profile tabs · launcher split pill [⊕ badge Default ▾] (▾ = launcher
// card) · tools pill [Find ⋯] · window pill [Maximize ⌄]. Body: find bar, the host the active xterm view
// lives in, and the states: desktop-only note, no folder, profile tiles (no terminal yet), starting.
import { signal } from '@preact/signals';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { app } from '../app/app';
import { addIcons, Icon } from '../app/icons';
import { openContextMenu, type MenuItem } from '../app/ui';
import { isMac, prettyKey } from '../app/commands';
/** macOS: Cmd+` is the OS's "cycle windows"; Ctrl+` (as in VS Code) is what reliably reaches the app. */
const TOGGLE_KEY = isMac ? 'Ctrl-`' : 'Mod-`';
const NEW_KEY = isMac ? 'Ctrl-Shift-`' : 'Mod-Shift-`';
import { updateSettings } from '../app/settings';
import type { ShellKind } from '@shared/terminal';
import type { TerminalBackend } from './backend';
import { ShellBadge } from './badge';
import { writeClipboard } from './clipboard';
import type { Session, TerminalManager } from './manager';
import { PANEL_DEFAULT_HEIGHT, PANEL_MIN_HEIGHT, panelHeight, panelMax, setPanelHeight } from './height';
import { TERMINAL_SETTING_KEYS } from './settings';
import './terminal.css';

// Icons only this lazy chunk draws.
addIcons({
  termTrash: 'M3 6h18|M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6|M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|M10 11v6|M14 11v6',
  termClear: 'M7 21h10|M5 11l7-7 8 8-6 6H9z|M10 8l6 6',
  termCase: 'M3 17l4-10 4 10|M4.5 13.5h5|M15 11.5a2.5 2.5 0 1 1 0 5.5h-.5a2.5 2.5 0 0 1 0-5H18v6',
  termRegex: 'M17 3v10|M12.67 5.5l8.66 5|M12.67 10.5l8.66-5|M6 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  termUp: 'm18 15-6-6-6 6',
  termDown: 'm6 9 6 6 6-6',
  termPaste: 'M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z|M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
  termSelectAll: 'M5 3a2 2 0 0 0-2 2|M19 3a2 2 0 0 1 2 2|M21 19a2 2 0 0 1-2 2|M5 21a2 2 0 0 1-2-2|M9 3h1|M9 21h1|M14 3h1|M14 21h1|M3 9v1|M21 9v1|M3 14v1|M21 14v1',
  termMax: 'M15 3h6v6|M9 21H3v-6|M21 3l-7 7|M3 21l7-7',
  termRestore: 'M4 14h6v6|M20 10h-6V4|M14 10l7-7|M3 21l7-7',
  termRestart: 'M3 12a9 9 0 1 0 3-6.7L3 8|M3 3v5h5',
  termCopyAll: 'M8 8h12v12H8z|M4 16V4h12|M11 12h6|M11 16h4',
  termRename: 'M12 20h9|M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  termLaunch: 'M4 5h16v14H4z|m8 10 2 2-2 2|M13 14h3',
});

const STAR = 'M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.3L12 17.1l-5.6 3 1.1-6.3-4.6-4.4 6.3-.9z';

/** Find bar visibility (Mod+F in a terminal opens it). */
export const findOpen = signal(false);
/** Launcher card (▾ on the launcher pill, "Open new terminal with…", palette). */
export const launcherOpen = signal(false);
/** Tab being renamed inline (from the ⋯ menu / double-click). */
const renaming = signal<number | null>(null);

export interface PanelProps {
  manager: TerminalManager;
  backend: TerminalBackend;
  hasWorkspace: boolean;
  /** Folder name for the empty state. */
  folderName?: string;
  /** Hide the panel (terminals keep running). */
  onHide(): void;
}

// ------------------------------------------------------------------ profiles

export interface LauncherRow {
  key: string;
  name: string;
  detail: string;
  kind: ShellKind | string;
  isDefault: boolean;
  /** Shells can be the default; Claude Code is a preset, not a shell. */
  canDefault: boolean;
  /** Claude Code without the CLI: shows the install command instead of starting. */
  missing?: boolean;
  install?: string;
  launch(): void;
  setDefault?(): void;
}

/** Every profile the launcher card / empty state offers, default first in nothing but its ★. */
export function launcherRows(m: TerminalManager, o: { setDefault?: (id: string, name: string) => void; toast?: (msg: string) => void } = {}): LauncherRow[] {
  const list = m.shells.value;
  const def = m.defaultShellId(list);
  const rows: LauncherRow[] = (list?.shells ?? []).map((s) => ({
    key: s.id,
    name: s.name,
    detail: s.detail ?? s.path,
    kind: s.kind,
    isDefault: s.id === def,
    canDefault: true,
    launch: () => void m.create({ shellId: s.id }),
    setDefault: () => o.setDefault?.(s.id, s.name),
  }));
  const c = list?.claude;
  if (c?.available) rows.push({ key: 'claude', name: 'Claude Code', detail: c.via === 'wsl' ? `AI assistant · in ${c.distro} (WSL)` : 'AI assistant in this folder', kind: 'claude', isDefault: false, canDefault: false, launch: () => void m.create({ preset: 'claude' }) });
  else if (c) rows.push({ key: 'claude', name: 'Claude Code', detail: 'Not installed', kind: 'claude', isDefault: false, canDefault: false, missing: true, install: c.install, launch: () => o.toast?.(c.hint ?? 'Claude Code is not installed') });
  return rows;
}

const setDefaultShell = (id: string, name: string) => {
  updateSettings({ [TERMINAL_SETTING_KEYS.defaultShell]: id });
  app.toast(`${name} is now the default terminal`, 'success', 2200);
};
const rowsFor = (m: TerminalManager) => launcherRows(m, { setDefault: setDefaultShell, toast: (msg) => app.toast(msg, 'info', 9000) });

// ------------------------------------------------------------------ pieces

function Sash({ panel }: { panel: () => HTMLElement | null }) {
  return (
    <div
      class="se-term-sash"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal"
      title="Drag to resize · double-click to reset"
      onDblClick={() => {
        panelMax.value = false;
        setPanelHeight(PANEL_DEFAULT_HEIGHT, true);
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const y0 = e.clientY;
        // Dragging a maximized panel un-maximizes it from where it is.
        const h0 = panelMax.value ? (panel()?.offsetHeight ?? panelHeight.value) : panelHeight.value;
        if (panelMax.value) {
          setPanelHeight(h0);
          panelMax.value = false;
        }
        document.body.classList.add('se-resizing-y');
        const move = (ev: PointerEvent) => setPanelHeight(Math.min(Math.max(PANEL_MIN_HEIGHT, h0 + y0 - ev.clientY), Math.max(PANEL_MIN_HEIGHT, innerHeight - 160)));
        const up = () => {
          document.body.classList.remove('se-resizing-y');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          setPanelHeight(panelHeight.value, true);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function TabButton({ s, active, m }: { s: Session; active: boolean; m: TerminalManager }) {
  const editing = renaming.value === s.id;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const exited = s.status.value === 'exited';
  const commit = (v: string | null) => {
    if (v !== null) m.rename(s.id, v);
    renaming.value = null;
  };
  const menu = (e: MouseEvent) =>
    openContextMenu(e, [
      { label: 'Rename…', icon: 'termRename', run: () => (renaming.value = s.id) },
      { label: 'Restart', icon: 'termRestart', run: () => void m.restart(s.id) },
      { label: 'Kill terminal', icon: 'termTrash', danger: true, run: () => void m.close(s.id) },
    ]);
  const detail = s.shell.detail ?? s.shell.path;
  return (
    <div
      class={`se-term-tab${active ? ' active' : ''}${exited ? ' exited' : ''}`}
      role="tab"
      aria-selected={active}
      data-term-id={s.id}
      title={`${s.shell.name} · ${detail}${s.cwd ? ` · ${s.cwd}` : ''}${exited ? ` · exited (${s.exitCode.value})` : ''}`}
      onClick={() => m.activate(s.id)}
      onAuxClick={(e) => e.button === 1 && void m.close(s.id)}
      onDblClick={() => (renaming.value = s.id)}
      onContextMenu={menu}
    >
      <ShellBadge kind={s.shell.kind} size={18} />
      {editing ? (
        <input
          ref={input}
          class="se-term-rename"
          aria-label="Terminal name"
          value={s.title.value}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
            if (e.key === 'Escape') commit(null);
          }}
          onBlur={(e) => commit((e.target as HTMLInputElement).value)}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span class="se-term-tab-title">{s.title.value}</span>
      )}
      <button
        class="se-term-tab-close"
        type="button"
        aria-label={`Kill terminal ${s.title.value}`}
        title="Kill terminal"
        onClick={(e) => {
          e.stopPropagation();
          void m.close(s.id);
        }}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/** ▾ launcher card: every profile as a row (badge, name, detail), ★ = default. ↑↓ Home End · Enter · D · Esc. */
export function LauncherCard({ anchor, rows, onClose, onRefresh }: { anchor: HTMLElement | null; rows: LauncherRow[]; onClose(refocus: boolean): void; onRefresh(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Record<string, string> | null>(null);
  useLayoutEffect(() => {
    const card = ref.current;
    if (!card) return;
    const a = anchor?.getBoundingClientRect() ?? { top: innerHeight / 2, bottom: innerHeight / 2, right: innerWidth - 16 };
    const h = card.offsetHeight;
    const above = a.top - 12;
    const below = innerHeight - a.bottom - 12;
    // The panel sits low in the window: open upwards unless that space is the smaller one and too small.
    const up = above >= Math.min(h, 360) || above > below;
    const right = `${Math.max(8, innerWidth - a.right)}px`;
    setPos(up ? { right, bottom: `${innerHeight - a.top + 6}px`, maxHeight: `${above}px` } : { right, top: `${a.bottom + 6}px`, maxHeight: `${below}px` });
  }, [anchor]);
  useEffect(() => {
    const card = ref.current;
    // Opened from the palette, the palette hands focus back to the editor right after: take it a few frames later too.
    let tries = 0;
    const grab = () => {
      if (!card || card.contains(document.activeElement)) return;
      (card.querySelector<HTMLElement>('.se-term-lrow.is-default') ?? card.querySelector<HTMLElement>('.se-term-lrow'))?.focus();
      if (++tries < 6) raf = requestAnimationFrame(grab);
    };
    let raf = requestAnimationFrame(grab);
    grab();
    const down = (e: MouseEvent) => !card?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && onClose(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
    };
    const off = () => onClose(false);
    window.addEventListener('mousedown', down, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('resize', off);
    window.addEventListener('blur', off);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('mousedown', down, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('resize', off);
      window.removeEventListener('blur', off);
    };
  }, []);
  const onKey = (e: KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('.se-term-lrow') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const go = (j: number) => items[(j + items.length) % items.length]?.focus();
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? items.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') onClose(true);
    else if ((e.key === 'd' || e.key === 'D') && i >= 0 && !e.ctrlKey && !e.metaKey && !e.altKey) rows.find((r) => r.key === items[i].dataset.key)?.setDefault?.();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div ref={ref} class="se-term-card" role="dialog" aria-label="New terminal" data-testid="terminal-launcher" style={pos ?? { visibility: 'hidden', right: '0px', top: '0px' }} onKeyDown={onKey}>
      <div class="se-term-card-head">
        <span class="se-term-card-title">New terminal</span>
        <span class="se-term-card-keys">↑↓ choose · Enter open · D default</span>
      </div>
      <ul class="se-term-card-list">
        {rows.map((r) => (
          <li key={r.key} class={`se-term-lrow-wrap${r.isDefault ? ' is-default' : ''}${r.missing ? ' is-missing' : ''}`}>
            <button
              type="button"
              class={`se-term-lrow${r.isDefault ? ' is-default' : ''}`}
              data-key={r.key}
              title={r.missing ? r.detail : `Open ${r.name}`}
              onClick={() => {
                r.launch();
                if (!r.missing) onClose(false);
              }}
            >
              <ShellBadge kind={r.kind} size={28} />
              <span class="se-term-lrow-text">
                <span class="se-term-lrow-name">{r.name}</span>
                <span class="se-term-lrow-detail">{r.missing && r.install ? <code>{r.install}</code> : r.detail}</span>
              </span>
              {r.isDefault && <span class="se-term-chip">Default</span>}
            </button>
            {r.canDefault && (
              <button type="button" tabIndex={-1} class={`se-term-star${r.isDefault ? ' on' : ''}`} aria-label={`Set ${r.name} as default`} aria-pressed={r.isDefault} title={r.isDefault ? 'Default profile' : 'Set as default (D)'} onClick={() => r.setDefault?.()}>
                <svg viewBox="0 0 24 24" fill={r.isDefault ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                  <path d={STAR} />
                </svg>
              </button>
            )}
            {r.missing && r.install && (
              <button type="button" class="se-term-copy" title="Copy the install command" onClick={() => void writeClipboard(r.install!).then((ok) => app.toast(ok ? 'Install command copied — run it in a terminal' : 'Could not copy', ok ? 'success' : 'error'))}>
                Copy
              </button>
            )}
          </li>
        ))}
      </ul>
      <div class="se-term-card-foot">
        <button type="button" class="se-term-link" onClick={onRefresh}>
          <Icon name="refresh" size={12} /> Refresh list
        </button>
        <span class="se-term-card-hint">{prettyKey(NEW_KEY)} opens the default</span>
      </div>
    </div>
  );
}

function FindBar({ m }: { m: TerminalManager }) {
  const [q, setQ] = useState('');
  const [caseSensitive, setCase] = useState(false);
  const [regex, setRegex] = useState(false);
  const [res, setRes] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const view = m.active?.view;
  useEffect(() => input.current?.focus(), []);
  useEffect(() => view?.onFindResults(setRes), [view]);
  const opts = { caseSensitive, regex };
  const find = (dir: 1 | -1, query = q) => {
    if (!view) return;
    if (!query) return view.clearFind(), setRes(null);
    if (dir === 1) view.findNext(query, opts);
    else view.findPrevious(query, opts);
  };
  const close = () => {
    view?.clearFind();
    findOpen.value = false;
    view?.focus();
  };
  return (
    <div class="se-term-find" role="search">
      <Icon name="search" size={13} class="se-term-find-icon" />
      <input
        ref={input}
        class="se-term-find-input"
        placeholder="Find in terminal"
        aria-label="Find in terminal"
        value={q}
        onInput={(e) => {
          const v = (e.target as HTMLInputElement).value;
          setQ(v);
          find(1, v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? -1 : 1);
          else if (e.key === 'Escape') close();
          else return;
          e.preventDefault();
        }}
      />
      <span class="se-term-find-count" aria-live="polite">
        {q && res ? (res.count ? `${res.index + 1}/${res.count}` : 'No results') : ''}
      </span>
      <button class={`se-term-fbtn${caseSensitive ? ' on' : ''}`} type="button" title="Match case" aria-pressed={caseSensitive} onClick={() => setCase(!caseSensitive)}>
        <Icon name="termCase" size={14} />
      </button>
      <button class={`se-term-fbtn${regex ? ' on' : ''}`} type="button" title="Regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}>
        <Icon name="termRegex" size={14} />
      </button>
      <button class="se-term-fbtn" type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" onClick={() => find(-1)}>
        <Icon name="termUp" size={14} />
      </button>
      <button class="se-term-fbtn" type="button" title="Next match (Enter)" aria-label="Next match" onClick={() => find(1)}>
        <Icon name="termDown" size={14} />
      </button>
      <button class="se-term-fbtn" type="button" title="Close (Escape)" aria-label="Close find" onClick={close}>
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

/** Right-click in the terminal area. */
export function terminalMenu(m: TerminalManager): MenuItem[] {
  const s = m.active;
  const v = s?.view;
  const mod = (k: string) => prettyKey(k);
  return [
    { label: 'Copy', icon: 'copy', keys: mod('Mod-Shift-c'), disabled: !v?.hasSelection(), run: () => void v?.copySelection() },
    { label: 'Paste', icon: 'termPaste', keys: mod('Mod-Shift-v'), disabled: !v || s?.status.value !== 'running', run: () => void v?.pasteFromClipboard() },
    { label: 'Select all', icon: 'termSelectAll', disabled: !v, run: () => v?.selectAll() },
    { separator: true },
    { label: 'Find…', icon: 'search', keys: mod('Mod-f'), disabled: !v, run: () => (findOpen.value = true) },
    { label: 'Clear', icon: 'termClear', disabled: !v, run: () => v?.clear() },
    { separator: true },
    { label: 'New terminal', icon: 'plus', run: () => void m.create() },
    { label: 'Kill terminal', icon: 'termTrash', danger: true, disabled: !s, run: () => s && void m.close(s.id) },
  ];
}

/** ⋯ in the tools pill. */
export function moreMenu(m: TerminalManager): MenuItem[] {
  const s = m.active;
  return [
    { label: 'Clear', icon: 'termClear', disabled: !s, run: () => s?.view.clear() },
    { label: 'Restart', icon: 'termRestart', disabled: !s, run: () => s && void m.restart(s.id) },
    { label: 'Rename…', icon: 'termRename', disabled: !s, run: () => s && (renaming.value = s.id) },
    {
      label: 'Copy all output',
      icon: 'termCopyAll',
      disabled: !s,
      run: async () => {
        const text = s?.view.allText() ?? '';
        const ok = await writeClipboard(text);
        app.toast(ok ? `Copied ${text ? text.split('\n').length : 0} lines` : 'Could not copy to the clipboard', ok ? 'success' : 'error', 2200);
      },
    },
    { separator: true },
    { label: 'Open new terminal with…', icon: 'termLaunch', run: () => (launcherOpen.value = true) },
    { separator: true },
    { label: 'Kill terminal', icon: 'termTrash', danger: true, disabled: !s, run: () => s && void m.close(s.id) },
  ];
}

function EmptyState({ m, folderName }: { m: TerminalManager; folderName?: string }) {
  const rows = rowsFor(m);
  useEffect(() => void m.ensureClaude(), [m]); // the Claude tile (looked up only when something shows it)
  if (m.starting.value) return <div class="se-term-empty"><span class="se-term-faint">Starting terminal…</span></div>;
  return (
    <div class="se-term-empty" data-testid="terminal-empty">
      <div class="se-term-empty-head">
        <span class="se-term-empty-title">Start a terminal</span>
        <span class="se-term-empty-sub">
          {folderName ? <>in <b>{folderName}</b> · </> : null}
          {prettyKey(NEW_KEY)} opens the default
        </span>
      </div>
      {m.error.value && <span class="se-term-error">{m.error.value}</span>}
      {!m.shells.value ? (
        <span class="se-term-faint">Looking for shells…</span>
      ) : (
        <div class="se-term-tiles">
          {rows.map((r) => (
            <button key={r.key} type="button" class={`se-term-tile${r.isDefault ? ' is-default' : ''}${r.missing ? ' is-missing' : ''}`} data-key={r.key} title={r.missing ? (m.shells.value?.claude?.hint ?? '') : `Open ${r.name} · ${r.detail}`} onClick={() => r.launch()}>
              <ShellBadge kind={r.kind} size={30} />
              <span class="se-term-tile-text">
                <span class="se-term-tile-name">{r.name}</span>
                <span class="se-term-tile-detail">
                  {r.isDefault && <span class="se-term-tile-def">★ Default · </span>}
                  {r.missing && r.install ? <code>{r.install}</code> : r.detail}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ panel

export function TerminalPanel({ manager: m, backend, hasWorkspace, folderName, onHide }: PanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const launcher = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const sessions = m.sessions.value;
  const active = m.active;
  useLayoutEffect(() => {
    m.setHost(host.current);
    return () => {
      m.setHost(null);
      renaming.value = null; // an inline rename never outlives the panel
      launcherOpen.value = false;
    };
  }, [m]);
  useEffect(() => {
    if (backend.available && hasWorkspace) void m.loadShells();
  }, [backend.available, hasWorkspace]);
  const height = panelHeight.value;
  const max = panelMax.value;
  const showLauncher = launcherOpen.value;
  useEffect(() => {
    if (showLauncher && backend.available && hasWorkspace) void m.ensureClaude();
  }, [showLauncher]);
  useEffect(() => m.fit(), [height, max]);

  const ready = backend.available && hasWorkspace;
  const note = !backend.available ? backend.unavailableReason : !hasWorkspace ? 'Open a folder to use the terminal.' : null;
  const rows = ready ? rowsFor(m) : [];
  const def = rows.find((r) => r.isDefault) ?? rows.find((r) => !r.missing);
  const openMore = () => {
    const r = more.current!.getBoundingClientRect();
    openContextMenu({ clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} }, moreMenu(m));
  };

  return (
    <section ref={panel} class={`se-term${max ? ' is-max' : ''}`} style={max ? undefined : { height: `min(${height}px, calc(100% - 120px))` }} aria-label="Terminal" data-testid="terminal-panel">
      <Sash panel={() => panel.current} />
      <header class="se-term-bar">
        <div class="se-term-tabs" role="tablist" aria-label="Terminals">
          {sessions.length ? sessions.map((s) => <TabButton key={s.id} s={s} active={s.id === active?.id} m={m} />) : <span class="se-term-label">Terminal</span>}
        </div>
        <div class="se-term-actions">
          {ready && (
            <div ref={launcher} class="se-term-group se-term-launch">
              <button type="button" class="se-term-gbtn se-term-launch-main" data-testid="terminal-new" title={`New ${def?.name ?? 'terminal'} (${prettyKey(NEW_KEY)})`} onClick={() => void m.create()}>
                <span class="se-term-plus" aria-hidden="true">
                  <Icon name="plus" size={11} />
                </span>
                {def && <ShellBadge kind={def.kind} size={16} />}
                <span class="se-term-launch-name">{def?.name ?? 'Terminal'}</span>
              </button>
              <button
                type="button"
                class={`se-term-gbtn se-term-launch-more${launcherOpen.value ? ' on' : ''}`}
                data-testid="terminal-shells"
                aria-haspopup="dialog"
                aria-expanded={launcherOpen.value}
                aria-label="Choose a profile"
                title="Choose a profile"
                onClick={() => {
                  launcherOpen.value = !launcherOpen.value;
                  if (launcherOpen.value) void m.loadShells();
                }}
              >
                <Icon name="chevronDown" size={13} />
              </button>
            </div>
          )}
          {ready && (
            <div class="se-term-group">
              <button type="button" class={`se-term-gbtn${findOpen.value ? ' on' : ''}`} data-testid="terminal-find" aria-pressed={findOpen.value} aria-label="Find in terminal" title={`Find (${prettyKey('Mod-f')})`} disabled={!active} onClick={() => (findOpen.value = !findOpen.value)}>
                <Icon name="search" size={14} />
              </button>
              <button ref={more} type="button" class="se-term-gbtn" data-testid="terminal-more" aria-haspopup="menu" aria-label="More terminal actions" title="More actions" onClick={openMore}>
                <Icon name="more" size={15} />
              </button>
            </div>
          )}
          <div class="se-term-group">
            <button type="button" class={`se-term-gbtn${max ? ' on' : ''}`} data-testid="terminal-max" aria-pressed={max} aria-label={max ? 'Restore panel size' : 'Maximize panel'} title={max ? 'Restore panel size' : 'Maximize panel'} onClick={() => {
                panelMax.value = !max;
                m.active?.view.focus(); // keep typing where you were
              }}>
              <Icon name={max ? 'termRestore' : 'termMax'} size={14} />
            </button>
            <button type="button" class="se-term-gbtn" data-testid="terminal-hide" aria-label="Hide terminal panel" title={`Hide panel — terminals keep running (${prettyKey(TOGGLE_KEY)})`} onClick={onHide}>
              <Icon name="chevronDown" size={15} />
            </button>
          </div>
        </div>
      </header>
      {launcherOpen.value && ready && (
        <LauncherCard
          anchor={launcher.current}
          rows={rows}
          onRefresh={() => void m.loadShells(true).then(() => m.ensureClaude(true))}
          onClose={(refocus) => {
            launcherOpen.value = false;
            if (refocus) launcher.current?.querySelector<HTMLElement>('.se-term-launch-more')?.focus();
          }}
        />
      )}
      <div class="se-term-body">
        {findOpen.value && active && <FindBar key={active.id} m={m} />}
        <div ref={host} class="se-term-host" onContextMenu={(e) => active && openContextMenu(e, terminalMenu(m))} />
        {note && (
          <div class="se-term-note" data-testid="terminal-note">
            <Icon name="terminal" size={18} />
            <span>{note}</span>
          </div>
        )}
        {!note && !sessions.length && <EmptyState m={m} folderName={folderName} />}
      </div>
    </section>
  );
}
