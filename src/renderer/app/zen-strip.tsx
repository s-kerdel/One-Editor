// Zen mode's edge strips (part of the lazy zen chunk: ./zen-impl re-exports it; Layout draws it through
// the stub's ZenStrip). Left: the sidebar's panels + the zen toggle; right: the file overview, if it was open.
// Imports only what the old zen chunk did (+ icons): a static import back into Shelf / the zen stub made the
// bundler split commands.ts into an extra startup chunk (more startup bytes). So the toggle comes in as `children`.
import type { ComponentChildren } from 'preact';
import { app } from './app';
import * as ui from './ui';
import { Icon, PanelIcon } from './icons';
import { prettyKey } from './commands';
import { persistSession } from './documents';

function showPanel(id: string) {
  app.sidebarPanel.value = id;
  app.sidebarVisible.value = true;
  persistSession();
}

/** Zen: the sidebar (left: its panels + the zen toggle) or the file overview (right) folded into a strip.
 *  A click shows that panel as a peek; again (or back in the text) folds it. */
export function ZenStrip({ right, children }: { right?: boolean; children?: ComponentChildren }) {
  if (right) {
    const on = ui.overviewVisible.value;
    return (
      <nav class="se-zen-strip right" aria-label="File overview strip">
        <button class={`se-zen-strip-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label="File overview" data-testid="zen-strip-overview" title={`File overview (${prettyKey('Mod-Alt-b')})`} onClick={() => void (ui.overviewVisible.value = !on)}>
          <Icon name="ov-panel" size={18} />
        </button>
      </nav>
    );
  }
  const open = app.sidebarVisible.value && app.sidebarPanel.value;
  return (
    <nav class="se-zen-strip left" aria-label="Sidebar strip">
      {ui.menuPanels(app.panels.value, app.settings.value['sidebar.panels'], open).map((p) => {
        const on = open === p.id;
        const keys = ui.PANEL_KEYS[p.id];
        return (
          <button class={`se-zen-strip-btn${on ? ' on' : ''}`} aria-pressed={on} aria-label={p.title} title={keys ? `${p.title} (${prettyKey(keys)})` : p.title} data-panel={p.id} onClick={() => (on ? (app.sidebarVisible.value = false) : showPanel(p.id))}>
            <PanelIcon icon={p.icon} size={18} />
          </button>
        );
      })}
      <span class="se-zen-strip-spacer" />
      {children}
    </nav>
  );
}
