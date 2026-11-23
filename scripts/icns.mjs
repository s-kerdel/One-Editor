// macOS .icns packing for make-icons.mjs (no dependency, nothing executed: the icon builds off a Mac too).
// The layout is what Apple's `iconutil` writes: the 16 and 32 px slots are 'ic04' / 'ic05' with raw ARGB
// (run-length packed), every larger slot is a PNG. Never store the 16 / 32 px images as PNG in 'icp4' / 'icp5':
// macOS reads those bytes as packed pixels and draws coloured noise (Finder list rows, "Open With" and Dock menus).
//   node scripts/icns.mjs <file.icns>          → list the entries
//   import { buildIcns, readIcns } from './icns.mjs'
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

/** [type, pixels, format] per slot, in file order: 16, 32 pt (ARGB), then 16@2x, 32@2x, 128, 128@2x, 256, 256@2x, 512, 512@2x (PNG). */
export const ICNS_SLOTS = [
  ['ic04', 16, 'argb'],
  ['ic05', 32, 'argb'],
  ['ic11', 32, 'png'],
  ['ic12', 64, 'png'],
  ['ic07', 128, 'png'],
  ['ic13', 256, 'png'],
  ['ic08', 256, 'png'],
  ['ic14', 512, 'png'],
  ['ic09', 512, 'png'],
  ['ic10', 1024, 'png'],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b) => b.length >= 33 && b.subarray(0, 8).equals(PNG_SIGNATURE);

/** PNG → { width, height, rgba } with straight alpha. Only 8-bit RGB / RGBA, not interlaced: what Chromium and macOS write. */
export function decodePng(png) {
  if (!isPng(png)) throw new Error('Not a PNG');
  let width = 0;
  let height = 0;
  let bpp = 0;
  const idat = [];
  for (let o = 8; o + 12 <= png.length; ) {
    const len = png.readUInt32BE(o);
    const type = png.toString('latin1', o + 4, o + 8);
    const data = png.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = data.subarray(8);
      if (depth !== 8 || (colour !== 6 && colour !== 2) || interlace !== 0) throw new Error(`PNG kind not supported: depth ${depth}, colour type ${colour}, interlace ${interlace}`);
      bpp = colour === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  if (!width || !height || raw.length !== (stride + 1) * height) throw new Error('PNG data does not match its size');
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`PNG filter ${filter} unknown`);
    const from = y * (stride + 1) + 1;
    const to = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[to + x - bpp] : 0; // left
      const b = y ? px[to - stride + x] : 0; // up
      const c = x >= bpp && y ? px[to - stride + x - bpp] : 0; // up left
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[to + x] = (raw[from + x] + predicted) & 255;
    }
  }
  if (bpp === 4) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0; i < width * height; i++) px.copy(rgba, i * 4, i * 3, i * 3 + 3);
  return { width, height, rgba };
}

/** ICNS run-length packing: a code 0x80–0xFF repeats the next byte (code − 125) times (3–130), a code 0x00–0x7F copies the next (code + 1) bytes. */
export function packRle(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    let run = 1;
    while (run < 130 && i + run < bytes.length && bytes[i + run] === bytes[i]) run++;
    if (run >= 3) {
      out.push(run + 125, bytes[i]);
      i += run;
      continue;
    }
    const start = i++;
    // Literal bytes up to the next run of three (or 128 of them).
    while (i < bytes.length && i - start < 128 && !(i + 2 < bytes.length && bytes[i] === bytes[i + 1] && bytes[i] === bytes[i + 2])) i++;
    out.push(i - start - 1, ...bytes.subarray(start, i));
  }
  return Buffer.from(out);
}

export function unpackRle(data) {
  const out = [];
  for (let i = 0; i < data.length; ) {
    const code = data[i++];
    const n = code & 0x80 ? code - 125 : code + 1;
    if (i + (code & 0x80 ? 1 : n) > data.length) throw new Error('Packed data ends inside a run');
    if (code & 0x80) out.push(...new Array(n).fill(data[i++]));
    else for (const end = i + n; i < end; i++) out.push(data[i]);
  }
  return Buffer.from(out);
}

/** 'ARGB' + the four planes (alpha, red, green, blue), each packed on its own; alpha stays straight (not premultiplied). */
function argbData({ width, height, rgba }) {
  const n = width * height;
  const plane = (channel) => {
    const p = Buffer.alloc(n);
    for (let i = 0; i < n; i++) p[i] = rgba[i * 4 + channel];
    return packRle(p);
  };
  return Buffer.concat([Buffer.from('ARGB'), plane(3), plane(0), plane(1), plane(2)]);
}

/** PNGs by pixel size ({ 16, 32, 64, 128, 256, 512, 1024 }) → the .icns file. An image of the wrong size for its slot is refused. */
export function buildIcns(pngs) {
  const chunks = ICNS_SLOTS.map(([type, px, format]) => {
    if (!pngs[px]) throw new Error(`icns ${type}: no ${px} px image`);
    const image = decodePng(pngs[px]);
    if (image.width !== px || image.height !== px) throw new Error(`icns ${type}: the image is ${image.width}×${image.height}, the slot is ${px}×${px}`);
    const data = format === 'argb' ? argbData(image) : pngs[px];
    const head = Buffer.alloc(8);
    head.write(type, 0, 'latin1');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'latin1');
  head.writeUInt32BE(8 + chunks.reduce((n, c) => n + c.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

/**
 * .icns → [{ type, format: 'png' | 'argb' | 'other', width, height, rgba, data }]. The size comes from the image data
 * itself, not from the type, so a mislabelled slot shows; 'other' (legacy masks, 'info', a table of contents) has no pixels.
 */
export function readIcns(file) {
  if (file.length < 8 || file.toString('latin1', 0, 4) !== 'icns' || file.readUInt32BE(4) !== file.length) throw new Error('Not an .icns file (magic or length)');
  const entries = [];
  for (let o = 8; o < file.length; ) {
    if (o + 8 > file.length) throw new Error('icns: entry header cut off');
    const type = file.toString('latin1', o, o + 4);
    const len = file.readUInt32BE(o + 4);
    if (len < 8 || o + len > file.length) throw new Error(`icns ${type}: bad length`);
    const data = file.subarray(o + 8, o + len);
    if (isPng(data)) entries.push({ type, format: 'png', ...decodePng(data), data });
    else if (data.toString('latin1', 0, 4) === 'ARGB') {
      const planes = unpackRle(data.subarray(4));
      const n = planes.length / 4;
      const side = Math.sqrt(n);
      if (!Number.isInteger(side)) throw new Error(`icns ${type}: ARGB data is not a square image`);
      const rgba = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        rgba[i * 4] = planes[n + i];
        rgba[i * 4 + 1] = planes[2 * n + i];
        rgba[i * 4 + 2] = planes[3 * n + i];
        rgba[i * 4 + 3] = planes[i];
      }
      entries.push({ type, format: 'argb', width: side, height: side, rgba, data });
    } else entries.push({ type, format: 'other', width: 0, height: 0, rgba: null, data });
    o += len;
  }
  return entries;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/icns.mjs <file.icns>');
    process.exit(2);
  }
  for (const e of readIcns(fs.readFileSync(file))) console.log(`${e.type}  ${e.format.padEnd(5)}  ${e.width ? `${e.width}×${e.height}` : '-'}  ${e.data.length} bytes`);
}
