// Files the user opened that are outside the open folder (shared/external.ts). One entry point for them:
// the allow-list. Only `allow()` adds to it, and only main / a trusted caller reaches it with a path the user
// chose (Finder, argv, drop, Open dialog; main vouches those, see main/open-gate.ts). Read / write / watch go
// through the list: an id that was never allowed (a page made it up, `..` segments, another file in the same
// folder) is EACCES. Regular files only; the real path is stored and re-checked on every operation, so a link
// swapped in later is not followed. Not indexed, not watched by the workspace watcher: a small poller here.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileData, FsEvent, WriteOptions } from '../shared/api';
import { EXT_PREFIX, extAbsOf, extIdOf, isExtPath } from '../shared/external';
import { BackendFailure } from './errors';
import { decode, detectEol, encode, toLf, withEol } from './textcodec';
import { atomicWrite } from './workspace';

const MAX_ALLOWED = 200;
const MAX_OPEN_BYTES = 64 * 1024 * 1024;
const POLL_MS = 1200;

interface Entry {
  id: string;
  real: string;
  mtime: number;
  size: number;
  gone: boolean;
}

export interface ExternalOptions {
  win?: boolean;
  foldCase?: boolean;
  pollMs?: number;
}

export class ExternalFiles {
  private entries = new Map<string, Entry>(); // key (resolved, case-folded where the OS folds) → entry; insertion order = age
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly win: boolean;
  private readonly foldCase: boolean;
  private listeners = new Set<(e: FsEvent[]) => void>();

  constructor(private readonly o: ExternalOptions = {}) {
    this.win = o.win ?? process.platform === 'win32';
    this.foldCase = o.foldCase ?? process.platform !== 'linux';
  }

  private key(abs: string) {
    const r = path.resolve(abs);
    return this.foldCase ? r.toLowerCase() : r;
  }

  onEvents(cb: (e: FsEvent[]) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  has(id: string): boolean {
    const abs = extAbsOf(id, this.win);
    return !!abs && this.entries.has(this.key(abs));
  }

  /** The user chose this file: put it on the list. Returns its id (from the real path), or throws. */
  async allow(absPath: unknown): Promise<string> {
    if (typeof absPath !== 'string' || !absPath || absPath.includes('\0') || !path.isAbsolute(absPath)) throw new BackendFailure('EINVAL', 'Not an absolute path');
    const real = await fsp.realpath(absPath).catch(() => null);
    if (!real) throw new BackendFailure('ENOENT', `File not found: ${absPath}`);
    const st = await fsp.stat(real);
    if (!st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${absPath}`);
    const id = extIdOf(real);
    const k = this.key(real);
    this.entries.delete(k);
    this.entries.set(k, { id, real, mtime: st.mtimeMs, size: st.size, gone: false });
    if (this.entries.size > MAX_ALLOWED) this.entries.delete(this.entries.keys().next().value as string);
    this.startPolling();
    return id;
  }

  /** The allowed file's real path, re-checked: still itself (no link swapped in), still a regular file. */
  private async target(id: string, mustExist = true): Promise<Entry> {
    const abs = extAbsOf(id, this.win);
    const e = abs ? this.entries.get(this.key(abs)) : undefined;
    if (!e) throw new BackendFailure('EACCES', 'This file was not opened from outside the folder: open it with “Open file”, drop it on the window or open it from the OS');
    const real = await fsp.realpath(e.real).catch(() => null);
    if (real === null) {
      if (mustExist) throw new BackendFailure('ENOENT', `File not found: ${e.real}`);
      return e;
    }
    if (this.key(real) !== this.key(e.real)) throw new BackendFailure('EACCES', 'The file is now a link to somewhere else');
    return e;
  }

  async read(id: string, opts: { maxBytes?: number } = {}): Promise<FileData> {
    const e = await this.target(id);
    const st = await fsp.stat(e.real);
    if (!st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${e.real}`);
    if (st.size > MAX_OPEN_BYTES) throw new BackendFailure('ETOOBIG', `File is too large to open (${Math.round(st.size / 1048576)} MB)`);
    if (opts.maxBytes !== undefined && st.size > opts.maxBytes) throw new BackendFailure('ETOOBIG', `File is larger than ${opts.maxBytes} bytes`);
    const d = decode(await fsp.readFile(e.real));
    this.note(e, st.mtimeMs, st.size);
    const data: FileData = { path: id, content: toLf(d.text), mtime: st.mtimeMs, eol: detectEol(d.text), size: st.size };
    if (d.bom) data.bom = true;
    if (d.encoding !== 'utf8') data.encoding = d.encoding;
    if (d.binary) data.binary = true;
    return data;
  }

  async write(id: string, content: string, opts: WriteOptions = {}): Promise<{ mtime: number }> {
    const e = await this.target(id, false);
    const st = await fsp.stat(e.real).catch(() => null);
    if (st && !st.isFile()) throw new BackendFailure('EINVAL', `Not a regular file: ${e.real}`);
    if (st && opts.expectedMtime !== undefined && Math.abs(st.mtimeMs - opts.expectedMtime) > 1) throw new BackendFailure('EXTERNAL_CHANGE', `File changed on disk: ${e.real}`);
    if (st && !(st.mode & 0o200)) throw new BackendFailure('EACCES', `File is read-only: ${e.real}`);
    let { eol, bom, encoding } = opts as Pick<WriteOptions, 'eol' | 'bom' | 'encoding'>;
    if (st && (eol === undefined || bom === undefined || encoding === undefined)) {
      const d = decode(await fsp.readFile(e.real));
      eol ??= detectEol(d.text);
      bom ??= d.bom;
      encoding ??= d.encoding;
    }
    await atomicWrite(e.real, encode(withEol(content, eol ?? 'lf'), encoding ?? 'utf8', bom ?? false), st?.mode);
    const now = await fsp.stat(e.real);
    this.note(e, now.mtimeMs, now.size);
    return { mtime: now.mtimeMs };
  }

  private note(e: Entry, mtime: number, size: number) {
    e.mtime = mtime;
    e.size = size;
    e.gone = false;
  }

  // ---- watching: a stat per allowed file; changes of files nobody has open are dropped by the renderer ----
  private startPolling() {
    if (this.timer || !this.listeners.size) return;
    this.timer = setInterval(() => void this.poll(), this.o.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  async poll(): Promise<void> {
    const out: FsEvent[] = [];
    for (const e of [...this.entries.values()]) {
      const st = await fs.promises.stat(e.real).catch(() => null);
      if (!st || !st.isFile()) {
        if (!e.gone) {
          e.gone = true;
          out.push({ type: 'unlink', path: e.id });
        }
      } else if (e.gone || st.mtimeMs !== e.mtime || st.size !== e.size) {
        this.note(e, st.mtimeMs, st.size);
        out.push({ type: 'change', path: e.id, mtime: st.mtimeMs });
      }
    }
    if (out.length) this.listeners.forEach((l) => l(out));
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.entries.clear();
  }
}

export { EXT_PREFIX, isExtPath };
