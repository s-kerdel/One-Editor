// Settings → Appearance → Sidebar menu (setting `sidebar.panels`): every panel with a ⠿ handle to drag, ↑ / ↓
// buttons (or Alt+↑ / ↓ on a focused entry), a checkbox to show / hide it, and Reset to default. Lazy: part of the
// Settings chunk. Writes go through ./panel-menu (unknown ids keep their place, the default stores null).
import { useRef, useState } from 'preact/hooks';
import { app } from './app';
import * as ui from './ui';
import { addIcons, Icon, PanelIcon } from './icons';
import { prettyKey } from './commands';
import { updateSettings } from './settings';
import { fullOrder, readPref, savePanels } from './panel-menu';
import './sidebar-menu.css';

addIcons({ chevronUp: 'M18 15l-6-6-6 6' });

export function SidebarMenuControl({ id }: { id: string }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const stored = app.settings.value['sidebar.panels'];
  const pref = readPref(stored);
  const panels = fullOrder(app.panels.value, pref);
  const ids = panels.map((p) => p.id);
  const hidden = new Set(pref.hidden.filter((x) => ids.includes(x)));
  const shownCount = ids.filter((x) => !hidden.has(x)).length;
  const focusEntry = (pid: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`li[data-panel="${pid}"]`)?.focus());

  const moveTo = (pid: string, to: number) => {
    const from = ids.indexOf(pid);
    if (from < 0 || to < 0 || to >= ids.length || to === from) return;
    const next = ids.filter((x) => x !== pid);
    next.splice(to, 0, pid);
    savePanels(next, hidden);
  };
  const setShown = (pid: string, show: boolean) => {
    const next = new Set(hidden);
    if (show) next.delete(pid);
    else if (shownCount > 1) next.add(pid);
    savePanels(ids, next);
  };

  return (
    <div class="se-sbm" id={id} data-setting="sidebar.panels">
      <ul class="se-sbm-list" ref={listRef} aria-label="Sidebar menu entries">
        {panels.map((p, i) => {
          const shown = !hidden.has(p.id);
          const keys = ui.PANEL_KEYS[p.id];
          const mark = over?.id === p.id && drag !== p.id ? (over.after ? ' drop-after' : ' drop-before') : '';
          return (
            <li
              key={p.id}
              class={`se-sbm-item${shown ? '' : ' off'}${drag === p.id ? ' dragging' : ''}${mark}`}
              data-panel={p.id}
              tabIndex={0}
              draggable
              aria-label={`${p.title}: ${i + 1} of ${ids.length}${shown ? '' : ', hidden'}. Alt+Up / Alt+Down to move.`}
              onKeyDown={(e) => {
                const up = e.key === 'ArrowUp';
                if (!up && e.key !== 'ArrowDown') return;
                if (e.altKey) {
                  e.preventDefault();
                  e.stopPropagation();
                  moveTo(p.id, i + (up ? -1 : 1));
                  focusEntry(p.id);
                } else if (e.target === e.currentTarget) {
                  e.preventDefault();
                  const next = ids[i + (up ? -1 : 1)];
                  if (next) focusEntry(next);
                }
              }}
              onDragStart={(e) => {
                setDrag(p.id);
                e.dataTransfer!.setData('text/plain', p.id);
                e.dataTransfer!.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                e.dataTransfer!.dropEffect = 'move';
                const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const after = e.clientY > box.top + box.height / 2;
                if (over?.id !== p.id || over.after !== after) setOver({ id: p.id, after });
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (drag && drag !== p.id) {
                  const rest = ids.filter((x) => x !== drag);
                  rest.splice(rest.indexOf(p.id) + (over?.after ? 1 : 0), 0, drag);
                  savePanels(rest, hidden);
                }
                setDrag(null);
                setOver(null);
              }}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
            >
              <span class="se-sbm-grip" aria-hidden="true" title="Drag to reorder">
                ⠿
              </span>
              <input
                type="checkbox"
                class="se-sbm-check"
                checked={shown}
                disabled={shown && shownCount <= 1}
                aria-label={`Show ${p.title} in the sidebar menu`}
                title={shown && shownCount <= 1 ? 'At least one entry stays in the menu' : shown ? 'Shown: uncheck to hide' : 'Hidden: check to show'}
                onChange={(e) => setShown(p.id, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span class="se-sbm-icon">
                <PanelIcon icon={p.icon} size={16} />
              </span>
              <span class="se-sbm-name">{p.title}</span>
              {keys && <kbd class="se-sbm-key">{prettyKey(keys)}</kbd>}
              <button class="se-icon-btn small" aria-label={`Move ${p.title} up`} title="Move up (Alt+↑)" disabled={i === 0} onClick={() => moveTo(p.id, i - 1)}>
                <Icon name="chevronUp" size={14} />
              </button>
              <button class="se-icon-btn small" aria-label={`Move ${p.title} down`} title="Move down (Alt+↓)" disabled={i === ids.length - 1} onClick={() => moveTo(p.id, i + 1)}>
                <Icon name="chevronDown" size={14} />
              </button>
            </li>
          );
        })}
      </ul>
      <div class="se-sbm-foot">
        <button class="se-btn small" data-testid="sidebar-menu-reset" disabled={stored == null} onClick={() => updateSettings({ 'sidebar.panels': null })}>
          Reset to default
        </button>
        <span class="se-sbm-note">A hidden panel still opens with its shortcut or from the palette.</span>
      </div>
    </div>
  );
}
