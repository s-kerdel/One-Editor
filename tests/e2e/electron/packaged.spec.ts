// The packaged Linux build (npm run package:linux) must launch from app.asar and work end to end.
import { fileURLToPath } from 'node:url';
import { test, expect, fs, path } from './fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = path.join(root, 'release/sec-edit-linux-x64/sec-edit');
const winZip = path.join(root, 'release/sec-edit-win32-x64.zip');

test.skip(process.platform !== 'linux' || !fs.existsSync(bin), 'run `npm run package:linux` first');

test('packaged Linux build launches, opens a folder, saves', async ({ el }) => {
  const { page, timings } = await el.launch([el.ws], { executablePath: bin });
  console.log('[packaged] timings', JSON.stringify(await timings()));
  await expect(page.locator('.se-tree-row', { hasText: 'README.md' })).toBeVisible();
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\npackaged ok');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFileSync(path.join(el.ws, 'README.md'), 'utf8')).toContain('packaged ok');
  // The editor chunk and workers load from inside app.asar via app://
  expect(await page.evaluate(() => !!(window as any).__secEdit.editor)).toBe(true);
});

test('packaged Linux build: the terminal loads node-pty from app.asar.unpacked', async ({ el }) => {
  const home = path.join(el.tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.bashrc'), 'PS1="pkg$ "\n');
  const { page } = await el.launch([el.ws], { executablePath: bin, env: { SHELL: '/bin/bash', HOME: home } });
  await page.keyboard.press('Control+Backquote');
  const text = () => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/\u00a0/g, ' '));
  await expect.poll(text, { timeout: 15000 }).toContain('pkg$');
  await page.keyboard.type('echo PTY=$((40+2)) $PWD\n');
  await expect.poll(text).toContain(`PTY=42 ${el.ws}`);
});

test('Windows zip contains the exe and app.asar', async () => {
  test.skip(!fs.existsSync(winZip), 'run `npm run package:win` first');
  const { execFileSync } = await import('node:child_process');
  const list = execFileSync('unzip', ['-l', winZip], { encoding: 'utf8' });
  expect(list).toContain('sec-edit-win32-x64/sec-edit.exe');
  expect(list).toContain('sec-edit-win32-x64/resources/app.asar');
  // The integrated terminal's node-pty is the only node_modules shipped: unpacked, with the ConPTY binaries.
  const pty = 'sec-edit-win32-x64/resources/app.asar.unpacked/node_modules/node-pty/';
  for (const f of ['lib/index.js', 'lib/worker/conoutSocketWorker.js', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node', 'prebuilds/win32-x64/conpty/conpty.dll', 'prebuilds/win32-x64/conpty/OpenConsole.exe']) expect(list).toContain(pty + f);
  for (const line of list.split('\n').filter((l) => l.includes('node_modules'))) expect(line).toMatch(/resources\/app\.asar\.unpacked\/node_modules\/(node-pty\/.*)?$/);
  expect(list).not.toMatch(/node-pty\/(src|deps|build|third_party\/conpty\/[^/]+\/win10)|\.pdb\b|linux|darwin/);
});
