// Settings → MCP server (main process): owns <app data>/mcp.json, the file the MCP server program
// (dist/mcp/cli.mjs, started by MCP clients over stdio) obeys. The page asks over mcp:* channels; main decides.
//  - Off by default. Switching on, sharing a folder (only through the native folder dialog: the page
//    never hands over a path) and allowing writes in a folder each need the user's OK in a native dialog.
//    Narrowing (off, remove a folder, back to read-only) needs none.
//  - Refused folders: a drive / file-system root, the home folder itself, anything that contains or
//    sits inside the app's data folder (settings, the vault, this file).
//  - Running servers poll mcp.json: off → they exit; a removed folder is gone for them at once.
//  - Activity = the tail of mcp-audit.jsonl (written by the servers), parsed field by field.
//  - Revert (an activity row's undo): the change's history group is replayed backwards through the same
//    folder resolver and write guard the server uses, only onto files still as MCP left them, and only
//    while the folder is still shared.
//  - Grants that widen what a client may do are asked in a native dialog too: code files in a folder,
//    switching undo copies off, every access token (create, regenerate, revoke).
//  - Access tokens: mcp.json keeps a SHA-256 per token; the raw token is kept encrypted with the OS keyring
//    (mcp-tokens.json; never vault.json) so "Copy setup" works again later, and main writes the finished
//    client setup to the clipboard itself: the token never reaches the page. No keyring: copied once, when made.
// No electron import: main.ts injects the dialogs (unit-testable).
import fs from 'node:fs';
import path from 'node:path';
import { generateToken, hashToken, tokenHint } from '../mcp/tokens';
import { readJson, writeJson } from '../backend/service';
import type { Settings } from '../shared/api';
import { AuditLog } from '../mcp/audit';
import { Folder } from '../mcp/folders';
import { JOURNAL_DIR, readGroup, revertGroup } from '../mcp/journal';
import { ToolError } from '../mcp/protocol';
import { tailLines } from '../mcp/audit';
import {
  EMPTY_MCP_CONFIG,
  MAX_MCP_FOLDERS,
  MCP_AUDIT_FILE,
  MCP_CHANNELS as CH,
  MCP_CONFIG_FILE,
  MCP_WRITES_ENABLED,
  JOURNAL_GROUP_RE,
  MAX_TOKENS,
  TOKEN_ENV,
  UNDO_DAYS,
  aliasFor,
  cleanTokenName,
  setupSnippets,
  parseActivityLine,
  parseMcpConfig,
  type McpActivity,
  type McpConfig,
  type McpLaunch,
  type McpReply,
  type McpStatus,
} from '../shared/mcp';

export interface McpDeps {
  /** The app data folder (Electron userData): mcp.json and the activity log live here. */
  configDir: string;
  homedir: string;
  platform: string;
  /** How a client starts the server; null when this build has no dist/mcp/cli.mjs. */
  launch(): McpLaunch | null;
  confirmEnable(): Promise<boolean>;
  confirmWrite(f: { alias: string; path: string }): Promise<boolean>;
  /** The native folder dialog; null = cancelled. */
  pickFolder(): Promise<string | null>;
  realpath(abs: string): Promise<string>;
  isDirectory(abs: string): Promise<boolean>;
  randomId(): string;
  onChange(s: McpStatus): void;
  /** Revert: the current settings (exclusions = what is visible) and the trash for files MCP created. */
  settings?(): Promise<Settings>;
  trash?(abs: string): Promise<void>;
  /** Tests only: allow Read-write although this build ships read-only (default MCP_WRITES_ENABLED). */
  writesEnabled?: boolean;
  /** Native confirms of the other widening steps. */
  confirmAllowCode?(f: { alias: string; path: string }): Promise<boolean>;
  confirmUndoOff?(): Promise<boolean>;
  confirmToken?(q: { kind: 'create' | 'regenerate' | 'revoke'; name: string }): Promise<boolean>;
  /** The OS keyring (safeStorage): keeps raw tokens for "Copy setup". Absent / unavailable = show once. */
  tokenCrypto?: { available(): boolean; encrypt(s: string): Buffer; decrypt(b: Buffer): string };
  /** Main writes the finished client setup to the clipboard itself (the token never reaches the page). */
  writeClipboard?(text: string): void;
  /** To clear the clipboard later only if it still holds the setup we put there. */
  readClipboard?(): string | Promise<string>;
  /** "Copy setup with the access token?" (copying again: creating / regenerating already asked). */
  confirmCopy?(q: { name: string }): Promise<boolean>;
  /** How long a copied setup stays on the clipboard (default 2 minutes; tests shorten it). */
  clipboardClearMs?: number;
  now?(): number;
}

const TOKEN_STORE = 'mcp-tokens.json';
const CLIENTS = ['lmstudio', 'codex', 'claude-desktop', 'claude-code'] as const;
type ClientId = (typeof CLIENTS)[number];
const clientOf = (v: unknown): ClientId => (CLIENTS.includes(v as ClientId) ? (v as ClientId) : 'lmstudio');

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// The grant rules live with the server, which checks every mcp.json entry again.
export { folderProblem } from '../mcp/grant';
import { folderProblem } from '../mcp/grant';

export class McpService {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: McpDeps) {}

  private get file() {
    return path.join(this.deps.configDir, MCP_CONFIG_FILE);
  }

  private get foldCase() {
    return this.deps.platform !== 'linux';
  }

  /** Every change goes through here, one at a time (two quick clicks never interleave). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => {}).then(fn);
    this.chain = next;
    return next;
  }

  private async read(): Promise<McpConfig> {
    return parseMcpConfig(await readJson<unknown>(this.file, EMPTY_MCP_CONFIG));
  }

  private async write(cfg: McpConfig): Promise<McpStatus> {
    await writeJson(this.file, cfg);
    const s = this.statusOf(cfg);
    this.deps.onChange(s);
    return s;
  }

  private statusOf(cfg: McpConfig, stored: Set<string> = this.storedIds): McpStatus {
    return {
      enabled: cfg.enabled,
      folders: cfg.folders.map((f) => ({ ...f })),
      launch: this.deps.launch(),
      platform: this.deps.platform,
      writes: this.writes,
      undo: { ...(cfg.undo ?? EMPTY_MCP_CONFIG.undo!) },
      tokens: (cfg.tokens ?? []).map((t) => ({ id: t.id, name: t.name, hint: t.hint, created: t.created, lastUsed: t.lastUsed ?? null, copyable: stored.has(t.id) })),
      tokenStore: this.keyring ? 'keyring' : 'once',
    };
  }

  // ---- access tokens ---------------------------------------------------------------------------------

  private storedIds = new Set<string>();

  private get keyring(): boolean {
    try {
      return !!this.deps.tokenCrypto?.available();
    } catch {
      return false;
    }
  }

  private async readStore(): Promise<Record<string, string>> {
    const raw = await readJson<{ tokens?: Record<string, string> } | null>(path.join(this.deps.configDir, TOKEN_STORE), null);
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(raw?.tokens ?? {})) if (/^[a-f0-9]{8,32}$/.test(id) && typeof v === 'string') out[id] = v;
    this.storedIds = new Set(Object.keys(out));
    return out;
  }

  private async writeStore(store: Record<string, string>) {
    await writeJson(path.join(this.deps.configDir, TOKEN_STORE), { version: 1, tokens: store });
    this.storedIds = new Set(Object.keys(store));
  }

  /** The finished setup of `client` with `raw` in its env block, straight to the clipboard. */
  private copy(raw: string, client: ClientId): void {
    const launch = this.deps.launch();
    if (!launch) throw new McpError('ENOTSUP', 'This build has no MCP server program (dist/mcp/cli.mjs)');
    if (!this.deps.writeClipboard) throw new McpError('ENOTSUP', 'No clipboard');
    const snip = setupSnippets({ ...launch, env: { ...launch.env, [TOKEN_ENV]: raw } }, this.deps.platform).find((x) => x.id === client)!;
    this.deps.writeClipboard(snip.text);
    // Not left there: cleared after 2 minutes, unless something else was copied meanwhile.
    const t = setTimeout(async () => {
      try {
        if ((await this.deps.readClipboard?.()) === snip.text) this.deps.writeClipboard?.('');
      } catch {}
    }, this.deps.clipboardClearMs ?? 120_000);
    (t as { unref?: () => void }).unref?.();
  }

  /** A new token, its hash in mcp.json, the raw one in the keyring store (if there is one), copied for `client`. */
  private async mint(cfg: McpConfig, name: string, client: ClientId, id = this.deps.randomId()): Promise<McpConfig> {
    const raw = generateToken();
    const store = await this.readStore();
    if (this.keyring) store[id] = this.deps.tokenCrypto!.encrypt(raw).toString('base64');
    else delete store[id];
    const rec = { id, name, sha256: hashToken(raw), hint: tokenHint(raw), created: this.deps.now?.() ?? Date.now() };
    const tokens = [...(cfg.tokens ?? []).filter((t) => t.id !== id), rec];
    this.copy(raw, client); // before anything is stored: a token nobody could copy is not made
    await this.writeStore(store);
    return { ...cfg, tokens };
  }

  createToken(name: unknown, client?: unknown): Promise<McpStatus> {
    const n = cleanTokenName(name);
    if (!n) return Promise.reject(new McpError('EINVAL', 'Give the token a name (the app it is for)'));
    return this.serial(async () => {
      const cfg = await this.read();
      if ((cfg.tokens ?? []).length >= MAX_TOKENS) throw new McpError('ELIMIT', `At most ${MAX_TOKENS} tokens`);
      if (!(await this.deps.confirmToken?.({ kind: 'create', name: n }))) return this.statusOf(cfg, (await this.readStore(), this.storedIds));
      return this.write(await this.mint(cfg, n, clientOf(client)));
    });
  }

  regenerateToken(id: unknown, client?: unknown): Promise<McpStatus> {
    return this.serial(async () => {
      const cfg = await this.read();
      const t = typeof id === 'string' ? (cfg.tokens ?? []).find((x) => x.id === id) : undefined;
      if (!t) throw new McpError('ENOENT', 'No such token');
      if (!(await this.deps.confirmToken?.({ kind: 'regenerate', name: t.name }))) return this.statusOf(cfg);
      return this.write(await this.mint(cfg, t.name, clientOf(client), t.id));
    });
  }

  revokeToken(id: unknown): Promise<McpStatus> {
    return this.serial(async () => {
      const cfg = await this.read();
      const t = typeof id === 'string' ? (cfg.tokens ?? []).find((x) => x.id === id) : undefined;
      if (!t) throw new McpError('ENOENT', 'No such token');
      if (!(await this.deps.confirmToken?.({ kind: 'revoke', name: t.name }))) return this.statusOf(cfg);
      const store = await this.readStore();
      delete store[t.id];
      await this.writeStore(store);
      return this.write({ ...cfg, tokens: (cfg.tokens ?? []).filter((x) => x.id !== t.id) });
    });
  }

  /** Copies a client setup with the token in it; the page only learns that it was copied. */
  async copySetup(id: unknown, client?: unknown): Promise<{ copied: true }> {
    const cfg = await this.read();
    const t = typeof id === 'string' ? (cfg.tokens ?? []).find((x) => x.id === id) : undefined;
    if (!t) throw new McpError('ENOENT', 'No such token');
    const enc = (await this.readStore())[t.id];
    if (!enc || !this.keyring) throw new McpError('ENOKEY', 'This token can only be copied when it is made (no keyring here): make a new one');
    if (!(await this.deps.confirmCopy?.({ name: t.name }))) throw new McpError('ECANCELED', 'Not copied');
    let raw: string;
    try {
      raw = this.deps.tokenCrypto!.decrypt(Buffer.from(enc, 'base64'));
    } catch {
      throw new McpError('ENOKEY', 'This token cannot be read back: regenerate it');
    }
    if (hashToken(raw) !== t.sha256) throw new McpError('ENOKEY', 'This token cannot be read back: regenerate it');
    this.copy(raw, clientOf(client));
    return { copied: true };
  }

  // ---- grants ----------------------------------------------------------------------------------------

  /** Code and config files in a folder: a grant, asked first; back to notes only needs no dialog. */
  setAllowCode(id: unknown, on: unknown): Promise<McpStatus> {
    if (typeof on !== 'boolean') return Promise.reject(new McpError('EINVAL', 'Expected true or false'));
    return this.serial(async () => {
      const cfg = await this.read();
      const f = typeof id === 'string' ? cfg.folders.find((x) => x.id === id) : undefined;
      if (!f) throw new McpError('ENOENT', 'No such shared folder');
      if (!!f.allowCode === on) return this.statusOf(cfg);
      if (on && !(await this.deps.confirmAllowCode?.({ alias: f.alias, path: f.path }))) return this.statusOf(cfg);
      return this.write({ ...cfg, folders: cfg.folders.map((x) => (x.id === f.id ? { ...x, allowCode: on || undefined } : x)) });
    });
  }

  /** Undo copies: switching them off is a widening (asked first); how long they are kept, 1–365 days. */
  setUndo(raw: unknown): Promise<McpStatus> {
    const o = raw && typeof raw === 'object' ? (raw as { on?: unknown; days?: unknown }) : null;
    if (!o || (o.on !== undefined && typeof o.on !== 'boolean') || (o.days !== undefined && (typeof o.days !== 'number' || !Number.isFinite(o.days)))) return Promise.reject(new McpError('EINVAL', 'Expected { on?, days? }'));
    return this.serial(async () => {
      const cfg = await this.read();
      const cur = cfg.undo ?? { on: true, days: UNDO_DAYS.def };
      const next = { on: o.on === undefined ? cur.on : (o.on as boolean), days: o.days === undefined ? cur.days : Math.min(UNDO_DAYS.max, Math.max(UNDO_DAYS.min, Math.round(o.days as number))) };
      if (cur.on && !next.on && !(await this.deps.confirmUndoOff?.())) return this.statusOf(cfg);
      return this.write({ ...cfg, undo: next });
    });
  }

  private get writes(): boolean {
    return this.deps.writesEnabled ?? MCP_WRITES_ENABLED;
  }

  async status(): Promise<McpStatus> {
    await this.readStore();
    return this.statusOf(await this.read());
  }

  /** On: asks first, and makes the first access token in the same step (its setup for `client` is copied). */
  setEnabled(on: unknown, client?: unknown): Promise<McpStatus> {
    if (typeof on !== 'boolean') return Promise.reject(new McpError('EINVAL', 'Expected true or false'));
    return this.serial(async () => {
      const cfg = await this.read();
      if (cfg.enabled === on) return this.statusOf(cfg);
      if (on && !(await this.deps.confirmEnable())) return this.statusOf(cfg);
      if (on && !(cfg.tokens ?? []).length) return this.write({ ...(await this.mint(cfg, 'First app', clientOf(client))), enabled: true });
      return this.write({ ...cfg, enabled: on });
    });
  }

  /** Opens the native folder dialog; the picked folder is shared read-only. */
  addFolder(): Promise<McpStatus> {
    return this.serial(async () => {
      const cfg = await this.read();
      if (cfg.folders.length >= MAX_MCP_FOLDERS) throw new McpError('ELIMIT', `At most ${MAX_MCP_FOLDERS} folders can be shared`);
      const picked = await this.deps.pickFolder();
      if (!picked) return this.statusOf(cfg);
      if (!(await this.deps.isDirectory(picked))) throw new McpError('ENOENT', 'Not a folder');
      const real = await this.deps.realpath(picked);
      const why = folderProblem(real, { configDir: await this.deps.realpath(this.deps.configDir).catch(() => this.deps.configDir), homedir: this.deps.homedir, foldCase: this.foldCase });
      if (why) throw new McpError('EACCES', why);
      const same = (a: string) => (this.foldCase ? a.toLowerCase() === real.toLowerCase() : a === real);
      const dup = cfg.folders.find((f) => same(f.path));
      if (dup) throw new McpError('EEXIST', `Already shared as “${dup.alias}”`);
      const alias = aliasFor(path.basename(real) || 'folder', cfg.folders.map((f) => f.alias));
      return this.write({ ...cfg, folders: [...cfg.folders, { id: this.deps.randomId(), alias, path: real, mode: 'read', added: this.deps.now?.() ?? Date.now() }] });
    });
  }

  removeFolder(id: unknown): Promise<McpStatus> {
    return this.serial(async () => {
      const cfg = await this.read();
      if (typeof id !== 'string' || !cfg.folders.some((f) => f.id === id)) throw new McpError('ENOENT', 'No such shared folder');
      return this.write({ ...cfg, folders: cfg.folders.filter((f) => f.id !== id) });
    });
  }

  setMode(id: unknown, mode: unknown): Promise<McpStatus> {
    if (mode !== 'read' && mode !== 'write') return Promise.reject(new McpError('EINVAL', 'Mode must be read or write'));
    if (mode === 'write' && !this.writes) return Promise.reject(new McpError('ENOTSUP', 'Changes by AI apps come with the next build of One: folders are read-only for now'));
    return this.serial(async () => {
      const cfg = await this.read();
      const f = typeof id === 'string' ? cfg.folders.find((x) => x.id === id) : undefined;
      if (!f) throw new McpError('ENOENT', 'No such shared folder');
      if (f.mode === mode) return this.statusOf(cfg);
      if (mode === 'write' && !(await this.deps.confirmWrite({ alias: f.alias, path: f.path }))) return this.statusOf(cfg);
      return this.write({ ...cfg, folders: cfg.folders.map((x) => (x.id === f.id ? { ...x, mode } : x)) });
    });
  }

  /** The newest calls first (at most `limit`); write rows say whether they were reverted. */
  async activity(limit = 50): Promise<McpActivity[]> {
    const out: McpActivity[] = [];
    const hist = path.join(this.deps.configDir, JOURNAL_DIR);
    const used = new Map<string, number>();
    for (const line of tailLines(path.join(this.deps.configDir, MCP_AUDIT_FILE))) {
      const row = parseActivityLine(line);
      if (row?.journal) row.reverted = fs.existsSync(path.join(hist, row.journal, 'reverted'));
      if (row?.token && row.t > (used.get(row.token) ?? 0)) used.set(row.token, row.t);
      if (row) out.push(row);
      if (out.length >= limit) break;
    }
    // "Last used" comes from the servers' activity log (they never write mcp.json): kept a minute coarse.
    if (used.size)
      void this.serial(async () => {
        const cfg = await this.read();
        let changed = false;
        const tokens = (cfg.tokens ?? []).map((t) => {
          const u = used.get(t.id);
          if (u && u > (t.lastUsed ?? 0) + 60_000) {
            changed = true;
            return { ...t, lastUsed: u };
          }
          return t;
        });
        if (changed) await writeJson(this.file, { ...cfg, tokens });
      }).catch(() => {});
    return out;
  }

  /** Undoes one MCP write (an activity row's history group). All or nothing; see journal.ts. */
  revert(group: unknown): Promise<{ reverted: number }> {
    if (typeof group !== 'string' || !JOURNAL_GROUP_RE.test(group)) return Promise.reject(new McpError('EINVAL', 'Not a history entry'));
    return this.serial(async () => {
      const dir = path.join(this.deps.configDir, JOURNAL_DIR);
      const t0 = Date.now();
      let alias: string | null = null;
      let first: string | null = null;
      const audit = new AuditLog(path.join(this.deps.configDir, MCP_AUDIT_FILE));
      try {
        const { entries } = await readGroup(dir, group);
        first = entries[0].path;
        const same = (a: string, b: string) => (this.foldCase ? a.toLowerCase() === b.toLowerCase() : a === b);
        const shared = (await this.read()).folders.find((f) => same(path.resolve(f.path), path.resolve(entries[0].root)));
        if (!shared) throw new McpError('EACCES', 'That folder is no longer shared: nothing was reverted');
        alias = shared.alias;
        const settings = (await this.deps.settings?.()) ?? ({ excludeGlobs: [] } as unknown as Settings);
        // Restorative only (puts back what MCP replaced), so it also works once the folder is read-only again
        // or code files are no longer allowed; the type rules of NEVER_EXTS still hold.
        const folder = new Folder({ alias: shared.alias, path: shared.path, mode: 'write' }, { settings: () => settings, configDir: this.deps.configDir, idleMs: 60_000, win: this.deps.platform === 'win32' });
        folder.allowCode = true;
        let n: number;
        try {
          n = await revertGroup(folder, dir, group, this.deps.trash ?? (() => Promise.reject(new Error('No trash'))));
        } finally {
          folder.dispose();
        }
        await audit.record({ client: 'One', transport: 'app', tool: 'revert', folder: alias, path: first, ok: true, code: null, ms: Date.now() - t0, bytes: 0, journal: null });
        return { reverted: n };
      } catch (err) {
        const e = err instanceof McpError ? err : err instanceof ToolError ? new McpError(err.code, err.message) : new McpError('EIO', 'The change could not be reverted');
        await audit.record({ client: 'One', transport: 'app', tool: 'revert', folder: alias, path: first, ok: false, code: e.code, ms: Date.now() - t0, bytes: 0, journal: null });
        throw e;
      }
    });
  }
}

/** The command a client runs: this executable in Node mode + cli.mjs; null when the build has no server. */
export function mcpLaunch(o: { execPath: string; cli: string; exists: (p: string) => boolean }): McpLaunch | null {
  return o.exists(o.cli) ? { command: o.execPath, args: [o.cli, '--stdio'], env: { ELECTRON_RUN_AS_NODE: '1' } } : null;
}

interface IpcLike {
  handle(channel: string, fn: (e: unknown, ...args: unknown[]) => unknown): void;
}

const reply = async <T>(fn: () => Promise<T> | T): Promise<McpReply<T>> => {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return err instanceof McpError ? { ok: false, error: { code: err.code, message: err.message } } : { ok: false, error: { code: 'EIO', message: 'MCP settings could not be changed' } };
  }
};

/** mcp:* handlers. The preload only coerces types; everything is validated in the service. */
export function registerMcpIpc(ipc: IpcLike, svc: McpService, o: { isTrusted: (e: unknown) => boolean }): void {
  const denied: McpReply<never> = { ok: false, error: { code: 'EACCES', message: 'Untrusted sender' } };
  const guard = (fn: (...a: unknown[]) => Promise<unknown> | unknown) => (e: unknown, ...a: unknown[]) => (o.isTrusted(e) ? reply(() => fn(...a)) : denied);
  ipc.handle(CH.status, guard(() => svc.status()));
  ipc.handle(CH.setEnabled, guard((on, client) => svc.setEnabled(on, client)));
  ipc.handle(CH.addFolder, guard(() => svc.addFolder()));
  ipc.handle(CH.removeFolder, guard((id) => svc.removeFolder(id)));
  ipc.handle(CH.setMode, guard((id, mode) => svc.setMode(id, mode)));
  ipc.handle(CH.activity, guard(() => svc.activity()));
  ipc.handle(CH.revert, guard((group) => svc.revert(group)));
  ipc.handle(CH.setAllowCode, guard((id, on) => svc.setAllowCode(id, on)));
  ipc.handle(CH.setUndo, guard((o) => svc.setUndo(o)));
  ipc.handle(CH.createToken, guard((name, client) => svc.createToken(name, client)));
  ipc.handle(CH.regenerateToken, guard((id, client) => svc.regenerateToken(id, client)));
  ipc.handle(CH.revokeToken, guard((id) => svc.revokeToken(id)));
  ipc.handle(CH.copySetup, guard((id, client) => svc.copySetup(id, client)));
}
