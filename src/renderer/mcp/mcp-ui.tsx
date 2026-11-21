// Settings → MCP server (lazy chunk, desktop only: imported by the Settings overlay, nothing at startup).
// Shows what main reports over `secEditBridge.mcp` and asks main to change it: main owns mcp.json and
// shows the native dialogs (turn on, share a folder, allow changes, code files, undo off, tokens). The page
// never names a folder path and never sees an access token: "Copy setup" happens in main.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { app } from '../app/app';
import { Icon } from '../app/icons';
import '../app/icon-pack'; // refresh, copy
import { NO_MCP_STATUS, TOKEN_ENV, UNDO_DAYS, setupSnippets, type McpActivity, type McpFolder, type McpReply, type McpStatus, type SetupSnippet } from '@shared/mcp';
import { ActivityList } from './activity';
import './mcp.css';

interface Bridge {
  status(): Promise<unknown>;
  setEnabled(on: boolean, client?: string): Promise<unknown>;
  setAllowCode(id: string, on: boolean): Promise<unknown>;
  setUndo(o: { on?: boolean; days?: number }): Promise<unknown>;
  createToken(name: string, client: string): Promise<unknown>;
  regenerateToken(id: string, client: string): Promise<unknown>;
  revokeToken(id: string): Promise<unknown>;
  copySetup(id: string, client: string): Promise<unknown>;
  addFolder(): Promise<unknown>;
  removeFolder(id: string): Promise<unknown>;
  setMode(id: string, mode: string): Promise<unknown>;
  activity(): Promise<unknown>;
  revert(group: string): Promise<unknown>;
  onChange(cb: (s: unknown) => void): () => void;
}
const bridge = () => (globalThis as { secEditBridge?: { mcp?: Bridge } }).secEditBridge?.mcp;

async function call<T>(p: Promise<unknown> | undefined): Promise<T> {
  const r = (await p) as McpReply<T> | undefined;
  if (!r) throw new Error('Not available in this build');
  if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
  return r.result;
}

/** "No" in one of main's native dialogs: the user's own choice, not an error worth a toast. */
const cancelled = (err: unknown) => (err as { code?: string })?.code === 'ECANCELED';

const status = signal<McpStatus>(NO_MCP_STATUS);
/** main's first answer is in: the rows above Recent activity have their real height. */
const loaded = signal(false);
const activity = signal<McpActivity[]>([]);
/** The client tab: the setup main copies (with a token) is for this app. */
const client = signal<SetupSnippet['id']>('lmstudio');
let installed = false;

function install() {
  const b = bridge();
  if (!b || installed) return;
  installed = true;
  b.onChange((s) => (status.value = s as McpStatus));
  void call<McpStatus>(b.status()).then((s) => (status.value = s), () => {}).finally(() => (loaded.value = true));
  (globalThis as { __secEditMcp?: unknown }).__secEditMcp = { status: () => status.value }; // E2E
}

/** Runs a change in main; its answer (or an error) lands in the panel. Cancelled dialogs change nothing. */
async function change(fn: (b: Bridge) => Promise<unknown>) {
  const b = bridge();
  if (!b) return;
  try {
    status.value = await call<McpStatus>(fn(b));
  } catch (err) {
    if (!cancelled(err)) app.toast(`MCP server: ${(err as Error).message}`, 'error');
  }
}

async function refreshActivity() {
  const b = bridge();
  if (!b) return;
  activity.value = await call<McpActivity[]>(b.activity()).catch(() => activity.value);
}

function FolderRow({ f, writes }: { f: McpFolder; writes: boolean }) {
  // This build ships read-only (MCP_WRITES_ENABLED): whatever mcp.json says, the folder is served read-only.
  const mode = writes ? f.mode : 'read';
  return (
    <li class="se-mcp-folder" data-testid="mcp-folder" data-alias={f.alias}>
      <div class="se-mcp-folder-what">
        <span class="se-mcp-alias">{f.alias}</span>
        <span class="se-mcp-path" title={f.path}>
          {f.path}
        </span>
      </div>
      <div class="se-seg" role="radiogroup" aria-label={`Access to ${f.alias}`}>
        {(['read', 'write'] as const).map((m) => (
          <button
            class={`se-seg-btn${mode === m ? ' active' : ''}`}
            role="radio"
            aria-checked={mode === m}
            data-testid={`mcp-mode-${m}`}
            disabled={m === 'write' && !writes}
            title={m === 'write' && !writes ? 'Coming in the next build: AI apps can only read for now' : undefined}
            onClick={() => void change((b) => b.setMode(f.id, m))}
          >
            {m === 'read' ? 'Read-only' : 'Read-write'}
          </button>
        ))}
      </div>
      {mode === 'write' && (
        <label class="se-mcp-check" title="Also code and config files (.json, .yaml, .ts…), not only notes. Asks first.">
          <input type="checkbox" data-testid="mcp-allow-code" checked={!!f.allowCode} onChange={(e) => void change((b) => b.setAllowCode(f.id, (e.currentTarget as HTMLInputElement).checked))} />
          Code files
        </label>
      )}
      <button class="se-btn small" data-testid="mcp-remove" title={`Stop sharing ${f.alias}`} onClick={() => void change((b) => b.removeFolder(f.id))}>
        Remove
      </button>
    </li>
  );
}

function Setup({ s }: { s: McpStatus }) {
  if (!s.launch) return <p class="se-mcp-note">This build has no MCP server program (dist/mcp/cli.mjs). Build or install One again.</p>;
  // The preview shows where the token goes, masked: main puts the real one in when it copies.
  const all = setupSnippets({ ...s.launch, env: { ...s.launch.env, [TOKEN_ENV]: 'one_••••' } }, s.platform);
  const cur = all.find((x) => x.id === client.value) ?? all[0];
  return (
    <div class="se-mcp-setup" data-testid="mcp-setup">
      <div class="se-seg" role="tablist" aria-label="Client">
        {all.map((x) => (
          <button class={`se-seg-btn${x.id === cur.id ? ' active' : ''}`} role="tab" aria-selected={x.id === cur.id} data-testid={`mcp-client-${x.id}`} onClick={() => (client.value = x.id)}>
            {x.title}
          </button>
        ))}
      </div>
      <p class="se-mcp-note">
        <strong>Where:</strong> {cur.where}
      </p>
      <pre class="se-mcp-snippet" data-testid="mcp-snippet" data-lang={cur.lang}>
        {cur.text}
      </pre>
      <p class="se-mcp-note">Copy a setup with its token below, paste it into the app, restart the app. Nothing needs Node.js: One runs the server itself.</p>
    </div>
  );
}

const day = (t: number | null) => (t ? new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' }) : 'never');
/** "today 14:03" / "21 Nov 2026, 14:03" / "never": last use needs the time, a day alone says too little. */
function when(t: number | null): string {
  if (!t) return 'never';
  const d = new Date(t);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `today ${time}` : `${day(t)}, ${time}`;
}

/** Access tokens: one per app. The page sees names and dates only; copying runs in main. */
function Tokens({ s }: { s: McpStatus }) {
  const [name, setName] = useState('');
  const copy = async (id: string) => {
    const b = bridge();
    if (!b) return;
    try {
      await call(b.copySetup(id, client.value));
      app.toast('Setup with its token copied: paste it into the app', 'success');
    } catch (err) {
      if (!cancelled(err)) app.toast(`MCP server: ${(err as Error).message}`, 'error');
    }
  };
  return (
    <div class="se-mcp-tokens" data-testid="mcp-tokens">
      <p class="se-mcp-note" data-testid="mcp-token-note">
        Every app needs its own access token. Updated One? <strong>Copy the setup again: a token is now required.</strong>
        {s.tokenStore === 'once' ? ' No keyring on this computer: a token can only be copied when it is made.' : ''}
      </p>
      {s.tokens.length > 0 && (
        <ul class="se-mcp-folders">
          {s.tokens.map((t) => (
            <li class="se-mcp-token" data-testid="mcp-token" data-name={t.name}>
              {/* Line 1: who + actions (wraps below the name on a narrow panel). Line 2: the dates, never cut off. */}
              <div class="se-mcp-token-head">
                <span class="se-mcp-alias">{t.name}</span>
                <code class="se-mcp-token-hint" title="The first characters of the token, to tell tokens apart">
                  one_{t.hint}…
                </code>
              </div>
              <div class="se-mcp-token-actions">
                <button class="se-btn small" data-testid="mcp-token-copy" disabled={!t.copyable} title={t.copyable ? 'Copy the setup for the app chosen above, with this token' : 'Only copyable when made: regenerate it'} onClick={() => void copy(t.id)}>
                  <Icon name="copy" size={13} />
                  Copy setup
                </button>
                <button class="se-btn small" data-testid="mcp-token-regenerate" onClick={() => void change((b) => b.regenerateToken(t.id, client.value))}>
                  Regenerate
                </button>
                <button class="se-btn small" data-testid="mcp-token-revoke" onClick={() => void change((b) => b.revokeToken(t.id))}>
                  Revoke
                </button>
              </div>
              <div class="se-mcp-token-meta" data-testid="mcp-token-meta">
                <span>
                  Last used <strong title={t.lastUsed ? new Date(t.lastUsed).toLocaleString() : undefined}>{when(t.lastUsed)}</strong>
                </span>
                <span>Made {day(t.created)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div class="se-mcp-row">
        <input class="se-input" data-testid="mcp-token-name" placeholder="App name, e.g. Codex CLI" value={name} maxLength={60} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <button
          class="se-btn small"
          data-testid="mcp-token-new"
          disabled={!name.trim()}
          onClick={() =>
            void change((b) => b.createToken(name.trim(), client.value)).then(() => {
              setName('');
            })
          }
        >
          <Icon name="plus" size={13} />
          New token for another app…
        </button>
      </div>
    </div>
  );
}

/** Undo copies: on / off (off asks in a native dialog) and how long they are kept. */
function Undo({ s }: { s: McpStatus }) {
  return (
    <div class="se-mcp-row" data-testid="mcp-undo">
      <label class="se-mcp-check">
        <input type="checkbox" data-testid="mcp-undo-on" checked={s.undo.on} onChange={(e) => void change((b) => b.setUndo({ on: (e.currentTarget as HTMLInputElement).checked }))} />
        Keep undo copies of AI edits
      </label>
      <label class="se-mcp-check">
        for
        <input
          class="se-input narrow"
          type="number"
          data-testid="mcp-undo-days"
          min={UNDO_DAYS.min}
          max={UNDO_DAYS.max}
          value={s.undo.days}
          disabled={!s.undo.on}
          onChange={(e) => void change((b) => b.setUndo({ days: Number((e.currentTarget as HTMLInputElement).value) }))}
        />
        days
      </label>
      <span class="se-mcp-note">Off: AI changes made from then on cannot be reverted. Deletes always keep a copy.</span>
    </div>
  );
}

/** Undoes one MCP write in main (all or nothing, only onto files still as MCP left them). */
async function revert(r: McpActivity) {
  const b = bridge();
  if (!b || !r.journal) return;
  try {
    const res = await call<{ reverted: number }>(b.revert(r.journal));
    app.toast(`Reverted ${r.tool}${r.path ? ` (${r.path})` : ''}${res.reverted > 1 ? `: ${res.reverted} changes` : ''}`, 'success');
  } catch (err) {
    app.toast(`Could not revert: ${(err as Error).message}`, 'error');
  }
  await refreshActivity();
}

let reveal = false;
/** The status bar's MCP icon: the next Settings open lands on Recent activity. */
export const revealActivity = () => void (reveal = true);

function Activity() {
  const box = useRef<HTMLDivElement>(null);
  const ready = loaded.value;
  useEffect(() => {
    if (!reveal || !ready) return;
    reveal = false;
    // A frame later: after Settings' own scroll to the section (a parent's effect runs after ours).
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'start' }));
  }, [ready]);
  return (
    <div ref={box} class="se-mcp-activity" data-testid="mcp-recent">
      <div class="se-mcp-row">
        <h4 class="se-set-group">Recent activity</h4>
        <button class="se-btn small" data-testid="mcp-activity-refresh" onClick={() => void refreshActivity()}>
          <Icon name="refresh" size={13} />
          Refresh
        </button>
      </div>
      <ActivityList rows={activity.value} revert={(r) => void revert(r)} />
    </div>
  );
}

export function SettingsPanel() {
  useEffect(() => {
    install();
    void refreshActivity();
    // Only while Settings is open: the servers append to the log from their own processes.
    const t = setInterval(() => void refreshActivity(), 4000);
    return () => clearInterval(t);
  }, []);
  const s = status.value;
  return (
    <div class="se-mcp-panel" data-testid="mcp-settings">
      <div class="se-mcp-head">
        <button class={`se-switch${s.enabled ? ' on' : ''}`} role="switch" aria-checked={s.enabled} aria-label="Enable MCP server" data-testid="mcp-enable" onClick={() => void change((b) => b.setEnabled(!s.enabled, client.value))}>
          <span class="se-switch-knob" />
        </button>
        <span class="se-mcp-headline" data-testid="mcp-state" data-on={s.enabled ? 'yes' : 'no'}>
          {s.enabled ? 'On: MCP clients you set up can read the folders below.' : 'Off. No MCP client can reach your files.'}
        </span>
      </div>
      <h4 class="se-set-group">Shared folders</h4>
      {s.folders.length ? (
        <ul class="se-mcp-folders">
          {s.folders.map((f) => (
            <FolderRow key={f.id} f={f} writes={s.writes} />
          ))}
        </ul>
      ) : (
        <p class="se-mcp-note" data-testid="mcp-no-folders">
          None yet. Only folders listed here are visible, never the rest of this computer.
        </p>
      )}
      <div class="se-mcp-row">
        <button
          class="se-btn small"
          data-testid="mcp-add-folder"
          title={`Pick one or more folders (${s.platform === 'darwin' ? 'Cmd' : 'Ctrl'}+click for several). They are shared read-only; several at once are listed for your OK first.`}
          onClick={() => void change((b) => b.addFolder())}
        >
          <Icon name="plus" size={13} />
          Add folders…
        </button>
        <span class="se-mcp-note" data-testid="mcp-folders-note">
          {s.writes
            ? 'Hidden files (.git, .env…), key files and your excluded folders stay invisible and can never be changed. Read-write lets AI apps edit, move and delete (to the Recycle Bin) notes; each change can be reverted below.'
            : 'Hidden files (.git, .env…), key files and your excluded folders stay invisible. This build is read-only.'}
        </span>
      </div>
      <h4 class="se-set-group">Client setup</h4>
      <Setup s={s} />
      <h4 class="se-set-group">Access tokens</h4>
      <Tokens s={s} />
      {s.writes && (
        <>
          <h4 class="se-set-group">Undo</h4>
          <Undo s={s} />
        </>
      )}
      <Activity />
    </div>
  );
}
