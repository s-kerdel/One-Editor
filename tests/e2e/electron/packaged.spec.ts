// The packaged Linux build must launch from app.asar and work end to end.
// It ships with its fuses set (scripts/fuses.mjs): no Node mode, no --inspect, no NODE_OPTIONS, the app from
// app.asar only — so Playwright's Electron launcher (which attaches through --inspect) cannot drive it, and
// SEC_EDIT_* test hooks are ignored (src/main/env-guard.ts). It is started like a user would start it and driven
// through Chromium's own DevTools port, with a private profile (--user-data-dir). A release package refuses that
// port: build a test package for this spec, outside release/:
//   node scripts/package.mjs linux --out .tmp/<area>/release --test-package
//   SEC_EDIT_PACKAGED_DIR=.tmp/<area>/release npx playwright test -c playwright.electron.config.ts tests/e2e/electron/packaged.spec.ts
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chromium, type Browser, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect, fs, path } from './fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.resolve(root, process.env.SEC_EDIT_PACKAGED_DIR || 'release');
const bin = path.join(out, 'One-linux-x64/one');
const winZip = path.join(out, 'One-win32-x64.zip');
const winExe = path.join(out, 'One-win32-x64/One.exe');
const unpacked = path.join(out, 'One-linux-x64/resources/app.asar.unpacked');

test.skip(process.platform !== 'linux' || !fs.existsSync(bin), 'build a Linux test package first (see the top of this file)');

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

test('packaged build: fuses are set, test hooks are dead, the web server child still starts (a utilityProcess)', async ({ el }) => {
  const fuses = await import(path.join(root, 'scripts/fuses.mjs'));
  const want = { RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, OnlyLoadAppFromAsar: true };
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

  // "Start web server" runs the bundled server in a utilityProcess (no Node mode: the fuse is off).
  const st = await page.evaluate(() => (window as any).secEditBridge.webServer.start({ port: null, access: 'local' }));
  expect(st).toMatchObject({ ok: true, result: { state: 'running' } });
  const origin: string = st.result.urls[0].origin;
  expect((await fetch(origin)).status).toBeLessThan(500);
  expect((await page.evaluate(() => (window as any).secEditBridge.webServer.stop())).result.state).toBe('stopped');
});

/** A data folder with MCP on, one shared folder and a token (what Settings → MCP server writes). */
function mcpConfig(el: { tmp: string }) {
  const xdg = path.join(el.tmp, 'xdg');
  const cfg = path.join(xdg, 'sec-edit');
  const shared = path.join(el.tmp, 'shared');
  fs.mkdirSync(cfg, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.md'), '# from the packaged server');
  const raw = 'one_' + crypto.randomBytes(32).toString('base64url');
  const sha256 = crypto.createHash('sha256').update(raw).digest('hex');
  fs.writeFileSync(path.join(cfg, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [{ id: 'aaaaaaaa', alias: 'shared', path: fs.realpathSync(shared), mode: 'read' }], tokens: [{ id: 'bbbbbbbb', name: 'Packaged', sha256, hint: '', created: 1 }] }));
  fs.writeFileSync(path.join(cfg, 'settings.json'), '{}');
  // Only what a client passes: no display (headless), the data folder by XDG (SEC_EDIT_* hooks are dead here).
  return { raw, cfg, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, XDG_CONFIG_HOME: xdg, ONE_MCP_TOKEN: raw } };
}

async function readHello(command: string, args: string[], env: Record<string, string>) {
  const client = new Client({ name: 'packaged-e2e', version: '1' });
  const t0 = Date.now();
  await client.connect(new StdioClientTransport({ command, args, env, stderr: 'pipe' }));
  const ms = Date.now() - t0;
  try {
    const read = (await client.callTool({ name: 'read_file', arguments: { path: 'hello.md' } })) as any;
    return { ms, text: read.content.map((c: any) => c.text).join('\n') as string };
  } finally {
    await client.close().catch(() => {});
  }
}

test('packaged build: `one --mcp-stdio` serves MCP without a window or display; a setup copied before still works; Node mode runs nothing', async ({ el }) => {
  const m = mcpConfig(el);
  const fresh = await readHello(bin, ['--ozone-platform=headless', '--mcp-stdio'], m.env);
  console.log(`[packaged] --mcp-stdio: connected (initialize) in ${fresh.ms} ms`);
  expect(fresh.text).toContain('from the packaged server');
  expect(fs.existsSync(path.join(m.cfg, 'headless-profile'))).toBe(true); // Chromium's files apart from One's own
  // The old setup (Node mode + cli.mjs): the fuse ignores ELECTRON_RUN_AS_NODE, main recognises its own server program.
  const old = await readHello(bin, [path.join(unpacked, 'dist/mcp/cli.mjs'), '--stdio'], { ...m.env, ELECTRON_RUN_AS_NODE: '1', DISPLAY: process.env.DISPLAY || ':99' });
  expect(old.text).toContain('from the packaged server');
  // Any other script given with ELECTRON_RUN_AS_NODE is never run (the app starts instead: killed here).
  const marker = path.join(el.tmp, 'node-mode-ran');
  const script = path.join(el.tmp, 'evil.js');
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
  const child = spawn(bin, ['--disable-gpu', `--user-data-dir=${el.userData}`, script], { env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' });
  running.push({ child });
  await new Promise((r) => setTimeout(r, 3000));
  expect(fs.existsSync(marker)).toBe(false);
});

test('packaged build: `one --serve` (what start-web.sh runs, here without --open) runs browser mode without a window', async ({ el }) => {
  expect(fs.readFileSync(path.join(path.dirname(bin), 'start-web.sh'), 'utf8')).toContain('--serve "$FOLDER" --open');
  const child = spawn(bin, ['--ozone-platform=headless', '--serve', el.ws], { env: { PATH: process.env.PATH ?? '', HOME: el.tmp, XDG_CONFIG_HOME: path.join(el.tmp, 'xdg') }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.push({ child });
  let text = '';
  child.stdout!.on('data', (d) => (text += String(d)));
  child.stderr!.on('data', (d) => (text += String(d)));
  await expect.poll(() => /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/.test(text), { timeout: 20000 }).toBe(true);
  const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[a-f0-9]+/.exec(text)![0];
  expect((await fetch(url)).status).toBe(200);
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
  expect(list).toContain('One-win32-x64/One.exe');
  expect(list).toContain('One-win32-x64/resources/app.asar');
  // The integrated terminal's node-pty is the only node_modules shipped: unpacked, with the ConPTY binaries.
  const pty = 'One-win32-x64/resources/app.asar.unpacked/node_modules/node-pty/';
  for (const f of ['lib/index.js', 'lib/worker/conoutSocketWorker.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node', 'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe']) expect(list).toContain(pty + f);
  for (const line of list.split('\n').filter((l) => l.includes('node_modules'))) expect(line).toMatch(/resources\/app\.asar\.unpacked\/node_modules\/(node-pty\/.*)?$/);
  expect(list).not.toMatch(/node-pty\/(src|deps|build|third_party\/conpty\/[^/]+\/win10)|\.pdb\b|linux|darwin/);
});
