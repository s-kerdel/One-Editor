// PDF viewer in the real app: the pdf.js worker comes from app:// with a no-eval CSP, an external link
// reaches shell.openExternal only on a click, and 20 open / close cycles give the memory back.
import { test, expect, fs, path } from './fixture';
import { writePdf } from '../pdf-fixture';

const URL_ = 'https://example.com/sec-edit-pdf-test';

test('PDF: worker CSP, external link on click only, open/close cycles free memory', async ({ el }) => {
  test.setTimeout(120_000);
  writePdf(path.join(el.ws, 'docs/sample.pdf'), { pages: 30, externalUrl: URL_ });
  const { app, page } = await el.launch([el.ws]);
  await app.evaluate(({ shell }) => {
    (globalThis as any).__opened = [];
    shell.openExternal = (async (u: string) => void (globalThis as any).__opened.push(u)) as typeof shell.openExternal;
  });
  const open = async () => {
    await page.evaluate(() => (window as any).__secEdit.openFile('docs/sample.pdf'));
    await expect(page.locator('.se-pdf-count')).toHaveText('/ 30', { timeout: 15000 });
    await expect(page.locator('.se-pdf .page[data-page-number="1"] canvas')).toBeVisible();
  };
  const close = async () => {
    await page.evaluate(() => (window as any).__secEdit.closeTab('docs/sample.pdf'));
    await expect(page.locator('.se-pdf')).toHaveCount(0);
  };
  const measure = async () => {
    await page.waitForTimeout(400);
    return app.evaluate(async ({ BrowserWindow, app: eapp }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const dbg = wc.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      const heap = ((await dbg.sendCommand('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
      const pid = wc.getOSProcessId();
      const kb = eapp.getAppMetrics().find((m) => m.pid === pid)?.memory.workingSetSize ?? 0;
      return { heapMB: heap / 1048576, rssMB: kb / 1024 };
    });
  };

  const t0 = Date.now();
  await open();
  const firstMs = Date.now() - t0;

  // Worker: the app's own origin, served with a CSP that forbids eval (wasm decoders only).
  const assets = path.join(process.env.SEC_EDIT_ELECTRON_APP!, 'dist/renderer/assets');
  const worker = fs.readdirSync(assets).find((f) => /^pdf\.worker.*\.mjs$/.test(f));
  expect(worker).toBeTruthy();
  const csp = await page.evaluate(async (f) => (await fetch(`app://sec-edit/assets/${f}`)).headers.get('content-security-policy'), worker!);
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).not.toMatch(/(^|\s)'unsafe-eval'/);

  // External link: nothing until the click, then exactly that URL through shell.openExternal.
  await page.waitForTimeout(300);
  expect(await app.evaluate(() => (globalThis as any).__opened)).toEqual([]);
  const appUrl = page.url();
  await page.locator('.se-pdf .page[data-page-number="1"] .annotationLayer a[href^="https:"]').click();
  await expect.poll(() => app.evaluate(() => (globalThis as any).__opened)).toEqual([URL_]);
  expect(page.url()).toBe(appUrl);
  expect(app.windows().length).toBe(1);

  const opened = await measure();
  await close();
  const closed = await measure();
  const cycles = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await open();
      await close();
    }
  };
  await cycles(10);
  const at10 = await measure(); // warm: pdf.js caches, lazy chunks
  await cycles(10);
  const at20 = await measure();
  const perCycleKB = ((at20.heapMB - at10.heapMB) * 1024) / 10;
  console.log(
    `[pdf] first open ${firstMs} ms; open: heap ${opened.heapMB.toFixed(1)} MB / renderer ${opened.rssMB.toFixed(0)} MB; ` +
      `closed: heap ${closed.heapMB.toFixed(1)} MB / ${closed.rssMB.toFixed(0)} MB; cycles 10 → 20: heap ${at10.heapMB.toFixed(1)} → ${at20.heapMB.toFixed(1)} MB ` +
      `(${perCycleKB.toFixed(1)} KB/cycle), renderer ${at10.rssMB.toFixed(0)} → ${at20.rssMB.toFixed(0)} MB`,
  );
  expect(closed.heapMB, 'heap after close').toBeLessThan(opened.heapMB + 0.5);
  expect(perCycleKB, 'renderer heap growth per open/close cycle').toBeLessThan(50);
});
