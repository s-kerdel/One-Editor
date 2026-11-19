// "Developer: Process explorer" in the desktop app: Chromium processes (main / UI / GPU), a terminal
// with its foreground command (stoppable), a running git command (stoppable), its own cost.
import { execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, path } from './fixture';

const termText = (page: Page) => page.evaluate(() => (document.querySelector('.se-term-view .xterm-rows')?.textContent ?? '').replace(/ /g, ' '));

async function openExplorer(page: Page) {
  await page.waitForFunction(() => !!(window as any).__secEditSearch, null, { timeout: 20000 }); // the command's chunk loads on idle
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Process explorer');
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Process explorer' });
  await expect(dlg).toBeVisible();
  return dlg;
}

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

  const dlg = await openExplorer(page);
  await expect(dlg.locator('tr[data-row="main"]')).toContainText('Main process');
  await expect(dlg.locator('tr[data-row="renderer"]')).toContainText('UI (renderer)');
  const shell = dlg.locator('tr', { hasText: 'Terminal: bash' });
  await expect(shell).toContainText('running a command');
  const sleep = dlg.locator('tr', { hasText: 'sleep 600' });
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
  const bin = path.join(el.tmp, 'bin');
  await fsp.mkdir(bin, { recursive: true });
  // `git status` takes 30 s (everything else is the real git).
  await fsp.writeFile(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" status "*) sleep 30 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const { page } = await el.launch([el.ws], { env: { PATH: `${bin}:${process.env.PATH}` } });
  const dlg = await openExplorer(page);
  const git = dlg.locator('tr', { hasText: 'git status' }).first();
  await expect(git).toBeVisible({ timeout: 20000 });
  await expect(git.getByRole('button', { name: 'Stop' })).toBeVisible();
  await git.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Stop' }).click(); // confirm
  await expect(dlg.locator('tr', { hasText: 'git status' })).toHaveCount(0, { timeout: 8000 });
});
