// Input checks and file writing for "Export note to PDF". The rendering itself is an Electron hook
// (ServiceHooks.renderPdf); this half is plain Node so it is unit-tested without Electron.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isMarkdown } from '../shared/paths';
import { pdfRequestProblem, type PdfLayout } from '../shared/pdf';
import { BackendFailure } from './errors';

export interface CheckedPdfRequest {
  path: string;
  noteAbs: string;
  html: string;
  layout: PdfLayout;
}

/** Validates an exportPdf payload from the renderer. `abs` maps a workspace path (Workspace.abs). */
export async function checkPdfRequest(req: unknown, abs: (rel: string) => string): Promise<CheckedPdfRequest> {
  const problem = pdfRequestProblem(req);
  if (problem) throw new BackendFailure(problem.code, problem.message);
  const r = req as Record<string, unknown> & PdfLayout & { path: string; html: string };
  // Workspace.abs() would quietly clamp "../x.md" to "x.md"; a request like that is refused outright.
  if (/^([\\/]|[a-z]:[\\/])/i.test(r.path) || r.path.split(/[\\/]/).includes('..')) throw new BackendFailure('OUTSIDE_WORKSPACE', `Path escapes workspace: ${r.path}`);
  if (!isMarkdown(r.path)) throw new BackendFailure('EINVAL', `Only Markdown notes can be exported to PDF: ${r.path}`);
  const noteAbs = abs(r.path);
  const st = await fsp.stat(noteAbs).catch(() => null);
  if (!st?.isFile()) throw new BackendFailure('ENOENT', `Note not found: ${r.path}`);
  return { path: r.path, noteAbs, html: r.html, layout: { pageSize: r.pageSize, margins: r.margins, pageNumbers: r.pageNumbers } };
}

/** "report" → "report.pdf" (GTK / macOS dialogs do not add the extension themselves). */
export function withPdfExtension(p: string): string {
  return /\.pdf$/i.test(p) ? p : `${p}.pdf`;
}

export function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.byteLength > 8 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-';
}

/** Temp sibling + rename, so an existing PDF is never left half-written. */
export async function writeFileAtomic(target: string, data: Uint8Array, retry: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()): Promise<void> {
  const tmp = path.join(path.dirname(target), `.~export.${crypto.randomBytes(4).toString('hex')}.sec-edit.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await retry(() => fsp.rename(tmp, target));
  } catch (err: any) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    // Windows: a PDF that is open in a viewer (Acrobat, Edge) is locked.
    if (['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw new BackendFailure('EACCES', `Cannot write ${path.basename(target)} — close it in other apps (or pick another name) and try again`);
    throw err;
  }
}
