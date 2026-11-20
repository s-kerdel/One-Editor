// Browser mode: "Security updates" is a desktop feature (the check runs in Electron's main process).
// No commands, no Settings section, no shield, and its chunk is never fetched.
import { test, expect } from './harness';

test('browser build: no security-updates commands, settings or chunk', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  // The idle Popups chunk is what pulls the feature in on the desktop: wait for it here.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/Popups-[\w-]+\.js$/.test(e.name)))).toBe(true);
  await page.waitForTimeout(300);

  await page.keyboard.press('Control+Shift+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await input.fill('>security updates');
  await expect(page.locator('.se-pal-item[data-command-id^="updates."]')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+,');
  await expect(page.locator('[data-testid="settings"]')).toBeVisible();
  await expect(page.locator('[data-nav="updates"]')).toHaveCount(0);
  await expect(page.locator('[data-row="updates.check"], [data-testid="updates-settings"], [data-testid="updates-shield"]')).toHaveCount(0);

  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /updates-ui/.test(e.name)))).toBe(false);
  expect(await page.evaluate(() => (window as any).__secEditUpdates)).toBeUndefined();
  expect(errors).toEqual([]);
});
