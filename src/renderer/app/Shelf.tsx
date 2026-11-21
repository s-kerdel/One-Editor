// The "shelf": sec-edit's sidebar. Deliberately not an IDE activity bar — one calm column with a
// workspace card, a jump pill, a pill switcher for panels and a footer for the everyday actions.
import { app } from './app';
import { Icon, PanelIcon } from './icons';
import { persistSession } from './documents';
import { runCommand, prettyKey } from './commands';
import { updateSettings } from './settings';
import { newNote } from './fileops';
import { PANEL_KEYS, menuPanels, openContextMenu, zen } from './ui';

/** Stable hue per name, so a workspace / top-level folder always gets "its" colour. */
export function hueOf(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function showPanel(id: string) {
  app.sidebarPanel.value = id;
  app.sidebarVisible.value = true;
  persistSession();
}

/** Right-click on a panel pill / classic icon: Hide <panel>, Customize sidebar… (menu built in the lazy Popups chunk). */
export const panelMenu = (e: MouseEvent, id: string) => openContextMenu(e, popups().then((m) => m.panelMenu(id)));

export function hideShelf() {
  app.sidebarVisible.value = false;
}

/** Folder switcher (Open folder… + recent folders): the menu is built in the lazy Popups chunk. */
const popups = () => import('./Popups'); // one call site: its preload list is in the bundle once
export const openWorkspaceMenu = (anchor: HTMLElement, placement?: 'below' | 'right' | 'above', extra?: import('./ui').MenuItem[]) =>
  void popups().then((m) => m.openWorkspaceMenu(anchor, placement, extra));

function ShelfHead() {
  const ws = app.workspace.value;
  const name = ws?.name ?? 'No folder';
  return (
    <div class="se-shelf-head">
      <button class="se-ws" title={ws ? `${ws.root}\nClick to switch folder` : 'Open a folder'} aria-label="Switch folder" onClick={(e) => (ws ? openWorkspaceMenu(e.currentTarget) : runCommand('workspace.open'))}>
        <span class="se-ws-avatar" style={{ '--ws-hue': String(hueOf(name)) }}>
          {name.replace(/[^\p{L}\p{N}]/gu, '').charAt(0).toUpperCase() || '·'}
        </span>
        <span class="se-ws-name" data-testid="workspace-name">
          {name}
        </span>
        <Icon name="chevronDown" size={13} class="se-ws-caret" />
      </button>
      <button class="se-icon-btn" title={`Hide sidebar (${prettyKey('Mod-Shift-b')})`} aria-label="Hide sidebar" onClick={hideShelf}>
        <Icon name="sidebar" size={16} />
      </button>
    </div>
  );
}

function JumpPill() {
  return (
    <button class="se-jump" onClick={() => runCommand('palette.files')} title="Jump to a file, heading or command">
      <Icon name="search" size={14} />
      <span class="se-jump-text">Jump to…</span>
      <kbd>{prettyKey('Mod-p')}</kbd>
    </button>
  );
}

function PanelSwitcher() {
  const current = app.sidebarPanel.value;
  return (
    <nav class="se-nav" role="tablist" aria-label="Sidebar panels">
      {menuPanels(app.panels.value, app.settings.value['sidebar.panels'], current).map((p) => {
        const active = p.id === current;
        const keys = PANEL_KEYS[p.id];
        return (
          <button
            class={`se-nav-btn${active ? ' active' : ''}`}
            role="tab"
            aria-selected={active}
            aria-label={p.title}
            title={keys ? `${p.title} (${prettyKey(keys)})` : p.title}
            data-panel={p.id}
            onClick={() => showPanel(p.id)}
            onContextMenu={(e) => panelMenu(e, p.id)}
          >
            <PanelIcon icon={p.icon} size={16} />
            {active && <span class="se-nav-label">{p.title}</span>}
          </button>
        );
      })}
    </nav>
  );
}

function isDark() {
  const t = app.settings.value.theme;
  return t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function ShelfFoot() {
  const dark = isDark();
  return (
    <div class="se-shelf-foot">
      <button class="se-new-note" onClick={() => newNote()} disabled={!app.workspace.value} title={`New note (${prettyKey('Mod-n')})`}>
        <Icon name="plus" size={15} />
        New note
      </button>
      <ZenButton />
      <button class="se-icon-btn" title={dark ? 'Switch to light theme' : 'Switch to dark theme'} aria-label="Toggle theme" onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })}>
        <Icon name={dark ? 'sun' : 'moon'} size={16} />
      </button>
      <button class="se-icon-btn" title={`Settings (${prettyKey('Mod-,')})`} aria-label="Settings" data-testid="open-settings" onClick={() => void runCommand('app.settings')}>
        <Icon name="settings" size={16} />
      </button>
    </div>
  );
}

export function ShelfTop() {
  return (
    <>
      <ShelfHead />
      <JumpPill />
      <PanelSwitcher />
    </>
  );
}

export { ShelfFoot };

/** The zen toggle (here, the classic icon bar; in zen the strip's foot and the tab strip's end). Runs the command: importing the zen stub
 *  (its import()) from here — or any new module from here or Tabs — made the bundler split startup code into an
 *  extra chunk (a few hundred bytes more, measured). */
export function ZenButton({ cls = 'se-icon-btn', size = 16 }: { cls?: string; size?: number }) {
  const on = !!zen.value;
  return (
    <button class={`${cls} se-zen-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label="Zen mode" data-testid="zen-toggle" title={`${on ? 'Leave zen mode' : 'Zen mode'} (${prettyKey('Mod-Alt-z')})`} onClick={() => void runCommand('view.toggleZen')}>
      <Icon name="zen" size={size} />
    </button>
  );
}

/** Shown at the start of the tab strip while the shelf is hidden. */
export function ShelfReveal() {
  return (
    <button class="se-shelf-reveal" title={`Show sidebar (${prettyKey('Mod-Shift-b')})`} aria-label="Show sidebar" onClick={() => showPanel(app.sidebarPanel.value)}>
      <Icon name="sidebar" size={16} />
    </button>
  );
}
