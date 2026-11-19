// File overview (right sidebar, Ctrl+Alt+B): toggling, persistence before first paint, resizing,
// live outline / code blocks / tasks / links for the active file, both sidebar styles.
import { test, expect } from './harness';
import type { Page } from '@playwright/test';

const open = (page: Page, path: string) => page.evaluate((p) => (window as any).__secEdit.openFile(p), path);
const overview = (page: Page) => page.locator('aside.se-overview');

async function toggleWithKeys(page: Page) {
  await page.keyboard.press('Control+Alt+b');
}

test('toggle button + Ctrl+Alt+B + palette command show and hide the column', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md');
  const btn = page.locator('.se-tabbar-tools .se-ov-toggle');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(overview(page)).toHaveCount(0);

  await btn.click();
  await expect(overview(page)).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.se-root')).toHaveClass(/ov-open/);
  // The card stays in the middle: the column sits to its right.
  const card = await page.locator('.se-content').boundingBox();
  const col = await overview(page).boundingBox();
  expect(col!.x).toBeGreaterThanOrEqual(card!.x + card!.width - 1);
  expect(Math.round(col!.x + col!.width)).toBe(page.viewportSize()!.width);

  await page.locator('.cm-content').click();
  await toggleWithKeys(page);
  await expect(overview(page)).toHaveCount(0);
  await toggleWithKeys(page);
  await expect(overview(page)).toBeVisible();

  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('toggle file overview');
  await expect(page.locator('.se-pal-item.selected')).toContainText('View: Toggle file overview');
  await page.keyboard.press('Enter');
  await expect(overview(page)).toHaveCount(0);
});

test('shows outline, code blocks, links and info for the active note; follows edits and the cursor', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md');
  await toggleWithKeys(page);
  const col = overview(page);
  await expect(col.locator('.se-ov-file-name')).toHaveText('README');
  await expect(col.locator('.se-ov-ol .se-ov-text')).toHaveText(['Welcome', 'Commands']);
  await expect(col.locator('.se-ov-code .se-ov-cmd')).toHaveText(['git push --force-with-lease origin main']);
  await expect(col.locator('.se-ov-code .se-ov-lang')).toHaveText(['bash']);
  // Knowledge index (loads on idle): outgoing link + the note linking here.
  await expect(col.locator('.se-ov-link .se-ov-text')).toContainText(['Daily notes']);
  await expect(col.locator('.se-ov-back .se-ov-name')).toContainText(['Daily notes']);
  await expect(col.locator('.se-ov-pill')).toContainText(['#tag/project', '#idea']);

  // Click a heading: the cursor lands on it, editor focused.
  await col.locator('.se-ov-ol', { hasText: 'Commands' }).click();
  await expect(page.locator('.se-status')).toContainText('Ln 8, Col 1');
  await expect(page.locator('.cm-content')).toBeFocused();
  await expect(col.locator('.se-ov-ol.is-active')).toContainText('Commands');

  // Live: a new heading appears after the short debounce; moving the cursor moves the highlight.
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n## Deploy steps\n');
  await expect(col.locator('.se-ov-ol .se-ov-text')).toHaveText(['Welcome', 'Commands', 'Deploy steps']);
  await expect(col.locator('.se-ov-ol.is-active')).toContainText('Deploy steps');
  await page.keyboard.press('Control+Home');
  await expect(col.locator('.se-ov-ol.is-active')).toContainText('Welcome');

  // Code block row → jumps into the block.
  await col.locator('.se-ov-code').first().click();
  await expect(page.locator('.se-status')).toContainText('Ln 11,');
});

test('task checkbox in the overview toggles the task in the note (undoable)', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/Daily notes.md');
  await toggleWithKeys(page);
  const col = overview(page);
  await expect(col.locator('[data-section="tasks"] .se-ov-count')).toHaveText('1/2');
  await col.locator('.se-ov-task .se-ov-check').first().click();
  await expect(col.locator('[data-section="tasks"] .se-ov-count')).toHaveText('2/2');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent())).toContain('- [x] Write the release notes');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect(col.locator('[data-section="tasks"] .se-ov-count')).toHaveText('1/2');
});

test('code files get a symbol outline; images get file info', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'code/UserController.php');
  await toggleWithKeys(page);
  const col = overview(page);
  await expect(col.locator('[data-section="outline"] .se-ov-sec-title')).toHaveText('Symbols');
  await expect(col.locator('.se-ov-ol .se-ov-text')).toHaveText(['UserController', 'index', 'show']);
  await expect(col.locator('[data-section]')).toHaveCount(2); // symbols + info
  await expect(col.locator('.se-ov-facts')).toContainText('PHP');
});

test('visibility and width survive a reload — and are in the skeleton before first paint', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md');
  await toggleWithKeys(page);
  await expect(overview(page)).toBeVisible();
  // Drag the sash 60px to the left → 60px wider.
  const before = (await overview(page).boundingBox())!;
  const sash = overview(page).locator('> .se-sash');
  const s = (await sash.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + 200);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 - 60, s.y + 200, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await overview(page).boundingBox())!.width)).toBe(Math.round(before.width + 60));
  await page.waitForTimeout(400); // session save is debounced

  // Hold the app bundle: what's on screen is the static skeleton.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  const nav = page.reload();
  await page.waitForSelector('.sk-ov', { state: 'attached' });
  const skel = await page.evaluate(() => {
    const r = document.querySelector('.sk-ov')!.getBoundingClientRect();
    return [r.x, r.y, r.width, r.height];
  });
  release();
  await nav;
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  const real = await overview(page).boundingBox();
  expect([real!.x, real!.y, real!.width, real!.height]).toEqual(skel);
  expect(Math.round(real!.width)).toBe(Math.round(before.width + 60));
  await expect(overview(page).locator('.se-ov-file-name')).toHaveText('README');

  // Double-click the sash: default width again.
  await overview(page).locator('> .se-sash').dblclick();
  await expect.poll(async () => Math.round((await overview(page).boundingBox())!.width)).toBe(280);
});

test('classic style: flat panel with the strip rule continued, same behaviour', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ sidebarStyle: 'classic' });
  await ws.open(page);
  await open(page, 'README.md');
  await toggleWithKeys(page);
  const col = overview(page);
  await expect(col).toBeVisible();
  const look = await col.evaluate((el) => {
    const cs = getComputedStyle(el);
    const head = el.querySelector('.se-ov-head')!.getBoundingClientRect();
    const bar = document.querySelector('.se-tabbar')!.getBoundingClientRect();
    return { bg: cs.backgroundColor, border: cs.borderLeftWidth, headBottom: head.bottom, barBottom: bar.bottom };
  });
  expect(look.border).toBe('1px');
  expect(look.bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(look.headBottom).toBe(look.barBottom); // the head's rule lines up with the tab strip's
  await expect(col.locator('.se-ov-ol .se-ov-text')).toHaveText(['Welcome', 'Commands']);
});

test('keyboard: Tab into the outline, arrows + Enter jump', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md');
  await toggleWithKeys(page);
  const col = overview(page);
  await col.locator('.se-ov-ol').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(col.locator('.se-ov-ol', { hasText: 'Commands' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-status')).toContainText('Ln 8, Col 1');
  await expect(page.locator('.cm-content')).toBeFocused();
});
