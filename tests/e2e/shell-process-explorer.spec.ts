// "Developer: Process explorer" in browser mode — a non-modal dock under the editor: the server
// process, its indexer and reader threads, this tab with its search shards. The editor stays usable
// and keeps focus; refreshed while shown; closing (or a hidden window) stops polling and the backend
// forgets everything (no timers, no helpers). PROCESS_SHOTS=<dir> also writes review screenshots.
import fs from 'node:fs';
import { test, expect } from './harness';
import type { Page } from '@playwright/test';

const dock = (page: Page) => page.getByTestId('process-dock');
const inEditor = (page: Page) => page.evaluate(() => !!document.activeElement?.closest('.cm-editor'));
const polls = (page: Page) => page.evaluate(() => (window as any).__secEditExplorerLive?.polls ?? 0);

/** The palette command toggles the dock. */
async function toggleExplorer(page: Page) {
  await page.waitForFunction(() => !!(window as any).__secEditSearch, null, { timeout: 15000 }); // command lives in the idle chunk
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Process explorer');
  await page.keyboard.press('Enter');
}

async function editNote(page: Page) {
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await expect(page.locator('.cm-content')).toContainText('Daily notes');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
}

test('non-modal: the editor keeps focus and stays editable while the dock refreshes; rows by keyboard; Escape back to the editor', async ({ page, ws }) => {
  await ws.open(page);
  await editNote(page);
  await toggleExplorer(page);
  await expect(dock(page).locator('tr[data-row="main"]')).toContainText('Server process');
  expect(await inEditor(page), 'opening keeps focus in the editor').toBe(true);

  const p0 = await polls(page);
  await page.keyboard.type(' typed while it refreshes', { delay: 15 });
  await expect.poll(() => polls(page), { timeout: 8000 }).toBeGreaterThanOrEqual(p0 + 2);
  await page.keyboard.type(' and after');
  await expect(page.locator('.cm-content')).toContainText('typed while it refreshes and after');
  expect(await inEditor(page)).toBe(true);

  // Into the dock only on purpose: arrows move between rows, Escape hands focus back (the dock stays).
  await dock(page).locator('.se-procx-list').focus();
  await page.keyboard.press('ArrowDown');
  const first = await page.evaluate(() => document.activeElement?.getAttribute('data-row'));
  await page.keyboard.press('ArrowDown');
  const second = await page.evaluate(() => document.activeElement?.getAttribute('data-row'));
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  await page.keyboard.press('End');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-row'))).toBe(await dock(page).locator('tr[data-row]').last().getAttribute('data-row'));
  await page.keyboard.press('Escape');
  expect(await inEditor(page), 'Escape returns focus to the editor').toBe(true);
  await expect(dock(page)).toBeVisible();
  await page.keyboard.type('!');
  await expect(page.locator('.cm-content')).toContainText('and after!');
});

test('shows the server, its indexer, this tab and the search shards; the command toggles it off and polling stops', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const rpc: string[] = [];
  page.on('request', (r) => r.url().includes('/api/rpc/processes') && rpc.push(r.postData() ?? ''));
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 30000 });

  await toggleExplorer(page);
  const row = (id: string) => dock(page).locator(`tr[data-row="${id}"]`);
  await expect(row('main')).toContainText('Server process');
  await expect(row('renderer')).toContainText('This tab (browser)');
  await expect(row('indexer')).toBeVisible();
  await expect(row('search')).toContainText('Search');
  await expect(row('explorer')).toContainText('Process explorer (itself)');
  await expect(row('desktop-only')).toContainText('desktop only');
  // The second refresh has CPU numbers (they are deltas).
  await expect.poll(async () => (await row('main').locator('td').nth(2).textContent())?.trim(), { timeout: 8000 }).toMatch(/^\d+\.\d$/);
  expect(rpc.filter((p) => p.includes('snapshot')).length).toBeGreaterThanOrEqual(2);

  await dock(page).getByRole('button', { name: 'Copy as text' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('sec-edit process list');
  expect(text).toMatch(/Server process\s+\d+/);

  await toggleExplorer(page); // off
  await expect(dock(page)).toHaveCount(0);
  await expect.poll(() => rpc.some((p) => p.includes('close'))).toBe(true);
  const afterClose = rpc.length;
  await page.waitForTimeout(4500); // two refresh periods
  expect(rpc.length, 'no polling once closed').toBe(afterClose);
  expect(await page.evaluate(() => ({ ...(window as any).__secEditExplorerLive, polls: 0 }))).toEqual({ timers: 0, observers: 0, polls: 0 });
  const ex = (ws.server.service as any).explorer;
  expect(ex.helperRunning).toBe(false);
  expect(ex.idleTimer, 'no backend timer once closed').toBeNull();

  await toggleExplorer(page); // and on again
  await expect(row('main')).toContainText('Server process');
  await dock(page).getByRole('button', { name: 'Close process explorer' }).click();
  await expect(dock(page)).toHaveCount(0);
});

test('nothing refreshes while the window is hidden; it resumes when shown', async ({ page, ws }) => {
  const rpc: string[] = [];
  page.on('request', (r) => r.url().includes('/api/rpc/processes') && r.postData()?.includes('snapshot') && rpc.push('s'));
  await ws.open(page);
  await toggleExplorer(page);
  await expect(dock(page).locator('tr[data-row="main"]')).toBeVisible();
  const setVisibility = (state: string) =>
    page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
  await setVisibility('hidden');
  await page.waitForTimeout(300); // a refresh already in flight may land
  const hidden = rpc.length;
  await page.waitForTimeout(4500);
  expect(rpc.length, 'no refresh while hidden').toBe(hidden);
  await setVisibility('visible');
  await expect.poll(() => rpc.length, { timeout: 3000 }).toBeGreaterThan(hidden);
});

test('open state and height are remembered in the session', async ({ page, ws }) => {
  await ws.open(page);
  await toggleExplorer(page);
  await expect(dock(page)).toBeVisible();
  const h0 = (await dock(page).boundingBox())!.height;
  const sash = (await dock(page).locator('.se-procx-sash').boundingBox())!;
  await page.mouse.move(sash.x + sash.width / 2, sash.y + sash.height / 2);
  await page.mouse.down();
  await page.mouse.move(sash.x + sash.width / 2, sash.y - 90, { steps: 5 });
  await page.mouse.up();
  const h1 = (await dock(page).boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 60);
  await page.waitForTimeout(600); // the session save is debounced
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(dock(page)).toBeVisible({ timeout: 15000 }); // restored open (its chunk loads once idle)
  expect(Math.abs((await dock(page).boundingBox())!.height - h1)).toBeLessThan(3);
  await toggleExplorer(page);
  await expect(dock(page)).toHaveCount(0);
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => !!(window as any).__secEditSearch, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await expect(dock(page), 'closed stays closed').toHaveCount(0);
});

// Visual review helper (not a test): PROCESS_SHOTS=<dir> writes the dock in shelf + classic, dark + light.
const SHOTS = process.env.PROCESS_SHOTS || '';
for (const style of ['shelf', 'classic'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshots ${style} ${theme}`, async ({ page, ws }) => {
      test.skip(!SHOTS, 'set PROCESS_SHOTS=<dir> to write screenshots');
      fs.mkdirSync(SHOTS, { recursive: true });
      await ws.server.service.saveSettings({ sidebarStyle: style, theme });
      await ws.open(page);
      await editNote(page);
      await toggleExplorer(page);
      await expect.poll(async () => (await dock(page).locator('tr[data-row="main"] td').nth(2).textContent())?.trim(), { timeout: 8000 }).toMatch(/^\d+\.\d$/);
      await dock(page).locator('.se-procx-list').focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.mouse.move(5, 5);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${SHOTS}/browser-${style}-${theme}.png` });
    });
  }
}
