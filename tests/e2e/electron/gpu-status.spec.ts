// "Developer: Show GPU status" in the desktop app: Chromium's own verdict (app.getGPUFeatureStatus via
// main), the GPU-related switches in effect, plus the page's view. Tests run with --disable-gpu, so the
// dialog must say software compositing and list that switch.
import { test, expect } from './fixture';

test('Developer: Show GPU status reports Chromium’s compositing mode and the switches', async ({ el }) => {
  const { page } = await el.launch();
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('Show GPU status');
  await expect(page.getByRole('dialog').getByText('Developer: Show GPU status').first()).toBeVisible();
  await page.keyboard.press('Enter');
  const dlg = page.locator('.se-dialog');
  await expect(dlg.locator('.se-dialog-title')).toHaveText('GPU status');
  await expect(dlg.locator('.se-dialog-msg')).toContainText('Software compositing');
  const details = dlg.locator('.se-dialog-details');
  await expect(details).toContainText('gpu compositing: disabled_software');
  await expect(details).toContainText('switches: --disable-gpu');
  await expect(details).toContainText('WebGL renderer:');
  // The same report straight from the bridge (main answers trusted senders only).
  const s = await page.evaluate(() => (window as any).secEditBridge.gpuStatus());
  expect(s.features.gpu_compositing).toBe('disabled_software');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
});
