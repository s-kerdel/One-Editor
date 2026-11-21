// Settings → MCP server (lazy chunk, desktop only: imported by the Settings overlay, nothing at startup).
// Shows what main reports over `secEditBridge.mcp` and asks main to change it: main owns mcp.json and
// shows the native dialogs (turn on, share a folder, allow changes). The page never names a folder path.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { app } from '../app/app';
import { Icon } from '../app/icons';
import '../app/icon-pack'; // refresh, copy
import { copyText } from '../app/fileops';
import { NO_MCP_STATUS, setupSnippets, type McpActivity, type McpFolder, type McpReply, type McpStatus, type SetupSnippet } from '@shared/mcp';
import './mcp.css';

interface Bridge {
  status(): Promise<unknown>;
  setEnabled(on: boolean): Promise<unknown>;
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
  if (!r.ok) throw new Error(r.error.message);
  return r.result;
}

const status = signal<McpStatus>(NO_MCP_STATUS);
const activity = signal<McpActivity[]>([]);
let installed = false;

function install() {
  const b = bridge();
  if (!b || installed) return;
  installed = true;
  b.onChange((s) => (status.value = s as McpStatus));
  void call<McpStatus>(b.status()).then((s) => (status.value = s), () => {});
  (globalThis as { __secEditMcp?: unknown }).__secEditMcp = { status: () => status.value }; // E2E
}

/** Runs a change in main; its answer (or an error) lands in the panel. Cancelled dialogs change nothing. */
async function change(fn: (b: Bridge) => Promise<unknown>) {
  const b = bridge();
  if (!b) return;
  try {
    status.value = await call<McpStatus>(fn(b));
  } catch (err) {
    app.toast(`MCP server: ${(err as Error).message}`, 'error');
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
      <button class="se-btn small" data-testid="mcp-remove" title={`Stop sharing ${f.alias}`} onClick={() => void change((b) => b.removeFolder(f.id))}>
        Remove
      </button>
    </li>
  );
}

function Setup({ s }: { s: McpStatus }) {
  const [pick, setPick] = useState<SetupSnippet['id']>('lmstudio');
  if (!s.launch) return <p class="se-mcp-note">This build has no MCP server program (dist/mcp/cli.mjs). Build or install One again.</p>;
  const all = setupSnippets(s.launch, s.platform);
  const cur = all.find((x) => x.id === pick) ?? all[0];
  return (
    <div class="se-mcp-setup" data-testid="mcp-setup">
      <div class="se-seg" role="tablist" aria-label="Client">
        {all.map((x) => (
          <button class={`se-seg-btn${x.id === cur.id ? ' active' : ''}`} role="tab" aria-selected={x.id === cur.id} data-testid={`mcp-client-${x.id}`} onClick={() => setPick(x.id)}>
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
      <div class="se-mcp-row">
        <button class="se-btn small" data-testid="mcp-copy" onClick={() => void copyText(cur.text, `${cur.title} setup`)}>
          <Icon name="copy" size={13} />
          Copy
        </button>
        <span class="se-mcp-note">Restart the client after adding it. Nothing needs Node.js: One runs the server itself.</span>
      </div>
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

const when = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function Activity() {
  const rows = activity.value;
  return (
    <div class="se-mcp-activity">
      <div class="se-mcp-row">
        <h4 class="se-set-group">Recent activity</h4>
        <button class="se-btn small" data-testid="mcp-activity-refresh" onClick={() => void refreshActivity()}>
          <Icon name="refresh" size={13} />
          Refresh
        </button>
      </div>
      {rows.length ? (
        <table class="se-mcp-table" data-testid="mcp-activity">
          <tbody>
            {rows.slice(0, 50).map((r) => (
              <tr data-ok={r.ok ? 'yes' : 'no'}>
                <td class="se-mcp-time">{when(r.t)}</td>
                <td>{r.client}</td>
                <td class="se-mcp-tool">{r.tool}</td>
                <td class="se-mcp-target" title={[r.folder, r.path].filter(Boolean).join(': ')}>
                  {[r.folder, r.path].filter(Boolean).join(': ')}
                </td>
                <td class="se-mcp-result">{r.ok ? 'ok' : (r.code ?? 'error')}</td>
                <td class="se-mcp-undo">
                  {r.reverted ? (
                    <span class="se-mcp-reverted" data-testid="mcp-reverted">
                      reverted
                    </span>
                  ) : r.ok && r.journal ? (
                    <button class="se-link-btn" data-testid="mcp-revert" title="Undo this change (only if the file was not changed since)" onClick={() => void revert(r)}>
                      Revert
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p class="se-mcp-note" data-testid="mcp-activity-empty">
          No calls yet. Each call is logged here (tool, folder, file, result: never the text or a search query). Changes get a Revert button.
        </p>
      )}
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
        <button class={`se-switch${s.enabled ? ' on' : ''}`} role="switch" aria-checked={s.enabled} aria-label="Enable MCP server" data-testid="mcp-enable" onClick={() => void change((b) => b.setEnabled(!s.enabled))}>
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
        <button class="se-btn small" data-testid="mcp-add-folder" onClick={() => void change((b) => b.addFolder())}>
          <Icon name="plus" size={13} />
          Add folder…
        </button>
        <span class="se-mcp-note" data-testid="mcp-folders-note">
          {s.writes
            ? 'Hidden files (.git, .env…), key files and your excluded folders stay invisible and can never be changed. Read-write lets AI apps edit, move and delete (to the Recycle Bin) notes; each change can be reverted below.'
            : 'Hidden files (.git, .env…), key files and your excluded folders stay invisible. AI apps can only read in this build: Read-write comes in the next build.'}
        </span>
      </div>
      <h4 class="se-set-group">Client setup</h4>
      <Setup s={s} />
      <Activity />
    </div>
  );
}
