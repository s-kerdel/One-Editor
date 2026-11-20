// The packaged Linux build (npm run package:linux) must launch from app.asar and work end to end.
// It ships with its fuses set (scripts/fuses.mjs): no --inspect, no NODE_OPTIONS — so Playwright's
// Electron launcher (which attaches through --inspect) cannot drive it, and SEC_EDIT_* test hooks are
// ignored (src/main/env-guard.ts). It is started like a user would start it and driven through
// Chromium's own DevTools port, with a private profile (--user-data-dir).
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = path.join(root, 'release/sec-edit-linux-x64/sec-edit');
const winZip = path.join(root, 'release/sec-edit-win32-x64.zip');
const winExe = path.join(root, 'release/sec-edit-win32-x64/sec-edit.exe');

test.skip(process.platform !== 'linux' || !fs.existsSync(bin), 'run `npm run package:linux` first');

const running: Array<{ child: ChildProcess; browser?: Browser }> = [];
test.afterEach(async () => {
  for (const r of running.splice(0)) {
    await r.browser?.close().catch(() => {});
    if (r.child.exitCode === null) r.child.kill('SIGKILL');
  }
});

/** Starts the packaged app and attaches to its window over the DevTools port Chromium announces on stderr. */
async function launchPackaged(args: string[], o: { userData: string; env?: Record<string, string> }): Promise<{ page: Page; child: ChildProcess; output: () => string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), DISPLAY: process.env.DISPLAY || ':99', SEC_EDIT_TIMINGS: '1', ...o.env };
  for (const k of Object.keys(env)) if (/^(SEC_EDIT_(?!TIMINGS)|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(k)) delete env[k];
  const child = spawn(bin, ['--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${o.userData}`, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry: { child: ChildProcess; browser?: Browser } = { child };
  running.push(entry);
  let out = '';
  child.stdout!.on('data', (d) => (out += String(d)));
  child.stderr!.on('data', (d) => (out += String(d)));
  const endpoint = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no DevTools endpoint from the packaged app:\n${out}`)), 20000);
    const look = () => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(out);
      if (!m) return;
      clearTimeout(t);
      resolve(m[1]);
    };
    child.stderr!.on('data', look);
    child.on('exit', (code) => (clearTimeout(t), reject(new Error(`packaged app exited (${code}):\n${out}`))));
  });
  const browser = (entry.browser = await chromium.connectOverCDP(endpoint));
  let page: Page | undefined;
  await expect.poll(() => (page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('app://sec-edit/'))) && true, { timeout: 20000 }).toBe(true);
  await page!.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
  return { page: page!, child, output: () => out };
}

test('packaged Linux build launches, opens a folder, saves', async ({ el }) => {
  const { page, output } = await launchPackaged([el.ws], { userData: el.userData });
  await expect.poll(output).toContain('[sec-edit:timings]');
  console.log('[packaged] timings', output().split('\n').find((l) => l.startsWith('[sec-edit:timings]'))?.slice('[sec-edit:timings] '.length));
  await expect(page.locator('.se-tree-row', { hasText: 'README.md' })).toBeVisible();
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\npackaged ok');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFileSync(path.join(el.ws, 'README.md'), 'utf8')).toContain('packaged ok');
  // The editor chunk and workers load from inside app.asar via app://
  expect(await page.evaluate(() => !!(window as any).__secEdit.editor)).toBe(true);
  // The private profile was used (settings / recent folders are in --user-data-dir, not the user's own).
  await expect.poll(() => fs.existsSync(path.join(el.userData, 'recent.json'))).toBe(true);
});

test('packaged Linux build: the terminal loads node-pty from app.asar.unpacked', async ({ el }) => {
  const home = path.join(el.tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bashrc'), 'PS1="pkg$ "\n');
  const { page } = await launchPackaged([el.ws], { userData: el.userData, env: { SHELL: '/bin/bash', HOME: home } });
  await page.keyboard.press('Control+Backquote');
  const text = () => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/\u00a0/g, ' '));
  await expect.poll(text, { timeout: 15000 }).toContain('pkg$');
  await page.keyboard.type('echo PTY=$((40+2)) $PWD\n');
  await expect.poll(text).toContain(`PTY=42 ${el.ws}`);
});

test('packaged build: fuses are set, test hooks are dead, the web server child still starts (RunAsNode)', async ({ el }) => {
  const fuses = await import(path.join(root, 'scripts/fuses.mjs'));
  const want = { RunAsNode: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false };
  expect(fuses.readFuses(bin)).toMatchObject(want);
  if (fs.existsSync(winExe)) expect(fuses.readFuses(winExe)).toMatchObject(want);

  // SEC_EDIT_* hooks do nothing: the renderer override, the profile override and the test mode are ignored.
  const evil = path.join(el.tmp, 'evil-renderer');
  fs.mkdirSync(evil);
  fs.writeFileSync(path.join(evil, 'index.html'), '<title>pwned</title><script>document.title = "pwned"</script>');
  const hooked = path.join(el.tmp, 'hooked-profile');
  const marker = path.join(el.tmp, 'node-options-ran');
  fs.writeFileSync(path.join(el.tmp, 'inject.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
  const { page } = await launchPackaged([el.ws], {
    userData: el.userData,
    env: { SEC_EDIT_RENDERER_DIR: evil, SEC_EDIT_USER_DATA: hooked, SEC_EDIT_TEST: '1', SEC_EDIT_TEST_SAVE_PATH: path.join(el.tmp, 'x.pdf'), NODE_OPTIONS: `--require ${path.join(el.tmp, 'inject.cjs')}` },
  });
  expect(await page.title()).not.toBe('pwned');
  await expect(page.locator('.se-tree-row', { hasText: 'README.md' })).toBeVisible();
  expect(fs.existsSync(hooked)).toBe(false);
  expect(fs.existsSync(marker)).toBe(false); // NODE_OPTIONS fuse: nothing was preloaded into main

  // RunAsNode stays on for exactly this: "Start web server" runs the bundled server with the app's own executable.
  const st = await page.evaluate(() => (window as any).secEditBridge.webServer.start({ port: null, access: 'local' }));
  expect(st).toMatchObject({ ok: true, result: { state: 'running' } });
  const origin: string = st.result.urls[0].origin;
  expect((await fetch(origin)).status).toBeLessThan(500);
  expect((await page.evaluate(() => (window as any).secEditBridge.webServer.stop())).result.state).toBe('stopped');
});

test('packaged build: --inspect does not open a debugger on the main process', async ({ el }) => {
  const child = spawn(bin, ['--disable-gpu', '--inspect=0', `--user-data-dir=${el.userData}`, el.ws], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  running.push({ child });
  let err = '';
  child.stderr!.on('data', (d) => (err += String(d)));
  await new Promise((r) => setTimeout(r, 4000));
  expect(err).not.toMatch(/Debugger listening on ws:/);
  expect(child.exitCode === null || child.exitCode !== 0).toBe(true);
});

test('Windows zip contains the exe and app.asar', async () => {
  test.skip(!fs.existsSync(winZip), 'run `npm run package:win` first');
  const list = execFileSync('unzip', ['-l', winZip], { encoding: 'utf8' });
  expect(list).toContain('sec-edit-win32-x64/sec-edit.exe');
  expect(list).toContain('sec-edit-win32-x64/resources/app.asar');
  // The integrated terminal's node-pty is the only node_modules shipped: unpacked, with the ConPTY binaries.
  const pty = 'sec-edit-win32-x64/resources/app.asar.unpacked/node_modules/node-pty/';
  for (const f of ['lib/index.js', 'lib/worker/conoutSocketWorker.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node', 'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe']) expect(list).toContain(pty + f);
  for (const line of list.split('\n').filter((l) => l.includes('node_modules'))) expect(line).toMatch(/resources\/app\.asar\.unpacked\/node_modules\/(node-pty\/.*)?$/);
  expect(list).not.toMatch(/node-pty\/(src|deps|build|third_party\/conpty\/[^/]+\/win10)|\.pdb\b|linux|darwin/);
});
