// Tab strip: drag to reorder, middle-click to close, context menu, dirty dot, overflow scrolling,
// and on the right the markdown view-mode switch + the file overview toggle (+ leave zen, in zen).
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { basename, dirname } from '@shared/paths';
import { app } from './app';
import * as ui from './ui';
import { FileIcon, Icon } from './icons';
import { closeTabs, persistSession } from './documents';
import { prettyKey, runCommand } from './commands';
import { lazyComponent } from './lazy';
import { popups } from './fileops';

const TAB_MIME = 'application/x-sec-edit-tab';
const TREE_MIME = 'application/x-sec-edit-paths';

export function closeAll() {
  return closeTabs(app.tabs.value.map((t) => t.path));
}

const tabMenu = (path: string) => popups().then((m) => m.tabMenu(path));

/** Labels for tabs, adding the folder when two open files share a name. */
function labels(paths: string[]): Map<string, string | null> {
  const byName = new Map<string, number>();
  for (const p of paths) byName.set(basename(p), (byName.get(basename(p)) ?? 0) + 1);
  const out = new Map<string, string | null>();
  for (const p of paths) out.set(p, (byName.get(basename(p)) ?? 0) > 1 ? dirname(p) || '/' : null);
  return out;
}

/** Markdown view: content width + view-mode switch (lazy ./doc-chrome, preloaded with the first file). */
export const TabDocTools = lazyComponent(() => import('./doc-chrome').then((m) => m.TabDocTools));

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

// Path of the tab that took the previous primary mouse-down: a double-click only closes a tab when
// both clicks landed on it (not when closing its neighbour slid it under the pointer).
let lastDown: string | null = null;

/** `end`: after the tools (zen: Layout's leave-zen button; passed in because a new import here splits startup code, see Shelf.tsx). */
export function TabBar({ end }: { end?: ComponentChildren }) {
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
        {/* Empty end of the strip: drags the window with the integrated frame (styles/app.css). */}
        <div class="se-tabs-end" aria-hidden="true" />
      </div>
      <div class="se-tabbar-tools">
        {ui.isMarkdownView(active) && <TabDocTools />}
        <OverviewToggle />
        {end}
      </div>
    </div>
  );
}
