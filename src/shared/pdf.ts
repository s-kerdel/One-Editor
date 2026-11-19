// PDF export layout, shared by the renderer (builds the print HTML + @page CSS) and the Electron main
// process (printToPDF options). One table drives both, so the page box and the PDF paper always agree.
// Pure: no DOM, no Node, no Electron. Only lazy chunks import it (never the startup bundle).
import type { RelPath } from './api';

export type PdfPageSize = 'A4' | 'Letter' | 'Legal';
export type PdfMargins = 'narrow' | 'normal' | 'wide';

export interface PdfLayout {
  pageSize: PdfPageSize;
  margins: PdfMargins;
  /** Footer "page / total" on every page. */
  pageNumbers: boolean;
}

export interface PdfExportRequest extends PdfLayout {
  /** The note being exported (workspace-relative Markdown): names the file and picks the default folder. */
  path: RelPath;
  /** Complete standalone HTML document (sanitized, images inlined, no scripts). */
  html: string;
}

export interface PdfExportResult {
  /** Where the PDF was written (native absolute path). */
  abs: string;
  /** Workspace-relative path when it was saved inside the open folder. */
  rel: RelPath | null;
  bytes: number;
}

/** Paper in millimetres (portrait). */
export const PDF_PAGE_MM: Record<PdfPageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 },
};

/** Page margins in millimetres. The bottom one also hosts the page-number footer. */
export const PDF_MARGIN_MM: Record<PdfMargins, { top: number; right: number; bottom: number; left: number }> = {
  narrow: { top: 12, right: 12, bottom: 14, left: 12 },
  normal: { top: 20, right: 20, bottom: 22, left: 20 },
  wide: { top: 25, right: 32, bottom: 27, left: 32 },
};

export const DEFAULT_PDF_LAYOUT: PdfLayout = { pageSize: 'A4', margins: 'normal', pageNumbers: true };

/** Upper bound for the HTML sent to the main process (images are inlined as data URIs). */
export const MAX_PDF_HTML_CHARS = 64 * 1024 * 1024;

const isSize = (v: unknown): v is PdfPageSize => typeof v === 'string' && Object.hasOwn(PDF_PAGE_MM, v);
const isMargins = (v: unknown): v is PdfMargins => typeof v === 'string' && Object.hasOwn(PDF_MARGIN_MM, v);

/** Settings → layout; anything missing or unknown falls back to the default. */
export function pdfLayoutFrom(s: Record<string, unknown>): PdfLayout {
  const size = s['export.pdfPageSize'];
  const margins = s['export.pdfMargins'];
  const numbers = s['export.pdfPageNumbers'];
  return {
    pageSize: isSize(size) ? size : DEFAULT_PDF_LAYOUT.pageSize,
    margins: isMargins(margins) ? margins : DEFAULT_PDF_LAYOUT.margins,
    pageNumbers: typeof numbers === 'boolean' ? numbers : DEFAULT_PDF_LAYOUT.pageNumbers,
  };
}

/** Why `req` is not a usable export request (null = fine). Shape only; paths are checked by the backend. */
export function pdfRequestProblem(req: unknown): { code: 'EINVAL' | 'ETOOBIG'; message: string } | null {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { code: 'EINVAL', message: 'Export request must be an object' };
  const r = req as Record<string, unknown>;
  if (typeof r.path !== 'string' || !r.path) return { code: 'EINVAL', message: 'Note path must be a non-empty string' };
  if (typeof r.html !== 'string' || !r.html) return { code: 'EINVAL', message: 'HTML must be a non-empty string' };
  if (r.html.length > MAX_PDF_HTML_CHARS) return { code: 'ETOOBIG', message: `Note is too large to export (${Math.round(r.html.length / 1048576)} MB of HTML; the limit is ${MAX_PDF_HTML_CHARS / 1048576} MB)` };
  if (!isSize(r.pageSize)) return { code: 'EINVAL', message: `Unknown page size: ${String(r.pageSize)}` };
  if (!isMargins(r.margins)) return { code: 'EINVAL', message: `Unknown margins: ${String(r.margins)}` };
  if (typeof r.pageNumbers !== 'boolean') return { code: 'EINVAL', message: 'pageNumbers must be a boolean' };
  return null;
}

/** @page rule for the print document (paper + margins), plus the image height cap that fits one page. */
export function pdfPageCss(l: PdfLayout): string {
  const p = PDF_PAGE_MM[l.pageSize];
  const m = PDF_MARGIN_MM[l.margins];
  // A picture taller than the text area would be sliced across two pages.
  const maxImg = Math.floor(p.height - m.top - m.bottom - 12);
  return `@page{size:${p.width}mm ${p.height}mm;margin:${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm}` + `.se-preview img,.se-preview svg{max-height:${maxImg}mm}`;
}

const inches = (mm: number) => Math.round((mm / 25.4) * 1000) / 1000;

/** Footer with "page / total", aligned with the text column. Chromium fills the two spans per page. */
export function pdfFooterTemplate(l: PdfLayout): string {
  const m = PDF_MARGIN_MM[l.margins];
  return (
    `<div style="box-sizing:border-box;width:100%;padding:0 ${m.right}mm 0 ${m.left}mm;margin-bottom:${Math.max(4, m.bottom / 2 - 3)}mm;` +
    `font:8pt 'Segoe UI',system-ui,-apple-system,sans-serif;color:#8d939b;text-align:center;-webkit-print-color-adjust:exact">` +
    `<span class="pageNumber"></span> / <span class="totalPages"></span></div>`
  );
}

/** Electron `webContents.printToPDF()` options for a layout (margins in inches). */
export function printToPdfOptions(l: PdfLayout) {
  const m = PDF_MARGIN_MM[l.margins];
  return {
    pageSize: l.pageSize,
    margins: { top: inches(m.top), right: inches(m.right), bottom: inches(m.bottom), left: inches(m.left) },
    printBackground: true, // code blocks, callouts, table stripes
    preferCSSPageSize: true,
    displayHeaderFooter: l.pageNumbers,
    // An empty header (Chromium's default would print date + title at the top of every page).
    headerTemplate: '<span></span>',
    footerTemplate: l.pageNumbers ? pdfFooterTemplate(l) : '<span></span>',
    generateDocumentOutline: true, // headings → PDF bookmarks
    generateTaggedPDF: true,
  };
}

// ---- PDF viewer (pdf.js) ----------------------------------------------------------------------
/** The pdf.js worker script as the renderer build emits it (`assets/pdf.worker.min-<hash>.mjs`). */
export const isPdfWorkerAsset = (file: string): boolean => /(^|[\\/])pdf\.worker[^\\/]*\.m?js$/.test(file);
/** A worker gets its CSP from its own response, not from index.html: served with this one, so pdf.js
 *  runs without eval (wasm image decoders only) and can reach nothing but the app's own origin. */
export const PDF_WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";
