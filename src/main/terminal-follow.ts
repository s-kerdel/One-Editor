// "Follow Claude's edits" (preview), main side. A Claude Code terminal started by One gets a private
// inbox folder + a settings file (passed with `claude --settings`, so the user's and the project's
// Claude settings are never touched). Claude Code hooks drop one small JSON file per edit there; this
// module reads them and tells the owning window which workspace file changed (`term:follow`) and what the
// session changed so far (`term:changes`, the list Opencode terminals report too: terminal-claude-changes.ts).
// Nothing here writes to the workspace, listens on a socket or runs a program (git's numstat for the exact
// numbers is asked of the backend, behind its trust gate).
// Trust: any process of the same user can drop a file in the inbox. So an event can only ever mean
// "show a file inside the open folder" — the path must map into the workspace, everything else is ignored.
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { FOLLOW_PROBE_CHARS, type TerminalChangesEvent, type TerminalFollowEvent } from '../shared/terminal';
import { ChangesSender, countLines, isObj, mergeRanges, PATCH_LIMITS } from './terminal-changes';
import { emptyClaudeChanges, onClaudeStep, reconcile, setBaseline, type ClaudeChanges, type ClaudeStep } from './terminal-claude-changes';
import { pathFor, wslPathFor } from './terminal-shells';

/** Env var the hook reads its session folder from (WSL: translated by WSLENV's /p flag). */
export const FOLLOW_ENV = 'ONE_FOLLOW_DIR';
export const FOLLOW_SETTINGS_FILE = 'settings.json';
const INBOX = 'in';

/**
 * The hook: a FIXED string — no workspace or user data is ever put into it; the only input is the
 * env var. POSIX sh + mktemp / cat / mv (Git Bash, WSL, macOS, Linux). Atomic: the payload is written
 * under a name without `.json` and renamed, so a half-written file is never read. Always exits 0 and
 * prints nothing: it can never block Claude or add to its context.
 */
// Early exits still drain stdin: Claude Code must never write into a closed pipe (EPIPE on big payloads).
export const FOLLOW_HOOK = `[ -d "$${FOLLOW_ENV}/${INBOX}" ] || { cat >/dev/null; exit 0; }; f=$(mktemp "$${FOLLOW_ENV}/${INBOX}/ev.XXXXXXXX") || { cat >/dev/null; exit 0; }; cat >"$f" && mv -f "$f" "$f.json"; exit 0`;

/**
 * The `UserPromptSubmit` hook ("a new turn starts": the change marks of the last one go). Also FIXED, and it
 * drops a constant instead of its input: that payload holds the user's prompt, which One has no use for
 * and so never writes to disk (stdin is only drained). Prints nothing — this event's stdout would be
 * added to Claude's context.
 */
export const FOLLOW_PROMPT_HOOK = `cat >/dev/null; [ -d "$${FOLLOW_ENV}/${INBOX}" ] || exit 0; f=$(mktemp "$${FOLLOW_ENV}/${INBOX}/ev.XXXXXXXX") || exit 0; printf '{"hook_event_name":"UserPromptSubmit"}' >"$f" && mv -f "$f" "$f.json"; exit 0`;

const FOLLOW_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;

/**
 * Contents of the per-session settings file. `PreToolUse` (same tools, same fixed hook: it prints nothing and
 * exits 0, so it never decides anything about the call) is the early "this file is about to change" signal.
 */
export function followSettings() {
  const hooks = [{ type: 'command', command: FOLLOW_HOOK, timeout: 5 }];
  const prompt = [{ type: 'command', command: FOLLOW_PROMPT_HOOK, timeout: 5 }];
  const matcher = FOLLOW_TOOLS.join('|');
  return { hooks: { PreToolUse: [{ matcher, hooks }], PostToolUse: [{ matcher, hooks }], Stop: [{ hooks }], UserPromptSubmit: [{ hooks: prompt }] } };
}

// ---------------------------------------------------------------- pure: payload + path rules

export const FOLLOW_MAX_BYTES = 1024 * 1024;
/** Edited text sent along, only to find the lines in the editor. */
export const FOLLOW_HINT_CHARS = 4096;

export interface FollowRaw {
  /** 'pre' = PreToolUse: the file is about to change (the change list only; never sent as a follow event). */
  kind: TerminalFollowEvent['kind'] | 'pre';
  /** Absolute path as Claude reported it (untrusted). */
  filePath?: string;
  hint?: string;
  lines?: Array<[number, number]>;
  probe?: { line: number; text: string };
  /** Lines this one call added / removed: from its patch, else from its input (the list's live estimate). */
  counts?: { additions: number; deletions: number };
  /** `Write` made a new file. */
  created?: true;
}

export const FOLLOW_MAX_RANGES = PATCH_LIMITS.ranges;

/**
 * One walk over the `structuredPatch` in an Edit / Write / MultiEdit `tool_response`
 * (`[{ newStart, lines: [' ctx', '-old', '+new'] }]`; not in the hooks docs, so: used when well-formed,
 * else null and the caller falls back). The counter starts at `newStart`: context moves it, an added line
 * is marked and moves it, a removed line marks where it was without moving. Context lines are not marked.
 */
function walkPatch(response: unknown): { marks: number[]; probe?: FollowRaw['probe']; additions: number; deletions: number } | null {
  const patch = isObj(response) ? response.structuredPatch : null;
  if (!Array.isArray(patch) || !patch.length || patch.length > PATCH_LIMITS.hunks) return null;
  const marks: number[] = [];
  let probe: FollowRaw['probe'];
  let walked = 0;
  let additions = 0;
  let deletions = 0;
  for (const h of patch as unknown[]) {
    if (!isObj(h) || !Array.isArray(h.lines)) return null;
    const start = h.newStart;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start > PATCH_LIMITS.lineNo) return null;
    let n = Math.max(1, start); // an emptied file reports newStart 0
    for (const l of h.lines as unknown[]) {
      if (typeof l !== 'string' || ++walked > PATCH_LIMITS.lines) return null;
      const c = l[0];
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === '+') {
        const text = l.slice(1).replace(/\r$/, '');
        if (!probe && text.trim()) probe = { line: n, text: text.slice(0, FOLLOW_PROBE_CHARS) };
        marks.push(n++);
        additions++;
      } else if (c === '-') {
        marks.push(n);
        deletions++;
      } else if (c === ' ' || l === '') n++; // some diff writers leave an empty context line bare
      else return null;
    }
  }
  return marks.length ? { marks, probe, additions, deletions } : null;
}

/** Changed lines of the new file (merged ranges, capped) + one added line's text to recognise the reloaded document by. */
export function patchLines(response: unknown): Pick<FollowRaw, 'lines' | 'probe'> | null {
  const w = walkPatch(response);
  if (!w) return null;
  const lines = mergeRanges(w.marks, FOLLOW_MAX_RANGES);
  return { lines, ...(w.probe && w.probe.line <= lines[lines.length - 1][1] ? { probe: w.probe } : {}) };
}

/** Added / removed lines of the same patch (the change list's + / − for this one call). */
export function patchCounts(response: unknown): { additions: number; deletions: number } | null {
  const w = walkPatch(response);
  return w ? { additions: w.additions, deletions: w.deletions } : null;
}

/** Without a patch in the response: what the call's own input says (the replaced text against the new one). */
function inputCounts(tool: string, input: Record<string, unknown>): { additions: number; deletions: number } | null {
  const one = (e: Record<string, unknown>) => ({ additions: countLines(e.new_string), deletions: countLines(e.old_string) });
  if (tool === 'Edit') return one(input);
  if (tool !== 'MultiEdit' || !Array.isArray(input.edits)) return null;
  const sum = { additions: 0, deletions: 0 };
  for (const e of (input.edits as unknown[]).slice(0, PATCH_LIMITS.hunks)) {
    if (!isObj(e)) continue;
    const c = one(e);
    sum.additions += c.additions;
    sum.deletions += c.deletions;
  }
  return sum;
}

/** Strict read of one hook payload: allow-listed event + tool, a sane path; unknown fields are ignored. */
export function parseFollowEvent(text: string): FollowRaw | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.hook_event_name === 'Stop') return { kind: 'stop' };
  if (v.hook_event_name === 'UserPromptSubmit') return { kind: 'prompt' }; // the prompt itself is never read
  const pre = v.hook_event_name === 'PreToolUse';
  if (!pre && v.hook_event_name !== 'PostToolUse') return null;
  const tool = v.tool_name;
  if (typeof tool !== 'string' || !(FOLLOW_TOOLS as readonly string[]).includes(tool) || !isObj(v.tool_input)) return null;
  if (!pre && typeof v.tool_response === 'string') return null; // a failed call: nothing changed
  const input = v.tool_input;
  const filePath = tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(filePath)) return null;
  if (pre) return { kind: 'pre', filePath }; // nothing of the text to come is carried on
  let hint: unknown;
  if (tool === 'Edit') hint = input.new_string;
  else if (tool === 'MultiEdit' && Array.isArray(input.edits)) hint = (input.edits as unknown[]).filter(isObj).pop()?.new_string;
  const out: FollowRaw = { kind: tool === 'Write' ? 'write' : 'edit', filePath };
  if (typeof hint === 'string' && hint.trim()) out.hint = hint.slice(0, FOLLOW_HINT_CHARS);
  // A new file has no "changed lines": the whole file is new.
  const created = tool === 'Write' && isObj(v.tool_response) && v.tool_response.type === 'create';
  if (created) {
    out.created = true;
    out.counts = { additions: countLines(input.content), deletions: 0 };
  } else if (tool !== 'NotebookEdit') {
    Object.assign(out, patchLines(v.tool_response));
    const counts = patchCounts(v.tool_response) ?? inputCounts(tool, input);
    if (counts) out.counts = counts;
  }
  return out;
}

export interface FollowCtx {
  /** The open folder (native absolute path). */
  root: string;
  /** The same folder without links, when that is another path (`/tmp/x` → `/private/tmp/x`, a folder opened through
   *  a symlink): an agent names files by its working folder, which the OS reports link-free. */
  realRoot?: string | null;
  platform: string;
  /** The folder's own case rule (`Workspace.foldsCase`), never the OS's. */
  foldCase: boolean;
  /** Claude runs inside this WSL distro: its paths are Linux paths (`/home/…`, `/mnt/c/…`). */
  wslDistro?: string;
}

/**
 * An agent's absolute path → workspace-relative POSIX path, or null when it is not inside the open
 * folder (as One names it, or as it really is: `realRoot`). Lexical only (`..` resolved first); the caller
 * still runs the workspace's real-path rule.
 */
export function mapFollowPath(filePath: string, o: FollowCtx): string | null {
  const rel = mapInto(filePath, o, o.root);
  if (rel !== null || !o.realRoot || o.realRoot === o.root || o.wslDistro) return rel;
  return mapInto(filePath, o, o.realRoot);
}

function mapInto(filePath: string, o: FollowCtx, folder: string): string | null {
  const win = !o.wslDistro && o.platform === 'win32';
  const P = o.wslDistro ? path.posix : pathFor(o.platform);
  const base = o.wslDistro ? wslPathFor(folder, o.wslDistro) : folder;
  if (!base || !P.isAbsolute(base)) return null;
  // win32 calls "\x" and "C:x" rooted / drive-relative: only full drive or UNC paths count.
  if (win ? !/^([a-z]:[\\/]|[\\/]{2}[^\\/])/i.test(filePath) : !filePath.startsWith('/')) return null;
  const abs = P.resolve(filePath);
  const root = P.resolve(base);
  const prefix = root.endsWith(P.sep) ? root : root + P.sep;
  const head = abs.slice(0, prefix.length);
  if (o.foldCase ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) return null;
  const segs = abs.slice(prefix.length).split(P.sep);
  // ':' on Windows would name an alternate data stream or a drive.
  if (segs.some((s) => !s || s === '.' || s === '..' || (win && s.includes(':')))) return null;
  return segs.join('/');
}

// ---------------------------------------------------------------- inbox

const SESSION_NAME = /^[0-9a-f]{32}$/;
const EVENT_NAME = /^ev\.[A-Za-z0-9_]{1,32}\.json$/;
/** Files handled per scan / per second: past either the session waits `floodWaitMs` (an edit is two files: before + after). */
const MAX_PER_SCAN = 40;
const MAX_PER_SECOND = 80;
/** More entries than this is not Claude editing: drop them all unread. */
const MAX_BACKLOG = 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * When the inbox is read. Change events (`fs.watch`) are the normal path: a scan `debounceMs` after one (the hook
 * writes under a temporary name and renames, so one event file makes two or three change events; a scan that came
 * too early is simply followed by another). The poll is only the safety net for a file system without change
 * events: every `fastPollMs` while a session is "hot" — a turn is running (at most `hotTurnMs` without any event:
 * an interrupted turn sends no Stop) or an event came in the last `hotTailMs` — and every `idlePollMs` otherwise,
 * so an idle Claude costs one directory read every two seconds.
 */
export const FOLLOW_TIMING = { debounceMs: 10, fastPollMs: 250, idlePollMs: 2000, hotTailMs: 5000, hotTurnMs: 10 * 60_000, floodWaitMs: 1000 };

/**
 * One inbox file's text, or null unless it is a small regular file: lstat, then open without
 * following links and without blocking (a FIFO or device left under that name must not hang main).
 */
export async function readInboxFile(file: string): Promise<{ text: string; mtime: number } | null> {
  const st = await fs.promises.lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > FOLLOW_MAX_BYTES) return null;
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fh = await fs.promises.open(file, flags).catch(() => null);
  if (!fh) return null;
  try {
    const now = await fh.stat(); // the file we actually opened
    if (!now.isFile() || now.size > FOLLOW_MAX_BYTES) return null;
    const buf = Buffer.alloc(now.size);
    const { bytesRead } = await fh.read(buf, 0, now.size, 0);
    return { text: buf.subarray(0, bytesRead).toString('utf8'), mtime: now.mtimeMs };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

interface Session {
  id: number;
  dir: string;
  ctx: FollowCtx;
  watcher: fs.FSWatcher | null;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  /** A file arrived while a scan ran. */
  again: boolean;
  /** The change list of this terminal. */
  ch: ClaudeChanges;
  sender: ChangesSender;
  /** Polled every `fastPollMs` until then. */
  hotUntil: number;
  polledAt: number;
  /** Flood window: its start and the files read in it. */
  winAt: number;
  winN: number;
  /** A numstat for this session is running / one more is wanted after it. */
  settling: boolean;
  settleAgain: boolean;
  /** The current turn's start snapshot while git is asked for it (a Stop waits for it). */
  baselining: Promise<void> | null;
}

export interface ClaudeFollowOptions {
  /** `<app data>/claude-follow`. */
  dir: string;
  /** The real-path rule (`Workspace.real`) of the folder terminal `terminalId` works in: false = outside, ignore.
   *  One instance serves every window (the stale-folder sweep must see every live session), so it names the terminal. */
  inside: (rel: string, terminalId: number) => Promise<boolean>;
  emit: (terminalId: number, e: TerminalFollowEvent) => void;
  /** The terminal's change list moved (`term:changes`). */
  emitChanges?: (terminalId: number, e: TerminalChangesEvent) => void;
  /**
   * git's numstat for the open folder (`BackendService.git('numstat')`: behind the trust gate, with the git
   * service's own safety switches — this module never starts git). null / a failure = no exact numbers.
   * Of the folder terminal `terminalId` works in.
   */
  numstat?: (terminalId: number) => Promise<unknown>;
  /** Test hooks: false = no change events (the poll alone), other timings. */
  watch?: boolean;
  timing?: Partial<typeof FOLLOW_TIMING>;
}

export class ClaudeFollow {
  private readonly sessions = new Map<number, Session>();
  private readonly T: typeof FOLLOW_TIMING;
  private poll: NodeJS.Timeout | null = null;
  private pollFast = false;
  private swept = false;
  private scans = 0;

  constructor(private readonly o: ClaudeFollowOptions) {
    this.T = { ...FOLLOW_TIMING, ...o.timing };
  }

  /** Inbox reads so far (tests: what an idle / a working session costs). */
  stats() {
    return { scans: this.scans, sessions: this.sessions.size, fast: this.pollFast && !!this.poll };
  }

  /** New session folder for terminal `id`; null when it cannot be made (Claude then starts without). */
  async open(id: number, ctx: FollowCtx): Promise<{ dir: string; settings: string } | null> {
    try {
      await fs.promises.mkdir(this.o.dir, { recursive: true, mode: 0o700 });
      if (!this.swept) {
        this.swept = true;
        void this.sweep();
      }
      const dir = path.join(this.o.dir, randomBytes(16).toString('hex'));
      await fs.promises.mkdir(dir, { mode: 0o700 }); // not recursive: an existing name is an error
      await fs.promises.mkdir(path.join(dir, INBOX), { mode: 0o700 });
      const settings = path.join(dir, FOLLOW_SETTINGS_FILE);
      await fs.promises.writeFile(settings, JSON.stringify(followSettings()), { mode: 0o600, flag: 'wx' });
      const ch = emptyClaudeChanges();
      const sender = new ChangesSender(id, 'claude', () => ch, (e) => this.o.emitChanges?.(id, e));
      const s: Session = { id, dir, ctx, watcher: null, timer: null, busy: false, again: false, ch, sender, hotUntil: 0, polledAt: Date.now(), winAt: 0, winN: 0, settling: false, settleAgain: false, baselining: null };
      this.sessions.set(id, s);
      if (this.o.watch !== false) {
        try {
          s.watcher = fs.watch(path.join(dir, INBOX), { persistent: false }, () => this.schedule(s, this.T.debounceMs));
          s.watcher.on('error', () => this.unwatch(s)); // the poll below still covers it
        } catch {}
      }
      this.heat(s, this.T.hotTailMs);
      void this.baseline(s);
      return { dir, settings };
    } catch (err) {
      console.warn('[claude-follow] no inbox:', (err as NodeJS.ErrnoException)?.code ?? 'EIO');
      return null;
    }
  }

  /** The terminal ended: its folder goes. */
  close(id: number): void {
    const s = this.stop(id);
    if (s) void fs.promises.rm(s.dir, { recursive: true, force: true }).catch(() => {});
  }

  /** App quit: remove every session folder now. */
  dispose(): void {
    for (const id of [...this.sessions.keys()]) {
      const s = this.stop(id);
      try {
        if (s) fs.rmSync(s.dir, { recursive: true, force: true });
      } catch {}
    }
  }

  private stop(id: number): Session | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    this.sessions.delete(id);
    this.unwatch(s);
    s.sender.close();
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    if (!this.sessions.size && this.poll) {
      clearTimeout(this.poll);
      this.poll = null;
    }
    return s;
  }

  private unwatch(s: Session) {
    try {
      s.watcher?.close();
    } catch {}
    s.watcher = null;
  }

  /** Folders a crashed run left behind (ours by name, older than a day, a real folder — never a link). */
  private async sweep() {
    const live = new Set([...this.sessions.values()].map((s) => path.basename(s.dir)));
    for (const name of await fs.promises.readdir(this.o.dir).catch(() => [] as string[])) {
      if (!SESSION_NAME.test(name) || live.has(name)) continue;
      const dir = path.join(this.o.dir, name);
      const st = await fs.promises.lstat(dir).catch(() => null);
      if (st?.isDirectory() && Date.now() - st.mtimeMs > STALE_MS) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- when to read

  /** The session is polled fast for `ms` from now (replaces what was set: a Stop shortens a running turn's window). */
  private heat(s: Session, ms: number) {
    s.hotUntil = Date.now() + ms;
    this.arm();
  }

  /** The one safety-poll timer: fast while any session is hot, slow otherwise; gone with the last session. */
  private arm() {
    if (!this.sessions.size) return;
    const now = Date.now();
    let fast = false;
    for (const s of this.sessions.values()) if (s.hotUntil > now) fast = true;
    if (this.poll && fast === this.pollFast) return;
    if (this.poll) clearTimeout(this.poll);
    this.pollFast = fast;
    this.poll = setTimeout(() => {
      this.poll = null;
      const t = Date.now();
      for (const s of this.sessions.values()) {
        if (s.hotUntil <= t && t - s.polledAt < this.T.idlePollMs) continue; // an idle session keeps its slow pace
        s.polledAt = t;
        this.schedule(s, 0);
      }
      this.arm();
    }, fast ? this.T.fastPollMs : this.T.idlePollMs);
    this.poll.unref?.();
  }

  private schedule(s: Session, ms: number) {
    if (s.busy) s.again = true;
    if (s.timer || s.busy || !this.sessions.has(s.id)) return;
    s.timer = setTimeout(() => {
      s.timer = null;
      void this.scan(s);
    }, ms);
    s.timer.unref?.();
  }

  private async scan(s: Session) {
    s.busy = true;
    s.again = false;
    this.scans++;
    let more = false;
    try {
      const inbox = path.join(s.dir, INBOX);
      const names = await fs.promises.readdir(inbox).catch(() => [] as string[]);
      const drop = (n: string) => fs.promises.unlink(path.join(inbox, n)).catch(() => {});
      if (names.length > MAX_BACKLOG) {
        await Promise.all(names.map(drop));
        console.warn(`[claude-follow] flood: dropped ${names.length} file(s)`); // counts only, never contents
        return;
      }
      const ready = names.filter((n) => EVENT_NAME.test(n));
      if (!ready.length) return;
      const now = Date.now();
      if (now - s.winAt >= 1000) {
        s.winAt = now;
        s.winN = 0;
      }
      const take = ready.slice(0, Math.max(0, Math.min(MAX_PER_SCAN, MAX_PER_SECOND - s.winN)));
      s.winN += take.length;
      more = ready.length > take.length;
      const read: Array<{ raw: FollowRaw | null; mtime: number }> = [];
      for (const n of take) {
        const f = await readInboxFile(path.join(inbox, n));
        await drop(n);
        read.push({ raw: f ? parseFollowEvent(f.text) : null, mtime: f?.mtime ?? 0 });
      }
      for (const { raw } of read.sort((a, b) => a.mtime - b.mtime)) {
        if (!this.sessions.has(s.id)) return;
        if (!raw) continue;
        if (raw.kind === 'stop' || raw.kind === 'prompt') {
          this.step(s, { kind: raw.kind });
          this.o.emit(s.id, { id: s.id, agent: 'claude', kind: raw.kind });
          if (raw.kind === 'stop') void this.settle(s);
          else void this.baseline(s); // every prompt: what the user changed before it is not this turn's
          continue;
        }
        const rel = raw.filePath ? mapFollowPath(raw.filePath, s.ctx) : null;
        // Outside the open folder (Claude's own plan / memory files, anything else): never shown, never logged.
        if (!rel || !(await this.o.inside(rel, s.id).catch(() => false)) || !this.sessions.has(s.id)) continue;
        if (raw.kind === 'pre') {
          this.step(s, { kind: 'pre', path: rel });
          continue;
        }
        this.step(s, { kind: raw.kind, path: rel, counts: raw.counts, created: raw.created });
        this.o.emit(s.id, { id: s.id, agent: 'claude', kind: raw.kind, path: rel, ...(raw.hint ? { hint: raw.hint } : {}), ...(raw.lines ? { lines: raw.lines } : {}), ...(raw.probe ? { probe: raw.probe } : {}) });
      }
      if (take.length && this.sessions.has(s.id)) this.heat(s, s.ch.busy ? this.T.hotTurnMs : this.T.hotTailMs);
    } finally {
      s.busy = false;
      if (more) this.schedule(s, this.T.floodWaitMs);
      else if (s.again) this.schedule(s, this.T.debounceMs);
    }
  }

  // ---------------------------------------------------------------- the change list

  private step(s: Session, e: ClaudeStep) {
    if (onClaudeStep(s.ch, e)) s.sender.schedule();
  }

  /** git names the files of a Windows folder (not one inside WSL): its path rules apply. */
  private win(s: Session) {
    return s.ctx.platform === 'win32' && !s.ctx.wslDistro;
  }

  /** What was already uncommitted when the turn started (at the session's start, then at every prompt). */
  private baseline(s: Session): Promise<void> {
    const numstat = this.o.numstat;
    if (!numstat) return Promise.resolve();
    const turn = s.ch.turns;
    const p = numstat(s.id)
      .catch(() => null)
      .then((rows) => {
        // Only the newest turn's: an answer that arrives after the next prompt is about the turn before.
        if (this.sessions.has(s.id) && s.ch.turns === turn) setBaseline(s.ch, rows, this.win(s));
      });
    s.baselining = p;
    void p.finally(() => s.baselining === p && (s.baselining = null));
    return p;
  }

  /** The end of a turn: git's numbers replace the estimates (single flight; a Stop during a run asks for one more). */
  private async settle(s: Session) {
    if (s.settling) {
      s.settleAgain = true;
      return;
    }
    s.settling = true;
    try {
      do {
        s.settleAgain = false;
        await s.baselining; // a short turn: its start snapshot first, or the user's earlier saves would count as Claude's
        const rows = this.o.numstat ? await this.o.numstat(s.id).catch(() => null) : null;
        if (!this.sessions.has(s.id)) return;
        if (reconcile(s.ch, rows, this.win(s))) s.sender.schedule();
      } while (s.settleAgain);
    } finally {
      s.settling = false;
    }
  }
}
