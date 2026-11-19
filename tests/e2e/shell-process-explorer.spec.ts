// "Developer: Process explorer" in browser mode: the server process, its indexer thread and reader
// threads, this tab with its search shards; refreshed while open; closing stops polling and the
// backend forgets everything (no timers, no helpers).
import { test, expect } from './harness';
import type { Page } from '@playwright/test';

async function openExplorer(page: Page) {
  await page.waitForFunction(() => !!(window as any).__secEditSearch, null, { timeout: 15000 }); // command lives in the idle chunk
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Process explorer');
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Process explorer' });
  await expect(dlg).toBeVisible();
  return dlg;
}

test('shows the server, its indexer, this tab and the search shards; closing stops polling', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const polls: string[] = [];
  page.on('request', (r) => r.url().includes('/api/rpc/processes') && polls.push(r.postData() ?? ''));
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 30000 });

  const dlg = await openExplorer(page);
  const row = (id: string) => dlg.locator(`tr[data-row="${id}"]`);
  await expect(row('main')).toContainText('Server process');
  await expect(row('renderer')).toContainText('This tab (browser)');
  await expect(row('indexer')).toBeVisible();
  await expect(row('search')).toContainText('Search');
  await expect(row('explorer')).toContainText('Process explorer (itself)');
  await expect(row('desktop-only')).toContainText('desktop only');
  // The second refresh has CPU numbers (they are deltas).
  await expect.poll(async () => (await row('main').locator('td').nth(2).textContent())?.trim(), { timeout: 8000 }).toMatch(/^\d+\.\d$/);
  expect(polls.filter((p) => p.includes('snapshot')).length).toBeGreaterThanOrEqual(2);

  await dlg.getByRole('button', { name: 'Copy as text' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('sec-edit process list');
  expect(text).toMatch(/Server process\s+\d+/);

  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect.poll(() => polls.some((p) => p.includes('close'))).toBe(true);
  const afterClose = polls.length;
  await page.waitForTimeout(4500); // two refresh periods
  expect(polls.length, 'no polling once closed').toBe(afterClose);
  const ex = (ws.server.service as any).explorer;
  expect(ex.helperRunning).toBe(false);
  expect(ex.idleTimer, 'no backend timer once closed').toBeNull();
});
