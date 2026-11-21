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
/** Larger previous contents are not kept (a deleted big file is still in the Recycle Bin). */
export const JOURNAL_MAX_ENTRY = 16 * 1024 * 1024;
export const GROUP_RE = JOURNAL_GROUP_RE;

export type JournalOp = 'write' | 'create' | 'append' | 'patch' | 'replace' | 'relink' | 'move' | 'mkdir' | 'delete';
const OPS: readonly JournalOp[] = ['write', 'create', 'append', 'patch', 'replace', 'relink', 'move', 'mkdir', 'delete'];
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

  constructor(
    readonly dir: string,
    private readonly o: { enabled?: () => boolean; maxAgeMs?: () => number; maxBytes?: number; now?: () => number } = {},
  ) {}

  /** Off (Settings → MCP server): writes keep no undo copy and get no Revert. */
  get enabled(): boolean {
    return this.o.enabled?.() ?? true;
  }

  newGroup(): string {
    return `${(this.o.now?.() ?? Date.now()).toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  async add(group: string, e: Omit<JournalEntry, 'v' | 'seq' | 't' | 'bytes'>, prev: Buffer | null): Promise<void> {
    if (!this.enabled) return;
    const seq = this.seqs.get(group) ?? 0;
    this.seqs.set(group, seq + 1);
    const dir = path.join(this.dir, group);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const keep = !!prev && prev.length <= JOURNAL_MAX_ENTRY;
    if (keep) await fsp.writeFile(path.join(dir, `${seq}.bin`), prev!, { flag: 'wx', mode: 0o600 });
    const entry: JournalEntry = { v: 1, seq, t: this.o.now?.() ?? Date.now(), ...e, bytes: keep };
    await fsp.writeFile(path.join(dir, `${seq}.json`), JSON.stringify(entry), { flag: 'wx', mode: 0o600 });
    await this.prune().catch(() => {});
  }

  /** Drops groups past the age cap, then the oldest while the total is over the size cap (at most once a minute). */
  async prune(force = false): Promise<void> {
    const now = this.o.now?.() ?? Date.now();
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
      const old = now - g.t > (this.o.maxAgeMs?.() ?? JOURNAL_MAX_AGE_MS);
      if (!old && total <= (this.o.maxBytes ?? JOURNAL_MAX_BYTES)) break;
      await fsp.rm(path.join(this.dir, g.name), { recursive: true, force: true });
      total -= g.bytes;
    }
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

const changed = (p: string) => new ToolError('EXTERNAL_CHANGE', `${p} changed after the MCP change. Nothing was reverted.`);
const same = (st: { mtimeMs: number; size: number } | null, s: Stamp) => !!st && Math.abs(st.mtimeMs - s.mtime) <= 1 && st.size === s.size;

/**
 * Undoes a group, newest change first, all or nothing: every precondition is checked before anything is
 * written, and each step checks again at commit time (the folder's write guard). Paths go through the
 * folder's resolver like any MCP write. Returns how many changes were undone.
 */
export async function revertGroup(folder: Folder, dir: string, group: string, trash: (abs: string) => Promise<void>): Promise<number> {
  const { entries, reverted } = await readGroup(dir, group);
  if (reverted) throw new ToolError('EALREADY', 'Already reverted');
  const gdir = path.join(dir, group);
  const prev = async (e: JournalEntry) => {
    if (!e.bytes) throw new ToolError('ENODATA', `The old content of ${e.path} was not kept (too large): restore it from the Recycle Bin`);
    return fsp.readFile(path.join(gdir, `${e.seq}.bin`));
  };
  const steps = [...entries].reverse();
  // What each path must be now: only the newest change of a path speaks for it (older ones are covered).
  const seen = new Set<string>();
  for (const e of steps) {
    const at = e.op === 'move' ? e.to! : e.path;
    if (CONTENT_OPS.includes(e.op) || e.op === 'delete') await prev(e); // fail early, before any write
    if (e.op === 'move') {
      await folder.resolveTarget(e.path, { kind: 'any', exists: 'mustNot' }).catch(() => Promise.reject(changed(e.path)));
    }
    if (seen.has(at)) continue;
    seen.add(at);
    if (e.op === 'delete') {
      await folder.resolveTarget(at, { kind: 'file', exists: 'mustNot' }).catch(() => Promise.reject(changed(at)));
      continue;
    }
    const t = await folder.resolveTarget(at, { kind: e.dir || e.op === 'mkdir' ? 'dir' : 'any', exists: 'must' }).catch(() => Promise.reject(changed(at)));
    if (e.after && !same(t.st, e.after)) throw changed(at);
    if (e.op === 'mkdir' && (await fsp.readdir(t.abs)).length) throw changed(at);
  }
  // Apply. `state`: what a path is after an earlier step of this revert (the next step's precondition).
  const ws = await folder.workspace();
  const state = new Map<string, Stamp | null>();
  const expectOf = (p: string, journaled: Stamp | null) => (state.has(p) ? state.get(p)! : journaled);
  let n = 0;
  for (const e of steps) {
    if (CONTENT_OPS.includes(e.op)) {
      const t = await folder.resolveTarget(e.path, { kind: 'any', exists: 'must' });
      const bytes = await prev(e);
      const ex = expectOf(e.path, e.after);
      const r = await ws.writeBinary(t.key, bytes, folder.guard(ex ? { expect: ex } : {}));
      state.set(e.path, { mtime: r.mtime, size: bytes.length });
    } else if (e.op === 'create') {
      const t = await folder.resolveTarget(e.path, { kind: 'any', exists: 'must' });
      const ex = expectOf(e.path, e.after);
      await ws.remove(t.key, trash, folder.guard(ex ? { expect: ex } : {}));
      state.set(e.path, null);
    } else if (e.op === 'delete') {
      const t = await folder.resolveTarget(e.path, { kind: 'file', exists: 'mustNot' });
      const bytes = await prev(e);
      const r = await ws.writeBinary(t.key, bytes, folder.guard({ expect: 'absent' }));
      state.set(e.path, { mtime: r.mtime, size: bytes.length });
    } else if (e.op === 'move') {
      const from = await folder.resolveTarget(e.to!, { kind: 'any', exists: 'must' });
      const to = await folder.resolveTarget(e.path, { kind: 'any', exists: 'mustNot' });
      const ex = e.dir ? null : expectOf(e.to!, e.after);
      await ws.rename(from.key, to.key, folder.guard(ex ? { expect: ex } : {}));
      const st = await fsp.stat(to.abs).catch(() => null);
      state.set(e.path, st && !e.dir ? { mtime: st.mtimeMs, size: st.size } : null);
      state.set(e.to!, null);
    } else if (e.op === 'mkdir') {
      const t = await folder.resolveTarget(e.path, { kind: 'dir', exists: 'must' });
      await ws.remove(t.key, undefined, folder.guard({ expect: 'emptyDir' }));
    }
    n++;
  }
  await fsp.writeFile(path.join(gdir, 'reverted'), String(Date.now()), { flag: 'wx' }).catch(() => {});
  return n;
}
