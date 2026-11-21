// Integrated terminal contract (desktop only). Terminals do NOT go through the generic RPC table
// (RPC_METHODS): they need the sender's identity (per-window ownership), push output events and
// fire-and-forget keystrokes, so they use their own `term:*` IPC channels (src/main/terminal.ts).
// The browser build never gets a shell: the HTTP server refuses these names with ENOTSUP.

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'gitbash' | 'wsl' | 'bash' | 'zsh' | 'fish' | 'sh' | 'other' | 'claude';

export interface ShellInfo {
  /** Stable id the renderer sends back ('pwsh', 'cmd', 'wsl:Ubuntu', 'bash', …). Never a path. */
  id: string;
  /** Display name ('PowerShell 7', 'Ubuntu 24.04', 'Zsh'). Unique within a list. */
  name: string;
  /** One line under the name: version / path, 'WSL · Ubuntu-24.04', … */
  detail?: string;
  kind: ShellKind;
  /** Absolute executable path (display only: spawning goes by id). */
  path: string;
  args: string[];
}

/** Claude Code CLI (`claude`) — started like a shell, in the workspace folder. Detected, never installed. */
export interface ClaudeInfo {
  available: boolean;
  /** 'wsl': runs inside `distro` (the default shell is that WSL distro). */
  via?: 'native' | 'wsl';
  distro?: string;
  /** Executable (native) or the Linux path inside the distro (display only). */
  path?: string;
  /** One-line install hint when not found. */
  hint?: string;
  /** The install command alone (copyable). */
  install?: string;
}

export interface ShellList {
  shells: ShellInfo[];
  /** Only when asked for (the lookup can start a WSL distro): see listShells(…, withClaude). */
  claude?: ClaudeInfo;
  /** Automatic default for this machine + workspace (the renderer's `terminal.defaultShell` wins if valid). */
  defaultId: string | null;
  /** Backend process.platform. */
  platform: string;
  /** Windows build number (xterm.js needs it for ConPTY reflow heuristics). */
  windowsBuild?: number;
}

export interface TerminalSpawnRequest {
  /** Shell id from listShells(); omitted → the automatic default. With preset 'claude': the shell
   *  whose environment Claude runs in (a WSL distro → Claude inside that distro). */
  shellId?: string;
  /** Start Claude Code instead of a shell. */
  preset?: 'claude';
  /** No shellId: use this one (the default-shell setting) when the machine has it, else the automatic default. */
  prefer?: string;
  /** Workspace-relative folder to start in ('' / omitted = the workspace root). */
  cwd?: string;
  cols?: number;
  rows?: number;
  /** With preset 'claude': report Claude's file edits back (`term:follow`, setting `claude.follow`). */
  follow?: boolean;
}

export interface TerminalSpawnResult {
  id: number;
  pid: number;
  shell: ShellInfo;
  /** Workspace-relative start folder. */
  cwd: string;
  /** Windows build (xterm.js ConPTY heuristics) — so the view needn't wait for the shell list. */
  windowsBuild?: number;
}

export interface TerminalDataEvent {
  id: number;
  data: string;
}

export interface TerminalExitEvent {
  id: number;
  exitCode: number;
  signal?: number;
}

/** Longest `probe.text` (a longer line is compared by this prefix). */
export const FOLLOW_PROBE_CHARS = 200;

/** Claude Code changed a file in the open folder (main/terminal-follow.ts), or finished its turn. */
export interface TerminalFollowEvent {
  /** Terminal id. */
  id: number;
  /** 'stop' = Claude finished its turn; 'prompt' = the user's next prompt was submitted (both without a path). */
  kind: 'edit' | 'write' | 'stop' | 'prompt';
  /** Workspace-relative POSIX path (edit / write). Never a path outside the open folder. */
  path?: string;
  /** Start of the new text: only to find the edited lines (fallback when there are no `lines`). */
  hint?: string;
  /** Changed lines of the file as it is after the edit (1-based, inclusive, merged), from Claude's own patch. */
  lines?: Array<[number, number]>;
  /** Text of one added line: the document shows the edit once that line reads like this. */
  probe?: { line: number; text: string };
}

export interface TerminalLimits {
  /** Live terminals per window. */
  maxPerOwner: number;
  /** Live terminals in the whole app. */
  maxTotal: number;
  /** Characters per write message (the client splits bigger pastes). */
  maxWriteChars: number;
  minCols: number;
  maxCols: number;
  minRows: number;
  maxRows: number;
}

export const TERMINAL_LIMITS: TerminalLimits = {
  maxPerOwner: 10,
  maxTotal: 24,
  maxWriteChars: 64 * 1024,
  minCols: 2,
  maxCols: 1000,
  minRows: 1,
  maxRows: 500,
};

/** Output batching (main → renderer): coalesce for ~one frame, flush early at this many chars. */
export const TERMINAL_FLUSH_MS = 16;
export const TERMINAL_FLUSH_CHARS = 64 * 1024;
/** Flow control: the renderer acks what xterm has parsed; main pauses the PTY above HIGH, resumes below LOW. */
export const TERMINAL_ACK_HIGH = 256 * 1024;
export const TERMINAL_ACK_LOW = 32 * 1024;

/** IPC channels (renderer → main: invoke / send; main → renderer: data / exit). */
export const TERMINAL_CHANNELS = {
  shells: 'term:shells',
  spawn: 'term:spawn',
  kill: 'term:kill',
  write: 'term:write',
  resize: 'term:resize',
  ack: 'term:ack',
  data: 'term:data',
  exit: 'term:exit',
  follow: 'term:follow',
} as const;

/** Names the HTTP server must refuse with ENOTSUP (browser mode never exposes a shell). */
export const TERMINAL_RPC_METHODS = ['terminalShells', 'terminalSpawn', 'terminalWrite', 'terminalResize', 'terminalKill', 'terminalAck'] as const;
/** Any terminal-ish RPC name (the listed ones, `term:*`, future `terminal*`): refused by the HTTP server. */
export const isTerminalMethod = (name: string): boolean => /^term(inal)?(?=[A-Z:_-]|$)/.test(name);

/** Invoke replies use the same envelope as RPC. */
export type TerminalReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

/** `\\wsl$\Ubuntu\home\me\proj` / `\\wsl.localhost\Ubuntu\...` → distro + Linux path. */
export function wslUncInfo(abs: string): { distro: string; linuxPath: string } | null {
  const m = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)(?:[\\/](.*))?$/i.exec(abs);
  if (!m) return null;
  const rest = (m[2] ?? '').split(/[\\/]+/).filter(Boolean).join('/');
  return { distro: m[1], linuxPath: '/' + rest };
}

/**
 * WSL distro id → display name: "Ubuntu-24.04" → "Ubuntu 24.04", "kali-linux" → "Kali Linux",
 * "OracleLinux_9_1" → "OracleLinux 9.1". Words that already carry capitals keep them ("openSUSE").
 */
export function prettyDistro(id: string): string {
  const s = id
    .replace(/(\d)_(?=\d)/g, '$1.')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^[a-z]+$/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
  return s || id;
}

/** "Bash", "Zsh", "Nu" — capitalised executable name for Unix shells. */
export const prettyExe = (base: string) => (base === 'sh' ? 'sh (POSIX)' : base ? base[0].toUpperCase() + base.slice(1) : base);

/** Same display name twice → "Name (2)", "Name (3)" (first one keeps the plain name). */
export function uniqueNames<T extends { name: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const n = (seen.get(it.name) ?? 0) + 1;
    seen.set(it.name, n);
    return n === 1 ? it : { ...it, name: `${it.name} (${n})` };
  });
}

