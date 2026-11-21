// Settings → MCP server → Recent activity (lazy mcp-ui chunk only). Same look and behaviour as the Security
// updates "Show all packages" list (marks, compact rows, a filter, collapsed), but newest first plus a
// "problems only" switch. Every field came from the audit log (another process) through main: shown as text.
import { useState } from 'preact/hooks';
import type { McpActivity } from '@shared/mcp';

/** Calls shown before "Show all N calls". */
export const FEW = 5;

type Mark = 'ok' | 'problem' | 'reverted';
const GLYPH: Record<Mark, string> = { ok: '✓', problem: '!', reverted: '↺' };
const SAY: Record<Mark, string> = { ok: 'OK', problem: 'Refused or failed', reverted: 'Reverted' };

/** The log keeps a call's code, not its message: one fixed short line per code the server uses. */
const CODE_SAY: Record<string, string> = {
  EACCES: 'not allowed',
  ENOENT: 'not found',
  EINVAL: 'invalid request',
  EEXIST: 'already exists',
  ETOOBIG: 'too large',
  ENOTSUP: 'not supported',
  ENOTDIR: 'not a folder',
  EISDIR: 'is a folder',
  EXTERNAL_CHANGE: 'file changed meanwhile',
  ESECRET: '{{variables}} are protected',
  EQUOTA: 'undo copy limit reached',
  ELIMIT: 'limit reached',
  ENOMATCH: 'text not found',
  EAMBIGUOUS: 'text matches more than once',
  ENODATA: 'no undo copy kept',
  EBUSY: 'busy, retry',
  EALREADY: 'already done',
  ETRASH: 'no Recycle Bin',
  ENOSPC: 'disk full',
  EIO: 'could not complete',
};

const markOf = (r: McpActivity): Mark => (r.reverted ? 'reverted' : r.ok ? 'ok' : 'problem');
const result = (r: McpActivity) => {
  const code = r.code ?? 'error';
  const say = r.code ? CODE_SAY[r.code] : undefined;
  return say ? `${code} · ${say}` : code;
};
const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** Today: the time only; older rows also say the day. */
const clock = (t: number, now: number) =>
  new Date(t).toDateString() === new Date(now).toDateString()
    ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** What the filter matches: tool, path, folder, app, result code (+ its short line), "reverted". */
const haystack = (r: McpActivity) => [r.tool, r.path, r.folder, r.client, r.ok ? 'ok' : result(r), r.reverted ? 'reverted' : ''].join(' ').toLowerCase();

/** Stable keys while new calls arrive on top (a row's open details stay with that row). */
function keyed(rows: McpActivity[]) {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const k = `${r.t}|${r.token ?? r.client}|${r.tool}|${r.path ?? ''}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return { r, key: n ? `${k}|${n}` : k };
  });
}

function CallRow({ r, now, revert }: { r: McpActivity; now: number; revert: (r: McpActivity) => void }) {
  const [open, setOpen] = useState(false);
  const mark = markOf(r);
  const where = r.path ?? r.folder ?? '';
  const more = [
    r.folder && `Folder ${r.folder}`,
    r.path && `File ${r.path}`,
    `Answer ${size(r.bytes)}`,
    new Date(r.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }),
    r.journal && !r.reverted && 'Undo copy kept',
  ].filter(Boolean);
  return (
    <li class="se-mcp-call" data-mark={mark} data-testid="mcp-call">
      <span class="se-mcp-mark" role="img" aria-label={SAY[mark]}>
        {GLYPH[mark]}
      </span>
      <button class="se-mcp-call-what" aria-expanded={open} data-testid="mcp-call-open" onClick={() => setOpen(!open)}>
        <span class="se-mcp-time">{clock(r.t, now)}</span>
        <span class="se-mcp-app">{r.client}</span>
        <span class="se-mcp-tool">{r.tool}</span>
        {/* The error sits next to the path, never cut: the path gives way first. */}
        <span class="se-mcp-target">
          <span class="se-mcp-where">{where}</span>
          {!r.ok && (
            <span class="se-mcp-code" data-testid="mcp-call-error">
              {result(r)}
            </span>
          )}
        </span>
      </button>
      <span class="se-mcp-ms">{took(r.ms)}</span>
      {r.reverted ? (
        <span class="se-mcp-undo se-mcp-reverted" data-testid="mcp-reverted">
          reverted
        </span>
      ) : r.ok && r.journal ? (
        <span class="se-mcp-undo">
          <button class="se-link-btn" data-testid="mcp-revert" title="Undo this change (only if the file was not changed since)" onClick={() => revert(r)}>
            Revert
          </button>
        </span>
      ) : null}
      {open && (
        <span class="se-mcp-call-more" data-testid="mcp-call-details">
          {more.join(' · ')}
        </span>
      )}
    </li>
  );
}

/** The list; `rows` as main sends them (newest first, at most 50), `revert` asks main to undo one write. */
export function ActivityList({ rows, revert, now = Date.now() }: { rows: McpActivity[]; revert: (r: McpActivity) => void; now?: number }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState('');
  const [bad, setBad] = useState(false);
  if (!rows.length) {
    return (
      <p class="se-mcp-note" data-testid="mcp-activity-empty">
        No calls yet. Each call is logged here (tool, folder, file, result: never the text or a search query). Changes get a Revert button.
      </p>
    );
  }
  const needle = q.trim().toLowerCase();
  const narrowed = !!needle || bad;
  const problems = rows.filter((r) => !r.ok).length;
  // Newest first (stable: main's order stays for calls in the same millisecond).
  const matches = keyed([...rows].sort((a, b) => b.t - a.t)).filter(({ r }) => (!bad || !r.ok) && (!needle || haystack(r).includes(needle)));
  // A filter or "problems only" searches every call; otherwise only the last few until "Show all".
  const shown = narrowed || all ? matches : matches.slice(0, FEW);
  return (
    <div class="se-mcp-calls-box">
      <div class="se-mcp-row">
        <input class="se-input se-mcp-filter" type="search" placeholder={`Filter ${rows.length} calls`} aria-label="Filter calls" data-testid="mcp-activity-filter" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
        <label class="se-mcp-check" title="Only calls that were refused or failed">
          <input type="checkbox" data-testid="mcp-activity-problems" checked={bad} onChange={(e) => setBad((e.currentTarget as HTMLInputElement).checked)} />
          Problems only ({problems})
        </label>
        {narrowed && (
          <span class="se-mcp-count" data-testid="mcp-activity-count">
            {matches.length} of {rows.length} calls
          </span>
        )}
      </div>
      {shown.length > 0 ? (
        <ul class="se-mcp-calls" data-testid="mcp-activity">
          {shown.map(({ r, key }) => (
            <CallRow key={key} r={r} now={now} revert={revert} />
          ))}
        </ul>
      ) : (
        <p class="se-mcp-note" data-testid="mcp-activity-none">
          {needle ? `No ${bad ? 'refused or failed ' : ''}call matches “${q.trim()}”.` : 'No refused or failed calls.'}
        </p>
      )}
      {!narrowed && rows.length > FEW && (
        <button class="se-link-btn" aria-expanded={all} data-testid="mcp-activity-toggle" onClick={() => setAll(!all)}>
          {all ? `Show only the last ${FEW}` : `Show all ${rows.length} calls`}
        </button>
      )}
    </div>
  );
}
