import { test, expect } from './harness';

test('boots, shows tree, opens and saves a file', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  await expect(page.locator('.se-tree-row', { hasText: 'README.md' })).toBeVisible();
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\nAdded by e2e');
  await page.keyboard.press('Control+s');
  await expect.poll(() => ws.read('README.md')).toContain('Added by e2e');
  expect(errors).toEqual([]);
});

test('quick switcher opens a nested file', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press('Control+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('deepnote');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('needle in a haystack');
});
