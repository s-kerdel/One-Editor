// "Developer: Show GPU status": in the browser only the page's own view (WebGL renderer, refresh rate);
// the desktop app adds Chromium's verdict (tests/e2e/electron/gpu-status.spec.ts).
import { test, expect } from './harness';

test('Developer: Show GPU status — renderer view in browser mode, Copy / Close', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Show GPU status');
  await expect(page.getByRole('dialog').getByText('Developer: Show GPU status').first()).toBeVisible();
  await page.keyboard.press('Enter');
  const dlg = page.locator('.se-dialog');
  await expect(dlg.locator('.se-dialog-title')).toHaveText('GPU status');
  await expect(dlg.locator('.se-dialog-details')).toContainText('compositing: n/a (browser mode)');
  await expect(dlg.locator('.se-dialog-details')).toContainText('WebGL renderer:');
  await expect(dlg.locator('.se-dialog-details')).toContainText(/display: \d+ Hz/);
  await dlg.locator('.se-btn', { hasText: 'Close' }).click();
  await expect(dlg).toHaveCount(0);
});
