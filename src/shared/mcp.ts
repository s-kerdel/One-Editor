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
export const MCP_WRITES_ENABLED = true;

export const MCP_CHANNELS = {
  status: 'mcp:status',
  setEnabled: 'mcp:setEnabled',
  addFolder: 'mcp:addFolder',
  removeFolder: 'mcp:removeFolder',
  setMode: 'mcp:setMode',
  activity: 'mcp:activity',
  /** Undo one MCP write (a history group id from an activity row). */
  revert: 'mcp:revert',
  /** A folder's grant for code and config files (turning on asks in a native dialog). */
  setAllowCode: 'mcp:setAllowCode',
  /** Undo copies on / off and how long they are kept (turning off asks in a native dialog). */
  setUndo: 'mcp:setUndo',
  /** Tokens: create / regenerate / revoke (each asks in a native dialog); copy a client setup (main writes the
   *  clipboard: the token never reaches the page). */
  createToken: 'mcp:createToken',
  regenerateToken: 'mcp:regenerateToken',
  revokeToken: 'mcp:revokeToken',
  copySetup: 'mcp:copySetup',
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
  /** Code and config files may be written too, not only notes (a grant: main asks first). */
  allowCode?: boolean;
  added?: number;
}

/** Undo copies of MCP writes. Main-owned (mcp.json): turning them off is a widening, so it asks first. */
export interface McpUndo {
  on: boolean;
  days: number;
}

// ---- access tokens (parsing here, pure; generating / hashing / matching in src/mcp/tokens.ts) ----------

/** The client's config passes its token in this environment variable (never argv: process lists show argv). */
export const TOKEN_ENV = 'ONE_MCP_TOKEN';
/** `one_` + 43 base64url characters = 256 random bits. */
export const TOKEN_RE = /^one_[A-Za-z0-9_-]{43}$/;
export const MAX_TOKENS = 32;

export interface TokenRecord {
  id: string;
  /** What the user called it ("LM Studio"). */
  name: string;
  /** SHA-256 of the raw token: all mcp.json keeps. */
  sha256: string;
  /** The first 4 characters after "one_" (shown in Settings, to tell tokens apart). */
  hint: string;
  created: number;
  lastUsed?: number;
}

export function cleanTokenName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  return s || null;
}

/** mcp.json `tokens` → valid records only (a broken entry is dropped: it matches nothing). */
export function parseTokens(raw: unknown): TokenRecord[] {
  const out: TokenRecord[] = [];
  const ids = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (!t || typeof t !== 'object') continue;
    const { id, name, sha256, hint, created, lastUsed } = t as Record<string, unknown>;
    const n = cleanTokenName(name);
    if (typeof id !== 'string' || !/^[a-f0-9]{8,32}$/.test(id) || ids.has(id) || !n || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    ids.add(id);
    out.push({
      id,
      name: n,
      sha256,
      hint: typeof hint === 'string' && /^[A-Za-z0-9_-]{0,4}$/.test(hint) ? hint : '',
      created: typeof created === 'number' && Number.isFinite(created) ? created : 0,
      ...(typeof lastUsed === 'number' && Number.isFinite(lastUsed) ? { lastUsed } : {}),
    });
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

export interface McpConfig {
  version: 1;
  enabled: boolean;
  folders: McpFolder[];
  /** Access tokens (hashes only). Every client needs one. */
  tokens?: TokenRecord[];
  /** Always set by parseMcpConfig; optional for hand-built configs (missing = on, 30 days). */
  undo?: McpUndo;
}

export const UNDO_DAYS = { min: 1, max: 365, def: 30 } as const;
export const EMPTY_MCP_CONFIG: McpConfig = { version: 1, enabled: false, folders: [], undo: { on: true, days: UNDO_DAYS.def } };
/** Grants live in mcp.json (main, behind native dialogs). A page may set only the result limits under `mcp.`;
 *  every other `mcp.*` key (mcp.allowCode, mcp.journal… of earlier builds) is refused (deny by default). */
export const isMainOwnedKey = (k: string) => k.startsWith('mcp.') && k !== 'mcp.maxReadKB' && k !== 'mcp.maxResults';
export const MAX_MCP_FOLDERS = 32;
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const ID_RE = /^[a-f0-9]{8,32}$/;

/** mcp.json → config. Anything odd is dropped (a broken file = off, never "everything shared"). */
export function parseUndo(raw: unknown): McpUndo {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const d = typeof o.days === 'number' && Number.isFinite(o.days) ? Math.round(o.days) : UNDO_DAYS.def;
  // Only an explicit false switches undo off (a broken file keeps it on).
  return { on: o.on !== false, days: Math.min(UNDO_DAYS.max, Math.max(UNDO_DAYS.min, d)) };
}

export function parseMcpConfig(raw: unknown): McpConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...EMPTY_MCP_CONFIG, folders: [], undo: { on: true, days: UNDO_DAYS.def }, tokens: [] };
  const o = raw as Record<string, unknown>;
  const folders: McpFolder[] = [];
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const f of Array.isArray(o.folders) ? o.folders : []) {
    if (!f || typeof f !== 'object') continue;
    const { id, alias, path, mode, added, allowCode } = f as Record<string, unknown>;
    if (typeof id !== 'string' || !ID_RE.test(id) || ids.has(id)) continue;
    if (typeof alias !== 'string' || !ALIAS_RE.test(alias) || aliases.has(alias)) continue;
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\u0000-\u001f]/.test(path)) continue;
    ids.add(id);
    aliases.add(alias);
    // Only the exact word grants writes: a typo or a hand edit means read-only.
    folders.push({ id, alias, path, mode: mode === 'write' ? 'write' : 'read', ...(allowCode === true ? { allowCode: true } : {}), ...(typeof added === 'number' && Number.isFinite(added) ? { added } : {}) });
    if (folders.length >= MAX_MCP_FOLDERS) break;
  }
  return { version: 1, enabled: o.enabled === true, folders, undo: parseUndo(o.undo), tokens: parseTokens(o.tokens) };
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

/** A history group id (one per write call): base-36 time + random hex. */
export const JOURNAL_GROUP_RE = /^[a-z0-9]{6,12}-[a-f0-9]{8}$/;

export interface McpLimits {
  /** Characters of file text per read_file call (and the size budget of any answer). */
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
  undo: McpUndo;
  /** Tokens as the page may see them: never the token, never its hash. */
  tokens: Array<{ id: string; name: string; hint: string; created: number; lastUsed: number | null; copyable: boolean }>;
  /** keyring = "Copy setup" works again later; once = no OS keyring: the setup is copied when the token is made. */
  tokenStore: 'keyring' | 'once';
}

export type McpReply<T> = { ok: true; result: T } | { ok: false; error: { code: string; message: string } };

export const NO_MCP_STATUS: McpStatus = { enabled: false, folders: [], launch: null, platform: '', writes: MCP_WRITES_ENABLED, undo: { on: true, days: UNDO_DAYS.def }, tokens: [], tokenStore: 'once' };

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
  /** The access token the call came with (its id; "last used" in Settings). */
  token?: string | null;
  /** A short note for the row, e.g. "restore from the Recycle Bin" (a folder delete keeps no undo copy). */
  note?: string | null;
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
  if (typeof r.t !== 'number' || !Number.isFinite(r.t) || !tool || !/^[\w./-]+(?: \([a-z ]{1,20}\))?$/.test(tool)) return null;
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
    token: typeof r.token === 'string' && /^[a-f0-9]{8,32}$/.test(r.token) ? r.token : null,
    note: short(r.note, 80),
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
