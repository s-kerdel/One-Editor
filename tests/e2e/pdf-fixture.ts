// Tiny hand-written PDFs for the viewer tests (no binaries in git): N Letter pages with "Page i" text,
// a search word on some pages, and on page 1 an external URI link plus an internal link to page 3.
import fs from 'node:fs';
import path from 'node:path';

export interface PdfFixtureOptions {
  pages?: number;
  /** Pages (1-based) that contain the word "needle". */
  needlePages?: number[];
  /** Extra line on every page (lets a test tell two versions of the file apart). */
  marker?: string;
  externalUrl?: string;
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function makePdf(o: PdfFixtureOptions = {}): Buffer {
  const pages = o.pages ?? 5;
  const needles = new Set(o.needlePages ?? [2, 4]);
  const url = o.externalUrl ?? 'https://example.com/sec-edit-pdf-test';
  const objs: string[] = []; // objs[i] = body of object i+1
  const add = (body: string) => objs.push(body) as number; // returns the object number
  const catalog = add(''); // filled below
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageNums: number[] = [];
  // Reserve page objects first so links can point at page 3.
  for (let i = 0; i < pages; i++) pageNums.push(add(''));
  for (let i = 1; i <= pages; i++) {
    const lines = [`Page ${i}`, `This is page ${i} of ${pages}.`];
    if (needles.has(i)) lines.push('Here is the needle in the haystack.');
    if (i === 1) lines.push('External link', 'Go to page 3');
    if (o.marker) lines.push(o.marker);
    let y = 720;
    const ops = lines.map((l, k) => {
      const size = k === 0 ? 28 : 14;
      const s = `BT /F1 ${size} Tf 72 ${y} Td (${esc(l)}) Tj ET`;
      y -= k === 0 ? 44 : 24;
      return s;
    });
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    let annots = '';
    if (i === 1) {
      // Lines: 720 (title), 676, then 652… — link rects sit on "External link" / "Go to page 3".
      const ext = add(`<< /Type /Annot /Subtype /Link /Rect [70 ${676 - 24 * 1 - 6} 200 ${676 - 24 * 1 + 16}] /Border [0 0 0] /A << /S /URI /URI (${esc(url)}) >> >>`);
      const ystart = 676 - 24 * 2;
      const int = add(`<< /Type /Annot /Subtype /Link /Rect [70 ${ystart - 6} 200 ${ystart + 16}] /Border [0 0 0] /Dest [${pageNums[Math.min(2, pages - 1)]} 0 R /XYZ 0 792 null] >>`);
      annots = ` /Annots [${ext} 0 R ${int} 0 R]`;
    }
    objs[pageNums[i - 1] - 1] = `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${annots} >>`;
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function writePdf(file: string, o?: PdfFixtureOptions): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makePdf(o));
}
