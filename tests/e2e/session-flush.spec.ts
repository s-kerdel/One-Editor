// A refresh right after a change (inside the save debounce) must not lose it: pending session and
// settings saves are flushed on page unload, and the backend serves the latest session from memory.
import { test, expect } from './harness';

test('switching tabs then refreshing immediately restores the new active tab', async ({ page, ws }) => {
  await ws.open(page);
  const app = () => page.evaluate(() => ({ active: (window as any).__secEdit.activePath.value, tabs: (window as any).__secEdit.tabs.value.map((t: any) => t.path) }));
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/kubernetes.md'));
  await page.waitForTimeout(400); // first state saved
  for (let i = 0; i < 3; i++) {
    const next = i % 2 ? 'notes/kubernetes.md' : 'README.md';
    await page.evaluate((p) => (window as any).__secEdit.openFile(p), next);
    await page.reload(); // no wait: inside the 250 ms debounce
    await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
    await expect.poll(app).toEqual({ active: next, tabs: ['README.md', 'notes/kubernetes.md'] });
  }
});

test('a setting changed right before a refresh survives it', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+,');
  await page.getByTestId('settings').locator('[data-setting="contentWidth"] [data-value="wide"]').click();
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await expect.poll(async () => (await ws.server.service.getSettings()).contentWidth).toBe('wide');
});
