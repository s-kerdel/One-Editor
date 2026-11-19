// Long-session leak guard on the real app: 200 cycles of open/close — tabs, a terminal, the git pane,
// reading / split preview, settings. After a forced GC the renderer heap and the DOM stay where they
// were at cycle 20 (everything lazy is loaded by then), and no shell outlives its closed terminal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, path } from './fixture';

const CYCLES = 200;

/** Shells (bash) the app's main process has running right now (Linux: /proc). */
function shells(mainPid: number): number {
  try {
    const kids = fs.readFileSync(`/proc/${mainPid}/task/${mainPid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean);
    return kids.filter((k) => {
      try {
        return fs.readFileSync(`/proc/${k}/comm`, 'utf8').trim() === 'bash';
      } catch {
        return false;
      }
    }).length;
  } catch {
    return -1;
  }
}

async function cycle(page: Page, notes: string[]) {
  await page.evaluate(async (list) => {
    const a = (window as any).__secEdit;
    for (const p of list) await a.openFile(p);
    for (const p of list) await a.closeTab(p);
  }, notes);
  // a terminal: open, wait for the prompt, close it from its tab
  await page.keyboard.press('Control+Shift+Backquote');
  await expect(page.locator('.se-term-tab')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.querySelector('.se-term-view .xterm-rows')?.textContent?.includes('term$') ?? false), { timeout: 15000 }).toBe(true);
  await page.locator('.se-term-tab-close').first().click();
  await expect(page.locator('.se-term-tab')).toHaveCount(0);
  // git pane, then back
  await page.locator('[data-panel="git"]').click();
  await expect(page.getByTestId('scm')).toBeVisible();
  await page.locator('[data-panel="files"]').click();
  // reading view and split preview on a note
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), notes[0]);
  for (const key of ['Control+e', 'Control+e', 'Control+Backslash', 'Control+Backslash']) {
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
  }
  await page.evaluate((p) => (window as any).__secEdit.closeTab(p), notes[0]);
  // settings
  await page.keyboard.press('Control+Comma');
  await expect(page.locator('.se-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-settings')).toHaveCount(0);
}

test.skip(process.platform !== 'linux', 'counts shells via /proc');

test(`${CYCLES} cycles of tabs, terminals, git pane, preview and settings: no heap / DOM growth, no stray shells`, async ({ el }) => {
  test.setTimeout(600_000);
  execFileSync('git', ['init', '-q'], { cwd: el.ws });
  const home = path.join(el.tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
  const { app, page } = await el.launch([el.ws], { env: { SHELL: '/bin/bash', HOME: home } });
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 60000 });
  await expect(page.locator('[data-panel="git"]')).toBeVisible({ timeout: 20000 });
  const notes = (await page.evaluate(() => (window as any).__secEdit.files.value.filter((f: string) => f.endsWith('.md')))).slice(0, 3);
  expect(notes.length).toBeGreaterThan(1);
  const mainPid: number = await app.evaluate(() => process.pid);
  const measure = async () => {
    await page.waitForTimeout(500);
    return app.evaluate(async ({ BrowserWindow }) => {
      const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      await dbg.sendCommand('HeapProfiler.collectGarbage');
      const heap = ((await dbg.sendCommand('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
      const dom = ((await dbg.sendCommand('Runtime.evaluate', { expression: "document.getElementsByTagName('*').length", returnByValue: true })) as { result: { value: number } }).result.value;
      return { heap, dom };
    });
  };
  for (let i = 1; i <= 20; i++) await cycle(page, notes);
  const at20 = await measure();
  for (let i = 21; i <= CYCLES; i++) await cycle(page, notes);
  const end = await measure();
  await expect.poll(() => shells(mainPid), { timeout: 10000 }).toBe(0);
  const perCycleKB = (end.heap - at20.heap) / (CYCLES - 20) / 1024;
  console.log(`[perf-leaks] desktop, ${CYCLES} cycles: heap after GC ${(at20.heap / 1048576).toFixed(1)} → ${(end.heap / 1048576).toFixed(1)} MB (${perCycleKB.toFixed(1)} KB/cycle); DOM ${at20.dom} → ${end.dom}; shells left 0`);
  // A real leak (a terminal / view / listener kept per cycle) is hundreds of KB per cycle.
  expect(perCycleKB, 'renderer heap growth per cycle').toBeLessThan(30);
  expect(end.dom - at20.dom, 'DOM growth').toBeLessThan(50);
});
