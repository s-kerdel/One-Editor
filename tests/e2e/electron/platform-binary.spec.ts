// Platform features in the real Electron app: writeBinary over IPC (pasted image, byte-exact) and the
// search workers loading from the app:// scheme and fetching the workspace text themselves
// (app://sec-edit/__index/, served by the indexer thread — never through the UI thread).
import { test, expect, fs, path } from './fixture';

test('pasting an image writes it byte-exact over IPC; the search workers feed themselves over app://', async ({ el }) => {
  const notes = path.join(el.ws, 'notes');
  fs.writeFileSync(path.join(notes, 'paste-el.md'), '# Paste\n\n');
  const { page } = await el.launch();
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 30000 });
  expect(await page.evaluate(() => (window as any).__secEditSearch.mode.value)).toBe('worker');
  expect(await page.evaluate(() => (window as any).__secEditSearch.lastBuild?.fed), 'built from the app:// index channel').toBe(true);
  expect(await page.evaluate(() => (window as any).__secEdit.knowledge.notes().length), 'knowledge metadata from the search workers').toBeGreaterThan(3);

  await page.evaluate(() => (window as any).__secEdit.openFile('notes/paste-el.md'));
  await expect(page.locator('.cm-content')).toContainText('Paste');
  const size = 3 * 1024 * 1024 + 7;
  await page.evaluate((n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < 256; i++) out[i] = i;
    for (let i = 0; i < 256; i++) out[256 + i] = 255 - i;
    let s = 99;
    for (let i = 512; i < n; i++) out[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
    const view = (window as any).__secEdit.editor.getView();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    const dt = new DataTransfer();
    dt.items.add(new File([out], 'image.png', { type: 'image/png' }));
    view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, size);
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent() as string)).toMatch(/!\[\[Pasted image [^\]]+\.png\]\]/);
  const name = /!\[\[(Pasted image [^\]]+\.png)\]\]/.exec(await page.evaluate(() => (window as any).__secEdit.editor.getContent() as string))![1];
  const file = path.join(el.ws, 'attachments', name);
  await expect.poll(() => fs.existsSync(file) && fs.statSync(file).size, { timeout: 15000 }).toBe(size);

  const want = new Uint8Array(size);
  for (let i = 0; i < 256; i++) want[i] = i;
  for (let i = 0; i < 256; i++) want[256 + i] = 255 - i;
  let s = 99;
  for (let i = 512; i < size; i++) want[i] = (s = (Math.imul(s, 1103515245) + 12345) >>> 0) >>> 24;
  expect(Buffer.compare(fs.readFileSync(file), Buffer.from(want))).toBe(0);
});
