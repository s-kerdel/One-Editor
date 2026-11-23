// "AI changes" for Claude Code terminals — the PURE part (no I/O): the hook events terminal-follow.ts already
// reads (prompt, PreToolUse, PostToolUse, Stop) → the same per-file change list Opencode terminals report
// (`term:changes`), and git's numstat at the end of a turn → exact numbers.
//  - PreToolUse (Edit / Write / MultiEdit / NotebookEdit): the row appears before the file changes;
//  - PostToolUse: + / − from the tool's own patch, summed per file — an estimate (`exact: false`);
//  - Stop: `git diff --numstat` against the last commit replaces the estimates and adds what only git saw
//    (a shell command's changes). What was already uncommitted when the session started is not listed.
// Trust: paths arrive mapped into the open folder (terminal-follow.ts); git's paths get the same lexical rule here.
import type { GitNumstatRow } from '../shared/git';
import { CHANGES_MAX_FILES } from '../shared/terminal';
import { cleanRel, isCount, isObj, touchRow, type ChangeRow } from './terminal-changes';

/**
 * `origin`: 'hook' = one of Claude's own tool calls named the file, 'git' = only git saw it change.
 * `pending` = announced by PreToolUse, not written yet (a refused or failed call never is: the row goes at Stop).
 */
type Row = ChangeRow<{ origin: 'hook' | 'git'; pending: boolean }>;

export interface ClaudeChanges {
  files: Map<string, Row>;
  /** Between a prompt and its Stop. */
  busy: boolean;
  /** Prompts seen since the terminal started. */
  turns: number;
  /** path → "additions,deletions,status" of what was already uncommitted when the session started; null = not known. */
  baseline: Map<string, string> | null;
}

export const emptyClaudeChanges = (): ClaudeChanges => ({ files: new Map(), busy: false, turns: 0, baseline: null });

export type ClaudeStep =
  | { kind: 'prompt' | 'stop' }
  | { kind: 'pre'; path: string }
  | { kind: 'edit' | 'write'; path: string; counts?: { additions: number; deletions: number }; created?: boolean };

const cap = (n: number) => Math.min(n, 1e9 - 1);

/** Applies one hook event (its path already mapped into the open folder). True = the list or the busy flag moved. */
export function onClaudeStep(st: ClaudeChanges, e: ClaudeStep): boolean {
  switch (e.kind) {
    case 'prompt':
      st.busy = true;
      st.turns++;
      return true;
    case 'stop': {
      const was = st.busy;
      st.busy = false;
      return was;
    }
    case 'pre':
      return touchRow(st.files, e.path, st.turns, { origin: 'hook', pending: true });
    default: {
      const made = touchRow(st.files, e.path, st.turns, { origin: 'hook', pending: false });
      const row = st.files.get(e.path);
      if (!row) return false; // the list is full
      const before = `${row.additions},${row.deletions},${row.status},${row.exact},${row.pending},${row.turn}`;
      row.origin = 'hook';
      row.pending = false;
      row.turn = st.turns;
      const c = e.counts && isCount(e.counts.additions) && isCount(e.counts.deletions) ? e.counts : null;
      if (e.created) {
        // A new file: all of it is added, whatever was estimated before.
        row.status = 'added';
        row.additions = c ? cap(c.additions) : 0;
        row.deletions = 0;
        row.exact = false;
      } else {
        if (row.status === 'deleted') row.status = 'modified';
        if (c && (c.additions || c.deletions)) {
          // This edit on top of what was counted so far: right to within lines edited twice, until git counts.
          row.additions = cap(row.additions + c.additions);
          row.deletions = cap(row.deletions + c.deletions);
          row.exact = false;
        }
      }
      return made || before !== `${row.additions},${row.deletions},${row.status},${row.exact},${row.pending},${row.turn}`;
    }
  }
}

const sig = (r: { additions: number; deletions: number; status: string }) => `${r.additions},${r.deletions},${r.status}`;

/** git's numstat answer, checked field by field (it crossed a process boundary); null = no answer. */
export function cleanNumstat(rows: unknown, win = false): GitNumstatRow[] | null {
  if (!Array.isArray(rows)) return null;
  const out: GitNumstatRow[] = [];
  for (const r of rows.slice(0, CHANGES_MAX_FILES * 8)) {
    if (!isObj(r)) continue;
    const path = cleanRel(r.path, win);
    const status = r.status;
    if (!path || !isCount(r.additions) || !isCount(r.deletions) || (status !== 'added' && status !== 'deleted' && status !== 'modified')) continue;
    out.push({ path, additions: r.additions, deletions: r.deletions, status });
  }
  return out;
}

/** What was already uncommitted when the session started (kept once: a later answer would hide the session's own work). */
export function setBaseline(st: ClaudeChanges, rows: unknown, win = false): void {
  const list = cleanNumstat(rows, win);
  if (!list || st.baseline) return;
  st.baseline = new Map(list.map((r) => [r.path, sig(r)]));
}

/**
 * The end of a turn. `rows` = git's numstat now (null: no repository, not trusted, git failed — then the estimates
 * stay): rows Claude's tools named get git's numbers; a file only git lists is added when it is not as it was
 * before the session (a shell command changed it); such a row goes again when git no longer lists it. Rows Claude
 * named stay even when git lists them no more (committed, or git-ignored). Announced rows nothing wrote are dropped.
 */
export function reconcile(st: ClaudeChanges, rows: unknown, win = false): boolean {
  let changed = false;
  const list = cleanNumstat(rows, win);
  if (list) {
    const seen = new Set<string>();
    for (const r of list) {
      const row = st.files.get(r.path);
      if (!row) {
        if (!st.baseline || st.baseline.get(r.path) === sig(r) || st.files.size >= CHANGES_MAX_FILES) continue;
        st.files.set(r.path, { ...r, turn: st.turns, exact: true, origin: 'git', pending: false });
        seen.add(r.path);
        changed = true;
        continue;
      }
      seen.add(r.path);
      const moved = sig(row) !== sig(r);
      if (moved || !row.exact || row.pending) changed = true;
      if (moved && row.origin === 'git') row.turn = st.turns;
      Object.assign(row, { additions: r.additions, deletions: r.deletions, status: r.status, exact: true, pending: false });
    }
    for (const [k, v] of st.files) {
      if (v.origin === 'git' && !seen.has(k)) {
        st.files.delete(k);
        changed = true;
      }
    }
  }
  for (const [k, v] of st.files) {
    if (v.pending) {
      st.files.delete(k);
      changed = true;
    }
  }
  return changed;
}
