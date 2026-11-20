// Status bar: sidebar toggle · folder · [crumbs · save state] · git / variables / web server pills ·
// activity · [cursor · words · EOL · encoding · language · mode]. The bracketed parts belong to the open
// file and live in the lazy ./doc-chrome chunk (Layout.preloadDocChrome: in time for the first file).
import { app } from './app';
import { Icon } from './icons';
import { runCommand } from './commands';
import { lazyComponent } from './lazy';
import { absolutePath, copyText, revealInOs, revealLabel } from './fileops';
import { openWorkspaceMenu } from './Shelf';
import { gitUi } from '../git/install';
import { varsStatus } from '../variables/slot';
import { webServerPill } from '../webserver/slot';
import { updatesShield } from '../updates/slot';
import { activityNow } from './ui';
import { indexDeferred } from '../search/demand';
import { startIndexing } from '../search';

const loadDocChrome = () => import('./doc-chrome');
export const StatusDocStart = lazyComponent<{ path: string; crumbs: boolean }>(() => loadDocChrome().then((m) => m.StatusDocStart));
export const StatusDocEnd = lazyComponent<{ path: string }>(() => loadDocChrome().then((m) => m.StatusDocEnd));

export function StatusBar() {
  const active = app.activePath.value;
  const ws = app.workspace.value;
  const GitBranch = gitUi.value?.Branch; // lazy git chunk; after the save state so nothing shifts when it appears
  const Vars = varsStatus.value; // env / target pills (lazy variables chunk), before the spacer: nothing shifts
  const WebServer = webServerPill.value; // ":4317" while the web server runs (desktop, lazy chunk)
  const Updates = updatesShield.value; // shield, only with security findings (desktop, opt-in, lazy chunk)

  return (
    <footer class="se-status">
      <button
        class="se-status-item se-status-sidebar"
        title={`${app.sidebarVisible.value ? 'Hide' : 'Show'} sidebar (Ctrl+Shift+B)`}
        aria-label="Toggle sidebar"
        onClick={() => void runCommand('view.toggleSidebar')}
      >
        <Icon name="sidebar" size={13} />
      </button>
      {ws && (
        <button
          class="se-status-item se-status-btn se-status-ws"
          title={`${ws.root}\nSwitch folder · reveal · copy path`}
          aria-label="Folder menu"
          data-testid="status-folder"
          onClick={(e) =>
            openWorkspaceMenu(e.currentTarget, 'above', [
              { label: revealLabel(), icon: 'reveal', run: () => revealInOs('') },
              { label: 'Copy folder path', icon: 'copy', run: () => copyText(absolutePath(''), 'Folder path') },
            ])
          }
        >
          <Icon name="folder" size={12} /> {ws.name}
        </button>
      )}
      {active && <StatusDocStart path={active} crumbs={!!ws} />}
      {GitBranch && <GitBranch />}
      {Vars && <Vars />}
      {WebServer && <WebServer />}
      {Updates && <Updates />}
      <span class="se-status-spacer" />
      {/* After the spacer: it absorbs the width, so nothing else moves while this comes and goes. */}
      {activityNow.value && (
        <span class="se-status-item" data-testid="activity" aria-live="polite" style="font-variant-numeric:tabular-nums">
          {activityNow.value}
        </span>
      )}
      {indexDeferred.value && !activityNow.value && (
        <button class="se-status-item se-status-btn" data-testid="index-on-demand" title="Built when you first search or open backlinks. Click to build it now." onClick={() => void startIndexing()}>
          Search index: on demand
        </button>
      )}
      {active && <StatusDocEnd path={active} />}
    </footer>
  );
}
