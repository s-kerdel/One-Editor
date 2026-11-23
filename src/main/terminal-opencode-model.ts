// "AI changes" for Opencode terminals — the PURE part (no I/O): opencode's server events (`GET /api/event`) and
// its per-session diff answers (`GET /api/session/{id}/diff`) → a per-file change list (+ / − rows) and the
// follow events the existing renderer already understands (`term:follow`). The wire shapes were recorded
// from opencode 2.3.2 (tests/fixtures/opencode/session-2.3.2.jsonl); the payload types are not documented
// by opencode, so every field is read defensively and anything odd is skipped, never thrown on.
// Trust: the stream comes from a server One started itself, but it is still untrusted input — an event can only
// ever mean "show a file inside the open folder" (lexical rule here, the workspace's real-path rule in the caller).
// What it shares with the Claude Code path (path rules, range merge, rows, snapshot) lives in terminal-changes.ts.
import { CHANGES_MAX_FILES, type AgentChangeFile, type TerminalFollowEvent } from '../shared/terminal';
import { cleanRel, isCount, isObj, MAX_PATH, mergeRanges, PATCH_LIMITS, snapshotRows, toRel, touchRow, type ChangeRow, type PathCtx } from './terminal-changes';

export { cleanRel, toRel };
export type OpencodeCtx = PathCtx;

/** Event types the SSE subscription asks for (the `types` filter cuts a turn to ~8 events instead of hundreds of text deltas). */
export const OPENCODE_EVENT_TYPES = [
  'session.created',
  'session.deleted',
  'session.inbox.enqueued',
  'session.tool.called',
  'session.tool.success',
  'session.tool.failed',
  'session.step.ended',
  'session.shell.ended',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.revert.committed',
] as const;

const MAX_SESSIONS = 200;
const STATUSES = new Set(['added', 'deleted', 'modified']);
/** A session / message id as it may appear in a request path (anything else is not ours to ask about). */
export const OPENCODE_ID = /^[\w.-]{1,200}$/;

/**
 * Changed lines of the NEW file from a unified patch (opencode's tool patches carry 3 context lines, its session
 * diff has none): context moves the counter, an added line is marked and moves it, a removed line marks where
 * it was. Merged, capped; null when the patch holds no change.
 */
export function patchLines(patch: unknown): Array<[number, number]> | null {
  if (typeof patch !== 'string' || patch.length > 4 * 1024 * 1024) return null;
  const marks: number[] = [];
  let n = 0;
  let inHunk = false;
  let hunks = 0;
  let walked = 0;
  for (const l of patch.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      if (++hunks > PATCH_LIMITS.hunks) break;
      n = Math.min(PATCH_LIMITS.lineNo, Math.max(1, +h[1]));
      inHunk = true;
      continue;
    }
    if (!inHunk || ++walked > PATCH_LIMITS.lines) continue;
    const c = l[0];
    if (c === '+') marks.push(n++);
    else if (c === '-') marks.push(n);
    else if (c === ' ') n++;
    // '\ No newline…', '' (the split's last piece) and anything else: ignored
  }
  return marks.length ? mergeRanges(marks) : null;
}

interface Sess {
  parent: string | null;
  busy: boolean;
  /** User prompt ids in order (the `/diff` range runs from the first to the last). */
  turnIds: string[];
  /** tool call id → workspace path the call announced (`session.tool.called`), shown once the call succeeded. */
  calls: Map<string, string>;
  /**
   * The folder opencode's relative paths are relative to when that is not the open folder (its project root — a git
   * work tree — is above it): absolute, as opencode names it. null = the open folder itself.
   */
  base: string | null;
}

/** `pending` = only announced by a tool call so far: it goes again when that call fails or the turn ends without it. */
type Row = ChangeRow<{ session: string; pending: boolean }>;

export interface OpencodeState {
  sessions: Map<string, Sess>;
  files: Map<string, Row>;
  /** Turns (user prompts) seen since this server started. */
  turns: number;
}

export const emptyState = (): OpencodeState => ({ sessions: new Map(), files: new Map(), turns: 0 });

/** What one event asks the caller to do. */
export interface EventResult {
  follow: Array<Omit<TerminalFollowEvent, 'id' | 'agent'>>;
  /** Sessions whose exact numbers should be fetched (`/diff`), debounced by the caller. */
  refresh: string[];
  /** The list or the busy flag changed: send a new snapshot. */
  changed: boolean;
}

const none = (): EventResult => ({ follow: [], refresh: [], changed: false });

export const isBusy = (st: OpencodeState) => [...st.sessions.values()].some((s) => s.busy);

/**
 * opencode's project root for a session opened in `dir`, when `subpath` (the session folder inside that project) says
 * the project starts above it: "/repo/packages/app" + "packages/app" → "/repo". null = no usable answer (then
 * relative paths are taken as relative to the open folder, which is right whenever the folder is the project root).
 */
export function worktreeOf(dir: unknown, subpath: unknown, win: boolean): string | null {
  if (typeof dir !== 'string' || typeof subpath !== 'string' || !dir || !subpath || dir.length > MAX_PATH || subpath.length > MAX_PATH) return null;
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const d = norm(dir);
  const sub = norm(subpath).replace(/^\/+/, '');
  if (!sub || sub.split('/').some((x) => !x || x === '.' || x === '..')) return null;
  const tail = '/' + sub;
  if (win ? !d.toLowerCase().endsWith(tail.toLowerCase()) : !d.endsWith(tail)) return null;
  return d.slice(0, d.length - tail.length) || '/';
}

/**
 * Registers a session as ours (a `session.created` event, or the tracker's resync / adoption of a session it
 * learned about from the server's list). false: the list is full of sessions that are all working.
 */
export function addSession(st: OpencodeState, id: string, o: { parent?: string | null; base?: string | null } = {}): boolean {
  if (!OPENCODE_ID.test(id)) return false;
  if (st.sessions.has(id)) return true;
  if (st.sessions.size >= MAX_SESSIONS) {
    // Long-lived terminals (every subagent is a session): the oldest idle one makes room; its rows stay.
    const idle = [...st.sessions].find(([, s]) => !s.busy)?.[0];
    if (idle === undefined) return false;
    st.sessions.delete(idle);
  }
  st.sessions.set(id, { parent: o.parent ?? null, busy: false, turnIds: [], calls: new Map(), base: o.base ?? null });
  return true;
}

/** Input of a tool that writes a file (edit / write / patch), as opposed to one that only reads or searches under a path. */
const WRITE_INPUT_KEYS = ['content', 'oldString', 'newString', 'old_string', 'new_string', 'patch', 'patchText', 'edits'];
const writes = (input: Record<string, unknown>) => WRITE_INPUT_KEYS.some((k) => input[k] !== undefined && input[k] !== null);

/**
 * Applies one decoded SSE event. `folder` = the open folder as opencode would name it: a session of another
 * folder is ignored (the server is shared by every session of the user's project, ours included).
 */
export function onEvent(st: OpencodeState, ev: unknown, ctx: OpencodeCtx, folder: (dir: string) => boolean): EventResult {
  const out = none();
  if (!isObj(ev) || typeof ev.type !== 'string' || !isObj(ev.data)) return out;
  const d = ev.data;
  // The id ends up in request paths (`/api/session/{id}/diff`): nothing but id characters.
  const sid = typeof d.sessionID === 'string' && OPENCODE_ID.test(d.sessionID) ? d.sessionID : null;
  if (!sid) return out;
  if (ev.type === 'session.created') {
    const dir = isObj(ev.location) ? ev.location.directory : isObj(d.location) ? d.location.directory : undefined;
    const parent = typeof d.parentID === 'string' ? d.parentID : null;
    const mother = parent ? st.sessions.get(parent) : undefined;
    // Ours: opened in the open folder, or a child (subagent) of one of ours.
    if ((typeof dir === 'string' && folder(dir)) || mother) addSession(st, sid, { parent, base: worktreeOf(dir, d.subpath, ctx.win) ?? mother?.base ?? null });
    return out;
  }
  const s = st.sessions.get(sid);
  if (!s) return out; // another folder's session
  const rel = (p: unknown) => toRel(ctx, p, s.base);
  switch (ev.type) {
    case 'session.inbox.enqueued': {
      if (!isObj(d.item) || d.item.type !== 'user') break;
      if (typeof d.inboxID === 'string' && s.turnIds.length < 1000) s.turnIds.push(d.inboxID);
      if (!s.busy) {
        s.busy = true;
        out.changed = true;
        // A subagent's task is its parent's turn, not a new one of the user's: no turn count, no mark clearing.
        if (!s.parent) {
          st.turns++;
          out.follow.push({ kind: 'prompt' });
        }
      }
      break;
    }
    case 'session.tool.called': {
      // The event names no tool: only a call whose input is a write (text to put into the file) announces a change —
      // a read / search / list under a path must not put that path in the list.
      const path = isObj(d.input) && writes(d.input) ? rel(d.input.path ?? d.input.filePath) : null;
      if (path && typeof d.id === 'string') {
        if (s.calls.size > 500) s.calls.clear();
        s.calls.set(d.id, path);
        // First signal, before the write: the row appears with an estimate (exact numbers follow from the diff).
        if (touchRow(st.files, path, st.turns, { session: sid, pending: true })) out.changed = true;
      }
      break;
    }
    case 'session.tool.success': {
      const id = typeof d.id === 'string' ? d.id : '';
      const announced = s.calls.get(id);
      s.calls.delete(id);
      const meta = isObj(d.metadata) ? d.metadata : {};
      const shown = new Set<string>();
      for (const f of Array.isArray(meta.files) ? (meta.files as unknown[]).slice(0, 50) : []) {
        if (!isObj(f)) continue;
        const path = rel(f.file);
        if (!path) continue;
        const row = confirm(st, path, sid);
        // A tool's own counts (this one edit) are a better estimate than nothing; the diff replaces them.
        if (row && !row.exact && isCount(f.additions) && isCount(f.deletions)) {
          row.additions = f.additions;
          row.deletions = f.deletions;
        }
        const lines = patchLines(f.patch);
        out.follow.push({ kind: 'edit', path, ...(lines ? { lines } : {}) });
        shown.add(path);
      }
      // `write` carries no patch: the whole file is new / replaced → a follow without lines.
      if (announced && !shown.has(announced)) {
        confirm(st, announced, sid);
        out.follow.push({ kind: 'write', path: announced });
      }
      out.refresh.push(sid);
      out.changed = true;
      break;
    }
    case 'session.tool.failed': {
      const id = typeof d.id === 'string' ? d.id : '';
      const announced = s.calls.get(id);
      s.calls.delete(id);
      // Nothing was written: the row this call announced goes, unless something else already confirmed it or
      // another call on the same file is still running.
      if (announced && st.files.get(announced)?.pending && ![...s.calls.values()].includes(announced)) {
        st.files.delete(announced);
        out.changed = true;
      }
      break;
    }
    case 'session.step.ended':
      if (Array.isArray(d.files) && d.files.length) {
        for (const f of (d.files as unknown[]).slice(0, CHANGES_MAX_FILES)) {
          const path = rel(f);
          if (path) confirm(st, path, sid);
        }
        out.refresh.push(sid);
        out.changed = true;
      }
      break;
    case 'session.shell.ended':
    case 'session.revert.committed':
      out.refresh.push(sid);
      break;
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      s.busy = false;
      s.calls.clear();
      // Calls the turn ended without (interrupted): their announced rows were never written.
      for (const [k, v] of st.files) if (v.session === sid && v.pending) st.files.delete(k);
      out.refresh.push(sid);
      if (!s.parent) out.follow.push({ kind: 'stop' });
      out.changed = true;
      break;
    case 'session.deleted':
      st.sessions.delete(sid);
      for (const [k, v] of st.files) if (v.session === sid) st.files.delete(k);
      out.changed = true;
      break;
  }
  return out;
}

/** The row for a path something really changed in the running turn (made when missing and there is room). */
function confirm(st: OpencodeState, path: string, session: string): Row | undefined {
  touchRow(st.files, path, st.turns, { session, pending: false });
  const row = st.files.get(path);
  if (row) {
    row.pending = false;
    row.turn = st.turns;
  }
  return row;
}

/**
 * The answer of `GET /api/session/{id}/diff` for `session` replaces that session's rows (validated field by
 * field; rows the diff does not know — it has no stats for git-ignored files — keep their estimate).
 * `changed` = something visible moved; null when the body is not a diff answer.
 */
export function onDiff(st: OpencodeState, session: string, body: unknown, ctx: OpencodeCtx): { changed: boolean } | null {
  const rows = isObj(body) && Array.isArray(body.data) ? (body.data as unknown[]) : null;
  if (!rows) return null;
  const base = st.sessions.get(session)?.base ?? null;
  const seen = new Set<string>();
  let changed = false;
  for (const f of rows.slice(0, CHANGES_MAX_FILES)) {
    if (!isObj(f)) continue;
    const rel = toRel(ctx, f.file, base);
    if (!rel || !isCount(f.additions) || !isCount(f.deletions) || typeof f.status !== 'string' || !STATUSES.has(f.status)) continue;
    if (!st.files.has(rel) && st.files.size >= CHANGES_MAX_FILES) continue;
    seen.add(rel);
    const old = st.files.get(rel);
    const moved = !old || old.additions !== f.additions || old.deletions !== f.deletions || old.status !== f.status;
    // Its turn: the one that last changed it — a row whose numbers did not move stays where it was.
    const next: Row = { path: rel, session, pending: false, status: f.status as AgentChangeFile['status'], additions: f.additions, deletions: f.deletions, turn: moved ? st.turns : old.turn, exact: true };
    if (moved || old.exact !== true) changed = true;
    st.files.set(rel, next);
  }
  // Rows of this session the diff no longer lists (reverted, or the user undid it) go; estimates stay.
  for (const [k, v] of st.files) {
    if (v.session === session && v.exact && !seen.has(k)) {
      st.files.delete(k);
      changed = true;
    }
  }
  return { changed };
}

/** The list the panel shows (terminal-changes.ts: alphabetical, capped). */
export const snapshot = (st: OpencodeState): AgentChangeFile[] => snapshotRows(st.files);

/** `/diff` query for a session: from its first turn to its last, no context lines (80 files = 26 KB instead of 863 KB). */
export const diffQuery = (turnIds: string[]): string => {
  const ok = turnIds.filter((i) => /^[\w.-]{1,100}$/.test(i));
  return ok.length > 1 ? `?from=${ok[0]}&to=${ok[ok.length - 1]}&context=0` : '?context=0';
};
