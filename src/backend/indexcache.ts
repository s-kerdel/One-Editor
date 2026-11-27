// Persistent cache of decoded workspace text for the indexers, kept in the app's config folder
// (never inside the user's folder). Keyed per file by path + mtime + size: a warm launch stats
// files instead of opening them (no antivirus scan per file on Windows) and reads only what changed.
//
// Format:  MAGIC | records… | END | u32 crc32(everything before). Record: u16 pathLen, path,
// f64 mtime, f64 size, u8 flags, u8 encoding, u32 contentLen, content (UTF-8, LF-normalised).
// Uncompressed on purpose: inflating 26 MB cost ~250 ms before the first page; a CRC check is ~10 ms.
// Truncated / corrupt / old-version files are ignored (full index).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { Eol, TextEncoding } from '../shared/api';

/** Bump when decoding / normalisation changes (old caches are then ignored). */
const MAGIC = Buffer.from('SECIDX\u0003\n', 'latin1');
const END = 0xffff;
const F_CRLF = 1;
const F_BOM = 2;
/** Not indexable (binary, NUL bytes): remembered so a warm start does not read it again. */
const F_SKIP = 4;
const ENCODINGS: TextEncoding[] = ['utf8', 'utf16le', 'utf16be', 'windows-1252'];
/** All workspaces together; least recently used caches go first. */
export const CACHE_BUDGET_BYTES = 200 * 1024 * 1024;

export interface CachedText {
  mtime: number;
  size: number;
  /** null: remembered as not indexable. */
  content: string | null;
  eol: Eol;
  bom?: boolean;
  encoding?: TextEncoding;
}

interface Slot {
  mtime: number;
  size: number;
  flags: number;
  enc: number;
  /** Record bytes in the inflated buffer (copied verbatim into the next cache). */
  start: number;
  end: number;
  contentStart: number;
}

/** `foldCase`: the folder's own case rule (Workspace.foldsCase). Folding roots keep the name they always had; on a
 *  case-sensitive disk "Proj" and "proj" are two folders and get two caches. */
export const cacheFileFor = (dir: string, root: string, foldCase = true) => path.join(dir, `${crypto.createHash('sha1').update(foldCase ? root.toLowerCase() : root).digest('hex').slice(0, 20)}.bin`);

/** A loaded cache: lookups decode lazily from one buffer. */
export class TextCache {
  private constructor(
    private readonly buf: Buffer,
    private readonly slots: Map<string, Slot>,
  ) {}

  static empty(): TextCache {
    return new TextCache(Buffer.alloc(0), new Map());
  }

  get size() {
    return this.slots.size;
  }

  /** Reads + verifies a cache file; any problem → empty cache (full index). */
  static async load(file: string): Promise<TextCache> {
    try {
      // Sync on purpose: this runs on the indexer's own thread, and async fs would queue behind (or
      // in front of) the user's file opens in the process-wide libuv threadpool.
      const raw = fs.readFileSync(file);
      if (raw.length < MAGIC.length + 6) throw new Error('short');
      const body = raw.subarray(0, raw.length - 4);
      if (zlib.crc32(body) !== raw.readUInt32LE(raw.length - 4)) throw new Error('checksum');
      const c = TextCache.parse(body);
      // LRU across workspaces: "last used" = mtime.
      const now = new Date();
      try {
        fs.utimesSync(file, now, now);
      } catch {}
      return c;
    } catch {
      return TextCache.empty();
    }
  }

  static parse(buf: Buffer): TextCache {
    if (buf.length < MAGIC.length || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad magic');
    const slots = new Map<string, Slot>();
    let o = MAGIC.length;
    for (;;) {
      if (o + 2 > buf.length) throw new Error('truncated');
      const pl = buf.readUInt16LE(o);
      if (pl === END) break;
      const start = o;
      o += 2;
      const p = buf.toString('utf8', o, o + pl);
      o += pl;
      const mtime = buf.readDoubleLE(o);
      const size = buf.readDoubleLE(o + 8);
      const flags = buf[o + 16];
      const enc = buf[o + 17];
      const cl = buf.readUInt32LE(o + 18);
      o += 22;
      if (o + cl > buf.length) throw new Error('truncated');
      slots.set(p, { mtime, size, flags, enc, start, end: o + cl, contentStart: o });
      o += cl;
    }
    return new TextCache(buf, slots);
  }

  /** mtime/size of a cached file (what the reader verifies with a stat). */
  stamp(p: string): { mtime: number; size: number } | undefined {
    const s = this.slots.get(p);
    return s && { mtime: s.mtime, size: s.size };
  }

  get(p: string): CachedText | undefined {
    const s = this.slots.get(p);
    if (!s) return undefined;
    const out: CachedText = {
      mtime: s.mtime,
      size: s.size,
      content: s.flags & F_SKIP ? null : this.buf.toString('utf8', s.contentStart, s.end),
      eol: s.flags & F_CRLF ? 'crlf' : 'lf',
    };
    if (s.flags & F_BOM) out.bom = true;
    const enc = ENCODINGS[s.enc];
    if (enc && enc !== 'utf8') out.encoding = enc;
    return out;
  }

  /** The cached text as its UTF-8 bytes (a view: no decode / re-encode when forwarding it). */
  getBytes(p: string): Uint8Array | undefined {
    const s = this.slots.get(p);
    return s && !(s.flags & F_SKIP) ? this.buf.subarray(s.contentStart, s.end) : undefined;
  }

  /** The record's bytes, for copying an unchanged entry into the next cache without re-encoding. */
  rawRecord(p: string): Buffer | undefined {
    const s = this.slots.get(p);
    return s && this.buf.subarray(s.start, s.end);
  }

  paths(): IterableIterator<string> {
    return this.slots.keys();
  }
}

export function encodeRecord(p: string, t: CachedText): Buffer {
  const pb = Buffer.from(p, 'utf8');
  if (pb.length >= END) return Buffer.alloc(0); // absurd path: just not cached
  const cb = t.content === null ? Buffer.alloc(0) : Buffer.from(t.content, 'utf8');
  const head = Buffer.alloc(2 + pb.length + 22);
  head.writeUInt16LE(pb.length, 0);
  pb.copy(head, 2);
  let o = 2 + pb.length;
  head.writeDoubleLE(t.mtime, o);
  head.writeDoubleLE(t.size, o + 8);
  head[o + 16] = (t.eol === 'crlf' ? F_CRLF : 0) | (t.bom ? F_BOM : 0) | (t.content === null ? F_SKIP : 0);
  head[o + 17] = Math.max(0, ENCODINGS.indexOf(t.encoding ?? 'utf8'));
  head.writeUInt32LE(cb.length, o + 18);
  return Buffer.concat([head, cb]);
}

/**
 * Streams a new cache while a full pass runs (records arrive in path order, buffered ~1 MB at a time).
 * `commit()` atomically replaces the old file; `abort()` drops the temp file. Synchronous writes:
 * the indexer runs on its own thread (see TextCache.load).
 */
export class CacheWriter {
  private crc = 0;
  private fd: number;
  private tmp: string;
  private failed = false;
  private chunks: Buffer[] = [];
  private pending = 0;
  records = 0;

  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    this.fd = fs.openSync(this.tmp, 'w');
    this.write(MAGIC);
  }

  private write(b: Buffer) {
    this.crc = zlib.crc32(b, this.crc);
    this.chunks.push(b);
    this.pending += b.length;
    if (this.pending >= 1 << 20) this.flush();
  }

  private flush() {
    if (!this.chunks.length || this.failed) return;
    try {
      fs.writeSync(this.fd, this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks));
    } catch {
      this.failed = true;
    }
    this.chunks = [];
    this.pending = 0;
  }

  add(record: Buffer | undefined) {
    if (!record?.length || this.failed) return;
    this.records++;
    this.write(record);
  }

  async commit(): Promise<boolean> {
    const end = Buffer.alloc(2);
    end.writeUInt16LE(END, 0);
    this.write(end);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(this.crc, 0);
    this.chunks.push(crc);
    this.flush();
    try {
      fs.closeSync(this.fd);
    } catch {
      this.failed = true;
    }
    if (!this.failed) {
      // Windows: antivirus may hold the old file for a moment.
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(this.tmp, this.file);
          enforceBudget(path.dirname(this.file));
          return true;
        } catch {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 2 ** attempt);
        }
      }
    }
    try {
      fs.rmSync(this.tmp, { force: true });
    } catch {}
    return false;
  }

  abort() {
    if (this.failed && this.fd < 0) return;
    this.failed = true;
    try {
      fs.closeSync(this.fd);
    } catch {}
    this.fd = -1;
    try {
      fs.rmSync(this.tmp, { force: true });
    } catch {}
  }
}

/** Keeps all caches together under the budget, dropping the least recently used first. */
export function enforceBudget(dir: string, budget = CACHE_BUDGET_BYTES): void {
  try {
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.bin'));
    const files = names.map((n) => {
      try {
        return { p: path.join(dir, n), st: fs.statSync(path.join(dir, n)) };
      } catch {
        return { p: '', st: null };
      }
    });
    const live = files.filter((f) => f.st).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
    let total = 0;
    for (const f of live) {
      total += f.st!.size;
      if (total > budget) fs.rmSync(f.p, { force: true });
    }
  } catch {}
}
