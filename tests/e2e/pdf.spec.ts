// PDF viewer E2E (browser mode): open from the tree, page count, lazy page rendering, find, zoom,
// dark pages, links (internal navigates, external only on click), embed card → page, session restore.
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { writePdf } from './pdf-fixture';

const row = (page: Page, name: string) => page.locator('.se-tree-row', { hasText: name }).first();
const pageInput = (page: Page) => page.locator('.se-pdf-page');
const pageBox = (page: Page, n: number) => page.locator(`.se-pdf .page[data-page-number="${n}"]`);

test.beforeEach(async ({ page, ws }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  writePdf(path.join(ws.root, 'docs/sample.pdf'), { pages: 12, needlePages: [2, 5, 9] });
  // Record what the app hands to the OS browser instead of opening windows.
  await page.addInitScript(() => {
    (window as any).__opened = [];
    (window as any).open = (url: string) => void (window as any).__opened.push(String(url));
  });
});

async function openSample(page: Page) {
  await row(page, 'docs').click();
  await row(page, 'sample.pdf').click();
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(pageBox(page, 1).locator('canvas')).toBeVisible();
  await expect(pageBox(page, 1).locator('.textLayer')).toContainText('Page 1');
}

test('opens from the tree: page count, text layer, later pages render on scroll', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  await expect(page.locator('.se-tab', { hasText: 'sample.pdf' })).toBeVisible();
  await expect(pageInput(page)).toHaveValue('1');
  // The status bar names the file type, not a language ("Plain text").
  await expect(page.getByTestId('language')).toHaveText('PDF');
  // Virtualised: the last page has no canvas until it is scrolled to.
  await expect(pageBox(page, 12)).toHaveCount(1);
  expect(await pageBox(page, 12).getAttribute('data-loaded')).toBeNull();
  await page.locator('.se-pdf-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(pageBox(page, 12).locator('canvas')).toBeVisible();
  await expect(pageInput(page)).toHaveValue('12');
  // Go to page
  await pageInput(page).fill('4');
  await pageInput(page).press('Enter');
  await expect(pageInput(page)).toHaveValue('4');
  await expect(pageBox(page, 4).locator('.textLayer')).toContainText('Page 4');
  // Selection / copy works on the text layer.
  const text = await pageBox(page, 4).locator('.textLayer').evaluate((el) => el.textContent ?? '');
  expect(text).toContain('This is page 4 of 12.');
});

test('Ctrl+F finds and highlights text; Enter goes to the next match', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  await page.locator('.se-pdf-scroll').focus();
  await page.keyboard.press('Control+f');
  await expect(page.locator('.se-pdf-find-input')).toBeFocused();
  await page.keyboard.type('needle');
  await expect(page.locator('.se-pdf-find-count')).toHaveText('1 / 3', { timeout: 10000 });
  await expect(page.locator('.se-pdf .textLayer .highlight').first()).toBeVisible();
  await expect(pageInput(page)).toHaveValue('2');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-pdf-find-count')).toHaveText('2 / 3');
  await expect(pageInput(page)).toHaveValue('5');
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-pdf-find')).toHaveCount(0);
  await expect(page.locator('.se-pdf .textLayer .highlight')).toHaveCount(0);
});

test('zoom: fit width by default, Ctrl+= / Ctrl+- / Ctrl+wheel / picker', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  const width = () => pageBox(page, 1).evaluate((el) => el.clientWidth); // without pdf.js's transparent page border
  const scroll = await page.locator('.se-pdf-scroll').evaluate((el) => el.clientWidth);
  const fit = await width();
  expect(Math.abs(scroll - fit)).toBeLessThan(80); // fit width (minus the scrollbar / gutter)
  await expect(page.locator('.se-pdf-zoom')).toHaveValue('page-width');
  await page.locator('.se-pdf-scroll').focus();
  await page.keyboard.press('Control+=');
  await expect.poll(width).toBeGreaterThan(fit + 5);
  const zoomed = await width();
  await page.keyboard.press('Control+-');
  await page.keyboard.press('Control+-');
  await expect.poll(width).toBeLessThan(zoomed - 5);
  await page.keyboard.press('Control+0');
  await expect.poll(width).toBeCloseTo(fit, 0);
  await page.locator('.se-pdf-zoom').selectOption('1');
  await expect.poll(width).toBeCloseTo(612 * (96 / 72), -1); // 100 % = CSS size of a Letter page
  const before = await width();
  await page.locator('.se-pdf-scroll').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect.poll(width).toBeGreaterThan(before + 5);
  // The app UI itself did not zoom.
  expect(await page.evaluate(() => (window as any).__secEdit.settings.value.zoom ?? 1)).toBe(1);
});

test('dark pages toggle inverts pages and is remembered', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  const filter = () => pageBox(page, 1).locator('.canvasWrapper').evaluate((el) => getComputedStyle(el).filter);
  expect(await filter()).toBe('none');
  await page.locator('.se-pdf-darkbtn').click();
  await expect(page.locator('.se-pdf')).toHaveClass(/se-pdf-dark/);
  expect(await filter()).toContain('invert');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(page.locator('.se-pdf')).toHaveClass(/se-pdf-dark/);
});

test('links: internal link navigates, external link opens only on click and never navigates the app', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  const ext = pageBox(page, 1).locator('.annotationLayer a[href^="https:"]');
  await expect(ext).toHaveCount(1);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__opened)).toEqual([]); // nothing automatic
  const url = page.url();
  await ext.click();
  await expect.poll(() => page.evaluate(() => (window as any).__opened)).toEqual(['https://example.com/sec-edit-pdf-test']);
  expect(page.url()).toBe(url);
  await pageBox(page, 1).locator('.annotationLayer a[href^="#"]').click();
  await expect(pageInput(page)).toHaveValue('3');
});

test('embed card in reading view opens the viewer at #page=N', async ({ page, ws }) => {
  await ws.write('pdf-embed.md', '# PDF embed\n\n![[sample.pdf#page=7]]\n\nAnd a link: [[sample.pdf#page=9]]\n');
  await ws.open(page);
  await page.evaluate(async () => {
    const a = (window as any).__secEdit;
    a.settings.value = await a.backend.saveSettings({ viewMode: 'preview' });
  });
  await row(page, 'pdf-embed').click();
  const card = page.locator('.se-preview a.se-embed-pdf-card');
  await expect(card).toBeVisible({ timeout: 10000 });
  await expect(card).toContainText('sample.pdf');
  await expect(card).toContainText('page 7');
  await card.click();
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(pageInput(page)).toHaveValue('7');
  // An already open viewer follows a link to another page.
  await page.locator('.se-tab', { hasText: 'pdf-embed' }).click();
  await page.locator('.se-preview a.se-wikilink', { hasText: 'sample.pdf' }).last().click();
  await expect(pageInput(page)).toHaveValue('9');
});

test('session restore reopens the PDF tab; closing the tab destroys the document', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  await pageInput(page).fill('6');
  await pageInput(page).press('Enter');
  await expect(pageInput(page)).toHaveValue('6');
  await page.waitForTimeout(400); // session save is debounced
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await expect(page.locator('.se-tab', { hasText: 'sample.pdf' })).toBeVisible();
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await page.locator('.se-pdf-scroll').focus();
  await page.keyboard.press('Control+w');
  await expect(page.locator('.se-tab', { hasText: 'sample.pdf' })).toHaveCount(0);
  await expect(page.locator('.se-pdf')).toHaveCount(0);
  // …and opening it again starts a fresh viewer.
  await page.evaluate(() => (window as any).__secEdit.openFile('docs/sample.pdf'));
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(pageBox(page, 1).locator('canvas')).toBeVisible();
});

test('a PDF changed on disk reloads and keeps the page', async ({ page, ws }) => {
  await ws.open(page);
  await openSample(page);
  await pageInput(page).fill('3');
  await pageInput(page).press('Enter');
  await expect(pageInput(page)).toHaveValue('3');
  writePdf(path.join(ws.root, 'docs/sample.pdf'), { pages: 12, needlePages: [2, 5, 9], marker: 'Second version' });
  await expect(pageBox(page, 3).locator('.textLayer')).toContainText('Second version', { timeout: 15000 });
  await expect(pageInput(page)).toHaveValue('3');
});
