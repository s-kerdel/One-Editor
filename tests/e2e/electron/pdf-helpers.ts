// Reads exported PDFs with pdf.js (real parsing, not regex): text per page, page size, painted images,
// and page → PNG (via @napi-rs/canvas) for eyeballing the layout.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface PdfInfo {
  pages: number;
  /** Text of each page (items joined by spaces). */
  text: string[];
  /** [width, height] of page 1 in PDF points (1/72 in). */
  size: [number, number];
  /** Number of raster images painted, over all pages. */
  images: number;
  /** Text items of each page, top to bottom (y = distance from the top edge, in points). */
  items: Array<Array<{ str: string; x: number; y: number }>>;
  /** Bookmark titles (document outline), depth-first. */
  outline: string[];
  /** URLs of link annotations, over all pages. */
  links: string[];
}

const load = (file: string) => getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: false });

export async function readPdf(file: string): Promise<PdfInfo> {
  const task = load(file);
  const doc = await task.promise;
  const text: string[] = [];
  const items: PdfInfo['items'] = [];
  const links: string[] = [];
  let images = 0;
  let size: [number, number] = [0, 0];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    if (i === 1) size = [page.view[2] - page.view[0], page.view[3] - page.view[1]];
    const tc = await page.getTextContent();
    text.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    const top = page.view[3];
    items.push(
      tc.items
        .flatMap((it) => ('str' in it && it.str.trim() ? [{ str: it.str, x: it.transform[4], y: top - it.transform[5] }] : []))
        .sort((a, b) => a.y - b.y || a.x - b.x),
    );
    for (const a of await page.getAnnotations()) if (a.subtype === 'Link' && a.url) links.push(a.url);
    const ops = await page.getOperatorList();
    images += ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject).length;
  }
  const outline: string[] = [];
  const walk = (nodes: Array<{ title: string; items: unknown[] }> | null) => nodes?.forEach((n) => (outline.push(n.title), walk(n.items as typeof nodes)));
  walk(await doc.getOutline());
  const pages = doc.numPages;
  await task.destroy();
  return { pages, text, size, images, items, outline, links };
}

/** Renders `pageNo` (1-based) to a PNG file at `scale` × 72 dpi. */
export async function renderPage(file: string, pageNo: number, out: string, scale = 1.5): Promise<void> {
  const { createCanvas } = await import('@napi-rs/canvas');
  const task = load(file);
  const doc = await task.promise;
  const page = await doc.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  await task.destroy();
}

/** Tiny RGB PNG encoder for fixture images (no binary fixtures in the repo). */
export function makePng(w: number, h: number, px: (x: number, y: number) => [number, number, number]): Buffer {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(px(x, y), y * stride + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
