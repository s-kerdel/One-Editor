// "Follow Claude's edits" (preview), main side. A Claude Code terminal started by One gets a private
// inbox folder + a settings file (passed with `claude --settings`, so the user's and the project's
// Claude settings are never touched). Claude Code hooks drop one small JSON file per edit there; this
// module reads them and tells the owning window which workspace file changed. Nothing here writes to
// the workspace, listens on a socket or runs a program.
// Trust: any process of the same user can drop a file in the inbox. So an event can only ever mean
// "show a file inside the open folder" — the path must map into the workspace, everything else is ignored.
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { FOLLOW_PROBE_CHARS, type TerminalFollowEvent } from '../shared/terminal';
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

/** Contents of the per-session settings file. */
export function followSettings() {
  const hooks = [{ type: 'command', command: FOLLOW_HOOK, timeout: 5 }];
  const prompt = [{ type: 'command', command: FOLLOW_PROMPT_HOOK, timeout: 5 }];
  return { hooks: { PostToolUse: [{ matcher: FOLLOW_TOOLS.join('|'), hooks }], Stop: [{ hooks }], UserPromptSubmit: [{ hooks: prompt }] } };
}

// ---------------------------------------------------------------- pure: payload + path rules

export const FOLLOW_MAX_BYTES = 1024 * 1024;
/** Edited text sent along, only to find the lines in the editor. */
export const FOLLOW_HINT_CHARS = 4096;

export interface FollowRaw {
  kind: TerminalFollowEvent['kind'];
  /** Absolute path as Claude reported it (untrusted). */
  filePath?: string;
  hint?: string;
  lines?: Array<[number, number]>;
  probe?: { line: number; text: string };
}

export const FOLLOW_MAX_RANGES = 20;
const MAX_HUNKS = 200;
const MAX_PATCH_LINES = 50_000;
const MAX_LINE_NO = 10_000_000;

/**
 * Changed lines of the new file from the `structuredPatch` in an Edit / Write / MultiEdit `tool_response`
 * (`[{ newStart, lines: [' ctx', '-old', '+new'] }]`; not in the hooks docs, so: used when well-formed,
 * else null and the caller falls back). The counter starts at `newStart`: context moves it, an added line
 * is marked and moves it, a removed line marks where it was without moving. Context lines are not marked.
 */
export function patchLines(response: unknown): Pick<FollowRaw, 'lines' | 'probe'> | null {
  const patch = isObj(response) ? response.structuredPatch : null;
  if (!Array.isArray(patch) || !patch.length || patch.length > MAX_HUNKS) return null;
  const marks: number[] = [];
  let probe: FollowRaw['probe'];
  let walked = 0;
  for (const h of patch as unknown[]) {
    if (!isObj(h) || !Array.isArray(h.lines)) return null;
    const start = h.newStart;
    if (typeof start !== 'number' || !Number.isInteger(start) || start < 0 || start > MAX_LINE_NO) return null;
    let n = Math.max(1, start); // an emptied file reports newStart 0
    for (const l of h.lines as unknown[]) {
      if (typeof l !== 'string' || ++walked > MAX_PATCH_LINES) return null;
      const c = l[0];
      if (c === '\\') continue; // "\ No newline at end of file"
      if (c === '+') {
        const text = l.slice(1).replace(/\r$/, '');
        if (!probe && text.trim()) probe = { line: n, text: text.slice(0, FOLLOW_PROBE_CHARS) };
        marks.push(n++);
      } else if (c === '-') marks.push(n);
      else if (c === ' ' || l === '') n++; // some diff writers leave an empty context line bare
      else return null;
    }
  }
  if (!marks.length) return null;
  marks.sort((a, b) => a - b);
  const lines: Array<[number, number]> = [];
  for (const m of marks) {
    const last = lines[lines.length - 1];
    if (last && m <= last[1] + 1) last[1] = Math.max(last[1], m);
    else if (lines.length < FOLLOW_MAX_RANGES) lines.push([m, m]);
    else break;
  }
  return { lines, ...(probe && probe.line <= lines[lines.length - 1][1] ? { probe } : {}) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
  if (v.hook_event_name !== 'PostToolUse') return null;
  const tool = v.tool_name;
  if (typeof tool !== 'string' || !(FOLLOW_TOOLS as readonly string[]).includes(tool) || !isObj(v.tool_input)) return null;
  if (typeof v.tool_response === 'string') return null; // a failed call: nothing changed
  const input = v.tool_input;
  const filePath = tool === 'NotebookEdit' ? input.notebook_path : input.file_path;
  if (typeof filePath !== 'string' || !filePath || filePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(filePath)) return null;
  let hint: unknown;
  if (tool === 'Edit') hint = input.new_string;
  else if (tool === 'MultiEdit' && Array.isArray(input.edits)) hint = (input.edits as unknown[]).filter(isObj).pop()?.new_string;
  const out: FollowRaw = { kind: tool === 'Write' ? 'write' : 'edit', filePath };
  if (typeof hint === 'string' && hint.trim()) out.hint = hint.slice(0, FOLLOW_HINT_CHARS);
  // A new file has no "changed lines": the whole file is new.
  const created = tool === 'Write' && isObj(v.tool_response) && v.tool_response.type === 'create';
  if (tool !== 'NotebookEdit' && !created) Object.assign(out, patchLines(v.tool_response));
  return out;
}

export interface FollowCtx {
  /** The open folder (native absolute path). */
  root: string;
  platform: string;
  /** The folder's own case rule (`Workspace.foldsCase`), never the OS's. */
  foldCase: boolean;
  /** Claude runs inside this WSL distro: its paths are Linux paths (`/home/…`, `/mnt/c/…`). */
  wslDistro?: string;
}

/**
 * Claude's absolute path → workspace-relative POSIX path, or null when it is not inside the open
 * folder. Lexical only (`..` resolved first); the caller still runs the workspace's real-path rule.
 */
export function mapFollowPath(filePath: string, o: FollowCtx): string | null {
  const win = !o.wslDistro && o.platform === 'win32';
  const P = o.wslDistro ? path.posix : pathFor(o.platform);
  const base = o.wslDistro ? wslPathFor(o.root, o.wslDistro) : o.root;
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
/** Files handled per scan; a scan that hits it waits FLOOD_WAIT_MS (≈ 40 events / second at most). */
const MAX_PER_SCAN = 40;
const FLOOD_WAIT_MS = 1000;
/** More entries than this is not Claude editing: drop them all unread. */
const MAX_BACKLOG = 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 2000;

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
}

export interface ClaudeFollowOptions {
  /** `<app data>/claude-follow`. */
  dir: string;
  /** The workspace's real-path rule for a relative path (`Workspace.real`): false = outside, ignore. */
  inside: (rel: string) => Promise<boolean>;
  emit: (terminalId: number, e: TerminalFollowEvent) => void;
}

export class ClaudeFollow {
  private readonly sessions = new Map<number, Session>();
  private poll: NodeJS.Timeout | null = null;
  private swept = false;

  constructor(private readonly o: ClaudeFollowOptions) {}

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
      const s: Session = { id, dir, ctx, watcher: null, timer: null, busy: false, again: false };
      this.sessions.set(id, s);
      try {
        s.watcher = fs.watch(path.join(dir, INBOX), { persistent: false }, () => this.schedule(s, 60));
        s.watcher.on('error', () => this.unwatch(s)); // the poll below still covers it
      } catch {}
      this.poll ??= setInterval(() => this.sessions.forEach((x) => this.schedule(x, 0)), POLL_MS);
      this.poll.unref?.();
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
    if (s.timer) clearTimeout(s.timer);
    if (!this.sessions.size && this.poll) {
      clearInterval(this.poll);
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
      more = ready.length > MAX_PER_SCAN;
      const read: Array<{ raw: FollowRaw | null; mtime: number }> = [];
      for (const n of ready.slice(0, MAX_PER_SCAN)) {
        const f = await readInboxFile(path.join(inbox, n));
        await drop(n);
        read.push({ raw: f ? parseFollowEvent(f.text) : null, mtime: f?.mtime ?? 0 });
      }
      for (const { raw } of read.sort((a, b) => a.mtime - b.mtime)) {
        if (!this.sessions.has(s.id)) return;
        if (raw?.kind === 'stop' || raw?.kind === 'prompt') {
          this.o.emit(s.id, { id: s.id, kind: raw.kind });
          continue;
        }
        const rel = raw?.filePath ? mapFollowPath(raw.filePath, s.ctx) : null;
        // Outside the open folder (Claude's own plan / memory files, anything else): never shown, never logged.
        if (!raw || !rel || !(await this.o.inside(rel).catch(() => false))) continue;
        this.o.emit(s.id, { id: s.id, kind: raw.kind, path: rel, ...(raw.hint ? { hint: raw.hint } : {}), ...(raw.lines ? { lines: raw.lines } : {}), ...(raw.probe ? { probe: raw.probe } : {}) });
      }
    } finally {
      s.busy = false;
      if (more) this.schedule(s, FLOOD_WAIT_MS);
      else if (s.again) this.schedule(s, 60);
    }
  }
}
