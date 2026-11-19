// Security review of the real Electron app: renderer isolation, navigation lock, app:// protocol,
// permissions, preload surface.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

test('renderer is isolated: no Node, minimal bridge, hardened webPreferences', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  const g = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, module: typeof (window as any).module }));
  expect(g).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  expect((await page.evaluate(() => Object.keys((window as any).secEditBridge))).sort()).toEqual(
    ['approveClose', 'frame', 'getPathForFile', 'invoke', 'on', 'os', 'ready', 'relaunch', 'setTitleBarOverlay', 'setZoom', 'terminal', 'toggleDevTools', 'vault'].sort(),
  );
  // The secrets vault ({{variables}}): fixed vault:* calls only (validated again in main, src/main/vault.ts).
  expect(await page.evaluate(() => Object.entries((window as any).secEditBridge.vault).map(([k, v]) => `${k}:${typeof v}`).sort())).toEqual(
    ['get', 'has', 'remove', 'set', 'status'].map((k) => `${k}:function`),
  );
  // The integrated terminal's bridge: fixed term:* calls only (arguments re-validated in main, src/main/terminal.ts).
  expect(await page.evaluate(() => Object.entries((window as any).secEditBridge.terminal).map(([k, v]) => `${k}:${typeof v}`).sort())).toEqual(
    ['ack', 'kill', 'onData', 'onExit', 'resize', 'shells', 'spawn', 'write'].map((k) => `${k}:function`),
  );
  // Unknown IPC channels are refused by the preload.
  expect(await page.evaluate(() => { try { (window as any).secEditBridge.on('rpc:writeFile', () => {}); return 'subscribed'; } catch { return 'refused'; } })).toBe('refused');
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = (BrowserWindow.getAllWindows()[0].webContents as any).getLastWebPreferences() as Record<string, unknown>;
    return { contextIsolation: p.contextIsolation, sandbox: p.sandbox, nodeIntegration: p.nodeIntegration, webSecurity: p.webSecurity, allowRunningInsecureContent: p.allowRunningInsecureContent, webviewTag: p.webviewTag };
  });
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });
});

test('the window cannot be navigated away — not even to a workspace file', async ({ el }) => {
  await fsp.writeFile(path.join(el.ws, 'evil.html'), '<script>document.title="pwned"</script><h1>evil</h1>');
  const { app, page } = await el.launch([el.ws]);
  const start = page.url();
  for (const target of ['app://sec-edit/__ws/evil.html', 'app://sec-edit/%5F%5Fws/evil.html', 'file:///etc/passwd', 'https://example.com/', 'javascript:document.title="pwned"']) {
    await page.evaluate((t) => { try { location.href = t; } catch {} }, target);
    await page.waitForTimeout(250);
    expect(page.url(), target).toBe(start);
  }
  // window.open: never a new Electron window (external http(s) goes to the OS browser instead).
  await page.evaluate(() => { window.open('app://sec-edit/__ws/evil.html'); window.open('file:///etc/passwd'); });
  await page.waitForTimeout(300);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  expect(await page.title()).not.toBe('pwned');
  // Still our live app (cancelled navigations leave Playwright "waiting", so ask the page directly).
  expect(await page.evaluate(() => document.documentElement.dataset.ready)).toBe('true');
});

test('app:// serves workspace files sandboxed and never outside the workspace', async ({ el }) => {
  await fsp.writeFile(path.join(el.tmp, 'outside.txt'), 'SECRET');
  await fsp.mkdir(path.join(el.ws, 'img'), { recursive: true });
  await fsp.writeFile(path.join(el.ws, 'img', 'a #1 50%.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const { page } = await el.launch([el.ws]);
  const r = await page.evaluate(async () => {
    const get = async (u: string) => {
      try {
        const res = await fetch(u);
        return { status: res.status, body: (await res.text()).slice(0, 40), csp: res.headers.get('content-security-policy') };
      } catch (e) {
        return { status: -1, body: String(e), csp: null };
      }
    };
    return {
      ok: await get(`app://sec-edit/__ws/img/${encodeURIComponent('a #1 50%.svg')}`),
      dir: await get('app://sec-edit/__ws/img'),
      up: await get('app://sec-edit/__ws/..%2Foutside.txt'),
      up2: await get('app://sec-edit/__ws/%2e%2e/%2e%2e/outside.txt'),
      renderer: await get('app://sec-edit/..%2F..%2F..%2Foutside.txt'),
      bad: await get('app://sec-edit/%E0%A4%A'),
    };
  });
  expect(r.ok.status).toBe(200);
  expect(r.ok.csp).toContain('sandbox');
  expect(r.dir.status).toBe(404); // no directory listing page on our origin
  for (const k of ['up', 'up2', 'renderer', 'bad'] as const) expect(r[k].body, k).not.toContain('SECRET');
  expect(r.bad.status).toBe(400);
});

test('permissions an editor never needs are denied', async ({ el }) => {
  const { page } = await el.launch([el.ws]);
  const res = await page.evaluate(async () => ({
    notification: await Notification.requestPermission(),
    media: await navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name),
    geo: await new Promise((r) => navigator.geolocation.getCurrentPosition(() => r('granted'), (e) => r(`denied:${e.code}`))),
  }));
  expect(res.notification).toBe('denied');
  expect(res.media).not.toBe('granted');
  expect(res.geo).not.toBe('granted');
});

test('a "Save changes?" prompt is not cut short: the window waits for the answer', async ({ el }) => {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ autosave: false }));
  const { app, page } = await el.launch();
  await page.locator('.se-tree-row', { hasText: 'README' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('slow reader ');
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const dlg = page.locator('.se-dialog');
  await expect(dlg).toContainText('Save changes');
  await page.waitForTimeout(5500); // longer than the old 4 s "renderer hung" guard
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  const closed = app.waitForEvent('close');
  await dlg.locator('.se-btn', { hasText: 'Save' }).last().click();
  await closed;
  expect(await fsp.readFile(path.join(el.ws, 'README.md'), 'utf8')).toContain('slow reader ');
});
