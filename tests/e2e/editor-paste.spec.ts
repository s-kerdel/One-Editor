import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { content, cursorTo, openNote } from './editor-helpers';

/** A real PNG drawn on a canvas; kept on window.__png and returned as bytes. */
async function makePng(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 24;
    const g = c.getContext('2d')!;
    g.fillStyle = '#e5484d';
    g.fillRect(0, 0, 40, 24);
    g.fillStyle = '#3b6ee8';
    g.fillRect(10, 4, 20, 16);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    (window as any).__png = blob;
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
}

/** Dispatches a paste event carrying files (as the OS clipboard would for a screenshot). */
async function pasteFiles(page: Page, files: Array<{ name: string; type: string; bytes?: number[] }>) {
  await page.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.bytes ? new Uint8Array(f.bytes) : (window as any).__png], f.name, { type: f.type }));
    const view = (window as any).__secEdit.editor.getView();
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, files);
}

const allBytes = Array.from({ length: 1024 }, (_, i) => (i * 7 + (i >> 8)) & 255);

test('pasting an image saves it to attachments/ (byte-exact) and embeds ![[Pasted image …]]', async ({ page, ws }) => {
  await ws.write('notes/paste.md', '# Paste\n\n');
  await ws.open(page);
  await openNote(page, 'notes/paste.md', 'Paste');
  await cursorTo(page, 'end');
  const png = await makePng(page);
  await pasteFiles(page, [{ name: 'image.png', type: 'image/png' }]);
  await expect.poll(() => content(page)).toMatch(/!\[\[Pasted image \d{8}-\d{6}\.png\]\]$/);
  const name = /!\[\[(Pasted image \d{8}-\d{6}\.png)\]\]/.exec(await content(page))![1];
  const file = path.join(ws.root, 'attachments', name);
  await expect.poll(() => fs.existsSync(file), { timeout: 8000 }).toBe(true);
  expect(Buffer.compare(fs.readFileSync(file), Buffer.from(png))).toBe(0);
  // Rendered inline once the tree knows the file; the note itself is saved with the link.
  await cursorTo(page, { after: '# Paste' });
  await expect.poll(() => page.locator('.se-image img').evaluate((i: HTMLImageElement) => i.naturalWidth).catch(() => 0), { timeout: 8000 }).toBe(40);
  await expect.poll(() => ws.read('notes/paste.md'), { timeout: 8000 }).toContain(`![[${name}]]`);
  expect(await page.evaluate(() => (window as any).__secEdit.files.value.some((f: string) => f.startsWith('attachments/Pasted image')))).toBe(true);

  // Same second → unique names (" 1" suffix), all bytes 0..255 survive the text transport.
  await page.keyboard.press('Enter');
  await pasteFiles(page, [
    { name: 'image.png', type: 'image/png', bytes: allBytes },
    { name: 'image.png', type: 'image/png', bytes: allBytes.slice().reverse() },
  ]);
  await expect.poll(() => content(page)).toMatch(/!\[\[Pasted image \d{8}-\d{6}( \d)?\.png\]\]\n!\[\[Pasted image \d{8}-\d{6} \d\.png\]\]/);
  // The pair went in above the first image (cursor was moved to the heading).
  const names = [...(await content(page)).matchAll(/!\[\[(Pasted image [^\]]+)\]\]/g)].map((m) => m[1]);
  expect(new Set(names).size).toBe(3);
  for (const [i, want] of [allBytes, allBytes.slice().reverse()].entries()) {
    const f = path.join(ws.root, 'attachments', names[i]);
    await expect.poll(() => fs.existsSync(f), { timeout: 8000 }).toBe(true);
    expect(Buffer.compare(fs.readFileSync(f), Buffer.from(want))).toBe(0);
  }
});

test('attachments.location = "note" puts files next to the note; backend.writeBinary is preferred when present', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'notes/deep'), { recursive: true });
  await ws.write('notes/deep/here.md', 'Here\n');
  await ws.open(page);
  await openNote(page, 'notes/deep/here.md', 'Here');
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, 'attachments.location': 'note' };
  });
  await cursorTo(page, 'end');
  await makePng(page);
  await pasteFiles(page, [{ name: 'image.png', type: 'image/png' }]);
  await expect.poll(() => content(page)).toMatch(/!\[\[Pasted image [^\]]+\]\]$/);
  const name = /!\[\[(Pasted image [^\]]+)\]\]/.exec(await content(page))![1];
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'notes/deep', name)), { timeout: 8000 }).toBe(true);

  // Stubbed optional backend capability: called with workspace path + base64; the text fallback is not used.
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    (window as any).__wb = [];
    app.backend.writeBinary = async (p: string, b64: string) => {
      (window as any).__wb.push([p, b64]);
      return { mtime: Date.now() };
    };
    app.settings.value = { ...app.settings.value, 'attachments.location': 'subfolder', 'attachments.folder': 'assets' };
  });
  await page.keyboard.press('Enter');
  await pasteFiles(page, [{ name: 'shot.webp', type: 'image/webp', bytes: allBytes }]);
  await expect.poll(() => page.evaluate(() => (window as any).__wb.length)).toBe(1);
  const [p, b64] = await page.evaluate(() => (window as any).__wb[0]);
  expect(p).toMatch(/^notes\/deep\/assets\/Pasted image \d{8}-\d{6}\.webp$/);
  expect(Buffer.compare(Buffer.from(b64, 'base64'), Buffer.from(allBytes))).toBe(0);
  expect(fs.existsSync(path.join(ws.root, p))).toBe(false);
  expect(await content(page)).toContain(`![[${p.split('/').pop()}]]`);
});

test('rich HTML pastes as Markdown (Ctrl+V), Ctrl+Shift+V pastes plain text, a URL stays a plain URL', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.write('notes/html.md', 'Start\n');
  await ws.open(page);
  await openNote(page, 'notes/html.md', 'Start');
  await cursorTo(page, 'end');
  const html =
    '<meta charset="utf-8"><h2>Title</h2><p>Some <b>bold</b>, <i>italic</i> and a <a href="https://x.dev/a">link</a>.</p>' +
    '<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul><pre><code class="language-js">let a = 1;</code></pre>' +
    '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const plain = 'Title\nSome bold, italic and a link.\none\ntwo\nnested\nlet a = 1;\nA\tB\n1\t2';
  await page.evaluate(
    async ([h, t]) => navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([h], { type: 'text/html' }), 'text/plain': new Blob([t], { type: 'text/plain' }) })]),
    [html, plain],
  );
  await page.keyboard.press('Control+v');
  await expect
    .poll(() => content(page))
    .toBe('Start\n## Title\n\nSome **bold**, *italic* and a [link](https://x.dev/a).\n\n- one\n- two\n  - nested\n\n```js\nlet a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');

  await cursorTo(page, 'end');
  await page.keyboard.insertText('\n\n');
  await page.keyboard.press('Control+Shift+v');
  await expect.poll(() => content(page)).toMatch(/\| 1 +\| 2 +\|\n\nTitle\nSome bold, italic and a link\.\none/);

  await page.keyboard.press('Enter');
  await page.evaluate(() => navigator.clipboard.writeText('https://example.com/some/page?x=1'));
  await page.keyboard.press('Control+v');
  await expect.poll(() => content(page)).toMatch(/\nhttps:\/\/example\.com\/some\/page\?x=1$/);
});

test('dragging a note / image from the file tree inserts [[link]] / ![[embed]]; dropped OS files are copied', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'img'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'img', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await ws.write('notes/drop.md', 'Drop here:\n\nend\n');
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('img/logo.png'));
  await openNote(page, 'notes/drop.md', 'Drop here');
  await page.locator('.se-tree-row', { hasText: 'img' }).first().click();
  const target = page.locator('.cm-line', { hasText: 'Drop here:' });
  await page.locator('.se-tree-row', { hasText: 'kubernetes' }).first().dragTo(target, { targetPosition: { x: 400, y: 8 } });
  await expect.poll(() => content(page)).toContain('Drop here:[[kubernetes]]');
  await page.locator('.se-tree-row', { hasText: 'logo.png' }).first().dragTo(page.locator('.cm-line', { hasText: 'end' }), { targetPosition: { x: 300, y: 8 } });
  await expect.poll(() => content(page)).toContain('end![[logo.png]]');

  // A file dropped from the OS (browser mode: no native path) is copied into attachments/ under its own name.
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'report: v1.pdf', { type: 'application/pdf' }));
    const view = (window as any).__secEdit.editor.getView();
    const r = view.coordsAtPos(0);
    view.contentDOM.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: r.left + 1, clientY: r.top + 2, bubbles: true, cancelable: true }));
  }, allBytes);
  await expect.poll(() => content(page)).toMatch(/^!\[\[report v1\.pdf\]\]/);
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'attachments', 'report v1.pdf')), { timeout: 8000 }).toBe(true);
  expect(Buffer.compare(fs.readFileSync(path.join(ws.root, 'attachments', 'report v1.pdf')), Buffer.from(allBytes))).toBe(0);
});
