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
// No electron import: main.ts injects the dialogs (unit-testable).
import fs from 'node:fs';
import path from 'node:path';
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
  aliasFor,
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
  now?(): number;
}

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

  private statusOf(cfg: McpConfig): McpStatus {
    return { enabled: cfg.enabled, folders: cfg.folders.map((f) => ({ ...f })), launch: this.deps.launch(), platform: this.deps.platform, writes: this.writes };
  }

  private get writes(): boolean {
    return this.deps.writesEnabled ?? MCP_WRITES_ENABLED;
  }

  async status(): Promise<McpStatus> {
    return this.statusOf(await this.read());
  }

  setEnabled(on: unknown): Promise<McpStatus> {
    if (typeof on !== 'boolean') return Promise.reject(new McpError('EINVAL', 'Expected true or false'));
    return this.serial(async () => {
      const cfg = await this.read();
      if (cfg.enabled === on) return this.statusOf(cfg);
      if (on && !(await this.deps.confirmEnable())) return this.statusOf(cfg);
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
    for (const line of tailLines(path.join(this.deps.configDir, MCP_AUDIT_FILE))) {
      const row = parseActivityLine(line);
      if (row?.journal) row.reverted = fs.existsSync(path.join(hist, row.journal, 'reverted'));
      if (row) out.push(row);
      if (out.length >= limit) break;
    }
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
        const folder = new Folder({ alias: shared.alias, path: shared.path, mode: 'write' }, { settings: () => settings, configDir: this.deps.configDir, idleMs: 60_000, win: this.deps.platform === 'win32' });
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
  ipc.handle(CH.setEnabled, guard((on) => svc.setEnabled(on)));
  ipc.handle(CH.addFolder, guard(() => svc.addFolder()));
  ipc.handle(CH.removeFolder, guard((id) => svc.removeFolder(id)));
  ipc.handle(CH.setMode, guard((id, mode) => svc.setMode(id, mode)));
  ipc.handle(CH.activity, guard(() => svc.activity()));
  ipc.handle(CH.revert, guard((group) => svc.revert(group)));
}
