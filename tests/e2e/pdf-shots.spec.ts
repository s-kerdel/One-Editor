// Visual check of the PDF viewer (screenshots only, looked at by a human / agent): dark + light theme,
// normal and "dark pages", find highlights, and the ![[doc.pdf]] embed card. → .tmp/pdf/shots/
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './harness';
import { writePdf } from './pdf-fixture';

const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tmp/pdf/shots');

for (const theme of ['dark', 'light'] as const) {
  test(`pdf viewer screenshots: ${theme}`, async ({ page, ws }) => {
    writePdf(path.join(ws.root, 'docs/sample.pdf'), { pages: 8, needlePages: [1, 2] });
    await ws.write('pdf-embed.md', '# Reading list\n\nThe spec, page 3:\n\n![[sample.pdf#page=3]]\n\nWhole file: ![[sample.pdf]]\n');
    await ws.server.service.saveSettings({ theme, viewMode: 'preview' });
    await page.setViewportSize({ width: 1280, height: 800 });
    await ws.open(page);
    await page.evaluate(() => (window as any).__secEdit.openFile('docs/sample.pdf'));
    await expect(page.locator('.se-pdf-count')).toHaveText('/ 8', { timeout: 15000 });
    await expect(page.locator('.se-pdf .page[data-page-number="1"] canvas')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/${theme}-viewer.png` });
    await page.locator('.se-pdf-scroll').focus();
    await page.keyboard.press('Control+f');
    // Type only once the box has focus: keys sent earlier land elsewhere (a search for just 'e' under load).
    await expect(page.locator('.se-pdf-find-input')).toBeFocused();
    await page.keyboard.type('needle');
    await expect(page.locator('.se-pdf-find-count')).toHaveText('1 / 2');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/${theme}-find.png` });
    await page.keyboard.press('Escape');
    await page.locator('.se-pdf-darkbtn').click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/${theme}-dark-pages.png` });
    await page.locator('.se-pdf-darkbtn').click(); // leave it off for the next test
    await page.evaluate(() => (window as any).__secEdit.openFile('pdf-embed.md'));
    await expect(page.locator('.se-preview a.se-embed-pdf-card').first()).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: `${SHOTS}/${theme}-embed-card.png` });
  });
}
