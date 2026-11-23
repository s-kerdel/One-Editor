// "AI changes" — what the agent trackers share (Claude Code: terminal-follow.ts + terminal-claude-changes.ts,
// Opencode: terminal-opencode*.ts): the path rules, the patch → line-range merge, the capped row map with its
// snapshot, and the throttled `term:changes` sender. Pure except for the sender's one timer.
// Trust: every input here is untrusted (hook payloads, a server's events, git output). A row can only ever name
// a file inside the open folder: lexical rule here, the workspace's real-path rule (`Workspace.real`) in the
// callers before anything is shown.
import { CHANGES_EMIT_MS, CHANGES_MAX_FILES, type AgentChangeFile, type AgentKind, type TerminalChangesEvent } from '../shared/terminal';

export const MAX_PATH = 4096;
/** Caps for any patch an agent reports (structured hunks or unified text). */
export const PATCH_LIMITS = { hunks: 200, lines: 50_000, ranges: 20, lineNo: 10_000_000 } as const;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** A path string worth looking at: non-empty, bounded, no control characters. */
export const isPathText = (p: unknown): p is string => typeof p === 'string' && !!p && p.length <= MAX_PATH && !CONTROL.test(p);

export interface PathCtx {
  /** Absolute path (as the agent reports it) → workspace-relative POSIX path, or null (outside the folder / odd). */
  map: (abs: string) => string | null;
  /** The open folder is on Windows: `\` separates segments. */
  win: boolean;
}

/** A workspace-relative path ('src/a.ts'): lexical rules only, no '..', no empty segments. */
export function cleanRel(p: unknown, win = false): string | null {
  if (!isPathText(p)) return null;
  const s = win ? p.replace(/\\/g, '/') : p;
  if (s.startsWith('/') || /^[a-z]:/i.test(s)) return null;
  const segs = s.split('/');
  if (segs.some((x) => !x || x === '.' || x === '..' || (win && x.includes(':')))) return null;
  return segs.join('/');
}

export const isAbsPath = (p: string, win: boolean) => p.startsWith('/') || (win && /^([a-z]:[\\/]|[\\/]{2})/i.test(p));

/**
 * One path from an event or a diff row → workspace-relative, or null. `base` = the absolute folder relative paths
 * are relative to when that is NOT the open folder (an agent whose project root is above it): the path is then
 * joined and mapped like an absolute one, so rows of the project outside the open folder are dropped, not mis-placed.
 */
export function toRel(ctx: PathCtx, p: unknown, base?: string | null): string | null {
  if (!isPathText(p)) return null;
  if (isAbsPath(p, ctx.win)) return ctx.map(p);
  if (!base) return cleanRel(p, ctx.win);
  return ctx.map(base.replace(/[\\/]+$/, '') + (ctx.win ? '\\' : '/') + p);
}

/** Line numbers → merged, sorted [from, to] ranges (adjacent lines join), at most `max` of them. */
export function mergeRanges(marks: number[], max: number = PATCH_LIMITS.ranges): Array<[number, number]> {
  const lines: Array<[number, number]> = [];
  for (const m of [...marks].sort((a, b) => a - b)) {
    const last = lines[lines.length - 1];
    if (last && m <= last[1] + 1) last[1] = Math.max(last[1], m);
    else if (lines.length < max) lines.push([m, m]);
    else break;
  }
  return lines;
}

/** Lines of a text as a diff would count them (a trailing newline ends the last line, it does not start one). */
export function countLines(text: unknown, max = 1e7): number {
  if (typeof text !== 'string' || !text) return 0;
  let n = text.endsWith('\n') ? 0 : 1;
  for (let i = text.indexOf('\n'); i >= 0 && n < max; i = text.indexOf('\n', i + 1)) n++;
  return n;
}

// ---------------------------------------------------------------- rows

export type ChangeRow<X = unknown> = AgentChangeFile & X;

/** A new estimate row for `path`, changed in `turn` (false: it is there already, or the list is full). */
export function touchRow<X>(files: Map<string, ChangeRow<X>>, path: string, turn: number, extra: X): boolean {
  if (files.has(path) || files.size >= CHANGES_MAX_FILES) return false;
  files.set(path, { path, status: 'modified', additions: 0, deletions: 0, turn, exact: false, ...extra });
  return true;
}

/** The list the panel shows: stable order (most changed first would jump while it moves — alphabetical does not), capped. */
export function snapshotRows(files: ReadonlyMap<string, AgentChangeFile>): AgentChangeFile[] {
  return [...files.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, CHANGES_MAX_FILES)
    .map(({ path, status, additions, deletions, turn, exact }) => ({ path, status, additions, deletions, turn, exact }));
}

// ---------------------------------------------------------------- sender

/**
 * `term:changes` for one terminal: the whole list, at most every `ms` (trailing, so the newest state always goes
 * out), and only when it differs from what was sent last.
 */
export class ChangesSender {
  private timer: NodeJS.Timeout | null = null;
  private last = '';
  private off = false;

  constructor(
    private readonly id: number,
    private readonly agent: AgentKind,
    private readonly state: () => { busy: boolean; turns: number; files: ReadonlyMap<string, AgentChangeFile> },
    private readonly send: (e: TerminalChangesEvent) => void,
    private readonly ms: number = CHANGES_EMIT_MS,
  ) {}

  schedule(): void {
    if (this.off || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.off) return;
      const s = this.state();
      const files = snapshotRows(s.files);
      const key = JSON.stringify([s.busy, s.turns, files]);
      if (key === this.last) return;
      this.last = key;
      this.send({ id: this.id, agent: this.agent, busy: s.busy, turns: s.turns, files });
    }, this.ms);
    this.timer.unref?.();
  }

  /** The terminal ended: nothing more is sent. */
  close(): void {
    this.off = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
