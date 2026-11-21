// Context menus are keyboard-usable: the menu takes focus once it is placed (it renders hidden first, and a
// hidden element can't take focus), so ↑ ↓ pick an item and Enter runs it; Esc closes and nothing runs.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

const row = (page: Page, rel: string) => page.locator(`.se-tree-row[data-path="${rel}"]`);

test('a right-click menu takes focus; ArrowDown selects, Enter runs, Escape closes', async ({ page, ws }) => {
  await ws.open(page);
  await expect(row(page, 'notes')).toBeVisible();

  await row(page, 'notes').click({ button: 'right' });
  const menu = page.locator('.se-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toBeFocused();

  // Esc closes without running anything.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // ↓ walks the actionable items; Enter runs the selected one ("New note" on a folder → inline name input).
  await row(page, 'notes').click({ button: 'right' });
  await expect(menu).toBeFocused();
  const selected = menu.locator('.se-menu-item.selected');
  for (let i = 0; i < 15; i++) {
    await page.keyboard.press('ArrowDown');
    await expect(selected).toHaveCount(1);
    if ((await selected.locator('.se-menu-label').textContent())?.trim() === 'New note') break;
  }
  await expect(selected.locator('.se-menu-label')).toHaveText('New note');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.se-tree-input')).toBeFocused();
  await page.keyboard.press('Escape');
});
