// The old "Print / Save as PDF" command is gone from the palette; Export note to PDF replaces it.
import { test, expect } from './harness';

test('palette offers Export note to PDF, not the old print command', async ({ page, ws }) => {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+Shift+P');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await page.keyboard.type('print');
  const list = page.getByRole('dialog').getByRole('option');
  await expect(list.first()).toContainText('Export note to PDF');
  await expect(page.getByRole('dialog').getByText(/Print \/ Save as PDF|Print \(PDF export fallback\)/)).toHaveCount(0);
});
