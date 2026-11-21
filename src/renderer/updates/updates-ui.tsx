// "Security updates" UI (lazy chunk, desktop only — loaded after the idle Popups chunk, nothing at startup
// but the status-bar slot): the shield, the findings dialog, the Settings panel and two palette commands.
// The check itself runs in main (src/main/update-check.ts); this side asks over `secEditBridge.updates`
// and shows what main reports. The setting = automatic checks: while it is off nothing is asked on its own;
// "Check now" always works (the user clicked). The shield shows the last check's problems either way.
import { effect, signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { app } from '../app/app';
import { addIcons, Icon } from '../app/icons';
import '../app/icon-pack'; // refresh
import { registerCommands, runCommand } from '../app/commands';
import { flushSettings } from '../app/settings';
import { BRAND } from '@shared/brand';
import { NO_STATUS, alerting, type Finding, type UpdateReply, type UpdateStatus } from '@shared/update-check';
import { updatesShield } from './slot';
import { SEVERITY_LABEL, Summary, when } from './summary';
import '../app/overlays.css'; // dialog base
import './updates.css';

addIcons({
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|M12 8v4|M12 16h.01',
  shieldOk: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z|m9 12 2 2 4-4',
  openExternal: 'M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
});

interface Bridge {
  status(): Promise<unknown>;
  check(force?: boolean): Promise<unknown>;
  onChange(cb: (s: unknown) => void): () => void;
}
const bridge = () => (globalThis as { secEditBridge?: { updates?: Bridge } }).secEditBridge?.updates;

async function call(p: Promise<unknown> | undefined): Promise<UpdateStatus> {
  const r = (await p) as UpdateReply<UpdateStatus> | undefined;
  if (!r) throw new Error('Not available');
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

export const status = signal<UpdateStatus>(NO_STATUS);
const enabled = () => app.settings.value['updates.check'] === true;
const KEYWORDS = ['security', 'update', 'electron', 'chromium', 'vulnerability', 'cve', 'patch', 'outdated', 'osv'];

/** Asks main for a check: `manual` = "Check now" (any time), else automatic (setting on, main applies the
 *  weekly rule). Automatic ones stay quiet whatever happens; the result lands in `status`. */
async function check(manual: boolean) {
  const b = bridge();
  if (!b || (!manual && !enabled()) || status.value.checking) return;
  status.value = { ...status.value, checking: true };
  try {
    status.value = await call(b.check(manual));
  } catch (err) {
    status.value = { ...status.value, checking: false };
    if (manual) app.toast(`Security updates: ${(err as Error).message}`, 'error');
  }
}

/** Never from a hidden / minimised window: the check waits until someone is looking. */
function whenVisible(fn: () => void) {
  if (!document.hidden) return fn();
  const on = () => {
    if (document.hidden) return;
    document.removeEventListener('visibilitychange', on);
    fn();
  };
  document.addEventListener('visibilitychange', on);
}

let installed = false;
/** Idempotent: the idle loader and the Settings panel both call it. */
export function install() {
  const b = bridge();
  if (!b || installed) return;
  installed = true;
  b.onChange((raw) => (status.value = raw as UpdateStatus));
  // The cached result first (no request): the shield of the last check shows right away.
  void call(b.status())
    .then((s) => (status.value = s), () => {})
    .then(() => {
      // Once per launch, and main only goes out when the last check is a week old.
      if (enabled()) whenVisible(() => void check(false));
      // Switched on (here or in another window): the automatic check right away when due (never checked,
      // or a week old) — after main has the setting.
      let was = enabled();
      effect(() => {
        const on = enabled();
        // A microtask later: updateSettings() queues the patch only after this signal fired.
        if (on && !was) void Promise.resolve().then(flushSettings).then(() => whenVisible(() => void check(false)));
        was = on;
      });
    });
  // In the status-bar corner only with findings: an empty corner draws no │.
  effect(() => void (updatesShield.value = alerting(status.value.findings).length ? Shield : null));
  registerCommands([
    { id: 'updates.show', title: 'Security updates: Show findings', keywords: KEYWORDS, run: openFindings },
    { id: 'updates.check', title: 'Security updates: Check now', keywords: KEYWORDS, run: () => void check(true).then(openFindings) },
  ]);
  (globalThis as { __secEditUpdates?: unknown }).__secEditUpdates = { status: () => status.value }; // E2E
}

// ---- pieces shared by the dialog and the Settings panel ------------------------------------------

function lastLine(s: UpdateStatus): { state: 'off' | 'never' | 'ok' | 'failed' | 'checking'; text: string } {
  if (s.checking) return { state: 'checking', text: 'Checking…' };
  if (s.lastError) return { state: 'failed', text: `Last check failed (${s.lastAttempt ? when(s.lastAttempt) : 'just now'}): ${s.lastError}.${s.lastChecked ? ` Last complete check: ${when(s.lastChecked)}.` : ''}` };
  if (!s.lastChecked) return { state: enabled() ? 'never' : 'off', text: enabled() ? 'Not checked yet.' : 'Automatic check off: nothing is sent until you click Check now.' };
  const n = alerting(s.findings).length;
  return { state: 'ok', text: `Last checked ${when(s.lastChecked)}: ${n ? `${n} finding${n === 1 ? '' : 's'}` : 'nothing found'}.` };
}

function CheckNow({ primary = false }: { primary?: boolean }) {
  return (
    <button class={`se-btn small${primary ? ' primary' : ''}`} data-testid="updates-check-now" disabled={status.value.checking} onClick={() => void check(true)}>
      <Icon name="refresh" size={13} />
      Check now
    </button>
  );
}

const KIND_LABEL: Record<Finding['kind'], string> = { vuln: 'Known vulnerability', 'electron-patch': 'Newer patch', 'electron-eol': 'End of support', 'electron-major': 'Newer major' };

/** Opens a link of a row / the summary in the OS browser (only URLs main built or fixed source pages). */
const openLink = (url: string) => void app.backend.openExternal(url).catch((err) => app.toast(`Could not open the link: ${(err as Error).message}`, 'error'));

function Row({ f }: { f: Finding }) {
  const open = () => openLink(f.url);
  return (
    <li class="se-upd-row" data-level={f.level} data-kind={f.kind} data-testid="updates-row">
      <span class="se-upd-dot" aria-hidden="true" />
      <div class="se-upd-what">
        <span data-testid="updates-pkg">{f.pkg}</span>
        <span class="se-upd-ver" data-testid="updates-version">
          {f.version}
          {f.fixed ? ` → ${f.fixed}` : f.kind === 'vuln' ? ' → no fixed version listed' : ''}
        </span>
        <span class="se-upd-sev">{f.kind === 'vuln' ? `${KIND_LABEL.vuln} · ${SEVERITY_LABEL[f.severity ?? 'UNKNOWN']}` : KIND_LABEL[f.kind]}</span>
      </div>
      <button class="se-btn small" data-testid="updates-link" title={f.url} onClick={open}>
        <Icon name="openExternal" size={13} />
        Details
      </button>
      <p class="se-upd-sum">{f.summary}</p>
    </li>
  );
}

function openSettings() {
  void import('../app/SettingsOverlay').then((m) => {
    m.requestSection('updates');
    app.overlay.value = null;
    void runCommand('app.settings');
  });
}

// ---- findings dialog -----------------------------------------------------------------------------

export function openFindings() {
  install();
  app.overlay.value = FindingsDialog;
}

function FindingsDialog() {
  const s = status.value;
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => box.current?.focus(), []);
  const close = () => {
    if (app.overlay.value === FindingsDialog) app.overlay.value = null;
    const el = back.current as HTMLElement | null;
    queueMicrotask(() => (el && el.isConnected && el !== document.body ? el.focus() : app.editor?.focus()));
  };
  const alerts = alerting(s.findings);
  const level = alerts.some((f) => f.level === 'high') ? 'high' : alerts.length ? 'warn' : 'none';
  const libs = s.findings.some((f) => f.kind === 'vuln' && f.pkg !== 'electron');
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        class="se-dialog se-upd"
        role="dialog"
        aria-modal="true"
        aria-label="Security updates"
        tabIndex={-1}
        data-testid="updates-findings"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      >
        <div class="se-upd-title" data-level={level}>
          <Icon name={level === 'none' ? 'shieldOk' : 'shield'} size={18} />
          <h2 class="se-dialog-title">Security updates</h2>
        </div>
        <p class="se-dialog-msg" data-testid="updates-last">
          {lastLine(s).text}
        </p>
        {s.findings.length > 0 && (
          <ul class="se-upd-list">
            {s.findings.map((f) => (
              <Row key={f.id} f={f} />
            ))}
          </ul>
        )}
        {alerts.length > 0 && (
          <p class="se-upd-note" data-testid="updates-todo">
            <strong>What to do:</strong> rebuild {BRAND} with updated Electron / libraries (for example, ask Claude: “update Electron and release”). Findings disappear on their own once a build ships fixed versions.
          </p>
        )}
        {libs && <p class="se-upd-note">A library finding may not affect {BRAND}: it depends on how the library is used. Check the link.</p>}
        <div class="se-dialog-buttons">
          <button class="se-link-btn se-upd-options" onClick={openSettings}>
            Settings…
          </button>
          <CheckNow />
          <button class="se-btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- status bar ----------------------------------------------------------------------------------

function Shield() {
  const alerts = alerting(status.value.findings);
  // Quiet unless the last check (manual or automatic) found something to do. Findings about versions this
  // build no longer ships are already dropped in main, so an old result can't warn about an updated app.
  if (!alerts.length) return null;
  const high = alerts.some((f) => f.level === 'high');
  return (
    <button
      class="se-status-item se-status-btn se-upd-shield"
      data-testid="updates-shield"
      data-level={high ? 'high' : 'warn'}
      title={`${alerts.length} security finding${alerts.length === 1 ? '' : 's'} for this build — click for details`}
      aria-label={`${alerts.length} security findings`}
      onClick={openFindings}
    >
      <Icon name="shield" size={12} />
      {alerts.length}
    </button>
  );
}

// ---- Settings → Security updates -----------------------------------------------------------------

export function SettingsPanel() {
  useEffect(() => install(), []);
  const s = status.value;
  const last = lastLine(s);
  return (
    <div class="se-upd-panel" data-testid="updates-settings">
      <div class="se-upd-head">
        <span class="se-upd-last" data-state={last.state} data-testid="updates-last-checked">
          {last.text}
        </span>
        {s.findings.length > 0 && (
          <button class="se-btn small" data-testid="updates-show" onClick={openFindings}>
            Show findings ({s.findings.length})
          </button>
        )}
        <CheckNow primary />
      </div>
      {s.summary ? (
        <Summary s={s.summary} findings={s.findings} open={openLink} />
      ) : (
        s.lastChecked && !s.checking && <p class="se-upd-note">Check now to see what is checked, line by line.</p>
      )}
      <p class="se-upd-note" data-testid="updates-privacy">
        <strong>What is sent:</strong> a check asks endoflife.date for the public list of Electron releases (nothing about you or this app is sent), and sends api.osv.dev the names and versions of the libraries this build of {BRAND} ships. Both see your IP address, as any website does. Nothing else: no ids, no file or folder names, no cookies. <strong>When:</strong> whenever you click Check now; with the switch below on, also once after launch if the last check is a week old.
      </p>
    </div>
  );
}
