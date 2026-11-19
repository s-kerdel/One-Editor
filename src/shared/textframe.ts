// Binary page of workspace texts (indexer thread → search worker). JSON-encoding a few MB of text
// (escaping every newline and quote) and parsing it again cost more than reading the files; here
// the header is small JSON and every file's text is its UTF-8 bytes — for most files exactly the
// bytes read from disk or the cache, forwarded without ever becoming a string on the way.
//
//   'SEF1' | u32 header length (LE) | header JSON (UTF-8) | contents, concatenated (UTF-8)
//   header = { ...meta, files: [{ path, mtime, eol, size?, bom?, encoding?, len }] }
import type { FileData } from './api';

const MAGIC = 0x31464553; // 'SEF1' little-endian
const enc = new TextEncoder();

/** A file plus, when known, the UTF-8 bytes of exactly its `content` (skips re-encoding). */
export type FrameFile = FileData & { utf8?: Uint8Array };

export function encodeTextFrame(meta: Record<string, unknown>, files: readonly FrameFile[]): Uint8Array {
  const bodies: Uint8Array[] = [];
  const heads: unknown[] = [];
  let total = 0;
  for (const f of files) {
    const b = f.utf8 ?? enc.encode(f.content);
    bodies.push(b);
    total += b.length;
    const h: Record<string, unknown> = { path: f.path, mtime: f.mtime, eol: f.eol, len: b.length };
    if (f.size !== undefined) h.size = f.size;
    if (f.bom) h.bom = true;
    if (f.encoding) h.encoding = f.encoding;
    heads.push(h);
  }
  const header = enc.encode(JSON.stringify({ ...meta, files: heads }));
  const out = new Uint8Array(8 + header.length + total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, header.length, true);
  out.set(header, 8);
  let o = 8 + header.length;
  for (const b of bodies) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

export function isTextFrame(buf: Uint8Array): boolean {
  return buf.length >= 8 && new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, true) === MAGIC;
}

export function decodeTextFrame<M = Record<string, unknown>>(input: ArrayBuffer | Uint8Array): M & { files: FileData[] } {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!isTextFrame(buf)) throw new Error('not a text frame');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hl = dv.getUint32(4, true);
  const dec = new TextDecoder();
  const head = JSON.parse(dec.decode(buf.subarray(8, 8 + hl))) as M & { files: Array<Omit<FileData, 'content'> & { len: number }> };
  let o = 8 + hl;
  const files: FileData[] = head.files.map(({ len, ...f }) => {
    const content = dec.decode(buf.subarray(o, o + len));
    o += len;
    return { ...f, content } as FileData;
  });
  return { ...head, files };
}
