// Settings → MCP server (main process): owns <app data>/mcp.json, the file the MCP server program
// (dist/mcp/cli.mjs, started by MCP clients over stdio) obeys. The page asks over mcp:* channels; main decides.
//  - Off by default. Switching on, sharing folders (only through the native folder dialog, several at once:
//    the page never hands over a path; a batch gets one native confirm) and allowing writes in a folder each
//    need the user's OK in a native dialog. Narrowing (off, remove a folder, back to read-only) needs none.
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
  MCP_IDLE_MS,
  MCP_LIVE_DIR,
  MCP_WRITES_ENABLED,
  parseLiveFile,
  type McpSession,
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
  /** The native folder dialog, several folders at once; [] = cancelled. */
  pickFolders(): Promise<string[]>;
  /** Several folders picked: one native confirm for the batch (see `foldersConfirm`). No `add` = only the reasons, answers false. */
  /** THE dialog of "Add folders…" (one, also for one folder): read-only / allow changes (+ code files) / Cancel. */
  confirmFolders(q: FolderBatch): Promise<FolderChoice | null>;
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
  /** Is this process still running? (Default: process.kill(pid, 0); EPERM = it runs, as someone else.) */
  isAlive?(pid: number): boolean;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: a check only (Windows too: Node opens the process)
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** A live file is tiny; more files than this in mcp-live/ are not servers we started. */
export const MAX_LIVE_FILES = 64;
const MAX_LIVE_BYTES = 4096;

/**
 * A live file's text, or '' for anything that isn't a small regular file. Another process could leave a FIFO,
 * a device, a link or a huge file under that name (review round 7: a FIFO hung main's file I/O for good):
 * lstat first, then open without following links and without blocking, and read at most 4 kB.
 */
export async function readLiveFile(file: string): Promise<string> {
  const st = await fs.promises.lstat(file).catch(() => null);
  if (!st?.isFile() || st.size > MAX_LIVE_BYTES) return '';
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const fh = await fs.promises.open(file, flags).catch(() => null);
  if (!fh) return '';
  try {
    const buf = Buffer.alloc(MAX_LIVE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, MAX_LIVE_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return '';
  } finally {
    await fh.close().catch(() => {});
  }
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

/** A batch of picked folders after the checks: what would be shared (real path) and what not, with why. */
export interface FolderBatch {
  add: Array<{ alias: string; path: string }>;
  refused: Array<{ path: string; why: string }>;
  /** This build lets AI apps change files (MCP_WRITES_ENABLED): "Add and allow changes" is offered. */
  writes?: boolean;
}
/** What the one "Add folders…" dialog answered, for every folder of that step. */
export interface FolderChoice {
  mode: 'read' | 'write';
  /** Code and config files too (the dialog's checkbox; only with mode write). */
  allowCode: boolean;
}

/** A refused pick + the error code a single pick answers with. */
type Refusal = FolderBatch['refused'][number] & { code: string };

/** Refused rows shown at most (each widens nothing, so the rest is a count); every folder to add is listed. */
const REFUSED_SHOWN = 10;

export interface FoldersBox {
  type: 'question' | 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
}

/**
 * The one native dialog of "Add folders…" (main.ts shows it): every folder to add and every refused one with
 * why; [Add read-only] [Add and allow changes] [Cancel] (Cancel the default) and "Also code and config files"
 * (only with allow changes). Writes off in this build: [Add read-only] [Cancel]. Nothing to add → a notice
 * with the reasons and only "OK".
 */
export function foldersConfirm(q: FolderBatch, writes = q.writes !== false): FoldersBox {
  const n = q.add.length;
  const refused = q.refused.slice(0, REFUSED_SHOWN).map((r) => `• ${r.path}: ${r.why}`);
  if (q.refused.length > REFUSED_SHOWN) refused.push(`…and ${q.refused.length - REFUSED_SHOWN} more`);
  if (!n) return { type: 'warning', title: 'No folder added', message: 'None of these folders can be shared', detail: refused.join('\n'), buttons: ['OK'], defaultId: 0, cancelId: 0 };
  const parts = [`${n === 1 ? 'Folder' : 'Folders'}:\n${q.add.map((f) => `• ${f.alias}: ${f.path}`).join('\n')}`];
  if (refused.length) parts.push(`Not added:\n${refused.join('\n')}`);
  parts.push(
    writes
      ? 'Read-only: AI apps you set up can search and read them. Allow changes: they can also edit, move and delete notes there (to the Recycle Bin; each change can be reverted). Hidden files, key files and excluded folders stay invisible either way.'
      : 'AI apps you set up can search and read them, not change them. Hidden files, key files and excluded folders stay invisible.',
  );
  const it = n === 1 ? `“${q.add[0].alias}”` : `these ${n} folders`;
  return {
    type: 'question',
    title: n === 1 ? 'Share this folder?' : `Share ${n} folders?`,
    message: `Share ${it} with MCP clients?`,
    detail: parts.join('\n\n'),
    buttons: writes ? ['Add read-only', 'Add and allow changes', 'Cancel'] : ['Add read-only', 'Cancel'],
    defaultId: writes ? 2 : 1,
    cancelId: writes ? 2 : 1,
    ...(writes ? { checkboxLabel: 'Also code and config files', checkboxChecked: false } : {}),
  };
}

/** The dialog's answer → the choice (null = Cancel or the notice). The checkbox counts only with allow changes. */
export function folderChoice(box: FoldersBox, r: { response: number; checkboxChecked?: boolean }): FolderChoice | null {
  const label = box.buttons[r.response];
  if (label === 'Add read-only') return { mode: 'read', allowCode: false };
  if (label === 'Add and allow changes') return { mode: 'write', allowCode: r.checkboxChecked === true };
  return null;
}

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
      sessions: this.sessions.map((x) => ({ ...x })),
    };
  }

  // ---- running servers ("MCP active"): their live files -------------------------------------------------

  private sessions: McpSession[] = [];
  private sessionsKey = '';

  /** Reads mcp-live/: one session per running server; files of processes that are gone are removed. */
  async scanSessions(): Promise<McpSession[]> {
    const dir = path.join(this.deps.configDir, MCP_LIVE_DIR);
    const now = this.deps.now?.() ?? Date.now();
    const alive = this.deps.isAlive ?? pidAlive;
    const out: McpSession[] = [];
    let seen = 0;
    for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      const file = path.join(dir, name);
      if (name.endsWith('.tmp')) {
        // A writer's temp file left behind (it died between write and rename): old ones go.
        const st = await fs.promises.lstat(file).catch(() => null);
        if (st && now - st.mtimeMs > 60_000) await fs.promises.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (!/^\d+-[a-f0-9]{8}\.json$/.test(name)) continue;
      if (++seen > MAX_LIVE_FILES) break;
      const live = parseLiveFile(await readLiveFile(file));
      if (!live || String(live.pid) !== name.split('-')[0]) continue; // half-written / foreign: left alone
      if (!alive(live.pid)) {
        await fs.promises.rm(file, { force: true }).catch(() => {}); // crashed: its file is ours to clean up
        continue;
      }
      out.push({ client: live.client, started: live.started, lastCall: live.lastCall, idle: now - (live.lastCall ?? live.started) > MCP_IDLE_MS });
    }
    out.sort((a, b) => a.started - b.started);
    return out;
  }

  private scanBusy = false;
  private scanAgain = false;

  /** Rescans; when the list changed, the page hears it (onChange, the usual status event). One scan at a time:
   *  a kick during a scan asks for one more afterwards instead of piling up reads. */
  async refreshSessions(): Promise<void> {
    if (this.scanBusy) {
      this.scanAgain = true;
      return;
    }
    this.scanBusy = true;
    try {
      do {
        this.scanAgain = false;
        const next = await this.scanSessions();
        const key = JSON.stringify(next);
        if (key === this.sessionsKey) continue;
        this.sessionsKey = key;
        this.sessions = next;
        this.deps.onChange(await this.status());
      } while (this.scanAgain);
    } finally {
      this.scanBusy = false;
    }
  }

  /**
   * Watches mcp-live/ (fs.watch, plus a slow poll: a crashed process changes no file, and idle flips with
   * time). Main side only; the first scan also cleans up after crashes. Returns the stop function.
   */
  watchSessions(pollMs = 15_000): () => void {
    const dir = path.join(this.deps.configDir, MCP_LIVE_DIR);
    let timer: NodeJS.Timeout | null = null;
    let soon: NodeJS.Timeout | null = null;
    let watcher: fs.FSWatcher | null = null;
    const kick = () => {
      if (soon) return;
      soon = setTimeout(() => {
        soon = null;
        void this.refreshSessions().catch(() => {});
      }, 200); // a burst of writes → one scan
      soon.unref?.();
    };
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      watcher = fs.watch(dir, kick);
      watcher.on('error', () => {});
    } catch {}
    timer = setInterval(kick, pollMs);
    timer.unref?.();
    kick();
    return () => {
      if (timer) clearInterval(timer);
      if (soon) clearTimeout(soon);
      watcher?.close();
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

  /** Opens the native folder dialog (several at once), then ONE native confirm for that step (also for one
   *  folder): what is added and what is not (and why), read-only or with changes allowed (and code files). The
   *  choice applies to every folder of the step; nothing else asks. One folder that is refused: the error, as
   *  before. "Cancel" adds nothing; with nothing left to add it only shows the reasons. */
  addFolder(): Promise<McpStatus> {
    return this.serial(async () => {
      const cfg = await this.read();
      if (cfg.folders.length >= MAX_MCP_FOLDERS) throw new McpError('ELIMIT', `At most ${MAX_MCP_FOLDERS} folders can be shared`);
      const picked = await this.deps.pickFolders();
      if (!picked.length) return this.statusOf(cfg);
      const { add, refused } = await this.sortOut(cfg, picked);
      if (picked.length === 1 && refused.length) throw new McpError(refused[0].code, refused[0].why);
      const choice = await this.deps.confirmFolders({ add, refused: refused.map(({ path, why }) => ({ path, why })), writes: this.writes });
      if (!choice || !add.length) return this.statusOf(cfg);
      const mode: 'read' | 'write' = this.writes && choice.mode === 'write' ? 'write' : 'read';
      const allowCode = mode === 'write' && choice.allowCode;
      const added = this.deps.now?.() ?? Date.now();
      return this.write({ ...cfg, folders: [...cfg.folders, ...add.map((f) => ({ id: this.deps.randomId(), alias: f.alias, path: f.path, mode, ...(allowCode ? { allowCode: true } : {}), added }))] });
    });
  }

  /** The grant checks for each picked folder, sorted by path so aliases do not depend on the click order
   *  ("notes", "notes-2"…). Already shared, picked twice (through a link) or over the limit = refused too. */
  private async sortOut(cfg: McpConfig, picked: string[]): Promise<{ add: FolderBatch['add']; refused: Refusal[] }> {
    const key = (a: string) => (this.foldCase ? a.toLowerCase() : a);
    const order = (a: string, b: string) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);
    const configDir = await this.deps.realpath(this.deps.configDir).catch(() => this.deps.configDir);
    const shared = new Map(cfg.folders.map((f) => [key(f.path), `Already shared as “${f.alias}”`]));
    const aliases = cfg.folders.map((f) => f.alias);
    const add: FolderBatch['add'] = [];
    const refused: Refusal[] = [];
    for (const p of [...new Set(picked)].sort(order)) {
      const real = (await this.deps.isDirectory(p)) ? await this.deps.realpath(p).catch(() => null) : null;
      if (!real) {
        refused.push({ path: p, code: 'ENOENT', why: 'Not a folder' });
        continue;
      }
      const why = folderProblem(real, { configDir, homedir: this.deps.homedir, foldCase: this.foldCase });
      const dup = shared.get(key(real));
      if (why || dup) {
        refused.push({ path: p, code: why ? 'EACCES' : 'EEXIST', why: why ?? dup! });
        continue;
      }
      if (cfg.folders.length + add.length >= MAX_MCP_FOLDERS) {
        refused.push({ path: p, code: 'ELIMIT', why: `At most ${MAX_MCP_FOLDERS} folders can be shared` });
        continue;
      }
      const alias = aliasFor(path.basename(real) || 'folder', aliases);
      aliases.push(alias);
      shared.set(key(real), `The same folder as “${alias}”`);
      add.push({ alias, path: real });
    }
    return { add, refused };
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
