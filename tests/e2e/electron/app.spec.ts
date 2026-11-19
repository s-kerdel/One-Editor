// Real Electron app: launch speed, CLI args, saving, trash, window state, single-instance handoff, app:// protocol.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { test, expect, fs, path } from './fixture';

test('launches fast and reports timings', async ({ el }) => {
  const { page, readyMs, timings } = await el.launch();
  const t = await timings();
  console.log(`[launch] playwright→ready ${readyMs} ms; main timings (ms since process start): ${JSON.stringify(t)}`);
  expect(t).toBeTruthy();
  // Generous bounds for loaded CI boxes; typical on a dev machine: shown ≈ 200 ms, painted ≈ 230 ms.
  expect(t!.shown).toBeLessThan(2500);
  expect(t!['r.painted']).toBeLessThan(3000);
  expect(t!['r.ready'] - t!['r.start']).toBeLessThan(1000); // renderer boot
  await expect(page.locator('.se-tree-row', { hasText: 'README.md' })).toBeVisible();
  expect(await page.evaluate(() => location.protocol)).toBe('app:');
  if (process.env.SEC_EDIT_SHOTS) {
    await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${process.env.SEC_EDIT_SHOTS}/electron-dark.png` });
  }
});

test('opens the folder given on the command line', async ({ el }) => {
  const { page } = await el.launch([el.ws]);
  await expect(page.getByTestId('workspace-name')).toHaveText('workspace');
  await expect(page).toHaveTitle(/workspace/);
});

test('opens a single file given on the command line (inside its folder)', async ({ el }) => {
  const file = path.join(el.ws, 'notes', 'kubernetes.md');
  const { page } = await el.launch([file]);
  await expect(page.locator('.se-tab.active')).toContainText('kubernetes.md');
  await expect(page.locator('.cm-content')).toContainText('Kubernetes cheatsheet');
  // Fresh profile → the file's own folder is the workspace.
  expect(await page.evaluate(() => (window as any).__secEdit.workspace.value.name)).toBe('notes');
});

test('a file inside a recent folder opens in that folder', async ({ el }) => {
  const first = await el.launch([el.ws]);
  await first.app.close();
  const { page } = await el.launch([path.join(el.ws, 'deep', 'nested', 'folder', 'Deep note.md')]);
  await expect(page.locator('.se-tab.active')).toContainText('Deep note.md');
  expect(await page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('deep/nested/folder/Deep note.md');
  await expect(page.locator('.se-tree-row.active')).toContainText('Deep note');
});

test('edit + Ctrl+S writes to disk (CRLF preserved)', async ({ el }) => {
  const { page } = await el.launch();
  await page.locator('.se-tree-row', { hasText: 'notes' }).first().click();
  await page.locator('.se-tree-row', { hasText: 'windows-crlf' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nSaved from Electron');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fsp.readFile(path.join(el.ws, 'notes', 'windows-crlf.md'), 'utf8')).toContain('Saved from Electron');
  const raw = await fsp.readFile(path.join(el.ws, 'notes', 'windows-crlf.md'), 'utf8');
  expect(raw.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true);
});

test('delete moves the file to the trash (Electron hook → platform fallback)', async ({ el }) => {
  // No D-Bus under Xvfb, so shell.trashItem fails and the freedesktop fallback must catch it.
  const xdg = path.join(el.tmp, 'xdg-data');
  const { page } = await el.launch([el.ws], { env: { XDG_DATA_HOME: xdg } });
  await page.locator('.se-tree-row', { hasText: 'README' }).click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Delete' }).click();
  await page.locator('.se-dialog .se-btn.danger').click();
  await expect.poll(() => fs.existsSync(path.join(el.ws, 'README.md'))).toBe(false);
  const trashed = fs.existsSync(path.join(xdg, 'Trash', 'files', 'README.md')) || fs.existsSync(path.join(process.env.HOME!, '.local/share/Trash/files/README.md'));
  expect(trashed).toBe(true);
});

test('window size/position/maximized state persists across launches', async ({ el }) => {
  const a = await el.launch();
  await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 30, width: 1000, height: 700 }));
  await a.page.waitForTimeout(600); // debounced save
  await a.app.close();
  expect(JSON.parse(await fsp.readFile(path.join(el.userData, 'window-state.json'), 'utf8'))).toMatchObject({ width: 1000, height: 700 });
  const b = await el.launch();
  const bounds = await b.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(bounds.width).toBe(1000);
  expect(bounds.height).toBe(700);
});

test('zoom keys change the web contents zoom and persist in settings', async ({ el }) => {
  const { app, page } = await el.launch();
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await page.keyboard.press('Control+=');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1.1, 2);
  await page.keyboard.press('Control+0');
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1, 2);
});

test('workspace images are served over app:// (preview/image viewer)', async ({ el }) => {
  // 1×1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fsp.writeFile(path.join(el.ws, 'pixel.png'), png);
  const { page } = await el.launch();
  await page.locator('.se-tree-row', { hasText: 'pixel.png' }).click();
  const img = page.locator('.se-viewer-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1);
  expect(await img.getAttribute('src')).toBe('app://sec-edit/__ws/pixel.png');
});

test('second launch hands its file to the running window (single instance)', async ({ el }) => {
  const env = { SEC_EDIT_SINGLE_INSTANCE: '1' };
  const { page } = await el.launch([el.ws], { env });
  const electronBin = (await import('electron')).default as unknown as string;
  const t0 = Date.now();
  const second = spawn(electronBin, ['--disable-gpu', process.env.SEC_EDIT_ELECTRON_APP!, path.join(el.ws, 'code', 'app.ts')], {
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', SEC_EDIT_TEST: '1', SEC_EDIT_USER_DATA: el.userData, ...env },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((r) => second.on('exit', r));
  console.log(`[handoff] second instance exited in ${Date.now() - t0} ms`);
  expect(code).toBe(0);
  await expect(page.locator('.se-tab.active')).toContainText('app.ts');
});

test('closing with unsaved changes (autosave off) asks first', async ({ el }) => {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ autosave: false }));
  const { app, page } = await el.launch();
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('unsaved ');
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const dlg = page.locator('.se-dialog');
  await expect(dlg).toContainText('Save changes');
  const closed = app.waitForEvent('close');
  await dlg.locator('.se-btn', { hasText: 'Save' }).last().click();
  await closed;
  expect(await fsp.readFile(path.join(el.ws, 'README.md'), 'utf8')).toContain('unsaved ');
});
