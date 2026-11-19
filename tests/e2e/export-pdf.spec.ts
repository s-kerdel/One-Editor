// Browser mode has no Chromium on the server: "Export note to PDF…" falls back to the print dialog
// (window.print is stubbed) with a one-line hint and the paper settings from Settings → Export.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

async function runCommand(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type(title);
  await expect(page.getByRole('dialog').getByText(title, { exact: false }).first()).toBeVisible();
  await page.keyboard.press('Enter');
}

/** Records each window.print() call: the @page rules in force and what the preview holds at that moment. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__prints = [];
    window.print = () => {
      window.dispatchEvent(new Event('beforeprint'));
      const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
      w.__prints.push({ page: css.match(/@page\{[^}]*\}/g) ?? [], breaks: document.querySelectorAll('.se-preview .se-page-break').length, h1: document.querySelector('.se-preview h1')?.textContent });
      window.dispatchEvent(new Event('afterprint'));
    };
  });
}
const prints = (page: Page) => page.evaluate(() => (window as any).__prints as Array<{ page: string[]; breaks: number; h1: string }>);

test('falls back to the print dialog with a hint, using the PDF page settings', async ({ page, ws }) => {
  await ws.write('Report.md', '# Quarterly Report\n\nBody text.\n\n\\pagebreak\n\nPage two.\n');
  await ws.open(page);
  await stubPrint(page);
  // Default view mode (live): no preview pane yet — the fallback creates it.
  await page.evaluate(() => (window as any).__secEdit.openFile('Report.md'));
  await expect(page.locator('.se-tab.active')).toContainText('Report.md');
  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: "Choose 'Save as PDF' as the printer" })).toBeVisible();
  await expect.poll(async () => (await prints(page)).length).toBe(1);
  const [first] = await prints(page);
  expect(first.h1).toBe('Quarterly Report');
  expect(first.breaks).toBe(1);
  expect(first.page.join(' ')).toContain('@page{size:210mm 297mm;margin:20mm 20mm 22mm 20mm}');
  // The temporary @page rule is gone afterwards (plain "Print" keeps its own margins).
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('style')].some((s) => s.textContent?.includes('size:210mm 297mm')))).toBe(false);

  // Settings → Export apply to the fallback too.
  await page.evaluate(async () => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ 'export.pdfPageSize': 'Letter', 'export.pdfMargins': 'wide' });
  });
  await runCommand(page, 'Export note to PDF');
  await expect.poll(async () => (await prints(page)).length).toBe(2);
  expect((await prints(page))[1].page.join(' ')).toContain('@page{size:215.9mm 279.4mm;margin:25mm 32mm 27mm 32mm}');
});

test('the tab menu offers it for notes only; the server refuses the desktop RPC', async ({ page, ws }) => {
  await ws.open(page);
  await stubPrint(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await page.locator('.se-tab.active').click({ button: 'right' });
  await expect(page.locator('.se-menu-item', { hasText: 'Copy path' })).toBeVisible();
  await expect(page.locator('.se-menu-item', { hasText: 'Export to PDF' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.locator('.se-tab.active').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Export to PDF…' }).click();
  await expect(page.locator('.se-toast', { hasText: "Choose 'Save as PDF' as the printer" })).toBeVisible();
  await expect.poll(async () => (await prints(page)).length).toBe(1);

  const code = await page.evaluate(() =>
    (window as any).__secEdit.backend.exportPdf({ path: 'README.md', html: '<p>x</p>', pageSize: 'A4', margins: 'normal', pageNumbers: true }).then(
      () => 'resolved',
      (e: { code: string }) => e.code,
    ),
  );
  expect(code).toBe('ENOTSUP');
});
