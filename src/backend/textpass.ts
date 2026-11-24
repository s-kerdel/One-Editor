// One sequential pass over the workspace's indexable text files, read in parallel ahead of the
// consumer (ReadPool) and cut into pages in path order. A full pass also streams a fresh persistent
// cache; with a loaded cache, unchanged files are only stat'ed, never opened.
import type { FileData } from '../shared/api';
import type { ReadPool, ReadResult } from './readpool';
import { CacheWriter, TextCache, encodeRecord } from './indexcache';

/** Files per worker message: amortises messaging without making any one batch slow. */
const BATCH = 24;
/** Decoded text buffered ahead of the consumer (bounds memory while pages are in transit). */
const READ_AHEAD_CHARS = 8 << 20;
/** A page waits at most this long to fill up once it holds something. */
const PAGE_WAIT_MS = 60;

/**
 * A "no content" entry: a file that exists but cannot be content-indexed (binary/NUL, oversized, or
 * a name that is not text). Path metadata only — its content is never read. `binary: true` is the
 * existing FileData idiom for "content empty, do not index/save its text", so MCP content search and
 * the knowledge index skip it; the search engine still finds it by name / path / ext.
 */
export const nameOnlyFile = (path: string, mtime: number, size?: number): FileData => {
  const f: FileData = { path, content: '', mtime, eol: 'lf', binary: true };
  if (size !== undefined) f.size = size;
  return f;
};

export interface PassHost {
  abs(rel: string): string;
  /** Bytes → indexable text (null: binary); records the file's stamp in the workspace index. */
  decode(rel: string, bytes: Uint8Array, mtime: number, size: number): FileData | null;
  /** A cache hit: records the stamp, returns the cached text (null: remembered as not indexable). */
  fromCache(rel: string, mtime: number, size: number, cache: TextCache): FileData | null;
}

type Slot = { file: FileData | null; record?: Buffer; changed: boolean; stamp?: [path: string, mtime: number, size: number]; nameOnly?: boolean } | undefined;

export class TextPass {
  /** Next list index handed to the pool / taken by the consumer. */
  private issued: number;
  head: number;
  private slots = new Map<number, Slot>();
  private buffered = 0;
  private inflight = 0;
  private wake: (() => void) | null = null;
  private closed = false;
  private failed: unknown = null;
  /** Any file differs from the loaded cache (or the cache lacked files) → write a new one. */
  private dirty = false;
  private written = 0;
  /** Unchanged records seen before the first change (views into the old cache, no copies). */
  private held: Buffer[] = [];
  private writer: CacheWriter | null = null;
  lastUsed = Date.now();
  /** Files opened and read vs. served from the cache after a stat (tests, diagnostics). */
  readonly stats = { read: 0, cached: 0 };
  /** Bumped by retarget(): batches read for an older list are dropped. */
  private epoch = 0;

  constructor(
    public list: readonly string[],
    start: number,
    private readonly host: PassHost,
    private readonly pool: ReadPool,
    private readonly maxBytes: number,
    private readonly cache: TextCache | null,
    /** Opens the next cache file; only called once something changed (a warm start writes nothing). */
    private makeWriter: (() => CacheWriter | null) | null,
    private readonly threads: number,
  ) {
    this.issued = start;
    this.head = start;
  }

  /** The cursor a consumer continuing this pass presents: the last path examined. */
  get cursor(): string | null {
    return this.head === 0 ? null : this.list[this.head - 1];
  }

  get finished() {
    return this.head >= this.list.length;
  }

  private pump() {
    while (!this.closed && this.issued < this.list.length && this.inflight < this.threads * 2 && this.buffered < READ_AHEAD_CHARS) {
      const from = this.issued;
      const rels = this.list.slice(from, from + BATCH);
      this.issued += rels.length;
      this.inflight++;
      const epoch = this.epoch;
      const jobs = rels.map((rel) => {
        const st = this.cache?.stamp(rel);
        return st ? { abs: this.host.abs(rel), mtime: st.mtime, size: st.size } : { abs: this.host.abs(rel) };
      });
      this.pool.read(jobs, this.maxBytes).then(
        (out) => {
          this.inflight--;
          if (this.closed || epoch !== this.epoch) return this.pump();
          out.forEach((r, i) => this.accept(from + i, rels[i], r));
          this.pump();
          this.wake?.();
        },
        (err) => {
          this.inflight--;
          this.failed = err;
          this.wake?.();
        },
      );
    }
  }

  private accept(i: number, rel: string, r: ReadResult) {
    let file: FileData | null = null;
    let record: Buffer | undefined;
    // Only fresh reads change the cache; unreadable / oversized files are never cached at all.
    let changed = r.kind === 'data';
    try {
      if (r.kind === 'hit' && this.cache && r.size <= this.maxBytes) {
        file = this.host.fromCache(rel, r.mtime, r.size, this.cache);
        record = this.cache.rawRecord(rel);
        this.stats.cached++;
      } else if (r.kind === 'data') {
        this.stats.read++;
        file = this.host.decode(rel, r.bytes, r.mtime, r.size);
        record = this.makeWriter ? encodeRecord(rel, file ? { mtime: r.mtime, size: r.size, content: file.content, eol: file.eol, bom: file.bom, encoding: file.encoding } : { mtime: r.mtime, size: r.size, content: null, eol: 'lf' }) : undefined;
      }
    } catch {
      file = null; // a path Win32 cannot open etc.: skipped like an unreadable file
    }
    this.slots.set(i, { file, record, changed, stamp: r.kind === 'error' ? undefined : [rel, r.mtime, r.size], nameOnly: file === null && r.kind !== 'error' });
    if (file) this.buffered += file.content.length;
  }

  /**
   * The set of paths changed mid-pass (files created / deleted): continue after the cursor on the new
   * list, so a file appearing later in path order is still read. Read-ahead is redone; the cache
   * being written carries on.
   */
  retarget(list: readonly string[]) {
    if (list === this.list) return;
    const c = this.cursor;
    this.epoch++;
    this.slots.clear();
    this.buffered = 0;
    this.list = list;
    this.head = this.issued = c === null ? 0 : upperBound(list, c);
  }

  /** Next page (≥ 1 file examined when any remain): ~`want` chars, in path order. */
  async page(want: number, stamps?: Array<[string, number, number]>): Promise<FileData[]> {
    this.lastUsed = Date.now();
    const files: FileData[] = [];
    let bytes = 0;
    const t0 = Date.now();
    this.pump();
    while (this.head < this.list.length && bytes < want) {
      if (this.failed) throw this.failed;
      if (!this.slots.has(this.head)) {
        // Something to return already: don't hold the page back for long.
        if (files.length && Date.now() - t0 > PAGE_WAIT_MS) break;
        await new Promise<void>((r) => {
          this.wake = r;
          if (files.length) setTimeout(r, PAGE_WAIT_MS);
        });
        this.wake = null;
        continue;
      }
      const s = this.slots.get(this.head)!;
      this.slots.delete(this.head);
      this.head++;
      if (s?.stamp) stamps?.push(s.stamp);
      if (s?.changed && !this.dirty) this.startWriting();
      if (s?.record && this.makeWriter) {
        if (this.writer) this.writer.add(s.record);
        else if (!this.dirty) this.held.push(s.record);
        this.written++;
      }
      if (s?.file) {
        files.push(s.file);
        bytes += s.file.content.length;
        this.buffered -= s.file.content.length;
      } else if (s?.nameOnly && s.stamp) {
        // A text-named file that decoded to nothing (binary / NUL) or was oversized: a no-content hit.
        files.push(nameOnlyFile(s.stamp[0], s.stamp[1], s.stamp[2]));
      }
      this.pump();
    }
    if (this.finished) this.written$ = this.finish();
    return files;
  }

  private startWriting() {
    this.dirty = true;
    try {
      this.writer = this.makeWriter?.() ?? null;
    } catch {
      this.writer = null;
    }
    for (const r of this.held) this.writer?.add(r);
    this.held = [];
  }

  /** Resolves once a finished pass has written (or decided not to write) its cache. */
  written$: Promise<void> = Promise.resolve();

  private async finish() {
    if (!this.makeWriter) return;
    // Files deleted since the cache was written also make it stale.
    if (!this.dirty && (!this.cache || this.written !== this.cache.size)) this.startWriting();
    const w = this.writer;
    this.writer = null;
    this.makeWriter = null;
    this.held = [];
    await w?.commit();
  }

  close() {
    this.closed = true;
    this.slots.clear();
    this.held = [];
    this.makeWriter = null;
    this.writer?.abort();
    this.writer = null;
    this.wake?.();
  }
}

/** Index of the first entry > key in a sorted list. */
export function upperBound(list: readonly string[], key: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] <= key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
