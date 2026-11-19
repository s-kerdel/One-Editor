// pdf.js loading and the one place documents are opened (security options live here, nowhere else).
// Everything in this file is part of the lazy `pdf` chunk: nothing of pdf.js is parsed at startup.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { app } from '../app/app';
import { fileUrl } from '../platform';

type Lib = typeof import('pdfjs-dist');
type ViewerLib = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

let libs: Promise<{ lib: Lib; viewer: ViewerLib }> | null = null;

/** pdf.js core + its viewer component. The viewer module reads `globalThis.pdfjsLib`, so core goes first. */
export function loadPdfjs(): Promise<{ lib: Lib; viewer: ViewerLib }> {
  return (libs ??= (async () => {
    const lib = await import('pdfjs-dist');
    // Served from the app's own origin (app://sec-edit or the local server), under a CSP without eval.
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
    return { lib, viewer };
  })().catch((err) => {
    libs = null; // allow a retry
    throw err;
  }));
}

/** Font / CMap / wasm data copied next to the renderer by vite.config.ts (`pdfjs/…`). */
const asset = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/**
 * Bytes of a workspace PDF through the workspace-scoped file endpoint (`app://sec-edit/__ws/…` /
 * `/api/file`): a network read off the UI thread, then handed (transferred) to the pdf.js worker.
 */
export async function readPdfBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(fileUrl(app.backend, app.workspace.value?.root ?? '', path), { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? `File not found: ${path}` : `Cannot read ${path} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Opens a PDF with scripting, XFA and eval off. `task.destroy()` also ends its worker. */
export async function openPdfDocument(data: Uint8Array): Promise<PDFDocumentLoadingTask> {
  const { lib } = await loadPdfjs();
  const params = {
    data,
    // pdf.js 6 has no eval code path left; kept so a future version can never turn it back on.
    isEvalSupported: false,
    enableXfa: false, // XFA forms are scripted HTML: never
    stopAtErrors: false,
    verbosity: lib.VerbosityLevel.ERRORS,
    cMapUrl: asset('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: asset('standard_fonts'),
    wasmUrl: asset('wasm'),
    iccUrl: asset('iccs'),
  };
  return lib.getDocument(params as Parameters<Lib['getDocument']>[0]);
}
