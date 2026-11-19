// Terminal implementation: manager + panel wired to the app (created on first use by ./entry).
// xterm.js is its own chunk (./view), fetched when the first terminal is created — the browser build never loads it.
import { h, type ComponentType } from 'preact';
import { isExternalUrl } from '@shared/api';
import { app } from '../app/app';
import { confirmDialog } from '../app/ui';
import type { TerminalBackend } from './backend';
import { TerminalManager } from './manager';
import { findOpen, TerminalPanel } from './Panel';
import { readTerminalSettings } from './settings';
import { panelOpen } from './state';
import { canvasColorResolver, readTerminalTheme, sameTheme, watchTheme, type TermTheme } from './theme';
import type { TerminalViewOptions } from './types';

export interface TerminalImpl {
  manager: TerminalManager;
  PanelSlot: ComponentType;
  hide(): void;
}

export function createTerminalImpl(backend: TerminalBackend, o: { onHide: () => void }): TerminalImpl {
  // Token probe: the --se-term-* variables only apply inside .se-term (the panel may not be mounted yet).
  const probe = document.createElement('div');
  probe.className = 'se-term';
  probe.hidden = true;
  probe.setAttribute('aria-hidden', 'true');
  document.body.append(probe);
  const resolve = canvasColorResolver();
  let theme: TermTheme | null = null;
  const readTheme = () => (theme = readTerminalTheme(probe, resolve));

  let filesSrc: string[] | null = null;
  let filesSet: ReadonlySet<string> = new Set();
  const files = () => {
    const now = app.files.value;
    if (now !== filesSrc) (filesSrc = now), (filesSet = new Set(now));
    return filesSet;
  };
  const mono = () => getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace';

  const manager = new TerminalManager({
    backend,
    os: app.backend?.os ?? 'linux',
    createView: async (vo: TerminalViewOptions) => (await import('./view')).createXtermView(vo),
    settings: () => readTerminalSettings(app.settings.value),
    workspaceRoot: () => app.workspace.value?.root ?? null,
    files,
    openFile: (path, at) => void app.openFile(path, at).catch((err) => app.toast(String((err as Error)?.message ?? err), 'error')),
    // Web / mail only: never file:, javascript: or Windows protocol handlers printed by a program.
    openUrl: (url) => void (isExternalUrl(url) && app.backend.openExternal(url)),
    toast: (m, kind) => app.toast(m, kind),
    confirm: (title, message, ok) => confirmDialog(title, message, ok),
    fontFamily: mono,
    theme: () => theme ?? readTheme(),
    onFind: () => (findOpen.value = true),
    onEmpty: () => o.onHide(),
  });

  // Live re-theme (dark/light/system/accent) and settings.
  watchTheme(() => {
    const before = theme;
    if (!sameTheme(before, readTheme())) manager.applyTheme();
  });
  let lastRoot = app.workspace.value?.root ?? null;
  app.events.on('settings:changed', () => {
    manager.applySettings();
    manager.applyFont();
  });
  // Shells started in the previous folder must not linger (main kills them too).
  app.events.on('workspace:opened', (ws) => {
    if (ws.root === lastRoot) return;
    lastRoot = ws.root;
    void manager.closeAll();
  });

  const PanelSlot: ComponentType = () => h(TerminalPanel, { manager, backend, hasWorkspace: !!app.workspace.value, folderName: app.workspace.value?.name, onHide: o.onHide });
  (globalThis as { __secEditTerminal?: unknown }).__secEditTerminal = { manager, backend, panelOpen }; // E2E / debugging
  return { manager, PanelSlot, hide: o.onHide };
}
