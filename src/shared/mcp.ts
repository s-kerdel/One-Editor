// MCP server (desktop: Settings → MCP server). The server itself is a separate Node program
// (dist/mcp/cli.mjs, src/mcp) that MCP clients start over stdio. Main owns its config file
// (<app data>/mcp.json: on/off, the folder allow-list, per-folder mode); the page talks to main over
// these mcp:* channels only, and every widening step (enable, add a folder, allow writes) is a native
// dialog in main. Pure: parsers and snippet builders, unit-tested.

/**
 * THE switch for MCP writes. false = this build ships read-only: the server serves every folder read-only
 * and lists no write tools whatever mcp.json says, main refuses Read-write, Settings shows it disabled.
 * The write code and its tests stay in place (tests pass `writes: true` explicitly). Flip to true to ship writes.
 */
export const MCP_WRITES_ENABLED = false;

export const MCP_CHANNELS = {
  status: 'mcp:status',
  setEnabled: 'mcp:setEnabled',
  addFolder: 'mcp:addFolder',
  removeFolder: 'mcp:removeFolder',
  setMode: 'mcp:setMode',
  activity: 'mcp:activity',
  /** Undo one MCP write (a history group id from an activity row). */
  revert: 'mcp:revert',
  /** main → renderer: a new McpStatus. */
  changed: 'mcp:changed',
} as const;

/** In the app data folder (never inside a shared folder). */
export const MCP_CONFIG_FILE = 'mcp.json';
/** One JSON line per tool call (never content, never a query): written by the server, read by Settings. */
export const MCP_AUDIT_FILE = 'mcp-audit.jsonl';

/** read = the read tools only. write = write tools too (stored now; the write tools ship later). */
export type McpMode = 'read' | 'write';

export interface McpFolder {
  /** Stable id (random hex): Settings rows address folders by it, never by a path from the page. */
  id: string;
  /** What tools call the folder (`folder` parameter). Lower case, unique. */
  alias: string;
  /** Absolute real path, native separators. */
  path: string;
  mode: McpMode;
  added?: number;
}

export interface McpConfig {
  version: 1;
  enabled: boolean;
  folders: McpFolder[];
}

export const EMPTY_MCP_CONFIG: McpConfig = { version: 1, enabled: false, folders: [] };
export const MAX_MCP_FOLDERS = 32;
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ID_RE = /^[a-f0-9]{8,32}$/;

/** mcp.json → config. Anything odd is dropped (a broken file = off, never "everything shared"). */
export function parseMcpConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_MCP_CONFIG, folders: [] };
  const o = raw as Record<string, unknown>;
  const folders: McpFolder[] = [];
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const f of Array.isArray(o.folders) ? o.folders : []) {
    if (!f || typeof f !== 'object') continue;
    const { id, alias, path, mode, added } = f as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || ids.has(id)) continue;
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias) || aliases.has(alias)) continue;
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\u0000-\u001f]/.test(path)) continue;
    ids.add(id);
    aliases.add(alias);
    // Only the exact word grants writes: a typo or a hand edit means read-only.
    folders.push({ id, alias, path, mode: mode === 'write' ? 'write' : 'read', ...(typeof added === 'number' && Number.isFinite(added) ? { added } : {}) });
    if (folders.length >= MAX_MCP_FOLDERS) break;
  }
  return { version: 1, enabled: o.enabled === true, folders };
}

/** A folder's name → an alias ("My Notes" → "my-notes"), made unique against `taken`. */
export function aliasFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[^a-z0-9]+/, '')
      .replace(/-+$/, '')
      .slice(0, 32) || 'folder';
  if (!ALIAS_RE.test(base)) base = 'folder';
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

// ---- result limits (settings.json, Settings → MCP server; read by the server on every call) ------------

export const MCP_LIMIT_KEYS = { readKB: 'mcp.maxReadKB', results: 'mcp.maxResults' } as const;
/** Sized for local models with small context windows (LM Studio): ~4k tokens of text per read. */
export const MCP_LIMIT_DEFAULTS = { readKB: 16, results: 25 } as const;
export const MCP_LIMIT_RANGES = { readKB: { min: 4, max: 256 }, results: { min: 5, max: 200 } } as const;

/** Undo copies of MCP writes (settings.json; off = no new copies, existing ones age out). */
export const MCP_JOURNAL_KEYS = { on: 'mcp.journal', days: 'mcp.journalDays' } as const;
export const MCP_JOURNAL_DEFAULTS = { on: true, days: 30 } as const;
export const MCP_JOURNAL_DAYS = { min: 1, max: 365 } as const;
/** A history group id (one per write call): base-36 time + random hex. */
export const JOURNAL_GROUP_RE = /^[a-z0-9]{6,12}-[a-f0-9]{8}$/;

export function journalFromSettings(s: Record<string, unknown>): { on: boolean; maxAgeMs: number } {
  return { on: s[MCP_JOURNAL_KEYS.on] !== false, maxAgeMs: clampInt(s[MCP_JOURNAL_KEYS.days], MCP_JOURNAL_DEFAULTS.days, MCP_JOURNAL_DAYS) * 24 * 3600_000 };
}

export interface McpLimits {
  /** Characters of file text per read_file / read_section call (and the size budget of any answer). */
  readChars: number;
  /** Rows per call (files, hits, headings, tags, links): the default and the maximum of `limit`. */
  results: number;
}

const clampInt = (v: unknown, def: number, r: { min: number; max: number }) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && v !== null && v !== '' ? Math.min(r.max, Math.max(r.min, Math.round(n))) : def;
};

export function limitsFromSettings(s: Record<string, unknown>): McpLimits {
  return {
    readChars: clampInt(s[MCP_LIMIT_KEYS.readKB], MCP_LIMIT_DEFAULTS.readKB, MCP_LIMIT_RANGES.readKB) * 1024,
    results: clampInt(s[MCP_LIMIT_KEYS.results], MCP_LIMIT_DEFAULTS.results, MCP_LIMIT_RANGES.results),
  };
}

// ---- status for Settings ------------------------------------------------------------------------

/** How a client starts the server: the executable in Node mode + cli.mjs. */
export interface McpLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpStatus {
  enabled: boolean;
  folders: McpFolder[];
  /** null: this build has no MCP server program (dist/mcp/cli.mjs missing). */
  launch: McpLaunch | null;
  platform: string;
  /** MCP_WRITES_ENABLED of this build (false: Read-write is not offered yet). */
  writes: boolean;
}

export type McpReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export const NO_MCP_STATUS: McpStatus = { enabled: false, folders: [], launch: null, platform: '', writes: MCP_WRITES_ENABLED };

// ---- activity (mcp-audit.jsonl) -------------------------------------------------------------------

export interface McpActivity {
  t: number;
  client: string;
  transport: string;
  tool: string;
  folder: string | null;
  path: string | null;
  ok: boolean;
  code: string | null;
  ms: number;
  bytes: number;
  /** Write calls: their undo history group (no group = nothing to revert: undo copies were off). */
  journal?: string | null;
  /** Filled in by main: that change was reverted. */
  reverted?: boolean;
}

const short = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null);

/** One audit line → a row, or null. The file is written by another process: every field is checked. */
export function parseActivityLine(line: string): McpActivity | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const tool = short(r.tool, 64);
  if (typeof r.t !== 'number' || !Number.isFinite(r.t) || !tool || !/^[\w./-]+$/.test(tool)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
  return {
    t: r.t,
    client: short(r.client, 60) ?? 'unknown',
    transport: short(r.transport, 10) ?? 'stdio',
    tool,
    folder: short(r.folder, 40),
    path: short(r.path, 300),
    ok: r.ok === true,
    code: short(r.code, 40),
    ms: num(r.ms),
    bytes: num(r.bytes),
    journal: typeof r.journal === 'string' && JOURNAL_GROUP_RE.test(r.journal) ? r.journal : null,
  };
}

// ---- client setup snippets ----------------------------------------------------------------------

export interface SetupSnippet {
  id: 'lmstudio' | 'codex' | 'claude-desktop' | 'claude-code';
  title: string;
  /** Where it goes (file or place). */
  where: string;
  lang: 'json' | 'toml' | 'shell';
  text: string;
}

/** TOML string: literal ('…', backslashes as they are) when possible, else a basic string. */
export function tomlString(s: string): string {
  if (!/['\n\r\u0000-\u001f]/.test(s)) return `'${s}'`;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\u0000-\u001f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/** Quotes one argument for the Claude Code command line (POSIX shell / PowerShell / cmd alike for plain paths). */
const shellArg = (s: string) => (/^[\w./:=@%+-]+$/.test(s) ? s : `"${s.replace(/(["$`\\])/g, (c) => (c === '\\' ? '\\' : `\\${c}`))}"`);

/** Ready-to-paste configs. LM Studio and Codex first (the main clients), then Claude. */
export function setupSnippets(l: McpLaunch, platform: string): SetupSnippet[] {
  const server = { command: l.command, args: l.args, env: l.env };
  const json = JSON.stringify({ mcpServers: { one: server } }, null, 2);
  const env = Object.entries(l.env);
  const win = platform === 'win32';
  const home = win ? '%USERPROFILE%' : '~';
  const sep = win ? '\\' : '/';
  const codex = [
    '[mcp_servers.one]',
    `command = ${tomlString(l.command)}`,
    `args = [${l.args.map(tomlString).join(', ')}]`,
    ...(env.length ? [`env = { ${env.map(([k, v]) => `${k} = ${tomlString(v)}`).join(', ')} }`] : []),
  ].join('\n');
  const claudeCode = ['claude mcp add --scope user', ...env.map(([k, v]) => `--env ${k}=${shellArg(v)}`), 'one --', shellArg(l.command), ...l.args.map(shellArg)].join(' ');
  const desktopWhere = win ? '%APPDATA%\\Claude\\claude_desktop_config.json' : platform === 'darwin' ? '~/Library/Application Support/Claude/claude_desktop_config.json' : 'claude_desktop_config.json (Claude Desktop settings → Developer → Edit config)';
  return [
    { id: 'lmstudio', title: 'LM Studio', where: `${home}${sep}.lmstudio${sep}mcp.json (LM Studio → Program → Install → Edit mcp.json)`, lang: 'json', text: json },
    { id: 'codex', title: 'Codex CLI', where: `${home}${sep}.codex${sep}config.toml`, lang: 'toml', text: codex },
    { id: 'claude-desktop', title: 'Claude Desktop', where: desktopWhere, lang: 'json', text: json },
    { id: 'claude-code', title: 'Claude Code', where: 'Run once in a terminal', lang: 'shell', text: claudeCode },
  ];
}
