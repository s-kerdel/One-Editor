// Security review of the real Electron app: renderer isolation, navigation lock, app:// protocol,
// permissions, preload surface.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';

test('renderer is isolated: no Node, minimal bridge, hardened webPreferences', async ({ el }) => {
  const { app, page } = await el.launch([el.ws]);
  const g = await page.evaluate(() => ({ require: typeof (window as any).require, process: typeof (window as any).process, module: typeof (window as any).module }));
  expect(g).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  expect((await page.evaluate(() => Object.keys((window as any).secEditBridge))).sort()).toEqual(
    ['approveClose', 'frame', 'getPathForFile', 'gpuStatus', 'indexToken', 'invoke', 'on', 'os', 'ready', 'relaunch', 'setTitleBarOverlay', 'setZoom', 'terminal', 'toggleDevTools', 'vault', 'webServer'].sort(),
  );
  // "Start web server": fixed webserver:* calls only (validated again in main, src/main/web-server.ts).
  expect(await page.evaluate(() => Object.entries((window as any).secEditBridge.webServer).map(([k, v]) => `${k}:${typeof v}`).sort())).toEqual(
    ['onChange', 'open', 'start', 'status', 'stop'].map((k) => `${k}:function`),
  );
  // The secrets vault ({{variables}}): fixed vault:* calls only (validated again in main, src/main/vault.ts).
  expect(await page.evaluate(() => Object.entries((window as any).secEditBridge.vault).map(([k, v]) => `${k}:${typeof v}`).sort())).toEqual(
    ['get', 'has', 'remove', 'set', 'status'].map((k) => `${k}:function`),
  );
  // The text channel for the search workers needs the per-launch token.
  expect(
    await page.evaluate(async () => {
      const bad = await fetch('app://sec-edit/__index/page').then((r) => r.status);
      const wrong = await fetch('app://sec-edit/__index/page', { headers: { 'x-sec-edit-index': 'nope' } }).then((r) => r.status);
      const good = await fetch('app://sec-edit/__index/page', { headers: { 'x-sec-edit-index': (window as any).secEditBridge.indexToken } }).then((r) => r.status);
      return { bad, wrong, good };
    }),
  ).toEqual({ bad: 403, wrong: 403, good: 200 });
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
  expect(await fsp.readFile(path.join(el.ws, 'README.md'), 'utf8')).toContain('slow reader') // trailing space trimmed on save;
});

// ---- a taken-over page (XSS in a note) must not widen its reach ------------------------------------

test('the page cannot open a folder main has not seen: no home folder, no parent; subfolders and recents work', async ({ el }) => {
  const other = path.join(el.tmp, 'other');
  await fsp.mkdir(other);
  await fsp.writeFile(path.join(other, 'private.md'), 'PRIVATE');
  const { app, page } = await el.launch([el.ws]);
  const open = (p: string) => page.evaluate((x) => (window as any).__secEdit.backend.openWorkspace(x).then((w: { root: string }) => w.root, (e: { code?: string }) => `refused:${e.code}`), p);
  const home = await app.evaluate(() => require('node:os').homedir()).catch(() => process.env.HOME!);
  for (const p of [other, el.tmp, path.dirname(el.ws), home, '/', '/etc']) expect(await open(p), p).toBe('refused:EACCES');
  expect(await page.evaluate(() => (window as any).__secEdit.workspace.value.root)).toBe(el.ws);
  await expect(page.evaluate(() => (window as any).__secEdit.backend.readFile('../other/private.md'))).rejects.toThrow();
  // What main saw itself passes: the dialog's answer (stood in for here), then it is a recent folder.
  await app.evaluate((_e, p) => (globalThis as any).__secEditVouch(p), other);
  expect(await open(other)).toBe(other);
  expect(await open(el.ws)).toBe(el.ws); // recent
  expect(await open(path.join(el.ws, 'notes'))).toBe(path.join(el.ws, 'notes')); // inside the open folder ("Open as project")
  expect(await open(el.tmp)).toBe('refused:EACCES');
});

test('links out of the folder are not served, read or written — app://, RPC and the tree', async ({ el }) => {
  const outside = path.join(el.tmp, 'outside');
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'secret.md'), 'TOP SECRET');
  await fsp.symlink(outside, path.join(el.ws, 'out-dir'), 'dir');
  await fsp.symlink(path.join(outside, 'secret.md'), path.join(el.ws, 'out-file.md'));
  await fsp.symlink(path.join(el.ws, 'README.md'), path.join(el.ws, 'in-file.md'));
  const { page } = await el.launch([el.ws]);
  await expect(page.locator('.se-tree-row', { hasText: 'in-file.md' })).toBeVisible();
  await expect(page.locator('.se-tree-row', { hasText: 'out-file.md' })).toHaveCount(0);
  await expect(page.locator('.se-tree-row', { hasText: 'out-dir' })).toHaveCount(0);
  const res = await page.evaluate(async () => {
    const b = (window as any).__secEdit.backend;
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code);
    const get = (u: string) => fetch(u).then(async (r) => `${r.status}:${r.ok ? (await r.text()).slice(0, 10) : ''}`, () => 'blocked');
    return {
      wsDir: await get('app://sec-edit/__ws/out-dir/secret.md'),
      wsFile: await get('app://sec-edit/__ws/out-file.md'),
      wsInside: (await get('app://sec-edit/__ws/in-file.md')).slice(0, 4),
      read: await code(b.readFile('out-dir/secret.md')),
      readLink: await code(b.readFile('out-file.md')),
      write: await code(b.writeFile('out-file.md', 'OVERWRITTEN')),
      create: await code(b.createFile('out-dir/new.md', 'x')),
      remove: await code(b.remove('out-dir/secret.md', { permanent: true })),
      inside: await code(b.readFile('in-file.md')),
    };
  });
  expect(res).toEqual({ wsDir: '404:', wsFile: '404:', wsInside: '200:', read: 'OUTSIDE_WORKSPACE', readLink: 'OUTSIDE_WORKSPACE', write: 'OUTSIDE_WORKSPACE', create: 'OUTSIDE_WORKSPACE', remove: 'OUTSIDE_WORKSPACE', inside: 'ok' });
  expect(await fsp.readFile(path.join(outside, 'secret.md'), 'utf8')).toBe('TOP SECRET');
  expect(await fsp.readdir(outside)).toEqual(['secret.md']);
});

test('the vault only serves the open folder’s keys', async ({ el }) => {
  const { page } = await el.launch([el.ws]);
  const scope = el.ws.replace(/\\/g, '/');
  const res = await page.evaluate(async (s) => {
    const v = (window as any).secEditBridge.vault;
    const mine = `${s}::prod/db_pass`;
    const theirs = '/home/someone/other-project::prod/db_pass';
    return {
      setMine: (await v.set(mine, 'm')).ok,
      setTheirs: (await v.set(theirs, 't')).error?.code,
      getMine: (await v.get(mine)).result,
      getTheirs: (await v.get(theirs)).error?.code,
      getParent: (await v.get(`${s.slice(0, s.lastIndexOf('/'))}::x`)).error?.code,
      removeTheirs: (await v.remove(theirs)).error?.code,
      has: (await v.has([mine, theirs, 'shared-key'])).result,
      shared: (await v.set('shared-key', 'explicit vault:<key> names stay shared')).ok,
    };
  }, scope);
  expect(res).toEqual({ setMine: true, setTheirs: 'EACCES', getMine: 'm', getTheirs: 'EACCES', getParent: 'EACCES', removeTheirs: 'EACCES', has: [`${scope}::prod/db_pass`], shared: true });
});

test('a shared vault key saved by another folder needs the user’s native OK; the answer "allow" is remembered', async ({ el }) => {
  // Saved earlier by another folder (vault file as that session left it; test builds use plain-text safeStorage).
  const first = await el.launch([el.ws]);
  expect((await first.page.evaluate(() => (window as any).secEditBridge.vault.set('prod-db', 'hunter2'))).ok).toBe(true);
  expect((await first.page.evaluate(() => (window as any).secEditBridge.vault.get('prod-db'))).result).toBe('hunter2'); // its own: no question
  await first.app.close();
  const other = path.join(el.tmp, 'cloned-repo');
  await fsp.mkdir(other);
  await fsp.writeFile(path.join(other, 'README.md'), '# cloned');
  const get = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).secEditBridge.vault.get('prod-db'));
  // The user says no (stub of the native dialog): no value, an error instead.
  const denied = await el.launch([other], { env: { SEC_EDIT_TEST_VAULT_CONFIRM: 'deny' } });
  expect(await get(denied.page)).toMatchObject({ ok: false, error: { code: 'EACCES' } });
  expect(JSON.stringify(await get(denied.page))).not.toContain('hunter2');
  await denied.app.close();
  // The user says yes: served, and remembered for that folder in the vault file (not in settings.json).
  const allowed = await el.launch([other], { env: { SEC_EDIT_TEST_VAULT_CONFIRM: 'allow' } });
  expect(await get(allowed.page)).toMatchObject({ ok: true, result: 'hunter2' });
  await allowed.app.close();
  const vaultFile = JSON.parse(await fsp.readFile(path.join(el.userData, 'vault.json'), 'utf8'));
  expect(Object.values(vaultFile.grants)).toEqual([['prod-db']]);
  expect(vaultFile.owners['prod-db']).toBe(el.ws.replace(/\\/g, '/'));
  expect(await fsp.readFile(path.join(el.userData, 'settings.json'), 'utf8').catch(() => '')).not.toContain('prod-db');
  const later = await el.launch([other], { env: { SEC_EDIT_TEST_VAULT_CONFIRM: 'deny' } }); // not asked again
  expect(await get(later.page)).toMatchObject({ ok: true, result: 'hunter2' });
});
