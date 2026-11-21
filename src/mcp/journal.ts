// Undo history of MCP writes: <app data>/mcp-history/<group>/, one group per tool call (a move plus the
// link rewrites it caused is one group). Each change keeps `<seq>.json` (what changed, and the file's
// mtime + size right after: the precondition of a revert) and `<seq>.bin` (the bytes it replaced).
// Capped by age (setting mcp.journalDays) and total size; switched off (mcp.journal) nothing new is kept.
// Reverting (Settings → MCP server → Recent activity → Revert, in main)
// runs every path through the folder's resolver again and lands only on files still as MCP left them.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { JOURNAL_GROUP_RE } from '../shared/mcp';
import type { Folder, Stamp } from './folders';
import { ToolError } from './protocol';

export const JOURNAL_DIR = 'mcp-history';
export const JOURNAL_MAX_AGE_MS = 30 * 24 * 3600_000;
export const JOURNAL_MAX_BYTES = 100 * 1024 * 1024;
/** Larger previous contents are not kept for edits (a delete of a larger file is refused instead). */
export const JOURNAL_MAX_ENTRY = 16 * 1024 * 1024;
/** Undo copies one server session may add: a client cannot fill the history in one go. */
export const JOURNAL_SESSION_BYTES = 64 * 1024 * 1024;
/** Groups younger than this, and every group of the running session, are never evicted for space. */
export const JOURNAL_KEEP_RECENT_MS = 24 * 3600_000;
export const GROUP_RE = JOURNAL_GROUP_RE;

/** `trash`: a whole folder went to the Recycle Bin (a note only: no copy, never reverted; restore it from the bin). */
export type JournalOp = 'write' | 'create' | 'append' | 'patch' | 'replace' | 'relink' | 'move' | 'mkdir' | 'delete' | 'trash';
const OPS: readonly JournalOp[] = ['write', 'create', 'append', 'patch', 'replace', 'relink', 'move', 'mkdir', 'delete', 'trash'];
/** Ops that replaced the content of a file that existed (revert = put the old bytes back). */
const CONTENT_OPS: readonly JournalOp[] = ['write', 'append', 'patch', 'replace', 'relink'];

export interface JournalEntry {
  v: 1;
  seq: number;
  t: number;
  client: string;
  tool: string;
  /** Real path of the shared folder (a revert only runs while it is still shared). */
  root: string;
  folder: string;
  op: JournalOp;
  path: string;
  /** move: where it went. */
  to?: string;
  dir?: boolean;
  /** The previous bytes are in <seq>.bin. */
  bytes: boolean;
  /** The file right after the change (null: a folder, or gone). */
  after: Stamp | null;
}

export class Journal {
  private seqs = new Map<string, number>();
  private lastPrune = 0;
  /** This session's groups: never evicted while it runs (a client cannot flush the history it just wrote). */
  private readonly mine = new Set<string>();
  private sessionBytes = 0;
  /** Bytes in the history: scanned once, then kept up to date by add() / prune(). */
  private total: number | null = null;

  constructor(
    readonly dir: string,
    private readonly o: { enabled?: () => boolean; maxAgeMs?: () => number; maxBytes?: number; sessionBytes?: number; now?: () => number } = {},
  ) {}

  private get now() {
    return this.o.now?.() ?? Date.now();
  }

  /**
   * Room for an undo copy of `bytes`, asked inside the commit guard before the disk changes: refuses
   * (EQUOTA) rather than evicting a recent or this-session copy. `force`: a delete keeps its copy even
   * while undo copies are off, and is refused when it cannot.
   */
  async reserve(bytes: number, force = false): Promise<void> {
    if (!this.enabled && !force) return;
    if (bytes > JOURNAL_MAX_ENTRY) {
      if (force) throw new ToolError('EQUOTA', `Too large to keep an undo copy (over ${JOURNAL_MAX_ENTRY / 1048576} MB): delete it in One instead`);
      return; // an edit of a huge file: kept without its old bytes (Revert then says so)
    }
    if (this.sessionBytes + bytes > (this.o.sessionBytes ?? JOURNAL_SESSION_BYTES)) throw new ToolError('EQUOTA', 'This session kept as many undo copies as it may. Ask the user to restart the AI app’s connection to continue.');
    const max = this.o.maxBytes ?? JOURNAL_MAX_BYTES;
    if ((await this.totalBytes()) + bytes > max) {
      await this.prune(true, bytes);
      if ((await this.totalBytes()) + bytes > max) throw new ToolError('EQUOTA', 'The undo history is full (recent changes are kept at least 24 hours). Try again later, or ask the user to free space in One.');
    }
    this.sessionBytes += bytes;
  }

  private async totalBytes(): Promise<number> {
    if (this.total !== null) return this.total;
    let n = 0;
    for (const name of (await fsp.readdir(this.dir).catch(() => [] as string[])).filter((x) => GROUP_RE.test(x)))
      for (const f of await fsp.readdir(path.join(this.dir, name)).catch(() => [] as string[])) n += (await fsp.stat(path.join(this.dir, name, f)).catch(() => null))?.size ?? 0;
    return (this.total = n);
  }

  /** Off (Settings → MCP server): writes keep no undo copy and get no Revert. */
  get enabled(): boolean {
    return this.o.enabled?.() ?? true;
  }

  /** A group this process made (full id, or the 8-character undo code answers show); null = not ours. */
  ownGroup(id: string): string | null {
    const want = id.trim().toLowerCase();
    if (!want) return null;
    for (const g of this.mine) if (g === want || (want.length === 8 && g.endsWith(`-${want}`))) return g;
    return null;
  }

  newGroup(): string {
    const g = `${this.now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    this.mine.add(g);
    return g;
  }

  async add(group: string, e: Omit<JournalEntry, 'v' | 'seq' | 't' | 'bytes'>, prev: Buffer | null, o: { force?: boolean } = {}): Promise<void> {
    if (!this.enabled && !o.force) return;
    const seq = this.seqs.get(group) ?? 0;
    this.seqs.set(group, seq + 1);
    const dir = path.join(this.dir, group);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const keep = !!prev && prev.length <= JOURNAL_MAX_ENTRY;
    if (keep) await fsp.writeFile(path.join(dir, `${seq}.bin`), prev!, { flag: 'wx', mode: 0o600 });
    const entry: JournalEntry = { v: 1, seq, t: this.now, ...e, bytes: keep };
    const json = JSON.stringify(entry);
    await fsp.writeFile(path.join(dir, `${seq}.json`), json, { flag: 'wx', mode: 0o600 });
    if (this.total !== null) this.total += json.length + (keep ? prev!.length : 0);
    await this.prune().catch(() => {});
  }

  /**
   * Drops groups past the age cap, then the oldest while the total is over the size cap (at most once a
   * minute). Never a group of this session, never one younger than 24 hours: when only those are left,
   * new writes get EQUOTA (reserve) instead.
   */
  async prune(force = false, need = 0): Promise<void> {
    const now = this.now;
    if (!force && now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    const names = (await fsp.readdir(this.dir).catch(() => [] as string[])).filter((n) => GROUP_RE.test(n));
    const groups: Array<{ name: string; t: number; c: number; bytes: number }> = [];
    for (const name of names) {
      const dir = path.join(this.dir, name);
      let bytes = 0;
      for (const f of await fsp.readdir(dir).catch(() => [] as string[])) bytes += (await fsp.stat(path.join(dir, f)).catch(() => null))?.size ?? 0;
      // Same millisecond: the folder's own creation time decides which is older.
      const c = (await fsp.stat(dir).catch(() => null))?.birthtimeMs ?? 0;
      groups.push({ name, t: parseInt(name.split('-')[0], 36) || 0, c, bytes });
    }
    groups.sort((a, b) => a.t - b.t || a.c - b.c);
    let total = groups.reduce((n, g) => n + g.bytes, 0);
    for (const g of groups) {
      if (this.mine.has(g.name) || now - g.t < JOURNAL_KEEP_RECENT_MS) continue; // protected
      const old = now - g.t > (this.o.maxAgeMs?.() ?? JOURNAL_MAX_AGE_MS);
      if (!old && total + need <= (this.o.maxBytes ?? JOURNAL_MAX_BYTES)) continue;
      await fsp.rm(path.join(this.dir, g.name), { recursive: true, force: true });
      total -= g.bytes;
    }
    this.total = total;
  }
}

const isStamp = (v: unknown): v is Stamp => !!v && typeof v === 'object' && Number.isFinite((v as Stamp).mtime) && Number.isInteger((v as Stamp).size);

/** A group's entries, checked field by field (another process wrote them). Newest change last. */
export async function readGroup(dir: string, group: string): Promise<{ entries: JournalEntry[]; reverted: boolean }> {
  if (!GROUP_RE.test(group)) throw new ToolError('EINVAL', 'Not a history entry');
  const gdir = path.join(dir, group);
  const names = await fsp.readdir(gdir).catch(() => null);
  if (!names) throw new ToolError('ENOENT', 'This change is no longer in the history (it is kept 30 days)');
  const entries: JournalEntry[] = [];
  for (const n of names.filter((x) => /^\d{1,6}\.json$/.test(x))) {
    const e = JSON.parse(await fsp.readFile(path.join(gdir, n), 'utf8')) as Partial<JournalEntry>;
    if (e.v !== 1 || !Number.isInteger(e.seq) || typeof e.root !== 'string' || typeof e.path !== 'string' || !OPS.includes(e.op as JournalOp)) throw new ToolError('EINVAL', 'Damaged history entry');
    if (e.op === 'move' && typeof e.to !== 'string') throw new ToolError('EINVAL', 'Damaged history entry');
    if (e.after !== null && !isStamp(e.after)) throw new ToolError('EINVAL', 'Damaged history entry');
    entries.push(e as JournalEntry);
  }
  if (!entries.length) throw new ToolError('ENOENT', 'Empty history entry');
  if (new Set(entries.map((e) => e.root)).size !== 1) throw new ToolError('EINVAL', 'Damaged history entry');
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, reverted: names.includes('reverted') };
}

const changedSince = (ps: string[]) => new ToolError('EXTERNAL_CHANGE', `Changed since: ${[...ps].sort().slice(0, 10).join(', ')}${ps.length > 10 ? ` +${ps.length - 10} more` : ''}. Nothing was reverted.`);
const same = (st: { mtimeMs: number; size: number } | null, s: Stamp) => !!st && Math.abs(st.mtimeMs - s.mtime) <= 1 && st.size === s.size;

/** What a revert did: files whose content came back, moves undone, created things removed; folders it cannot bring back. */
export interface RevertReport {
  n: number;
  restored: number;
  movedBack: number;
  removed: number;
  /** Folders deleted whole (no copy): to be restored from the Recycle Bin. */
  inBin: string[];
}

/**
 * Undoes a group, newest change first, all or nothing: every precondition is checked before anything is
 * written (every changed path is named), and each step checks again at commit time (the folder's write
 * guard). Paths go through the folder's resolver like any MCP write. Returns how many changes were undone.
 */
export async function revertGroup(folder: Folder, dir: string, group: string, trash: (abs: string) => Promise<void>): Promise<number> {
  return (await revertGroupReport(folder, dir, group, trash)).n;
}

export async function revertGroupReport(folder: Folder, dir: string, group: string, trash: (abs: string) => Promise<void>): Promise<RevertReport> {
  const { entries: all, reverted } = await readGroup(dir, group);
  if (reverted) throw new ToolError('EALREADY', 'Already undone (here or with Revert in One)');
  const inBin = all.filter((e) => e.op === 'trash').map((e) => e.path);
  const entries = all.filter((e) => e.op !== 'trash');
  if (!entries.length) throw new ToolError('ENOTUNDOABLE', `Not undoable here: restore ${inBin.slice(0, 5).join(', ')}${inBin.length > 5 ? ' …' : ''} from the Recycle Bin`);
  const gdir = path.join(dir, group);
  const prev = async (e: JournalEntry) => {
    if (!e.bytes) throw new ToolError('ENODATA', `The old content of ${e.path} was not kept (too large): restore it from the Recycle Bin`);
    return fsp.readFile(path.join(gdir, `${e.seq}.bin`));
  };
  const steps = [...entries].reverse();
  // What each path must be now: only the newest change of a path speaks for it (older ones are covered).
  const seen = new Set<string>();
  const changed: string[] = [];
  const check = async (p: string, fn: () => Promise<unknown>) => {
    if (!(await fn().then(() => true, () => false)) && !changed.includes(p)) changed.push(p);
  };
  for (const e of steps) {
    const at = e.op === 'move' ? e.to! : e.path;
    if (CONTENT_OPS.includes(e.op) || e.op === 'delete') await prev(e); // fail early, before any write
    if (e.op === 'move') await check(e.path, () => folder.resolveTarget(e.path, { kind: 'any', exists: 'mustNot' }));
    if (seen.has(at)) continue;
    seen.add(at);
    if (e.op === 'delete') {
      await check(at, () => folder.resolveTarget(at, { kind: 'file', exists: 'mustNot' }));
      continue;
    }
    await check(at, async () => {
      const t = await folder.resolveTarget(at, { kind: e.dir || e.op === 'mkdir' ? 'dir' : 'any', exists: 'must' });
      if (e.after && !same(t.st, e.after)) throw new Error('changed');
      if (e.op === 'mkdir' && (await fsp.readdir(t.abs)).length) throw new Error('not empty');
    });
  }
  if (changed.length) throw changedSince(changed);
  const report: RevertReport = { n: 0, restored: 0, movedBack: 0, removed: 0, inBin };
  // Apply. `state`: what a path is after an earlier step of this revert (the next step's precondition).
  const ws = await folder.workspace();
  const state = new Map<string, Stamp | null>();
  const expectOf = (p: string, journaled: Stamp | null) => (state.has(p) ? state.get(p)! : journaled);
  for (const e of steps) {
    if (CONTENT_OPS.includes(e.op)) {
      const t = await folder.resolveTarget(e.path, { kind: 'any', exists: 'must' });
      const bytes = await prev(e);
      const ex = expectOf(e.path, e.after);
      const r = await ws.writeBinary(t.key, bytes, folder.guard(ex ? { expect: ex } : {}));
      state.set(e.path, { mtime: r.mtime, size: bytes.length });
      report.restored++;
    } else if (e.op === 'create') {
      const t = await folder.resolveTarget(e.path, { kind: 'any', exists: 'must' });
      const ex = expectOf(e.path, e.after);
      await ws.remove(t.key, trash, folder.guard(ex ? { expect: ex } : {}));
      state.set(e.path, null);
      report.removed++;
    } else if (e.op === 'delete') {
      const t = await folder.resolveTarget(e.path, { kind: 'file', exists: 'mustNot' });
      const bytes = await prev(e);
      const r = await ws.writeBinary(t.key, bytes, folder.guard({ expect: 'absent' }));
      state.set(e.path, { mtime: r.mtime, size: bytes.length });
      report.restored++;
    } else if (e.op === 'move') {
      const from = await folder.resolveTarget(e.to!, { kind: 'any', exists: 'must' });
      const to = await folder.resolveTarget(e.path, { kind: 'any', exists: 'mustNot' });
      const ex = e.dir ? null : expectOf(e.to!, e.after);
      await ws.rename(from.key, to.key, folder.guard(ex ? { expect: ex } : {}));
      const st = await fsp.stat(to.abs).catch(() => null);
      state.set(e.path, st && !e.dir ? { mtime: st.mtimeMs, size: st.size } : null);
      state.set(e.to!, null);
      report.movedBack++;
    } else if (e.op === 'mkdir') {
      const t = await folder.resolveTarget(e.path, { kind: 'dir', exists: 'must' });
      await ws.remove(t.key, undefined, folder.guard({ expect: 'emptyDir' }));
      report.removed++;
    }
    report.n++;
  }
  await fsp.writeFile(path.join(gdir, 'reverted'), String(Date.now()), { flag: 'wx' }).catch(() => {});
  return report;
}
