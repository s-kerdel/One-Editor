// Byte <-> text conversion that round-trips exactly: BOMs, UTF-16 (PowerShell 5 default) and legacy
// Windows-1252 files are decoded for editing and re-encoded the same way on save.
import type { Eol, TextEncoding } from '../shared/api';

export interface Decoded {
  text: string; // raw text, EOL untouched, BOM stripped
  encoding: TextEncoding;
  bom: boolean;
  binary: boolean;
}

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
const cp1252 = new TextDecoder('windows-1252');

export function decode(buf: Uint8Array): Decoded {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: Buffer.from(buf.subarray(3)).toString('utf8'), encoding: 'utf8', bom: true, binary: false };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: Buffer.from(buf.subarray(2)).toString('utf16le'), encoding: 'utf16le', bom: true, binary: false };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: swap16(buf.subarray(2)).toString('utf16le'), encoding: 'utf16be', bom: true, binary: false };
  // NUL bytes in the first 8 KB → binary (images, sqlite, …). Never offer those for editing.
  const probe = buf.subarray(0, 8192);
  if (probe.includes(0)) return { text: '', encoding: 'utf8', bom: false, binary: true };
  try {
    return { text: utf8Strict.decode(buf), encoding: 'utf8', bom: false, binary: false };
  } catch {
    // Not valid UTF-8: almost always a legacy ANSI file on Windows.
    return { text: cp1252.decode(buf), encoding: 'windows-1252', bom: false, binary: false };
  }
}

export function encode(text: string, encoding: TextEncoding = 'utf8', bom = false): Buffer {
  switch (encoding) {
    case 'utf16le':
      return Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
    case 'utf16be':
      return Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), swap16(Buffer.from(text, 'utf16le'))]);
    case 'windows-1252':
      return encodeCp1252(text);
    default:
      return Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
  }
}

/** Sniffs only the encoding/BOM of an existing file from its first bytes. */
export function sniff(head: Uint8Array): { encoding: TextEncoding; bom: boolean } {
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return { encoding: 'utf8', bom: true };
  if (head[0] === 0xff && head[1] === 0xfe) return { encoding: 'utf16le', bom: true };
  if (head[0] === 0xfe && head[1] === 0xff) return { encoding: 'utf16be', bom: true };
  return { encoding: 'utf8', bom: false };
}

export function detectEol(text: string): Eol {
  const crlf = text.indexOf('\r\n');
  if (crlf === -1) return 'lf';
  const lf = text.indexOf('\n');
  return lf === crlf + 1 ? 'crlf' : 'lf';
}

export function toLf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

export function withEol(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
}

function swap16(buf: Uint8Array): Buffer {
  const out = Buffer.from(buf.subarray(0, buf.length - (buf.length % 2)));
  out.swap16();
  return out;
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F; map those back explicitly.
const CP1252_HIGH: Record<number, number> = {};
for (let b = 0x80; b <= 0x9f; b++) {
  const ch = cp1252.decode(new Uint8Array([b])).charCodeAt(0);
  if (ch !== 0xfffd) CP1252_HIGH[ch] = b;
}

function encodeCp1252(text: string): Buffer {
  const out = Buffer.alloc(text.length);
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[n++] = c;
    else if (CP1252_HIGH[c] !== undefined) out[n++] = CP1252_HIGH[c];
    else if (c >= 0x80 && c <= 0x9f) out[n++] = c; // undefined slots decoded as C1 controls
    else out[n++] = 0x3f; // '?': not representable (user typed e.g. an emoji into an ANSI file)
  }
  return out.subarray(0, n);
}
