// Root layout: the shelf (sidebar: workspace, jump pill, panel switcher, panel, footer) beside a
// raised content card (tabs · editor · status bar), and optionally the file overview on the right.
import { app } from './app';
import * as ui from './ui';
import { persistSession } from './documents';
import { TabBar } from './Tabs';
import { EditorArea } from './EditorArea';
import { StatusBar } from './StatusBar';
import { lazyComponent, onIdle } from './lazy';
import { ShelfTop, ShelfFoot, ShelfReveal } from './Shelf';
import { loadClassic, setClassicPrimer } from './classic-loader';
import { panelOpen as terminalOpen, TerminalPanelSlot } from '../terminal/install';
import { OverviewPanelLazy as OverviewPanel } from '../overview';

const ActivityBar = lazyComponent(() => loadClassic().then((m) => m.ActivityBar));

/** Classic style: resolve its lazy parts before the first render so the activity bar and the Files
 *  header are in the very first frame (otherwise they pop in one frame later and shove the layout). */
export const preloadClassicUi = () => Promise.all([ActivityBar.preload(), ClassicFilesHead.preload()]);
setClassicPrimer(preloadClassicUi);

/** Sidebar style (Settings → Appearance): 'shelf' (default) or IDE-like 'classic'. */
export const isClassic = () => app.settings.value.sidebarStyle === 'classic';

export { FilesPanel } from './FileTree';
import { ClassicFilesHead } from './FileTree';

// Dialogs, context menus, the Ctrl-Tab switcher and the drop target only exist after a user action: keep them out of the startup chunk.
const loadPopups = () => import('./Popups');
const DialogHost = lazyComponent(() => loadPopups().then((m) => m.DialogHost));
const ContextMenuHost = lazyComponent(() => loadPopups().then((m) => m.ContextMenuHost));
const TabSwitcher = lazyComponent(() => loadPopups().then((m) => m.TabSwitcher));
const DropOverlay = lazyComponent(() => loadPopups().then((m) => m.DropOverlay));
const PickerHost = lazyComponent(() => loadPopups().then((m) => m.PickerHost));
const ToastList = lazyComponent(() => loadPopups().then((m) => m.ToastList));
/** Warm the chunk so the first right-click / dialog is instant. */
// preload() also resolves the components, so the first right-click / dialog renders in the same frame
// (and the menu can take focus at once) instead of mounting one render later.
export const preloadPopups = () =>
  onIdle(() => void Promise.all([DialogHost, ContextMenuHost, TabSwitcher, DropOverlay, ToastList].map((c) => c.preload())).catch(() => {}));

// Both side columns resize the same way; the overview sits on the right, so it grows leftwards.
const SASHES = {
  sidebar: { label: 'Resize sidebar', width: ui.sidebarWidth, initial: ui.SIDEBAR_DEFAULT, dir: 1, min: 170, max: () => Math.min(640, innerWidth - 320), shown: app.sidebarVisible },
  overview: { label: 'Resize file overview', width: ui.overviewWidth, initial: ui.OVERVIEW_DEFAULT, dir: -1, min: ui.OVERVIEW_MIN, max: () => Math.min(ui.OVERVIEW_MAX, innerWidth - 360), shown: ui.overviewVisible },
};

function Sash({ of }: { of: keyof typeof SASHES }) {
  const s = SASHES[of];
  return (
    <div
      class="se-sash"
      role="separator"
      aria-orientation="vertical"
      aria-label={s.label}
      title="Drag to resize · double-click to reset"
      onDblClick={() => {
        s.width.value = s.initial;
        persistSession();
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const startX = e.clientX;
        const startW = s.width.value;
        document.body.classList.add('se-resizing-x');
        const move = (ev: PointerEvent) => {
          const w = startW + s.dir * (ev.clientX - startX);
          // Drag far enough towards the window edge and the column tucks away.
          if (w < 120) s.shown.value = false;
          else {
            s.shown.value = true;
            s.width.value = Math.round(Math.min(Math.max(s.min, w), s.max()));
          }
        };
        const up = () => {
          document.body.classList.remove('se-resizing-x');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          persistSession();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }}
    />
  );
}

function Sidebar({ classic }: { classic: boolean }) {
  const panels = app.panels.value;
  const current = panels.find((p) => p.id === app.sidebarPanel.value) ?? panels[0];
  const Panel = current?.component;
  return (
    <aside class={`se-sidebar${classic ? '' : ' se-shelf'}`} style={{ width: `${ui.sidebarWidth.value}px` }} data-panel={current?.id} aria-label={current?.title}>
      {!classic && <ShelfTop />}
      <div class="se-sidebar-body">{Panel && <Panel />}</div>
      {!classic && <ShelfFoot />}
      <Sash of="sidebar" />
    </aside>
  );
}

export function Layout() {
  const Overlay = app.overlay.value;
  const ProcessDock = ui.processDock.value;
  const classic = isClassic();
  return (
    // frame-integrated: the desktop window has no OS title bar; the tab strip is the title bar (styles/app.css).
    <div class={`se-root theme-${app.settings.value.theme} ${classic ? 'ui-classic' : 'ui-shelf'}${app.backend?.frame === 'integrated' ? ' frame-integrated' : ''}${ui.overviewVisible.value ? ' ov-open' : ''}`} data-os={app.backend?.os}>
      <div class={`se-main${app.sidebarVisible.value ? '' : ' shelf-hidden'}`}>
        {classic && <ActivityBar />}
        {app.sidebarVisible.value && <Sidebar classic={classic} />}
        <section class="se-content">
          <div class="se-topline">
            {!app.sidebarVisible.value && !classic && <ShelfReveal />}
            <TabBar />
          </div>
          <EditorArea />
          {/* "Developer: Process explorer", docked (non-modal); its chunk fills ui.processDock when loaded. */}
          {ui.processesOpen.value && ProcessDock && <ProcessDock />}
          {/* Integrated terminal (Ctrl+`): bottom of the editor card, both sidebar styles. Starts closed. */}
          {terminalOpen.value && <TerminalPanelSlot />}
          {!classic && <StatusBar />}
        </section>
        {/* File overview (Ctrl+Alt+B): right column, mirroring the shelf. */}
        {ui.overviewVisible.value && (
          <aside class="se-overview" style={{ width: `${ui.overviewWidth.value}px` }} aria-label="File overview">
            <OverviewPanel />
            <Sash of="overview" />
          </aside>
        )}
      </div>
      {/* Classic keeps the full-width status bar; the shelf puts it inside the editor card. */}
      {classic && <StatusBar />}
      {Overlay && <Overlay />}
      {ui.tabSwitcher.value && <TabSwitcher />}
      {ui.dialog.value && <DialogHost />}
      {ui.contextMenu.value && <ContextMenuHost />}
      {ui.dropActive.value && <DropOverlay />}
      {ui.picker.value && <PickerHost />}
      {/* The live region exists from the first frame (announcements need it); the toasts render from the Popups chunk. */}
      <div class="se-toasts" aria-live="polite">
        {app.toasts.value.length > 0 && <ToastList />}
      </div>
    </div>
  );
}
