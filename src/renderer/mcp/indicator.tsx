// Status-bar corner: the MCP icon (desktop only). Rides in the lazy web-server-ui chunk (re-exported there;
// Popups installs it after idle): a status subscription over `secEditBridge.mcp` and the icon. Shown while
// MCP is on: muted with no app connected, accent while one is (live files, `McpStatus.sessions`), a short
// pulse on each new call. Only *types* from @shared/mcp: a value import would split that module out of the
// mcp-ui chunk into one shared with this chunk.
import { signal } from '@preact/signals';
import { app } from '../app/app';
import { addIcons, Icon } from '../app/icons';
import { runCommand } from '../app/commands';
import type { McpSession, McpStatus } from '@shared/mcp';
import { mcpIndicator } from './slot';
import './indicator.css';

// Settings → MCP server's nav icon: the same plug here.
addIcons({ plug: 'M12 22v-5|M9 8V2|M15 8V2|M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z' });

interface Bridge {
  status(): Promise<unknown>;
  onChange(cb: (s: unknown) => void): () => void;
}
const bridge = () => (globalThis as { secEditBridge?: { mcp?: Bridge } }).secEditBridge?.mcp;

/** Tooltip lines shown per app; the rest is "+N more". */
export const TITLE_SESSIONS = 3;
export const PULSE_MS = 1000;

const hhmm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The icon's tooltip: `MCP server on · no app connected`, or one line per app (`LM Studio connected · last call 12:04`). */
export function mcpTitle(sessions: McpSession[], time: (t: number) => string = hhmm): string {
  if (!sessions.length) return 'MCP server on · no app connected';
  const line = (x: McpSession) => `${x.client} connected · ${x.idle ? 'idle' : x.lastCall ? `last call ${time(x.lastCall)}` : 'no calls yet'}`;
  const lines = sessions.slice(0, TITLE_SESSIONS).map(line);
  if (sessions.length > TITLE_SESSIONS) lines.push(`+${sessions.length - TITLE_SESSIONS} more`);
  return lines.join('\n');
}

const newest = (sessions: McpSession[]) => sessions.reduce((m, x) => Math.max(m, x.lastCall ?? 0), 0);
/** Pulse? A call newer than any in the previous status. `prev` null = the first status: what already
 *  happened before this window looked is no news. */
export const newCall = (prev: McpSession[] | null, next: McpSession[]) => prev !== null && newest(next) > newest(prev);

const status = signal<McpStatus | null>(null);
const pulsing = signal(false);
let pulseTimer: ReturnType<typeof setTimeout> | undefined;

/** A status from main (first answer or a push). Exported for unit tests. */
export function take(s: McpStatus) {
  const prev = status.value;
  status.value = s;
  mcpIndicator.value = s.enabled ? Indicator : null;
  if (!newCall(prev ? prev.sessions : null, s.sessions)) return;
  pulsing.value = true;
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => (pulsing.value = false), PULSE_MS);
}

let installed = false;
/** Idempotent; nothing without the desktop bridge. */
export function install() {
  const b = bridge();
  if (!b || installed) return;
  installed = true;
  b.onChange((s) => take(s as McpStatus));
  void b.status().then((r) => {
    const reply = r as { ok?: boolean; result?: McpStatus } | undefined;
    if (reply?.ok && reply.result) take(reply.result);
  }, () => {});
}

/** Settings → MCP server, scrolled to Recent activity (mcp-ui scrolls once its panel is in). */
function openActivity() {
  void Promise.all([import('../app/Settings'), import('./mcp-ui')]).then(
    ([settings, panel]) => {
      panel.revealActivity();
      settings.requestSection('mcp');
      app.overlay.value = null;
      void runCommand('app.settings');
    },
    () => app.toast('Could not open the MCP settings', 'error'),
  );
}

function Indicator() {
  const s = status.value;
  if (!s?.enabled) return null;
  const n = s.sessions.length;
  return (
    <button
      class="se-status-item se-status-btn se-mcp-ind"
      data-testid="mcp-indicator"
      data-state={n ? 'live' : 'on'}
      data-pulse={pulsing.value ? '' : undefined}
      title={mcpTitle(s.sessions)}
      aria-label={n ? `MCP server: ${n} app${n === 1 ? '' : 's'} connected. Recent activity` : 'MCP server on, no app connected. Recent activity'}
      onClick={openActivity}
    >
      <Icon name="plug" size={12} />
      MCP
      {n > 1 && (
        <span class="se-mcp-ind-n" data-testid="mcp-indicator-count">
          {n}
        </span>
      )}
    </button>
  );
}
