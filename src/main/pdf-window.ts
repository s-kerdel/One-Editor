// "Export note to PDF": prints a standalone HTML document in a throwaway, locked-down window.
//  - own in-memory session: no cookies / cache / storage shared with the app, nothing written to disk;
//  - JavaScript off, sandboxed, no preload → the page can reach neither IPC nor Node;
//  - the document is served only by that session (app://sec-edit-pdf/<random id>); every other request
//    is refused except data: URIs and https: images (what the preview shows anyway);
//  - navigation, pop-ups, downloads and permissions are denied; the window is destroyed afterwards.
import { BrowserWindow, session, type Session } from 'electron';
import crypto from 'node:crypto';
import { printToPdfOptions, type PdfLayout } from '../shared/pdf';
import { PDF_HOST, SCHEME, isPdfWindowRequestAllowed } from './protocol';

const PARTITION = 'sec-edit-pdf-export'; // no "persist:" prefix → in memory only
// Second layer behind the sanitizer: no script, no frames, no fetches; inline styles + images only.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; base-uri 'none'; form-action 'none'";
const LOAD_TIMEOUT_MS = 20_000;
const PRINT_TIMEOUT_MS = 90_000;

const docs = new Map<string, string>();
let pdfSession: Session | null = null;

function getSession(): Session {
  if (pdfSession) return pdfSession;
  const s = session.fromPartition(PARTITION, { cache: false });
  s.protocol.handle(SCHEME, (req) => {
    let html: string | undefined;
    try {
      const u = new URL(req.url);
      if (u.host === PDF_HOST) html = docs.get(u.pathname.slice(1));
    } catch {}
    if (html === undefined) return new Response('not found', { status: 404 });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' } });
  });
  s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !isPdfWindowRequestAllowed(d.url, d.resourceType) }));
  s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  s.on('will-download', (e) => e.preventDefault());
  return (pdfSession = s);
}

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());
}

export async function renderPdf(html: string, layout: PdfLayout): Promise<Uint8Array> {
  const id = crypto.randomBytes(16).toString('hex');
  docs.set(id, html);
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: getSession(),
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webgl: false,
      spellcheck: false,
      backgroundThrottling: false,
      disableDialogs: true,
      navigateOnDragDrop: false,
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  try {
    const loaded = wc.loadURL(`${SCHEME}://${PDF_HOST}/${id}`);
    loaded.catch(() => {});
    // A slow remote image must not hold the export hostage: after the timeout, print what has arrived.
    await Promise.race([loaded, new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS).unref())]);
    const data = await Promise.race([wc.printToPDF(printToPdfOptions(layout)), timeout(PRINT_TIMEOUT_MS, 'PDF rendering timed out')]);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } finally {
    docs.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
}
