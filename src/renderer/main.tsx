// Renderer bootstrap. Order matters for launch speed:
//   1. start loading the editor chunk (CodeMirror) immediately, in parallel with everything else;
//   2. one backend round-trip (bootstrap) → settings, workspace, session;
//   3. render the shell (paints without the editor), then tree + session restore.
// Feature modules: add your installX() call in the "feature modules" block below.
import { render } from 'preact';
import './styles/app.css';
import { app } from './app/app';
import { Layout, FilesPanel, preloadPopups, preloadClassicUi, preloadDocChrome } from './app/Layout';
import { installGlobalKeymap } from './app/commands';
import { applySessionLayout, installDocuments, openWorkspace, restoreSession } from './app/documents';
import { installShell } from './app/shell';
import { applySettingsToDom } from './app/settings';
import { loadEditorModule, loadPreviewModule } from './app/EditorArea';
import { openAbsolutePaths } from './app/fileops';
import * as ui from './app/ui';
import { connectBackend } from './platform';
import { installSearch } from './search';
import { installKnowledge } from './knowledge';
import { installFormatLazy } from './app/lazy-features';
import { installPreview } from './preview/install';
import { loadClassic } from './app/classic-loader';
import { installOverview, preloadOverview } from './overview';
import { installTerminal } from './terminal/install';
import { installGitLazy } from './git/install';
import { installNav } from './nav/install';

const marks: Record<string, number> = { start: performance.now() };
const mark = (k: string) => (marks[k] = Math.round(performance.now() * 10) / 10);
void loadEditorModule();
// Classic sidebar style is a separate chunk; theme-boot.js already set data-ui from the last session.
if (document.documentElement.dataset.ui === 'classic') void loadClassic();
// File overview open last time (theme-boot.js set data-ov): fetch its chunk alongside the bootstrap.
const overviewP = document.documentElement.dataset.ov === '1' ? preloadOverview().catch(() => {}) : null;

async function boot() {
  app.backend = await connectBackend();
  const bootP = app.backend.bootstrap();
  const treeP = app.backend.listTree().catch(() => null); // same round-trip window as bootstrap
  const b = await bootP;
  mark('bootstrap');
  app.settings.value = b.settings;
  applySettingsToDom(b.settings);
  ui.recentFolders.value = b.recent;
  if (b.workspace) {
    app.workspace.value = b.workspace;
    document.title = `${b.workspace.name} — sec-edit`;
    applySessionLayout(b.session); // sidebar width etc. before first paint → no layout jump
  }

  app.registerPanel({ id: 'files', title: 'Files', icon: 'files', order: 0, component: FilesPanel });
  installDocuments();
  installGlobalKeymap();
  installShell();

  // ---- feature modules ----
  installSearch();
  installKnowledge();
  installFormatLazy(); // src/format/install loads on idle / first use
  installPreview();
  installOverview();
  installTerminal(); // desktop shell panel; everything but two key bindings loads on idle / first use
  installGitLazy(); // Source control pill + slots; the git chunk loads on idle
  installNav(); // Go back / forward: keys + mouse side buttons; the recorder loads on idle
  // ---- /feature modules ----

  // Already in flight since module start when classic was the saved style: no half-drawn sidebar.
  if (b.settings.sidebarStyle === 'classic') await preloadClassicUi().catch(() => {});
  // Same for the file overview column: its panel is in the first frame, nothing pops in.
  if (ui.overviewVisible.value) await (overviewP ?? preloadOverview().catch(() => {}));
  const root = document.getElementById('app')!;
  root.textContent = ''; // drop the static skeleton in the same frame we render
  render(<Layout />, root);
  mark('rendered');
  // The open file's status-bar / tab-strip parts: alongside the session restore, else on idle.
  preloadDocChrome(!!(b.session?.openTabs?.length || b.openRequests.length));
  // Integrated window frame: colour the native window controls like the strip (tiny lazy chunk).
  if (app.backend.frame === 'integrated') void import('./app/titlebar').then((m) => m.installTitleBar());
  // Timings go to main once both "painted" and "ready" are known: they land within a few ms of each
  // other, in either order, and a report sent in between would lack one of them.
  let reported = false;
  const report = () => {
    if (reported || marks.painted === undefined || marks.ready === undefined) return;
    reported = true;
    app.backend.notifyReady?.({ ...marks });
  };
  requestAnimationFrame(() =>
    setTimeout(() => {
      mark('painted');
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav?.domContentLoadedEventEnd) marks.dcl = Math.round(nav.domContentLoadedEventEnd * 10) / 10;
      report();
    }),
  );

  if (b.workspace) {
    const tree = (await treeP) ?? (await app.backend.listTree());
    app.tree.value = tree;
    app.events.emit('tree:changed', tree);
    app.events.emit('workspace:opened', b.workspace);
    await restoreSession(b.session);
  }
  if (b.openRequests.length) await openAbsolutePaths(b.openRequests);
  app.ready.value = true;
  document.documentElement.dataset.ready = 'true';
  mark('ready');
  report();
  (window as any).__secEditBootMs = marks.ready - marks.start;
  (window as any).__secEditTimings = marks;
  // Warm the preview chunk once idle so the first Mod-e / split is instant.
  (window.requestIdleCallback ?? setTimeout)(() => void loadPreviewModule(), { timeout: 3000 } as never);
  preloadPopups(); // dialogs / context menus: first right-click is instant
}

boot().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<pre style="padding:2rem;color:#f66;white-space:pre-wrap">Failed to start: ${String(err?.stack || err)}</pre>`;
});

export { openWorkspace };
