// Platform (browser mode): pasted images go through backend.writeBinary byte-exactly; the indexers read
// the workspace in pages and knowledge extraction runs in its worker.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { content, cursorTo, openNote } from './editor-helpers';

/** Every byte value (both directions, so all base64 alignments), then deterministic noise up to `size`.
 *  pasteBytes() repeats this in the page: shipping MBs of numbers over the protocol is slow (and the
 *  app's CSP forbids rebuilding it from source there). */
function pattern(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(size, 512));
  for (let i = 0; i < 256; i++) out[i] = i;
  for (let i = 0; i < 256; i++) out[256 + i] = 255 - i;
  let s = 12345;
  for (let i = 512; i < out.length; i++) out[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
  return out;
}

/** Pastes a file of `size` bytes (pattern, or zeros) built in the page, as a screenshot paste would. */
async function pasteBytes(page: Page, size: number, zeros = false) {
  await page.evaluate(
    ([n, z]) => {
      const out = new Uint8Array(Math.max(n, 512));
      if (!z) {
        for (let i = 0; i < 256; i++) out[i] = i;
        for (let i = 0; i < 256; i++) out[256 + i] = 255 - i;
        let s = 12345;
        for (let i = 512; i < out.length; i++) out[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
      }
      const dt = new DataTransfer();
      dt.items.add(new File([out], 'image.png', { type: 'image/png' }));
      const view = (window as any).__secEdit.editor.getView();
      view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [size, zeros] as const,
  );
}

/** RPC calls the page makes (method names), plus the bodies of writeFile calls. */
function trackRpc(page: Page) {
  const methods: string[] = [];
  const writeFileBodies: string[] = [];
  page.on('request', (r) => {
    const m = /\/api\/rpc\/(\w+)$/.exec(r.url());
    if (!m) return;
    methods.push(m[1]);
    if (m[1] === 'writeFile') writeFileBodies.push(r.postData() ?? '');
  });
  return { methods, writeFileBodies };
}

const lastEmbed = async (page: Page) => [...(await content(page)).matchAll(/!\[\[([^\]]+)\]\]/g)].map((m) => m[1]).pop()!;

test('pasted images are written with writeBinary, byte-exact (small and multi-MB)', async ({ page, ws }) => {
  const rpc = trackRpc(page);
  await ws.write('notes/bin.md', '# Bin\n\n');
  await ws.open(page);
  await openNote(page, 'notes/bin.md', 'Bin');
  await cursorTo(page, 'end');

  for (const size of [512, 6 * 1024 * 1024 + 1]) {
    const bytes = pattern(size);
    const before = rpc.methods.filter((m) => m === 'writeBinary').length;
    await pasteBytes(page, size);
    await expect.poll(() => rpc.methods.filter((m) => m === 'writeBinary').length).toBe(before + 1);
    const name = await lastEmbed(page);
    const file = path.join(ws.root, 'attachments', name);
    await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size, { timeout: 15000 }).toBe(bytes.length);
    expect(Buffer.compare(fs.readFileSync(file), Buffer.from(bytes)), `${size} bytes`).toBe(0);
    await page.keyboard.press('Enter');
  }
  // The old latin1 / windows-1252 text transport is gone.
  expect(rpc.writeFileBodies.some((b) => b.includes('windows-1252'))).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.files.value.filter((f: string) => f.startsWith('attachments/')).length)).toBe(2);
  // No temp files left in the attachments folder.
  expect(fs.readdirSync(path.join(ws.root, 'attachments')).every((n) => n.startsWith('Pasted image'))).toBe(true);
});

test('an attachment over the 50 MB limit is refused with a clear message', async ({ page, ws }) => {
  const rpc = trackRpc(page);
  await ws.write('notes/huge.md', '# Huge\n\n');
  await ws.open(page);
  await openNote(page, 'notes/huge.md', 'Huge');
  await cursorTo(page, 'end');
  await pasteBytes(page, 50 * 1024 * 1024 + 1, true);
  await expect(page.locator('.se-toast.error')).toContainText(/too large.*50 MB/);
  expect(rpc.methods).not.toContain('writeBinary'); // refused before encoding + upload
  expect(fs.existsSync(path.join(ws.root, 'attachments'))).toBe(false);
});

test('the server refuses an oversized writeBinary body with a JSON error (not a reset connection)', async ({ page, ws }) => {
  await ws.open(page);
  const r = await page.evaluate(async () => {
    const be = (window as any).__secEdit.backend;
    try {
      await be.writeBinary('big.bin', 'A'.repeat(70 * 1024 * 1024));
      return 'ok';
    } catch (e: any) {
      return `${e.code}: ${e.message}`;
    }
  });
  expect(r).toMatch(/^ETOOBIG: .*too large.*50 MB/);
  expect(fs.existsSync(path.join(ws.root, 'big.bin'))).toBe(false);
});

test('indexes stream in pages (no single readAllText) and knowledge extraction runs in a worker', async ({ page, ws }) => {
  const rpc = trackRpc(page);
  // A big note (> the in-thread threshold) so edits go through the worker too.
  const big = Array.from({ length: 900 }, (_, i) => `Line ${i} with [[kubernetes]] and #bulk text.`).join('\n');
  await ws.write('notes/big-links.md', `# Big\n\n${big}\n`);
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 20000 });
  expect(rpc.methods).toContain('readAllTextPage');
  expect(rpc.methods).not.toContain('readAllText');
  expect(await page.evaluate(() => (window as any).__secEdit.knowledge.extractionMode())).toBe('worker');
  // Both indexes saw the content.
  const k = await page.evaluate(() => {
    const kn = (window as any).__secEdit.knowledge;
    return { back: kn.backlinks('notes/kubernetes.md').filter((b: any) => b.from === 'notes/big-links.md').length, tag: kn.notesWithTag('bulk') };
  });
  expect(k.back).toBe(900);
  expect(k.tag).toEqual(['notes/big-links.md']);
  const hits = await page.evaluate(async () => (await (window as any).__secEditSearch.search('Line 777 with', {}, 'probe')).totalFiles);
  expect(hits).toBe(1);

  // Typing in the big note: the index follows (worker path), unsaved text included.
  await openNote(page, 'notes/big-links.md', 'Big');
  await cursorTo(page, { after: '# Big' });
  await page.keyboard.type(' [[Daily notes]] #freshtag');
  await expect
    .poll(() => page.evaluate(() => (window as any).__secEdit.knowledge.outgoing('notes/big-links.md').some((o: any) => o.path === 'notes/Daily notes.md')), { timeout: 8000 })
    .toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.knowledge.notesWithTag('freshtag'))).toEqual(['notes/big-links.md']);
});
