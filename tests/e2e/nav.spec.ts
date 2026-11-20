// Go back / Go forward (browser mode): history across files and big jumps, closed tabs, keys, mouse
// side buttons (CDP), palette, typing, PDF pages, rename / delete, reload.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { writePdf } from './pdf-fixture';

const A = 'nav/alpha.md';
const B = 'nav/beta.md';
const C = 'nav/gamma.ts';
/** Longer than the 350 ms window in which jumps coalesce into one entry. */
const SETTLE = 450;

const lines = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name} line ${i + 1}`).join('\n') + '\n';

test.beforeEach(async ({ page, ws }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
  fs.mkdirSync(path.join(ws.root, 'nav'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, A), lines('alpha', 300));
  fs.writeFileSync(path.join(ws.root, B), lines('beta', 300));
  fs.writeFileSync(path.join(ws.root, C), lines('// gamma', 120));
});

async function boot(page: Page, ws: { open(p: Page): Promise<void> }) {
  await ws.open(page);
  await page.waitForFunction(() => !!(window as any).__secEditNav); // the recorder chunk (idle after boot)
}

interface State {
  active: string | null;
  line: number;
  col: number;
  top: number;
  tabs: string[];
  index: number;
  entries: Array<{ path: string; line?: number; page?: number }>;
}
const state = (page: Page): Promise<State> =>
  page.evaluate(() => {
    const app = (window as any).__secEdit;
    const h = (window as any).__secEditNav.history;
    const c = app.editor?.getCursor() ?? { line: -1, col: -1 };
    return {
      active: app.activePath.value,
      line: c.line,
      col: c.col,
      top: app.editor?.getTopLine() ?? -1,
      tabs: app.tabs.value.map((t: { path: string }) => t.path),
      index: h.index,
      entries: h.entries.map((e: any) => ({ path: e.path, line: e.line, page: e.page })),
    };
  });
const where = async (page: Page) => {
  const s = await state(page);
  return `${s.active}:${s.line}`;
};
const trail = async (page: Page) => (await state(page)).entries.map((e) => (e.page ? `${e.path}#${e.page}` : `${e.path}:${e.line ?? ''}`));

async function open(page: Page, file: string, line?: number, col = 0) {
  await page.evaluate(([f, l, c]) => (window as any).__secEdit.openFile(f, l === null ? undefined : { line: l, col: c }), [file, line ?? null, col] as const);
  await expect.poll(() => where(page)).toBe(`${file}:${line ?? 0}`);
  await page.waitForTimeout(SETTLE);
}

test('A → B → big jump in B: back restores each place, forward returns (Alt+Left / Alt+Right)', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 150, 4);
  await open(page, B, 3);
  await page.keyboard.press('Control+End'); // a big non-typing jump
  await expect.poll(() => where(page)).toBe(`${B}:300`);
  await page.waitForTimeout(SETTLE);
  expect(await trail(page)).toEqual([`${A}:150`, `${B}:3`, `${B}:300`]);

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${B}:3`);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${A}:150`);
  expect((await state(page)).col).toBe(4);
  await page.keyboard.press('Alt+ArrowLeft'); // at the start: nothing happens
  await page.waitForTimeout(150);
  expect(await where(page)).toBe(`${A}:150`);
  expect((await state(page)).index).toBe(0);

  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => where(page)).toBe(`${B}:3`);
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => where(page)).toBe(`${B}:300`);
  // Going back and forth never recorded anything itself.
  expect(await trail(page)).toEqual([`${A}:150`, `${B}:3`, `${B}:300`]);
  // The editor keeps focus: typing lands in the document.
  await expect(page.locator('.cm-content')).toBeFocused();
});

test('a new navigation after going back drops the forward entries', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 10);
  await open(page, B, 20);
  await open(page, C, 30);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${B}:20`);
  await page.waitForTimeout(SETTLE);
  await open(page, B, 200); // a jump from the middle of the history
  expect(await trail(page)).toEqual([`${A}:10`, `${B}:20`, `${B}:200`]);
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(150);
  expect(await where(page)).toBe(`${B}:200`);
});

test('a closed tab reopens on back, with cursor and scroll restored', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 200, 2);
  // Scroll away from where reveal centred the cursor, so "scroll restored" means something.
  await page.evaluate(() => (window as any).__secEdit.editor.scrollToLine(195));
  await expect.poll(async () => (await state(page)).top).toBe(195);
  await page.waitForTimeout(100); // the scroll event reaches the recorder
  await open(page, B, 5);
  await page.evaluate((p) => (window as any).__secEdit.closeTab(p), A);
  await expect.poll(async () => (await state(page)).tabs.includes(A)).toBe(false);

  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${A}:200`);
  const s = await state(page);
  expect(s.tabs).toContain(A);
  expect(s.col).toBe(2);
  await expect.poll(async () => (await state(page)).top).toBe(195);
  await expect(page.locator('.se-tab.active, .se-tab[aria-selected="true"]').first()).toContainText('alpha.md');
});

test('mouse side buttons: one step per press, anywhere in the window, and the page URL never changes', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 40);
  await open(page, B, 60);
  await open(page, C, 80);
  const url = page.url();
  const cdp = await page.context().newCDPSession(page);
  const press = async (button: 'back' | 'forward', x: number, y: number) => {
    const buttons = button === 'back' ? 8 : 16;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
  };
  const editor = (await page.locator('.cm-content').boundingBox())!;
  const sidebar = (await page.locator('.se-tree').boundingBox())!;

  await press('back', editor.x + 200, editor.y + 100); // over the editor
  await expect.poll(() => where(page)).toBe(`${B}:60`);
  await page.waitForTimeout(300);
  expect((await state(page)).index).toBe(1); // exactly one step
  // The click itself did not move the cursor or select anything.
  expect(await where(page)).toBe(`${B}:60`);

  await press('back', sidebar.x + 30, sidebar.y + sidebar.height - 20); // over the sidebar
  await expect.poll(() => where(page)).toBe(`${A}:40`);
  await press('back', editor.x + 200, editor.y + 100); // nothing further back: stays in the app
  await page.waitForTimeout(300);
  expect(await where(page)).toBe(`${A}:40`);
  expect(page.url()).toBe(url);
  await expect(page.locator('html[data-ready="true"]')).toHaveCount(1);

  await press('forward', editor.x + 200, editor.y + 100);
  await expect.poll(() => where(page)).toBe(`${B}:60`);
  await press('forward', 5, 5); // a corner of the window
  await expect.poll(() => where(page)).toBe(`${C}:80`);
  await press('forward', editor.x + 200, editor.y + 100);
  await page.waitForTimeout(300);
  expect((await state(page)).index).toBe(2);
  expect(page.url()).toBe(url);
  // Still the same document (no reload, no history walk): the recorder kept its entries.
  expect(await trail(page)).toEqual([`${A}:40`, `${B}:60`, `${C}:80`]);
  expect(await page.evaluate(() => history.length)).toBeGreaterThan(0);
});

test('typing and small cursor moves do not add entries; a far mouse click does', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 5);
  const before = (await state(page)).entries.length;
  await page.locator('.cm-content').click({ position: { x: 200, y: 30 } }); // a nearby line
  for (let i = 0; i < 25; i++) await page.keyboard.type(`typed ${i}\n`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Control+z'); // undo moves the cursor far, but it is an edit
  await page.waitForTimeout(SETTLE);
  const s = await state(page);
  expect(s.entries.length).toBe(before);
  expect(s.entries.at(-1)!.line).toBe(s.line); // the entry followed the cursor

  // A click far away (scrolled there with the wheel) is a navigation.
  await page.evaluate(() => (window as any).__secEdit.editor.scrollToLine(220));
  await page.waitForTimeout(100);
  const box = (await page.locator('.cm-scroller').boundingBox())!;
  await page.mouse.click(box.x + 200, box.y + 300); // viewport coordinates: no scrolling back to the top
  await expect.poll(async () => (await state(page)).entries.length).toBe(before + 1);
  const far = (await state(page)).line;
  expect(far).toBeGreaterThan(200);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(async () => (await state(page)).line).toBe(s.line);
});

test('palette: "Go back" and "Go forward" with their keys', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 10);
  await open(page, B, 20);
  const input = page.getByRole('dialog').locator('input');
  const first = page.locator('.se-pal-item').first();
  await page.keyboard.press('F1');
  await input.fill('>go back');
  await expect(first).toHaveAttribute('data-command-id', 'nav.back');
  await expect(first).toContainText('Go back');
  await expect(first.locator('kbd').first()).toHaveText('Alt');
  await page.keyboard.press('Enter');
  await expect.poll(() => where(page)).toBe(`${A}:10`);
  await page.keyboard.press('F1');
  await input.fill('>go forward');
  await expect(first).toHaveAttribute('data-command-id', 'nav.forward');
  await page.keyboard.press('Enter');
  await expect.poll(() => where(page)).toBe(`${B}:20`);
  // The CodeMirror action Alt+Left used to run is still reachable.
  await page.keyboard.press('F1');
  await input.fill('>syntax node start');
  await expect(first).toContainText('Move cursor to syntax node start');
});

test('PDF: pages are history entries (internal link, page box, #page), scrolling is not', async ({ page, ws }) => {
  writePdf(path.join(ws.root, 'nav/sample.pdf'), { pages: 12 });
  await boot(page, ws);
  await open(page, A, 30);
  const pageInput = page.locator('.se-pdf-page');
  await page.evaluate(() => (window as any).__secEdit.openFile('nav/sample.pdf'));
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(page.locator('.se-pdf .page[data-page-number="1"] canvas')).toBeVisible();
  await page.waitForTimeout(SETTLE);

  await page.locator('.se-pdf .page[data-page-number="1"] .annotationLayer a[href^="#"]').click(); // → page 3
  await expect(pageInput).toHaveValue('3');
  await page.waitForTimeout(SETTLE);
  await pageInput.fill('9');
  await pageInput.press('Enter');
  await expect(pageInput).toHaveValue('9');
  await page.waitForTimeout(1100); // the mark of the page box has expired
  // Scrolling on is not a navigation: the entry follows.
  await page.locator('.se-pdf-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(pageInput).toHaveValue('12');
  await page.waitForTimeout(SETTLE);
  expect(await trail(page)).toEqual([`${A}:30`, 'nav/sample.pdf:', 'nav/sample.pdf#3', 'nav/sample.pdf#12']);

  // #page link while the PDF is open
  await page.evaluate(() => (window as any).__secEdit.openFile('nav/sample.pdf', { line: 0, page: 6 }));
  await expect(pageInput).toHaveValue('6');
  await page.waitForTimeout(SETTLE);

  await page.keyboard.press('Alt+ArrowLeft');
  await expect(pageInput).toHaveValue('12');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(pageInput).toHaveValue('3');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(pageInput).toHaveValue('1');
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${A}:30`);
  await expect(page.locator('.se-pdf')).toHaveCount(0);
  // Forward into the PDF (its viewer is mounted again) lands on the recorded pages.
  await page.keyboard.press('Alt+ArrowRight');
  await expect(page.locator('.se-pdf-count')).toHaveText('/ 12', { timeout: 15000 });
  await expect(pageInput).toHaveValue('1');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(pageInput).toHaveValue('3');
  await page.keyboard.press('Alt+ArrowRight');
  await page.keyboard.press('Alt+ArrowRight');
  await expect(pageInput).toHaveValue('6');
  expect((await state(page)).entries.length).toBe(5);
});

test('entries follow a rename and skip a deleted file', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 100);
  await open(page, B, 50);
  await open(page, C, 20);
  // Rename alpha.md (not the active tab) in the tree.
  await page.locator('.se-tree-row', { hasText: 'alpha' }).first().click();
  await expect.poll(() => where(page)).toBe(`${A}:100`);
  await page.waitForTimeout(SETTLE);
  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  await page.locator('.se-tree-input').fill('renamed.md');
  await page.keyboard.press('Enter');
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'nav/renamed.md'))).toBe(true);
  expect(await trail(page)).toEqual(['nav/renamed.md:100', `${B}:50`, `${C}:20`, 'nav/renamed.md:100']);

  // beta.md is closed, then deleted on disk: going back steps over it.
  await page.evaluate((p) => (window as any).__secEdit.closeTab(p), B);
  fs.rmSync(path.join(ws.root, B));
  await expect.poll(() => page.evaluate((p) => (window as any).__secEdit.files.value.includes(p), B)).toBe(false);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${C}:20`);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe('nav/renamed.md:100');
  expect((await state(page)).tabs).not.toContain(B);
  expect(await trail(page)).toEqual(['nav/renamed.md:100', `${C}:20`, 'nav/renamed.md:100']);
});

test('the history survives a reload of the window', async ({ page, ws }) => {
  await boot(page, ws);
  await open(page, A, 120);
  await open(page, B, 7);
  await page.waitForTimeout(400); // session (open tabs) saved
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForFunction(() => !!(window as any).__secEditNav);
  const s = await state(page);
  expect(s.active).toBe(B);
  expect(s.entries.map((e) => e.path)).toEqual([A, B]);
  await page.keyboard.press('Alt+ArrowLeft');
  await expect.poll(() => where(page)).toBe(`${A}:120`);
});
