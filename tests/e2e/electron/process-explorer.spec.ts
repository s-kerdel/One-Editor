// "Developer: Process explorer" in the desktop app — a non-modal dock under the editor (above the
// terminal when both are open): Chromium processes (main / UI / GPU), a terminal with its foreground
// command (stoppable), a running git command (stoppable), its own cost. The editor keeps focus and
// stays usable; nothing refreshes while the window is hidden. PROCESS_SHOTS=<dir>: review screenshots.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, path } from './fixture';
import { trustRepo } from '../git-helpers';

const termText = (page: Page) => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/ /g, ' '));
const polls = (page: Page) => page.evaluate(() => (window as any).__secEditExplorerLive?.polls ?? 0);
const inEditor = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));

/** The palette command toggles the dock; returns it. */
async function openExplorer(page: Page) {
  await page.waitForFunction(() => !!(window as any).__secEditSearch, null, { timeout: 20000 }); // the command's chunk loads on idle
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Process explorer');
  await page.keyboard.press('Enter');
  const dock = page.getByTestId('process-dock');
  await expect(dock).toBeVisible();
  return dock;
}

test('docked: typing into the editor works while it refreshes, focus stays there; hidden window = no refresh', async ({ el }) => {
  test.setTimeout(90_000);
  const { page } = await el.launch([el.ws]);
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  const dock = await openExplorer(page);
  await expect(dock.locator('tr[data-row="main"]')).toContainText('Main process');
  expect(await inEditor(page), 'opening keeps focus in the editor').toBe(true);
  const p0 = await polls(page);
  await page.keyboard.type(' typed while it refreshes', { delay: 15 });
  await expect.poll(() => polls(page), { timeout: 8000 }).toBeGreaterThanOrEqual(p0 + 2);
  await expect(page.locator('.cm-content')).toContainText('typed while it refreshes');
  expect(await inEditor(page)).toBe(true);

  // Window hidden (minimised): no refresh until it is shown again. Xvfb has no window manager, so
  // hide() / minimize() never change document.visibilityState there: simulate what Chromium reports.
  const setVisibility = (state: string) =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await setVisibility('hidden');
  await page.waitForTimeout(300); // a refresh already in flight may land
  const hidden = await polls(page);
  await page.waitForTimeout(4500);
  expect(await polls(page), 'no refresh while hidden').toBe(hidden);
  await setVisibility('visible');
  await expect.poll(() => polls(page), { timeout: 4000 }).toBeGreaterThan(hidden);
});

test('a terminal and its foreground command appear; Stop ends the command, not the shell', async ({ el }) => {
  test.setTimeout(90_000);
  const home = path.join(el.tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
  const { page } = await el.launch([el.ws], { env: { SHELL: '/bin/bash', HOME: home } });
  await page.keyboard.press('Control+Backquote');
  await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$');
  await page.keyboard.type('sleep 600\n');
  await page.waitForTimeout(500);

  const dock = await openExplorer(page);
  await expect(dock.locator('tr[data-row="main"]')).toContainText('Main process');
  await expect(dock.locator('tr[data-row="renderer"]')).toContainText('UI (renderer)');
  const shell = dock.locator('tr', { hasText: 'Terminal: bash' });
  await expect(shell).toContainText('running a command');
  const sleep = dock.locator('tr', { hasText: 'sleep 600' });
  await expect(sleep).toContainText('foreground');
  await sleep.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click(); // confirm
  await expect(sleep).toHaveCount(0, { timeout: 8000 });
  await expect(shell).toContainText('idle prompt', { timeout: 8000 });
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await termText(page)).split('term$').length, { timeout: 8000 }).toBeGreaterThan(2); // a fresh prompt
});

test('a slow git command shows as a stoppable row', async ({ el }) => {
  test.setTimeout(90_000);
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  execFileSync(realGit, ['init', '-q'], { cwd: el.ws });
  trustRepo(el.ws); // the user's "Trust" (no git runs in a folder without it)
  const bin = path.join(el.tmp, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  // `git status` takes 30 s (everything else is the real git).
  await fsp.writeFile(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) sleep 30 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const { page } = await el.launch([el.ws], { env: { PATH: `${bin}:${process.env.PATH}` } });
  const dock = await openExplorer(page);
  const git = dock.locator('tr', { hasText: 'git status' }).first();
  await expect(git).toBeVisible({ timeout: 20000 });
  await expect(git.getByRole('button', { name: 'Stop' })).toBeVisible();
  await git.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click(); // confirm
  await expect(dock.locator('tr', { hasText: 'git status' })).toHaveCount(0, { timeout: 8000 });
});

// Visual review helper (not a test): PROCESS_SHOTS=<dir> writes the dock above a terminal, dark + light.
for (const theme of ['dark', 'light'] as const) {
  test(`screenshot desktop ${theme}: dock above the terminal`, async ({ el }) => {
    const SHOTS = process.env.PROCESS_SHOTS || '';
    test.skip(!SHOTS, 'set PROCESS_SHOTS=<dir> to write screenshots');
    test.setTimeout(60_000);
    fs.mkdirSync(SHOTS, { recursive: true });
    const home = path.join(el.tmp, 'home');
    await fsp.mkdir(home, { recursive: true });
    await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
    const { page } = await el.launch([el.ws], { env: { SHELL: '/bin/bash', HOME: home } });
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme); // the CSS follows the attribute
    await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
    await page.keyboard.press('Control+Backquote');
    await expect.poll(() => termText(page), { timeout: 15000 }).toContain('term$');
    const dock = await openExplorer(page);
    await expect.poll(async () => (await dock.locator('tr[data-row="main"] td').nth(2).textContent())?.trim(), { timeout: 8000 }).toMatch(/^\d+\.\d$/);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/desktop-${theme}.png` });
  });
}
