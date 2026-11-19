// Optional writing aids: focus mode (dim all but the current block) and typewriter scrolling.
import { test, expect } from './harness';
import { openNote, cursorTo } from './editor-helpers';

test('focus mode dims everything but the current paragraph; typewriter keeps the caret centred', async ({ page, ws }) => {
  const paras = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} line one.\nParagraph ${i} line two.`).join('\n\n');
  await ws.write('notes/write.md', paras + '\n');
  await ws.server.service.saveSettings({ 'editor.focusMode': true, 'editor.typewriter': true });
  await ws.open(page);
  await openNote(page, 'notes/write.md', 'Paragraph 0');
  await cursorTo(page, { lineOf: 'Paragraph 30 line two' });
  const ed = page.locator('.cm-editor');
  await expect(ed).toHaveClass(/se-focus-mode/);
  await expect(ed).toHaveClass(/se-typewriter/);
  await expect(page.locator('.cm-line.se-focus-on')).toHaveCount(2);
  await expect(page.locator('.cm-line.se-focus-on').first()).toContainText('Paragraph 30 line one');
  const opacity = (t: string) => page.locator('.cm-line', { hasText: t }).evaluate((el) => getComputedStyle(el).opacity);
  await expect.poll(() => opacity('Paragraph 29 line two')).toBe('0.3');
  expect(await opacity('Paragraph 30 line one')).toBe('1');

  // Typing keeps the cursor line in the vertical middle of the editor.
  await page.keyboard.press('Enter');
  await page.keyboard.type('new text');
  await page.waitForTimeout(100);
  const off = await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    const c = view.coordsAtPos(view.state.selection.main.head);
    const r = view.scrollDOM.getBoundingClientRect();
    return Math.abs((c.top + c.bottom) / 2 - (r.top + r.bottom) / 2);
  });
  expect(off).toBeLessThan(40);
  // Unfocused editor: nothing is dimmed.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect.poll(() => opacity('Paragraph 29 line two')).toBe('1');
});
