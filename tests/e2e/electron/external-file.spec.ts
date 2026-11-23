// A file handed to the app from outside (Finder "Open With", argv, second instance, drop) opens as a tab and
// never moves the open folder; outside files are editable, saved, and watched; main serves only what it saw.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

test('a file outside the open folder opens as an editable tab; the folder stays', async ({ el }) => {
  const outside = path.join(el.tmp, 'elsewhere');
  await fsp.mkdir(outside);
  const file = path.join(outside, 'loose.txt');
  await fsp.writeFile(file, 'one\r\ntwo\r\n');
  const { app, page } = await el.launch([el.ws]);
  const ask = (p: string) => page.evaluate((x) => (window as any).__secEdit.backend.openExternalFile(x).then((id: string) => id, (e: { code?: string }) => `refused:${e.code}`), p);
  // The page cannot make a path up: main must have seen that very file.
  expect(await ask(file)).toBe('refused:EACCES');
  expect(await ask(path.join(el.ws, '..', 'elsewhere', 'loose.txt'))).toBe('refused:EACCES');
  const rpc = (code: string) => page.evaluate((c) => (window as any).__secEdit.backend.readFile(c).then(() => 'read', (e: { code?: string }) => e.code), code);
  expect(await rpc(`::ext:${file}`)).toBe('EACCES');
  // What the OS hands over: second instance / open-file / drop (vouched, then sent to the window).
  await app.evaluate(({ BrowserWindow }, p) => {
    (globalThis as any).__secEditVouch(p);
    BrowserWindow.getAllWindows()[0].webContents.send('app:openRequest', [p]);
  }, file);
  const tab = page.locator('.se-tab.active');
  await expect(tab).toContainText('loose.txt');
  await expect(tab).toHaveAttribute('title', file.replace(/\\/g, '/'));
  expect(await page.evaluate(() => (window as any).__secEdit.workspace.value.root)).toBe(el.ws);
  // Edit + save: bytes on disk keep the CRLF.
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('three');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => fsp.readFile(file, 'utf8')).toBe('one\r\ntwo\r\nthree');
  // A change on disk by another program shows up (clean doc follows the disk).
  await fsp.writeFile(file, 'changed outside\r\n');
  await expect(page.locator('.cm-content')).toContainText('changed outside', { timeout: 10_000 });
  expect(await page.evaluate(() => (window as any).__secEdit.workspace.value.root)).toBe(el.ws);
});
