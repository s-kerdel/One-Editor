// "Export note to PDF…" (lazy chunk). Desktop: the renderer builds a self-contained print document and the
// main process prints it in a locked-down hidden window (see src/main/pdf-window.ts). Browser mode has no
// Chromium on the server, so it falls back to the system print dialog with the same paper settings.
import css from './preview.css?inline';
import { app } from '../app/app';
import { runCommand } from '../app/commands';
import { fileUrl } from '../platform';
import { setTree } from '../app/fileops';
import { insertNode } from '../app/tree-model';
import { basename, stem } from '@shared/paths';
import { MAX_PDF_HTML_CHARS, pdfLayoutFrom, pdfPageCss, type PdfLayout } from '@shared/pdf';
import { renderStandalone } from './export';
import { assemblePdfHtml, inlineImages, preparePrintDom } from './pdf-doc';

async function loadWorkspaceFile(ws: string, maxBytes: number): Promise<Uint8Array | null> {
  const root = app.workspace.value?.root;
  if (!root) return null;
  const res = await fetch(fileUrl(app.backend, root, ws));
  if (!res.ok || Number(res.headers.get('content-length')) > maxBytes) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.length > maxBytes ? null : bytes;
}

/** The standalone print document for a note: light theme, images inlined, nothing to fetch but https images. */
export async function buildPdfDocument(path: string, src: string, layout: PdfLayout): Promise<string> {
  const box = await renderStandalone(path, src, async (b) => void (await inlineImages(b, loadWorkspaceFile)));
  preparePrintDom(box);
  const title = box.querySelector('h1')?.textContent?.trim() || stem(path);
  return assemblePdfHtml({ title, body: box.innerHTML, css, layout });
}

async function noteSource(path: string): Promise<string> {
  const open = app.editor?.getContent(path) ?? app.docs.get(path)?.content;
  return open ?? (await app.backend.readFile(path)).content;
}

const fail = (err: unknown) => app.toast(String((err as Error)?.message ?? err), 'error');

/** Browser mode: the system print dialog, with the paper size + margins from Settings → Export. */
async function printFallback(path: string, layout: PdfLayout): Promise<void> {
  if (app.activePath.value !== path) await app.openFile(path);
  app.toast("Choose 'Save as PDF' as the printer", 'info', 6000);
  const style = document.createElement('style');
  style.textContent = `@media print{${pdfPageCss(layout)}}`;
  document.head.append(style);
  try {
    await runCommand('preview.print');
  } finally {
    // Removed after the (blocking) dialog closes, so it never leaks into later prints.
    setTimeout(() => style.remove(), 1000);
  }
}

/** Export `path` (default: the active note). `src` = current editor text, when the caller has it. */
export async function exportPdf(path: string, src?: string): Promise<void> {
  const layout = pdfLayoutFrom(app.settings.value);
  if (app.backend.kind === 'web') return printFallback(path, layout);
  const busy = app.toast(`Exporting ${basename(path)} to PDF…`, 'info', 120_000);
  let res;
  try {
    const html = await buildPdfDocument(path, src ?? (await noteSource(path)), layout);
    if (html.length > MAX_PDF_HTML_CHARS) throw new Error(`the note and its images are too large (${Math.round(html.length / 1048576)} MB; the limit is ${MAX_PDF_HTML_CHARS / 1048576} MB)`);
    res = await app.backend.exportPdf({ path, html, ...layout });
  } finally {
    app.dismissToast(busy);
  }
  if (!res) return void app.toast('PDF export cancelled', 'info', 2000);
  const { abs, rel, bytes } = res;
  if (rel && !app.files.value.includes(rel)) setTree((t) => insertNode(t, { name: basename(rel), path: rel, kind: 'file', mtime: Date.now(), size: bytes }));
  app.toast(`Exported to ${rel ?? abs}`, 'success', 9000, [
    { label: 'Open', run: () => void app.backend.showExportedFile(abs, 'open').catch(fail) },
    { label: 'Show in folder', run: () => void app.backend.showExportedFile(abs, 'reveal').catch(fail) },
  ]);
}
