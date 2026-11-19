// Appearance options (Settings → Appearance): accent colour, corner style, density, content width,
// line height, editor font. Every control applies live, persists, and is restored before first paint.
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const cssVar = (page: Page, name: string, sel = 'html') => page.evaluate(([n, s]) => getComputedStyle(document.querySelector(s)!).getPropertyValue(n).trim(), [name, sel]);
const saved = async (ws: WsFixture) => (await ws.server.service.getSettings()) as Record<string, unknown>;

async function openSettings(page: Page) {
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  return dlg;
}

async function openNote(page: Page, ws: WsFixture, path = 'notes/Daily notes.md') {
  await ws.open(page);
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), path);
  await expect(page.locator('.cm-content')).toBeVisible();
}

/** Reloads while holding the app bundle back, runs `probe` on the bare skeleton, then lets the app boot. */
async function reloadProbingSkeleton<T>(page: Page, probe: () => T): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  const nav = page.reload();
  await page.waitForSelector('.sk-main', { state: 'attached' });
  const out = await page.evaluate(probe);
  release();
  await nav;
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await page.unroute(/\/assets\/index-[^/]+\.js$/);
  return out;
}

test('accent colour: swatches + custom apply live, per theme, and survive a refresh without a flash', async ({ page, ws }) => {
  await openNote(page, ws);
  expect(await cssVar(page, '--accent')).toBe('#7aa2f7');
  const dlg = await openSettings(page);
  const swatches = dlg.locator('[data-setting="accentColor"] .se-swatch');
  expect(await swatches.count()).toBeGreaterThanOrEqual(11); // ≥ 10 curated + custom
  await expect(dlg.locator('[data-setting="accentColor"] [data-value=""]')).toHaveAttribute('aria-checked', 'true');

  await dlg.locator('[data-setting="accentColor"] [data-value="#f97316"]').click();
  await expect.poll(() => cssVar(page, '--accent')).toBe('#f97316');
  await expect(dlg.locator('[data-setting="accentColor"] [data-value="#f97316"]')).toHaveAttribute('aria-checked', 'true');
  // every accent token follows
  expect(await cssVar(page, '--accent-soft')).toBe('rgba(249, 115, 22, 0.15)');
  expect(await cssVar(page, '--selection')).toBe('rgba(249, 115, 22, 0.28)');
  expect(await cssVar(page, '--focus-ring')).toBe('rgba(249, 115, 22, 0.6)');
  expect(await cssVar(page, '--accent-fg')).toBe('#0f1320');
  expect(await cssVar(page, '--accent-strong')).not.toBe('#9ab8ff');
  // …and real UI picks it up: the active tab's top line
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('.se-tab.active')!, '::before').backgroundColor)).toBe('rgb(249, 115, 22)');
  await expect.poll(async () => (await saved(ws)).accentColor).toBe('#f97316');

  // Light theme: same hue, darkened until readable on white — recomputed without touching the setting.
  await dlg.locator('[data-setting="theme"] [data-value="light"]').click();
  const light = await cssVar(page, '--accent');
  expect(light).not.toBe('#f97316');
  expect(light).not.toBe('#3b6ee8');
  expect(await cssVar(page, '--accent-soft')).toMatch(/, 0\.11\)$/);
  await dlg.locator('[data-setting="theme"] [data-value="dark"]').click();
  expect(await cssVar(page, '--accent')).toBe('#f97316');
  // "system" follows the OS scheme
  await dlg.locator('[data-setting="theme"] [data-value="system"]').click();
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await cssVar(page, '--accent')).toBe(light);
  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await cssVar(page, '--accent')).toBe('#f97316');
  await dlg.locator('[data-setting="theme"] [data-value="dark"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Refresh: the accent is on the page before the app bundle even runs.
  const early = await reloadProbingSkeleton(page, () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  expect(early).toBe('#f97316');
  expect(await cssVar(page, '--accent')).toBe('#f97316');

  // Custom colour input, then reset to the default blue.
  const dlg2 = await openSettings(page);
  await dlg2.getByTestId('accent-custom').fill('#00b3a4');
  await expect.poll(() => cssVar(page, '--accent')).toBe('#00b3a4');
  await expect(dlg2.locator('[data-setting="accentColor"] .se-swatch.custom')).toHaveClass(/active/);
  await expect.poll(async () => (await saved(ws)).accentColor).toBe('#00b3a4');
  await dlg2.locator('[data-reset="accentColor"]').click();
  await expect.poll(() => cssVar(page, '--accent')).toBe('#7aa2f7');
  expect(await page.evaluate(() => [!!document.getElementById('se-accent'), localStorage.getItem('sec-edit-accent')])).toEqual([false, null]);
  await expect.poll(async () => (await saved(ws)).accentColor).toBe('');
});

test('a saved accent applies on a fresh profile too (no cache yet)', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ accentColor: '#22c55e', theme: 'light' });
  await ws.open(page);
  await expect.poll(() => cssVar(page, '--accent')).not.toBe('#3b6ee8');
  expect(await page.evaluate(() => localStorage.getItem('sec-edit-accent'))).toContain('/*#22c55e*/');
  // A garbage value in a hand-edited settings file is ignored.
  await page.evaluate(() => (window as any).__secEdit.backend.saveSettings({ accentColor: 'javascript:alert(1)' }));
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  expect(await cssVar(page, '--accent')).toBe('#3b6ee8');
});

test('corner style: square flattens every radius token, live and before first paint', async ({ page, ws }) => {
  await openNote(page, ws);
  const radius = (sel: string) => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).borderTopLeftRadius, sel);
  expect(await radius('.se-content')).toBe('12px');
  expect(await radius('.se-jump')).toBe('8px');
  const dlg = await openSettings(page);
  await dlg.locator('[data-setting="cornerStyle"] [data-value="square"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-corners', 'square');
  for (const sel of ['.se-content', '.se-jump', '.se-nav', '.se-tree-row.active', '.se-settings', '.se-seg', '.se-switch', '.se-modes', '.se-ws-avatar']) {
    expect(parseFloat(await radius(sel)), sel).toBeLessThanOrEqual(2);
  }
  for (const token of ['--radius-sm', '--radius', '--radius-lg', '--radius-xl']) expect(parseFloat(await cssVar(page, token)), token).toBeLessThanOrEqual(2);
  await expect.poll(async () => (await saved(ws)).cornerStyle).toBe('square');
  await page.keyboard.press('Escape');
  const skel = await reloadProbingSkeleton(page, () => [document.documentElement.dataset.corners, getComputedStyle(document.querySelector('.sk-main')!).borderTopLeftRadius]);
  expect(skel).toEqual(['square', '2px']);
  expect(await radius('.se-content')).toBe('2px');
  // back to rounded
  const dlg2 = await openSettings(page);
  await dlg2.locator('[data-reset="cornerStyle"]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-corners', 'square');
  expect(await radius('.se-content')).toBe('12px');
});

for (const style of ['shelf', 'classic'] as const) {
  test(`density (${style}): tree rows, tabs and status bar follow it; the virtual tree stays aligned`, async ({ page, ws }) => {
    await ws.server.service.saveSettings({ sidebarStyle: style });
    await openNote(page, ws);
    const metrics = () =>
      page.evaluate(() => {
        const rows = [...document.querySelectorAll<HTMLElement>('.se-tree-row')].map((r) => r.getBoundingClientRect());
        return {
          row: rows[0].height,
          // virtualised rows are absolutely positioned by JS: their pitch must equal the CSS height
          pitch: rows[1].top - rows[0].top,
          tab: document.querySelector('.se-tabbar')!.getBoundingClientRect().height,
          status: document.querySelector('.se-status')!.getBoundingClientRect().height,
        };
      });
    const base = style === 'classic' ? 24 : 28;
    expect(await metrics()).toEqual({ row: base, pitch: base, tab: 38, status: 24 });
    const dlg = await openSettings(page);
    await dlg.locator('[data-setting="uiDensity"] [data-value="compact"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    expect(await metrics()).toEqual({ row: base - (style === 'classic' ? 2 : 4), pitch: base - (style === 'classic' ? 2 : 4), tab: 34, status: 22 });
    await dlg.locator('[data-setting="uiDensity"] [data-value="spacious"]').click();
    expect(await metrics()).toEqual({ row: base + 4, pitch: base + 4, tab: 42, status: 26 });
    await expect.poll(async () => (await saved(ws)).uiDensity).toBe('spacious');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // Refresh: the skeleton's card already has the spacious tab strip; the real card lands on it.
    const skel = await reloadProbingSkeleton(page, () => {
      const r = document.querySelector('.sk-main')!.getBoundingClientRect();
      return { density: document.documentElement.dataset.density, tab: getComputedStyle(document.documentElement).getPropertyValue('--sk-tab').trim(), card: [r.x, r.y, r.width] };
    });
    expect(skel.density).toBe('spacious');
    expect(skel.tab).toBe('42px');
    const card = await page.evaluate(() => {
      const r = document.querySelector('.se-content')!.getBoundingClientRect();
      return [r.x, r.y, r.width];
    });
    expect(card).toEqual(skel.card);
    expect(await metrics()).toEqual({ row: base + 4, pitch: base + 4, tab: 42, status: 26 });
  });
}

test('content width: tab-strip button cycles readable → wide → full, palette command, hidden for code files', async ({ page, ws }) => {
  await openNote(page, ws);
  const btn = page.getByTestId('content-width');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('data-width', 'readable');
  await expect(btn).toHaveAttribute('title', /Readable/);
  expect(await cssVar(page, '--content-width')).toBe('860px');
  // it sits in the view-mode group, left of the mode buttons
  const [bx, mx] = await page.evaluate(() => [document.querySelector('.se-width-btn')!.getBoundingClientRect().right, document.querySelector('.se-modes')!.getBoundingClientRect().left]);
  expect(mx - bx).toBeGreaterThan(0);
  expect(mx - bx).toBeLessThan(16);

  await btn.click();
  await expect(btn).toHaveAttribute('data-width', 'wide');
  await expect(btn).toHaveAttribute('title', /Wide/);
  expect(await cssVar(page, '--content-width')).toBe('1200px');
  await btn.click();
  await expect(btn).toHaveAttribute('data-width', 'full');
  await expect(btn).toHaveAttribute('title', /Full width/);
  expect(await cssVar(page, '--content-width')).toBe('none');
  await expect.poll(async () => (await saved(ws)).contentWidth).toBe('full');
  await btn.click();
  await expect(btn).toHaveAttribute('data-width', 'readable');

  // Palette: "View: Content width…" opens a picker with the current one checked.
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type('content width');
  await page.keyboard.press('Enter');
  const picker = page.getByTestId('picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('input')).toBeFocused();
  await expect(picker.locator('[role="option"]')).toHaveText([/Readable/, /Wide/, /Full width/]);
  await expect(picker.locator('[role="option"][aria-checked="true"]')).toHaveText(/Readable/);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(btn).toHaveAttribute('data-width', 'wide');
  await expect(page.locator('.cm-content')).toBeFocused();
  // Settings shows the same value.
  const dlg = await openSettings(page);
  await expect(dlg.locator('[data-setting="contentWidth"] [data-value="wide"]')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Persisted + restored.
  await expect.poll(async () => (await saved(ws)).contentWidth).toBe('wide');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  expect(await cssVar(page, '--content-width')).toBe('1200px');
  await expect(page.getByTestId('content-width')).toHaveAttribute('data-width', 'wide');

  // Code files have no text column to size.
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(page.locator('.se-tab.active')).toContainText('app.ts');
  await expect(page.getByTestId('content-width')).toHaveCount(0);
});

test('line height and editor font presets apply live and persist', async ({ page, ws }) => {
  await openNote(page, ws);
  expect(await cssVar(page, '--editor-line-height')).toBe('1.65');
  const dlg = await openSettings(page);
  await dlg.locator('#set-editorLineHeight').fill('1.9');
  await expect.poll(() => cssVar(page, '--editor-line-height')).toBe('1.9');
  await dlg.locator('[data-row="editorLineHeight"] [aria-label="Larger"]').click();
  await expect.poll(() => cssVar(page, '--editor-line-height')).toBe('1.95');
  await expect(dlg.locator('#set-editorLineHeight')).toHaveValue('1.95');
  await expect.poll(async () => (await saved(ws)).editorLineHeight).toBe(1.95);

  const font = dlg.locator('#set-editorFont');
  await expect(font.locator('option')).toHaveText(['System', 'Serif', 'Mono', 'Custom…']);
  await font.selectOption({ label: 'Serif' });
  await expect.poll(() => cssVar(page, '--font-editor')).toContain('serif');
  await font.selectOption({ label: 'Mono' });
  await expect.poll(() => cssVar(page, '--font-editor')).toContain('monospace');
  await expect.poll(async () => (await saved(ws)).editorFont).toBe('var(--font-mono)');
  // Custom: a text box appears and takes any font name.
  await font.selectOption({ label: 'Custom…' });
  const custom = dlg.locator('[data-setting-text="editorFont"]');
  await expect(custom).toBeFocused();
  await custom.fill('Georgia');
  await expect.poll(() => cssVar(page, '--font-editor')).toBe('Georgia');
  await expect.poll(async () => (await saved(ws)).editorFont).toBe('Georgia');
  // Reset → System, custom box gone.
  await dlg.locator('[data-reset="editorFont"]').click();
  await expect.poll(() => cssVar(page, '--font-editor')).not.toContain('Georgia');
  await expect(font).toHaveValue('0');

  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  expect(await cssVar(page, '--editor-line-height')).toBe('1.95');
});

test('editor settings list the Markdown line-number and formatting-toolbar toggles (old "Line numbers" is gone)', async ({ page, ws }) => {
  await ws.open(page);
  const dlg = await openSettings(page);
  await expect(dlg.locator('[data-row="markdownLineNumbers"]')).toContainText('Line numbers in Markdown source & split mode');
  await expect(dlg.locator('[data-row="formatToolbar"]')).toContainText('Formatting toolbar in live mode');
  await expect(dlg.locator('[data-row="lineNumbers"]')).toHaveCount(0);
  await expect(dlg.locator('[data-setting="markdownLineNumbers"]')).toHaveAttribute('aria-checked', 'true');
  await dlg.locator('[data-setting="formatToolbar"]').click();
  await expect.poll(async () => (await saved(ws)).formatToolbar).toBe(false);
});
