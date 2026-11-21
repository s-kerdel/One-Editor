// Status bar: ← → │ folder · [crumbs · save state] · git / variables pills · activity ·
// [cursor · words · EOL · encoding · language · mode] │ MCP · web server · shield. The bracketed parts belong to
// the open file and live in the lazy ./doc-chrome chunk (Layout.preloadDocChrome: in time for the first file).
import { app } from './app';
import { Icon } from './icons';
import { lazyComponent } from './lazy';
import { absolutePath, copyText, revealInOs, revealLabel } from './fileops';
import { openWorkspaceMenu } from './Shelf';
import { gitUi } from '../git/install';
import { varsStatus } from '../variables/slot';
import { webServerPill } from '../webserver/slot';
import { updatesShield } from '../updates/slot';
import { mcpIndicator } from '../mcp/slot';
import { activityNow } from './ui';
import { indexDeferred } from '../search/demand';
import { startIndexing } from '../search';
import { NavButtons } from '../nav/buttons';

const loadDocChrome = () => import('./doc-chrome');
export const StatusDocStart = lazyComponent<{ path: string; crumbs: boolean }>(() => loadDocChrome().then((m) => m.StatusDocStart));
export const StatusDocEnd = lazyComponent<{ path: string }>(() => loadDocChrome().then((m) => m.StatusDocEnd));

export function StatusBar() {
  const active = app.activePath.value;
  const ws = app.workspace.value;
  const GitBranch = gitUi.value?.Branch; // lazy git chunk; after the save state so nothing shifts when it appears
  const Vars = varsStatus.value; // env / target pills (lazy variables chunk), before the spacer: nothing shifts

  return (
    <footer class="se-status">
      {/* Go back / forward, then a rule (both sidebar styles; zen only with zen.keepStatusBar). Settings → Appearance hides them. */}
      {app.settings.value['nav.buttons'] !== false && <NavButtons />}
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
      <StatusCorner />
    </footer>
  );
}

/** The far-right corner, `│ MCP · :4317 · ⛨ 3`: what is on right now (desktop; lazy chunks fill the slots, each
 *  set only while its icon shows). Empty → nothing, not even the │ (the corner's ::before). Its own component:
 *  a slot coming or going re-renders only this. */
export function StatusCorner() {
  // MCP server on (accent while an AI app is connected) · web server running · the last security check found something.
  // Fixed positions (an empty one stays a hole), so an icon keeps its DOM while another comes or goes.
  const icons = [mcpIndicator.value, webServerPill.value, updatesShield.value];
  return icons.some(Boolean) ? <span class="se-status-corner">{icons.map((C) => C && <C />)}</span> : null;
}
