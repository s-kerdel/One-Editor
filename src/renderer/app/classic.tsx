// Classic sidebar style (Settings → Appearance → Sidebar style): IDE-style icon bar + Files header.
// Loaded on demand (and preloaded at boot when it is the saved style); the default "shelf" is ./Shelf.tsx.
import type { WorkspaceInfo } from '@shared/api';
import { app } from './app';
import { Icon, PanelIcon } from './icons';
import './classic.css';
import { persistSession } from './documents';
import { runCommand, prettyKey } from './commands';
import { newNote, startCreate } from './fileops';
import { collapseAll } from './FileTree';
import { openWorkspaceMenu } from './Shelf';

const PANEL_KEYS: Record<string, string> = { search: 'Mod-Shift-f', outline: 'Mod-Alt-o', backlinks: 'Mod-Alt-l' };

export function ActivityBar() {
  const current = app.sidebarPanel.value;
  return (
    <nav class="se-activity" aria-label="Sidebar panels">
      {app.panels.value.map((p) => {
        const active = app.sidebarVisible.value && p.id === current;
        const keys = PANEL_KEYS[p.id];
        return (
          <button
            class={`se-activity-btn${active ? ' active' : ''}`}
            title={keys ? `${p.title} (${prettyKey(keys)})` : p.title}
            aria-label={p.title}
            aria-pressed={active}
            data-panel={p.id}
            onClick={() => {
              // Clicking the open panel collapses the sidebar (IDE convention).
              if (active) app.sidebarVisible.value = false;
              else {
                app.sidebarPanel.value = p.id;
                app.sidebarVisible.value = true;
              }
              persistSession();
            }}
          >
            <PanelIcon icon={p.icon} size={20} />
          </button>
        );
      })}
      <span class="se-activity-spacer" />
      <button
        class="se-activity-btn"
        title="Open folder… / switch to a recent folder"
        aria-label="Switch folder"
        data-testid="classic-switch-folder"
        onClick={(e) => (app.workspace.value ? openWorkspaceMenu(e.currentTarget, 'right') : runCommand('workspace.open'))}
      >
        <Icon name="folderOpen" size={20} />
      </button>
      <button class="se-activity-btn" title={`Settings (${prettyKey('Mod-,')})`} aria-label="Settings" data-testid="open-settings" onClick={() => void runCommand('app.settings')}>
        <Icon name="settings" size={20} />
      </button>
    </nav>
  );
}

export function ClassicFilesHead({ ws }: { ws: WorkspaceInfo }) {
  return (
    <div class="se-panel-head">
      <button class="se-classic-ws" title={`${ws.root}\nClick to open another folder`} aria-label="Switch folder" onClick={(e) => openWorkspaceMenu(e.currentTarget)}>
        <span class="se-panel-title">{ws.name}</span>
        <Icon name="chevronDown" size={12} class="se-classic-ws-caret" />
      </button>
      <span class="se-panel-actions">
        <button class="se-icon-btn" title="New note (Ctrl+N)" aria-label="New note" onClick={() => newNote()}>
          <Icon name="filePlus" size={15} />
        </button>
        <button class="se-icon-btn" title="New folder" aria-label="New folder" onClick={() => startCreate('dir')}>
          <Icon name="folderPlus" size={15} />
        </button>
        <button class="se-icon-btn" title="Collapse all" aria-label="Collapse all" onClick={collapseAll}>
          <Icon name="collapse" size={15} />
        </button>
      </span>
    </div>
  );
}
