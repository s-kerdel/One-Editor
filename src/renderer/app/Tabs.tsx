// Tab strip: drag to reorder, middle-click to close, context menu, dirty dot, overflow scrolling,
// and on the right the markdown view-mode switch + the file overview toggle.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Settings } from '@shared/api';
import { basename, dirname } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { FileIcon, Icon } from './icons';
import { closeTabs, persistSession } from './documents';
import { absolutePath, copyText, revealInOs, revealInTree, revealLabel } from './fileops';
import { setViewMode, currentWidth, cycleContentWidth } from './settings';
import { prettyKey, runCommand } from './commands';

const TAB_MIME = 'application/x-sec-edit-tab';
const TREE_MIME = 'application/x-sec-edit-paths';

export function closeAll() {
  return closeTabs(app.tabs.value.map((t) => t.path));
}

const tabMenu = (path: string) => import('./Popups').then((m) => m.tabMenu(path));

/** Labels for tabs, adding the folder when two open files share a name. */
function labels(paths: string[]): Map<string, string | null> {
  const byName = new Map<string, number>();
  for (const p of paths) byName.set(basename(p), (byName.get(basename(p)) ?? 0) + 1);
  const out = new Map<string, string | null>();
  for (const p of paths) out.set(p, (byName.get(basename(p)) ?? 0) > 1 ? dirname(p) || '/' : null);
  return out;
}

const MODES: Array<{ id: Settings['viewMode']; icon: string; title: string; keys?: string }> = [
  { id: 'live', icon: 'pencil', title: 'Live preview' },
  { id: 'source', icon: 'code', title: 'Source' },
  { id: 'split', icon: 'columns', title: 'Split', keys: 'Mod-\\' },
  { id: 'preview', icon: 'eye', title: 'Reading view', keys: 'Mod-e' },
];

export function ViewModeSwitch() {
  const mode = app.settings.value.viewMode;
  return (
    <div class="se-modes" role="radiogroup" aria-label="View mode">
      {MODES.map((m) => (
        <button
          class={`se-mode${mode === m.id ? ' active' : ''}`}
          role="radio"
          aria-checked={mode === m.id}
          data-mode={m.id}
          title={m.keys ? `${m.title} (${prettyKey(m.keys)})` : m.title}
          onClick={() => setViewMode(m.id)}
        >
          <Icon name={m.icon} size={15} />
        </button>
      ))}
    </div>
  );
}

/** Shows / hides the file overview column (right sidebar, src/renderer/overview). */
function OverviewToggle() {
  const on = ui.overviewVisible.value;
  return (
    <button
      class={`se-width-btn se-ov-toggle${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label="File overview"
      title={`${on ? 'Hide' : 'Show'} file overview (${prettyKey('Mod-Alt-b')})`}
      onClick={() => void runCommand('view.toggleOverview')}
    >
      <Icon name="ov-panel" size={16} />
    </button>
  );
}

const WIDTH_LABEL = { readable: 'Readable', wide: 'Wide', full: 'Full width' } as const;

/** Markdown text column: readable → wide → full (also Settings → Appearance and "View: Content width…"). */
export function WidthToggle() {
  const w = currentWidth();
  return (
    <button class="se-width-btn" data-testid="content-width" data-width={w} aria-label={`Content width: ${WIDTH_LABEL[w]}`} title={`Content width: ${WIDTH_LABEL[w]} — click to change`} onClick={cycleContentWidth}>
      <Icon name={`w${w}`} size={16} />
    </button>
  );
}

// Path of the tab that took the previous primary mouse-down: a double-click only closes a tab when
// both clicks landed on it (not when closing its neighbour slid it under the pointer).
let lastDown: string | null = null;

export function TabBar() {
  const strip = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ index: number } | null>(null);
  const dragFrom = useRef<number>(-1);
  const tabs = app.tabs.value;
  const active = app.activePath.value;
  const names = labels(tabs.map((t) => t.path));

  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('.se-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const dropIndex = (e: DragEvent) => {
    const els = [...(strip.current?.querySelectorAll<HTMLElement>('.se-tab') ?? [])];
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  return (
    <div class="se-tabbar">
      <div
        ref={strip}
        class="se-tabs"
        role="tablist"
        onWheel={(e) => {
          // Vertical wheel scrolls the overflowing strip sideways.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current!.scrollLeft += e.deltaY;
        }}
        onDragOver={(e) => {
          const types = e.dataTransfer?.types ?? [];
          if (!types.includes(TAB_MIME) && !types.includes(TREE_MIME)) return;
          e.preventDefault();
          setDrop({ index: dropIndex(e) });
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDrop(null);
        }}
        onDrop={(e) => {
          const to = dropIndex(e);
          setDrop(null);
          const dt = e.dataTransfer!;
          if (dt.types.includes(TREE_MIME)) {
            e.preventDefault();
            const paths = JSON.parse(dt.getData(TREE_MIME) || '[]') as string[];
            for (const p of paths) if (app.files.value.includes(p)) void app.openFile(p);
            return;
          }
          const from = dragFrom.current;
          if (from < 0) return;
          e.preventDefault();
          const next = [...app.tabs.value];
          const [moved] = next.splice(from, 1);
          next.splice(to > from ? to - 1 : to, 0, moved);
          app.tabs.value = next;
          persistSession();
        }}
      >
        {tabs.map((t, i) => {
          const doc = app.docs.get(t.path);
          const isActive = active === t.path;
          const dirty = !!doc?.dirty.value;
          const hint = names.get(t.path);
          const conflict = ui.conflicts.value.has(t.path);
          const gone = ui.deletedOnDisk.value.has(t.path);
          return (
            <div
              key={t.path}
              class={`se-tab${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}${gone ? ' deleted' : ''}${conflict ? ' conflict' : ''}${drop?.index === i ? ' drop-before' : ''}${drop?.index === tabs.length && i === tabs.length - 1 ? ' drop-after' : ''}`}
              role="tab"
              aria-selected={isActive}
              title={gone ? `${t.path} (deleted on disk)` : t.path}
              data-path={t.path}
              draggable
              onDragStart={(e) => {
                dragFrom.current = i;
                e.dataTransfer!.setData(TAB_MIME, t.path);
                e.dataTransfer!.setData('text/plain', t.path);
                e.dataTransfer!.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragFrom.current = -1;
                setDrop(null);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault(); // no autoscroll cursor
                else if (e.button === 0) {
                  // Second press of a double-click on this tab's name → close (dirty docs: autosave / ask, as the × does).
                  if (e.detail === 2 && lastDown === t.path) void app.closeTab(t.path);
                  else if (!isActive) void app.openFile(t.path);
                  lastDown = e.detail === 2 ? null : t.path;
                }
              }}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void app.closeTab(t.path);
                }
              }}
              onContextMenu={(e) => ui.openContextMenu(e, tabMenu(t.path))}
            >
              <FileIcon path={t.path} size={14} />
              <span class="se-tab-title">{basename(t.path)}</span>
              {hint && <span class="se-tab-hint">{hint}</span>}
              <button
                class="se-tab-close"
                aria-label={`Close ${basename(t.path)}`}
                title={`Close (${prettyKey('Mod-w')})`}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  lastDown = null;
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  void app.closeTab(t.path);
                }}
              >
                {dirty && <span class="se-tab-dirty" aria-label="Unsaved changes" />}
                <Icon name="close" size={13} class="se-tab-x" />
              </button>
            </div>
          );
        })}
      </div>
      <div class="se-tabbar-tools">
        {ui.isMarkdownView(active) && (
          <>
            <WidthToggle />
            <span class="se-tools-sep" />
            <ViewModeSwitch />
            <span class="se-tools-sep" />
          </>
        )}
        <OverviewToggle />
      </div>
    </div>
  );
}
