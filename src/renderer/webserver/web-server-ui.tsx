// "Start web server" UI (lazy chunk, desktop only — loaded after the idle Popups chunk, nothing at
// startup but the status-bar slot): palette commands, the status-bar pill, the info dialog and the
// Settings → Browser mode panel. The server itself is a child process owned by main (src/main/web-server.ts);
// this side only asks over `secEditBridge.webServer` and shows what main reports.
import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { app } from '../app/app';
import { addIcons, Icon } from '../app/icons';
import '../app/icon-pack'; // copy
import { registerCommands, runCommand } from '../app/commands';
import * as ui from '../app/ui';
import { copyText } from '../app/fileops';
import { STOPPED, optionsFromSettings, type WebServerOptions, type WebServerReply, type WebServerStatus, type WebServerUrl } from '@shared/web-server';
import { webServerPill } from './slot';
import '../app/overlays.css'; // dialog base (.se-wsrv resizes it)
import './webserver.css';

addIcons({
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z|M2 12h20|M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
  openExternal: 'M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
});

interface Bridge {
  status(): Promise<unknown>;
  start(o: WebServerOptions): Promise<unknown>;
  stop(): Promise<unknown>;
  open(url: string): Promise<unknown>;
  onChange(cb: (s: unknown) => void): () => void;
}
const bridge = () => (globalThis as { secEditBridge?: { webServer?: Bridge } }).secEditBridge?.webServer;

async function call<T>(p: Promise<unknown> | undefined): Promise<T> {
  const r = (await p) as WebServerReply<T> | undefined;
  if (!r) throw new Error('Not available');
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

export const status = signal<WebServerStatus>(STOPPED);
const busy = signal(false);
const active = () => status.value.state === 'running' || status.value.state === 'starting';
const KEYWORDS = ['browser mode', 'serve', 'http', 'localhost', 'lan', 'network', 'share', 'phone', 'tablet', 'remote', 'url'];

let installed = false;
/** Idempotent: the idle loader and the Settings panel both call it. */
export function install() {
  const b = bridge();
  if (!b || installed) return;
  installed = true;
  b.onChange((raw) => {
    const prev = status.value;
    const s = raw as WebServerStatus;
    status.value = s;
    // A start that fails is reported by startServer(); here only what happens on its own.
    if (prev.state === 'running' && s.state === 'error') app.toast(`Web server stopped: ${s.error}`, 'error', 8000, [{ label: 'Details', run: openInfo }]);
    if (s.state === 'stopped' && s.notice && prev.state !== 'stopped') app.toast(s.notice, 'info', 6000);
  });
  void call<WebServerStatus>(b.status()).then((s) => (status.value = s), () => {});
  webServerPill.value = Pill;
  registerCommands([
    { id: 'webServer.start', title: 'Start web server', keywords: KEYWORDS, when: () => !!app.workspace.value && !active(), run: () => void startServer({ showInfo: true }) },
    { id: 'webServer.stop', title: 'Stop web server', keywords: KEYWORDS, when: active, run: () => void stopServer() },
    { id: 'webServer.info', title: 'Web server: Show info', keywords: KEYWORDS, run: openInfo },
  ]);
  (globalThis as { __secEditWebServer?: unknown }).__secEditWebServer = { status: () => status.value }; // E2E
}

/** LAN is opt-in, every time: the warning is the point. */
async function confirmLan(): Promise<boolean> {
  const r = await ui.ask({
    title: 'Share this folder on your network?',
    message: 'Anyone on your network with the link can read, change and delete the files in this folder (git included) and change your app settings. Nothing outside this folder.',
    details: [
      'The link holds a secret key. Send it only to people you trust.',
      'Plain HTTP (not encrypted): use it on trusted networks only, not public Wi-Fi.',
      ...(app.backend.os === 'win32' ? ['Windows will ask to let sec-edit through the firewall. Allow Private networks only.'] : []),
    ],
    cancelValue: 'cancel',
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Start on network', value: 'ok', kind: 'danger' },
    ],
  });
  return r.value === 'ok';
}

export async function startServer(o: { showInfo?: boolean } = {}) {
  const b = bridge();
  if (!b || busy.value || active()) return;
  if (!app.workspace.value) return app.toast('Open a folder first', 'info');
  const opts = optionsFromSettings(app.settings.value);
  if (opts.access === 'lan' && !(await confirmLan())) return;
  busy.value = true;
  try {
    status.value = await call<WebServerStatus>(b.start(opts));
    if (o.showInfo) openInfo();
  } catch (err) {
    app.toast(`Web server: ${(err as Error).message}`, 'error', 8000);
  } finally {
    busy.value = false;
  }
}

export async function stopServer() {
  const b = bridge();
  if (!b) return;
  busy.value = true;
  try {
    status.value = await call<WebServerStatus>(b.stop());
  } catch (err) {
    app.toast(`Web server: ${(err as Error).message}`, 'error');
  } finally {
    busy.value = false;
  }
}

// ---- pieces shared by the dialog and the Settings panel ------------------------------------------

const STATE_LABEL: Record<WebServerStatus['state'], string> = { stopped: 'Stopped', starting: 'Starting…', running: 'Running', error: 'Error' };

function StateChip({ s }: { s: WebServerStatus }) {
  return (
    <span class="se-wsrv-state" data-state={s.state} data-testid="webserver-state">
      {STATE_LABEL[s.state]}
    </span>
  );
}

function StartStop({ s, primary = true }: { s: WebServerStatus; primary?: boolean }) {
  if (s.state === 'running' || s.state === 'starting')
    return (
      <button class="se-btn" data-testid="webserver-stop" disabled={busy.value} onClick={() => void stopServer()}>
        Stop server
      </button>
    );
  return (
    <button class={`se-btn${primary ? ' primary' : ''}`} data-testid="webserver-start" disabled={busy.value || !app.workspace.value} title={app.workspace.value ? undefined : 'Open a folder first'} onClick={() => void startServer()}>
      <Icon name="globe" size={14} />
      Start web server
    </button>
  );
}

function Links({ s }: { s: WebServerStatus }) {
  const open = (u: WebServerUrl) => void call(bridge()?.open(u.url)).catch((err) => app.toast(`Could not open the browser: ${(err as Error).message}`, 'error'));
  return (
    <div class="se-wsrv-links">
      {s.urls.map((u) => (
        <div class="se-wsrv-link" data-kind={u.kind}>
          <code class="se-wsrv-origin" data-testid="webserver-url" title={u.kind === 'lan' ? 'From other devices on your network' : 'On this computer'}>
            {u.origin}
          </code>
          {/* Copy / open use the full link (with its access key); only the address is shown. */}
          <button class="se-btn small" data-testid="webserver-copy" onClick={() => void copyText(u.url, 'Link')}>
            <Icon name="copy" size={13} />
            Copy link
          </button>
          <button class="se-btn small" data-testid="webserver-open" onClick={() => open(u)}>
            <Icon name="openExternal" size={13} />
            Open
          </button>
        </div>
      ))}
      {s.access === 'lan' && !s.urls.some((u) => u.kind === 'lan') && <p class="se-wsrv-note">No network address found: other devices cannot reach this computer right now.</p>}
      {s.portBusy && (
        <p class="se-wsrv-warn" data-testid="webserver-port-busy">
          Port {s.portBusy} was busy — browser state for this folder starts empty.
        </p>
      )}
      <p class="se-wsrv-note">The link holds a secret key. Without it the server refuses every request.</p>
    </div>
  );
}

function Limits() {
  return (
    <ul class="se-wsrv-list" data-testid="webserver-limits">
      <li>No terminal in the browser.</li>
      <li>Secrets of {'{{variables}}'} stay in that browser tab’s memory only (never saved, never sent).</li>
      <li>PDF export uses the browser’s print dialog.</li>
      <li>One web server at a time. It serves the folder that is open now — and only that folder: the link cannot open other folders on this computer.</li>
    </ul>
  );
}

const HOW_TO_STOP = 'Click Stop server, run “Stop web server” (Ctrl+Shift+P), or quit sec-edit. Opening another folder stops it too.';

const accessLabel = (s: WebServerStatus) => {
  const a = s.access ?? optionsFromSettings(app.settings.value).access;
  return a === 'lan' ? 'Your network: anyone with the link can read and change the files in this folder' : 'This computer only (127.0.0.1)';
};

function openOptions() {
  void import('../app/Settings').then((m) => {
    m.requestSection('webserver');
    app.overlay.value = null;
    void runCommand('app.settings');
  });
}

// ---- info dialog ---------------------------------------------------------------------------------

export function openInfo() {
  install();
  app.overlay.value = InfoDialog;
}

function InfoDialog() {
  const s = status.value;
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => box.current?.focus(), []);
  const close = () => {
    if (app.overlay.value === InfoDialog) app.overlay.value = null;
    const el = back.current as HTMLElement | null;
    queueMicrotask(() => (el && el.isConnected && el !== document.body ? el.focus() : app.editor?.focus()));
  };
  const root = s.root ?? app.workspace.value?.root ?? null;
  return (
    <div class="se-overlay se-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={box}
        class="se-dialog se-wsrv"
        role="dialog"
        aria-modal="true"
        aria-label="Web server"
        tabIndex={-1}
        data-testid="webserver-info"
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      >
        <div class="se-wsrv-title">
          <Icon name="globe" size={18} />
          <h2 class="se-dialog-title">Web server</h2>
          <StateChip s={s} />
        </div>
        <p class="se-dialog-msg">Open this folder in a web browser, while sec-edit runs.</p>
        {s.state === 'error' && (
          <p class="se-wsrv-error" role="alert" data-testid="webserver-error">
            {s.error}
          </p>
        )}
        <dl class="se-wsrv-facts">
          <dt>Folder</dt>
          <dd data-testid="webserver-folder">{root ?? 'No folder open'}</dd>
          <dt>Access</dt>
          <dd data-testid="webserver-access">{accessLabel(s)}</dd>
          {s.state === 'running' && (
            <>
              <dt>Address</dt>
              <dd>
                <Links s={s} />
              </dd>
            </>
          )}
        </dl>
        <h3 class="se-wsrv-h">In the browser</h3>
        <Limits />
        <h3 class="se-wsrv-h">How to stop</h3>
        <p class="se-wsrv-text">{HOW_TO_STOP}</p>
        <div class="se-dialog-buttons">
          <button class="se-link-btn se-wsrv-options" onClick={openOptions}>
            Port and access…
          </button>
          <StartStop s={s} />
          <button class="se-btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- status bar ----------------------------------------------------------------------------------

function Pill() {
  const s = status.value;
  if (s.state !== 'running') return null;
  return (
    <button
      class="se-status-item se-status-btn se-wsrv-pill"
      data-testid="webserver-pill"
      data-access={s.access}
      title={`Web server running${s.access === 'lan' ? ' on your network' : ''} — click for the link and how to stop it`}
      onClick={openInfo}
    >
      <Icon name="globe" size={12} />:{s.port}
    </button>
  );
}

// ---- Settings → Browser mode ---------------------------------------------------------------------

export function SettingsPanel() {
  useEffect(() => install(), []);
  const s = status.value;
  const headline =
    s.state === 'running'
      ? `Serving ${s.root ?? ''}`
      : s.state === 'starting'
        ? 'Starting…'
        : app.workspace.value
          ? 'Not running. Nothing starts on its own.'
          : 'Open a folder first.';
  return (
    <div class="se-wsrv-panel" data-testid="webserver-settings">
      <div class="se-wsrv-head">
        <StateChip s={s} />
        <span class="se-wsrv-headline">{headline}</span>
        <StartStop s={s} />
      </div>
      {s.state === 'error' && (
        <p class="se-wsrv-error" role="alert" data-testid="webserver-error">
          {s.error}
        </p>
      )}
      {s.state === 'running' && <Links s={s} />}
      <details class="se-wsrv-more">
        <summary>What’s different in the browser · how to stop</summary>
        <Limits />
        <p class="se-wsrv-text">{HOW_TO_STOP}</p>
      </details>
    </div>
  );
}
