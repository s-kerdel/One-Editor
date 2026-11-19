// Visual check of the formatting toolbar + context menu (screenshots only; looked at by a human/agent).
import { test, expect } from './harness';
import { openNote, shot } from './editor-helpers';

for (const theme of ['dark', 'light'] as const) {
  for (const ui of ['shelf', 'classic'] as const) {
    for (const width of ['readable', 'full'] as const) {
      test(`toolbar + context menu: ${theme} / ${ui} / ${width}`, async ({ page, ws }) => {
        await ws.server.service.saveSettings({ sidebarStyle: ui, contentWidth: width, theme });
        await ws.open(page);
        await openNote(page, 'notes/Daily notes.md', 'Daily notes');
        await page.evaluate(() => {
          const view = (window as any).__secEdit.editor.getView();
          const doc: string = view.state.doc.toString();
          const at = doc.indexOf('Callouts render');
          view.dispatch({ selection: { anchor: at, head: at + 8 } });
          view.focus();
        });
        await expect(page.locator('.se-fmtbar')).toBeVisible();
        await page.screenshot({ path: shot(`toolbar-${theme}-${ui}-${width}.png`) });
        const word = page.locator('.cm-line', { hasText: 'Inline math' });
        const box = (await word.boundingBox())!;
        await page.mouse.click(box.x + 60, box.y + box.height / 2, { button: 'right' });
        await expect(page.locator('.se-menu')).toBeVisible();
        await page.waitForTimeout(200); // pop-in animation
        await page.screenshot({ path: shot(`ctxmenu-${theme}-${ui}-${width}.png`) });
        await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2); // click away closes it
        // Selection menu (formatting items) + the toolbar's text-style dropdown.
        await page.evaluate(() => {
          const view = (window as any).__secEdit.editor.getView();
          const doc: string = view.state.doc.toString();
          const at = doc.indexOf('Inline math');
          view.dispatch({ selection: { anchor: at, head: at + 11 } });
          view.focus();
        });
        await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: 'right' });
        await page.waitForTimeout(200);
        await page.screenshot({ path: shot(`ctxmenu-sel-${theme}-${ui}-${width}.png`) });
        await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
        await expect(page.locator('.se-menu')).toHaveCount(0);
        await page.locator('.se-fmt-block').click();
        await page.waitForTimeout(200);
        await page.screenshot({ path: shot(`toolbar-menu-${theme}-${ui}-${width}.png`) });
      });
    }
  }
}

test('toolbar: narrow window overflow menu, callout menu, square corners', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ cornerStyle: 'square', theme: 'dark' });
  await page.setViewportSize({ width: 820, height: 640 });
  await ws.open(page);
  await openNote(page, 'notes/Daily notes.md', 'Daily notes');
  await expect(page.locator('.se-fmt-more')).toBeVisible();
  await page.locator('.se-fmt-more').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('toolbar-overflow-square.png') });
  await page.locator('.se-fmt-more').click(); // toggles closed
  await expect(page.locator('.se-fmt-menu')).toHaveCount(0);
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(page.locator('[data-tool="callout"]')).toBeVisible();
  await page.locator('[data-tool="callout"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: shot('toolbar-callout-menu-square.png') });
});
