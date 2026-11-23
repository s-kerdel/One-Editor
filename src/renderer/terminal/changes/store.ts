// "AI changes" state (renderer): one change list per agent terminal (Claude Code or Opencode, started from One).
// Main sends a terminal's whole list each time it moves (term:changes, throttled, capped), so a list is replaced,
// never merged. What the user did in the panel is kept next to it: which turns are folded, which rows are
// reviewed, what "Clear" took away — all UI-only, nothing here reaches main or the disk.
// The reducers are pure (`reduce*`); the signals below just hold their result.
import { computed, signal } from '@preact/signals';
import { AGENT_KINDS, CHANGES_MAX_FILES, type AgentChangeFile, type AgentKind } from '@shared/terminal';

export interface AgentChanges {
  /** Terminal id the list came from. */
  id: number;
  agent: AgentKind;
  busy: boolean;
  turns: number;
  files: AgentChangeFile[];
  /** The terminal ended: the list stays (it is the review), nothing updates it any more. */
  ended: boolean;
  /** Turns folded / unfolded by hand since the newest turn started (turn → open). A new turn empties it. */
  open: Record<number, boolean>;
  /** Rows marked "reviewed": path → the row as it was then (the mark holds until the row changes). */
  reviewed: Record<string, string>;
  /** Rows "Clear" took away: path → the row as it was then (it comes back when the agent changes it again). */
  cleared: Record<string, string>;
  /** When its newest turn started (a counter): the panel shows the list the user prompted last. */
  at: number;
}

/** One turn of a list, as the panel draws it. */
export interface TurnGroup {
  /** 1-based; 0 = changes from before the first prompt. */
  turn: number;
  files: AgentChangeFile[];
  additions: number;
  deletions: number;
  open: boolean;
  /** The turn the agent is working on right now. */
  live: boolean;
}

/** Lists kept at once (more agent terminals than this: ended ones go first, then the one prompted longest ago). */
export const MAX_LISTS = 8;

const STATUS = new Set(['added', 'deleted', 'modified']);
const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1e9;
/** What makes a row "the same row as before": its numbers, its kind and the turn that changed it (not `exact`). */
export const rowSig = (f: AgentChangeFile) => `${f.additions},${f.deletions},${f.status},${f.turn}`;

let seq = 0;

/**
 * One `term:changes` payload applied to the lists (the bridge hands over whatever main sent: checked field by
 * field; anything malformed leaves the lists as they are).
 */
export function reduceChanges(lists: readonly AgentChanges[], e: unknown): readonly AgentChanges[] {
  const v = e as { id?: unknown; agent?: unknown; busy?: unknown; turns?: unknown; files?: unknown } | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'number' || !Number.isInteger(v.id) || !AGENT_KINDS.includes(v.agent as AgentKind) || !Array.isArray(v.files)) return lists;
  const old = lists.find((l) => l.id === v.id);
  const turns = count(v.turns) ? v.turns : 0;
  const busy = v.busy === true;
  const cleared = old?.cleared ?? {};
  const files: AgentChangeFile[] = [];
  for (const f of (v.files as Array<Partial<AgentChangeFile> | null>).slice(0, CHANGES_MAX_FILES)) {
    if (!f || typeof f.path !== 'string' || !f.path || !STATUS.has(f.status as string) || !count(f.additions) || !count(f.deletions)) continue;
    const row: AgentChangeFile = { path: f.path, status: f.status!, additions: f.additions, deletions: f.deletions, turn: count(f.turn) ? Math.min(f.turn, turns) : 0, exact: f.exact === true };
    if (cleared[row.path] !== rowSig(row)) files.push(row);
  }
  const next: AgentChanges = {
    id: v.id,
    agent: v.agent as AgentKind,
    busy,
    turns,
    files,
    ended: false,
    // A new turn: the folds of the last one are forgotten (older turns close, the new one is open).
    open: !old || turns > old.turns ? {} : old.open,
    reviewed: old?.reviewed ?? {},
    cleared,
    at: !old || turns > old.turns || (busy && !old.busy) ? ++seq : old.at,
  };
  if (old) return lists.map((l) => (l === old ? next : l));
  const all = [...lists, next];
  while (all.length > MAX_LISTS) {
    const victim = all.find((l) => l.ended && l !== next) ?? [...all].filter((l) => l !== next).sort((a, b) => a.at - b.at)[0];
    all.splice(all.indexOf(victim), 1);
  }
  return all;
}

const patch = (lists: readonly AgentChanges[], id: number, f: (l: AgentChanges) => AgentChanges | null): readonly AgentChanges[] => {
  const old = lists.find((l) => l.id === id);
  if (!old) return lists;
  const next = f(old);
  if (next === old) return lists;
  return next ? lists.map((l) => (l === old ? next : l)) : lists.filter((l) => l !== old);
};

/** The terminal exited: its list is kept (read-only) but nothing is busy any more. */
export const reduceEnded = (lists: readonly AgentChanges[], id: number) => patch(lists, id, (l) => ({ ...l, busy: false, ended: true }));

/**
 * "Clear": the rows shown now go. A list whose terminal still runs stays (empty) and remembers what it dropped, so
 * the next update does not bring the same rows back; an ended one goes altogether.
 */
export const reduceClear = (lists: readonly AgentChanges[], id: number) =>
  patch(lists, id, (l) => (l.ended ? null : { ...l, files: [], reviewed: {}, cleared: { ...l.cleared, ...Object.fromEntries(l.files.map((f) => [f.path, rowSig(f)])) } }));

/** The turns of a list, newest first; only the newest is open unless the user folded / unfolded one by hand. */
export function groupByTurn(c: AgentChanges): TurnGroup[] {
  const by = new Map<number, AgentChangeFile[]>();
  for (const f of c.files) by.set(f.turn, [...(by.get(f.turn) ?? []), f]);
  // The running turn shows from its first moment, also before its first change.
  if (c.busy && c.turns > 0 && !by.has(c.turns)) by.set(c.turns, []);
  const turns = [...by.keys()].sort((a, b) => b - a);
  return turns.map((turn) => {
    const files = by.get(turn)!;
    const sum = totals(files);
    return { turn, files, ...sum, open: c.open[turn] ?? turn === turns[0], live: c.busy && turn === c.turns };
  });
}

/** Fold / unfold one turn (`open` omitted: flip what the panel shows now). */
export const reduceFold = (lists: readonly AgentChanges[], id: number, turn: number, open?: boolean) =>
  patch(lists, id, (l) => {
    const shown = groupByTurn(l).find((g) => g.turn === turn);
    return shown ? { ...l, open: { ...l.open, [turn]: open ?? !shown.open } } : l;
  });

/** Every turn open (`only` omitted) or only that one. */
export const reduceFoldAll = (lists: readonly AgentChanges[], id: number, only?: number) =>
  patch(lists, id, (l) => ({ ...l, open: Object.fromEntries(groupByTurn(l).map((g) => [g.turn, only === undefined || g.turn === only])) }));

export const isReviewed = (c: AgentChanges, f: AgentChangeFile) => c.reviewed[f.path] === rowSig(f);

/** Mark rows reviewed / not reviewed (`on` omitted: flip the first one, the rest follow it). */
export const reduceReviewed = (lists: readonly AgentChanges[], id: number, paths: readonly string[], on?: boolean) =>
  patch(lists, id, (l) => {
    const rows = l.files.filter((f) => paths.includes(f.path));
    if (!rows.length) return l;
    const want = on ?? !isReviewed(l, rows[0]);
    const reviewed = { ...l.reviewed };
    for (const f of rows) {
      if (want) reviewed[f.path] = rowSig(f);
      else delete reviewed[f.path];
    }
    return { ...l, reviewed };
  });

export function totals(files: readonly AgentChangeFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------- signals

/** Every agent terminal's list, in the order they first reported. */
export const lists = signal<readonly AgentChanges[]>([]);
/** The terminal the user chose to look at (null: the one prompted last). */
export const picked = signal<number | null>(null);
/** The list the panel shows. */
export const changes = computed<AgentChanges | null>(() => {
  const all = lists.value;
  return all.find((l) => l.id === picked.value) ?? [...all].sort((a, b) => b.at - a.at)[0] ?? null;
});

export const applyChanges = (e: unknown): void => void (lists.value = reduceChanges(lists.value, e));
export const markEnded = (id: number): void => void (lists.value = reduceEnded(lists.value, id));
/** Clears one terminal's list (default: the one shown); `'all'` forgets every list. */
export function clearChanges(id: number | 'all' | undefined = changes.value?.id): void {
  if (id === 'all') lists.value = [];
  else if (id !== undefined) lists.value = reduceClear(lists.value, id);
  if (picked.value !== null && !lists.value.some((l) => l.id === picked.value)) picked.value = null;
}
export const pickList = (id: number | null): void => void (picked.value = id);
export const foldTurn = (id: number, turn: number, open?: boolean): void => void (lists.value = reduceFold(lists.value, id, turn, open));
export const foldAll = (id: number, only?: number): void => void (lists.value = reduceFoldAll(lists.value, id, only));
export const setReviewed = (id: number, paths: readonly string[], on?: boolean): void => void (lists.value = reduceReviewed(lists.value, id, paths, on));
