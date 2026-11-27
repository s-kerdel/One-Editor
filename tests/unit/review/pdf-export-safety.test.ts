// "Export note to PDF" backend: payload validation, workspace confinement, size caps, save flow,
// remembered folder, open/reveal restricted to exported files, browser-mode refusal, print-window filter.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendService, type ServiceHooks } from '../../../src/backend/service';
import { startServer } from '../../../src/server/server';
import { MAX_PDF_HTML_CHARS, pdfRequestProblem } from '../../../src/shared/pdf';
import { isAppNavigation, isPdfWindowRequestAllowed, PDF_HOST } from '../../../src/main/protocol';

const TMP = fileURLToPath(new URL('../../../.tmp/review/unit', import.meta.url));
const PDF = new TextEncoder().encode('%PDF-1.7\n%fake but well-formed enough\n%%EOF');
let tmp: string;
let root: string;

beforeEach(async () => {
  await fsp.mkdir(TMP, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(TMP, 'pdf-'));
  root = path.join(tmp, 'notes');
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'sub', 'Report.md'), '# Report');
  await fsp.writeFile(path.join(root, 'app.ts'), 'x');
  await fsp.writeFile(path.join(tmp, 'outside.md'), '# outside');
});
afterEach(async () => {
  // The service may still be finishing an atomic write (tmp file + rename) in cfg/: retry instead of ENOTEMPTY.
  await fsp.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const req = (over: Record<string, unknown> = {}) => ({ path: 'sub/Report.md', html: '<!doctype html><p>x</p>', pageSize: 'A4', margins: 'normal', pageNumbers: true, ...over });

async function service(hooks: Partial<ServiceHooks> & { save?: (def: string) => string | null } = {}) {
  const calls = { render: [] as unknown[][], dialog: [] as string[], opened: [] as string[], revealed: [] as string[] };
  const s = new BackendService(path.join(tmp, 'cfg'), {
    renderPdf: async (...a) => (calls.render.push(a), PDF),
    pickSavePath: async (def) => (calls.dialog.push(def), hooks.save ? hooks.save(def) : def),
    openPath: async (p) => void calls.opened.push(p),
    revealInFolder: async (p) => void calls.revealed.push(p),
    ...hooks,
  });
  await s.openWorkspace(root);
  return { s, calls };
}

describe('exportPdf: input validation', () => {
  it('rejects malformed payloads before rendering anything', async () => {
    const { s, calls } = await service();
    for (const bad of [null, 'x', [], {}, req({ path: '' }), req({ path: 3 }), req({ html: '' }), req({ html: 42 }), req({ pageSize: 'A0' }), req({ pageSize: '__proto__' }), req({ margins: 'none' }), req({ pageNumbers: 'yes' })]) {
      await expect(s.exportPdf(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'EINVAL' });
    }
    expect(calls.render).toHaveLength(0);
    expect(calls.dialog).toHaveLength(0);
    s.dispose();
  });

  it('only Markdown notes', async () => {
    const { s } = await service();
    for (const p of ['app.ts', 'sub/Report.md.exe', 'sub/Report', 'sub']) await expect(s.exportPdf(req({ path: p })), p).rejects.toMatchObject({ code: 'EINVAL' });
    s.dispose();
  });

  it('never a path outside the workspace (.., absolute, drive letters, UNC); missing notes → ENOENT', async () => {
    const { s, calls } = await service();
    for (const p of ['../outside.md', 'sub/../../outside.md', '..\\outside.md', path.join(tmp, 'outside.md'), '/etc/x.md', 'C:\\Windows\\x.md', 'c:/x.md', '\\\\server\\share\\x.md']) {
      await expect(s.exportPdf(req({ path: p })), p).rejects.toMatchObject({ code: 'OUTSIDE_WORKSPACE' });
    }
    await expect(s.exportPdf(req({ path: 'sub/Missing.md' }))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls.render).toHaveLength(0);
    s.dispose();
  });

  it('caps the HTML size (oversized payload → ETOOBIG, nothing rendered)', async () => {
    const { s, calls } = await service();
    const huge = 'x'.repeat(MAX_PDF_HTML_CHARS + 1);
    await expect(s.exportPdf(req({ html: huge }))).rejects.toMatchObject({ code: 'ETOOBIG' });
    expect(pdfRequestProblem(req({ html: huge }))?.code).toBe('ETOOBIG');
    expect(pdfRequestProblem(req({ html: 'x'.repeat(1024) }))).toBeNull();
    expect(calls.render).toHaveLength(0);
    s.dispose();
  });

  it('without the Electron hooks (browser mode) it refuses cleanly with ENOTSUP', async () => {
    const s = new BackendService(path.join(tmp, 'cfg'), {});
    await s.openWorkspace(root);
    await expect(s.exportPdf(req())).rejects.toMatchObject({ code: 'ENOTSUP' });
    s.dispose();
  });
});

describe('exportPdf: save flow', () => {
  it('suggests <note>.pdf next to the note, writes it through the workspace and reports the path', async () => {
    const { s, calls } = await service();
    const r = await s.exportPdf(req());
    expect(calls.dialog).toEqual([path.join(root, 'sub', 'Report.pdf')]);
    expect(calls.render[0][1]).toEqual({ pageSize: 'A4', margins: 'normal', pageNumbers: true });
    expect(r).toEqual({ abs: path.join(root, 'sub', 'Report.pdf'), rel: 'sub/Report.pdf', bytes: PDF.length });
    expect(fs.readFileSync(path.join(root, 'sub', 'Report.pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    s.dispose();
  });

  it('cancel → null and nothing written; outside the folder works and gets the .pdf extension', async () => {
    const out = path.join(tmp, 'elsewhere');
    await fsp.mkdir(out);
    let answer: string | null = null;
    const { s, calls } = await service({ save: () => answer });
    expect(await s.exportPdf(req())).toBeNull();
    expect(fs.existsSync(path.join(root, 'sub', 'Report.pdf'))).toBe(false);
    answer = path.join(out, 'final');
    const r = await s.exportPdf(req());
    expect(r).toMatchObject({ abs: path.join(out, 'final.pdf'), rel: null });
    expect(fs.existsSync(path.join(out, 'final.pdf'))).toBe(true);
    expect(fs.readdirSync(out)).toEqual(['final.pdf']); // no temp file left behind
    // The folder chosen last is suggested next time (per workspace, persisted).
    answer = null;
    await s.exportPdf(req());
    expect(calls.dialog.at(-1)).toBe(path.join(out, 'Report.pdf'));
    s.dispose();
    const saved = path.join(tmp, 'cfg', 'export-dirs.json');
    await expect.poll(() => (fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : '')).toContain('elsewhere');
    const again = await service({ save: () => null });
    await again.s.exportPdf(req());
    expect(again.calls.dialog).toEqual([path.join(out, 'Report.pdf')]);
    again.s.dispose();
  });

  it('two windows (services) on one app data folder keep each other’s remembered PDF folder', async () => {
    const root2 = path.join(tmp, 'notes2');
    await fsp.mkdir(path.join(root2, 'sub'), { recursive: true });
    await fsp.writeFile(path.join(root2, 'sub', 'Report.md'), '# Report 2');
    const [out1, out2] = [path.join(tmp, 'out1'), path.join(tmp, 'out2')];
    await Promise.all([fsp.mkdir(out1), fsp.mkdir(out2)]);
    const answers = { a: null as string | null, b: null as string | null };
    const a = await service({ save: () => answers.a });
    const b = await service({ save: () => answers.b });
    await b.s.openWorkspace(root2);
    // Both looked at the file before either saved (each used to keep a whole stale copy and write it back).
    await Promise.all([a.s.exportPdf(req()), b.s.exportPdf(req())]);
    [answers.a, answers.b] = [path.join(out1, 'a.pdf'), path.join(out2, 'b.pdf')];
    await Promise.all([a.s.exportPdf(req()), b.s.exportPdf(req())]);
    const saved = path.join(tmp, 'cfg', 'export-dirs.json');
    const disk = () => (fs.existsSync(saved) ? Object.values(JSON.parse(fs.readFileSync(saved, 'utf8'))).sort() : []);
    await expect.poll(disk).toEqual([out1, out2].sort());
    a.s.dispose();
    b.s.dispose();
    // A later launch suggests each folder its own.
    const again = await service({ save: () => null });
    await again.s.exportPdf(req());
    await again.s.openWorkspace(root2);
    await again.s.exportPdf(req());
    expect(again.calls.dialog).toEqual([path.join(out1, 'Report.pdf'), path.join(out2, 'Report.pdf')]);
    again.s.dispose();
  });

  it('a remembered folder that no longer exists falls back to the note folder', async () => {
    const gone = path.join(tmp, 'gone');
    await fsp.mkdir(gone);
    const first = await service({ save: () => path.join(gone, 'x.pdf') });
    await first.s.exportPdf(req());
    first.s.dispose();
    await fsp.rm(gone, { recursive: true });
    const { s, calls } = await service({ save: () => null });
    await s.exportPdf(req());
    expect(calls.dialog).toEqual([path.join(root, 'sub', 'Report.pdf')]);
    s.dispose();
  });

  it('a corrupt export-dirs.json is ignored', async () => {
    for (const junk of ['null', '[1,2]', '"x"', '{not json']) {
      await fsp.mkdir(path.join(tmp, 'cfg'), { recursive: true });
      await fsp.writeFile(path.join(tmp, 'cfg', 'export-dirs.json'), junk);
      const { s, calls } = await service({ save: () => null });
      await s.exportPdf(req());
      expect(calls.dialog, junk).toEqual([path.join(root, 'sub', 'Report.pdf')]);
      s.dispose();
    }
  });

  it('a renderer that returns no PDF is an error, not a corrupt file', async () => {
    const { s } = await service({ renderPdf: async () => new TextEncoder().encode('<html>') });
    await expect(s.exportPdf(req())).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.existsSync(path.join(root, 'sub', 'Report.pdf'))).toBe(false);
    s.dispose();
  });
});

describe('showExportedFile', () => {
  it('opens / reveals only files this session exported', async () => {
    const { s, calls } = await service();
    for (const p of [path.join(root, 'app.ts'), path.join(tmp, 'outside.md'), 'sub/Report.pdf', 42]) {
      await expect(s.showExportedFile(p, 'open'), String(p)).rejects.toMatchObject({ code: 'EACCES' });
    }
    const r = (await s.exportPdf(req()))!;
    await s.showExportedFile(r.abs, 'open');
    await s.showExportedFile(r.abs, 'reveal');
    await expect(s.showExportedFile(r.abs, 'delete')).rejects.toMatchObject({ code: 'EINVAL' });
    expect(calls.opened).toEqual([r.abs]);
    expect(calls.revealed).toEqual([r.abs]);
    s.dispose();
  });
});

describe('browser-mode server', () => {
  it('refuses the desktop-only methods with ENOTSUP (before reading the body)', async () => {
    const renderer = path.join(tmp, 'renderer');
    await fsp.mkdir(renderer);
    await fsp.writeFile(path.join(renderer, 'index.html'), '<!doctype html><html><head></head><body></body></html>');
    const srv = await startServer({ root, port: 0, rendererDir: renderer, configDir: path.join(tmp, 'cfg') });
    try {
      const post = (m: string, body: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const r = http.request({ host: '127.0.0.1', port: srv.port, path: `/api/rpc/${m}`, method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': srv.token } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
          });
          r.on('error', reject);
          r.end(body);
        });
      for (const m of ['exportPdf', 'showExportedFile']) {
        const r = await post(m, JSON.stringify({ args: [req()] }));
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body)).toMatchObject({ ok: false, error: { code: 'ENOTSUP' } });
      }
      // The server keeps working afterwards.
      expect(JSON.parse((await post('getWorkspace', '{"args":[]}')).body).ok).toBe(true);
    } finally {
      await srv.close();
    }
  });
});

describe('hidden print window request filter', () => {
  it('allows its own document, data: URIs and https images — nothing else', () => {
    expect(isPdfWindowRequestAllowed(`app://${PDF_HOST}/abc123`, 'mainFrame')).toBe(true);
    expect(isPdfWindowRequestAllowed('data:image/png;base64,AAAA', 'image')).toBe(true);
    expect(isPdfWindowRequestAllowed('https://example.com/a.png', 'image')).toBe(true);
    for (const [url, type] of [
      ['https://example.com/a.css', 'stylesheet'],
      ['https://example.com/x.js', 'script'],
      ['https://example.com/', 'subFrame'],
      ['http://example.com/a.png', 'image'],
      ['file:///etc/passwd', 'image'],
      ['file:///etc/passwd', 'subFrame'],
      ['app://sec-edit/index.html', 'subFrame'],
      ['app://sec-edit/__ws/a.png', 'image'],
      [`app://${PDF_HOST}/other`, 'subFrame'],
      ['blob:app://sec-edit/1', 'image'],
      ['not a url', 'image'],
    ]) {
      expect(isPdfWindowRequestAllowed(url, type), `${url} (${type})`).toBe(false);
    }
  });

  it('the PDF document is never treated as the app (no trusted IPC sender)', () => {
    expect(isAppNavigation(`app://${PDF_HOST}/abc`)).toBe(false);
  });
});
