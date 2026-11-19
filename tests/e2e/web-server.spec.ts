// Browser mode: "Start web server" is a desktop feature. No commands, no Settings section, no chunk.
import { test, expect } from './harness';

test('browser build: no web server commands, no Browser mode settings, its chunk is never fetched', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  // The idle Popups chunk is what pulls the feature in on the desktop: wait for it here.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/Popups-[\w-]+\.js$/.test(e.name)))).toBe(true);
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+Shift+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await input.fill('>web server');
  await expect(page.locator('.se-pal-item[data-command-id^="webServer."]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+,');
  await expect(page.locator('[data-testid="settings"]')).toBeVisible();
  await expect(page.locator('[data-nav="webserver"]')).toHaveCount(0);
  await page.locator('[data-testid="settings-search"]').fill('web server');
  await expect(page.locator('[data-row="webserver.port"], [data-row="webserver.access"], [data-testid="webserver-settings"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="settings-empty"]')).toBeVisible();

  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /web-server-ui/.test(e.name)))).toBe(false);
  expect(await page.evaluate(() => (window as any).__secEditWebServer)).toBeUndefined();
  expect(errors).toEqual([]);
});
