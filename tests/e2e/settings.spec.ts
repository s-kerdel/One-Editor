// Settings overlay E2E (browser mode): search, change + persist, reset to default, shortcut table, focus.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const SHOTS = path.resolve(process.cwd(), '.tmp/settings/shots');

async function openWithEditor(page: Page, ws: WsFixture) {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('code/UserController.php'));
  await page.locator('.cm-content').click();
  await expect(page.locator('.cm-content')).toBeFocused();
}

async function openSettings(page: Page) {
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  return dlg;
}

const saved = (ws: WsFixture) => ws.server.service.getSettings() as Promise<Record<string, unknown>>;

test('search "php" → PHP version control → change persists across reload; reset restores the default', async ({ page, ws }) => {
  await openWithEditor(page, ws);
  let dlg = await openSettings(page);
  const search = dlg.getByTestId('settings-search');
  await expect(search).toBeFocused();
  await page.keyboard.type('php');

  const row = dlg.locator('[data-row="format.phpVersion"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('PHP version');
  // Unrelated settings are filtered away; sections without a hit are disabled in the nav.
  await expect(dlg.locator('[data-row="theme"]')).toHaveCount(0);
  await expect(dlg.locator('[data-nav="appearance"]')).toBeDisabled();
  await expect(dlg.locator('[data-nav="formatting"]')).toBeEnabled();

  const select = row.locator('select');
  await expect(select.locator('option:checked')).toHaveText('Default (8.3)');
  await expect(row.locator('[data-reset]')).toHaveCount(0);
  await select.selectOption({ label: 'PHP 7.4' });
  await expect.poll(async () => (await saved(ws))['format.phpVersion']).toBe('7.4');
  await expect(row).toHaveClass(/changed/);

  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  expect(await page.evaluate(() => (window as any).__secEdit.settings.value['format.phpVersion'])).toBe('7.4');
  dlg = await openSettings(page);
  await page.keyboard.type('phpv'); // fuzzy
  const row2 = dlg.locator('[data-row="format.phpVersion"]');
  await expect(row2.locator('select option:checked')).toHaveText('PHP 7.4');
  await expect(dlg.getByTestId('settings-changed-count')).toContainText('1 changed');

  await row2.locator('[data-reset="format.phpVersion"]').click();
  await expect(row2.locator('select option:checked')).toHaveText('Default (8.3)');
  await expect(row2.locator('[data-reset]')).toHaveCount(0);
  await expect.poll(async () => (await saved(ws))['format.phpVersion']).toBeNull();
  await expect(dlg.getByTestId('settings-changed-count')).toHaveCount(0);
});

test('every control type saves: toggle, text, number, select, list — and reset puts each back', async ({ page, ws }) => {
  await openWithEditor(page, ws);
  const dlg = await openSettings(page);

  await dlg.locator('[data-setting="preview.lineBreaks"]').click();
  await dlg.locator('[data-setting="daily.folder"]').fill('journal');
  await dlg.locator('[data-setting="format.printWidth"]').fill('120');
  await dlg.locator('[data-setting="attachments.location"]').selectOption({ label: 'Subfolder next to the note' });
  await dlg.locator('[data-setting="format.singleQuote"]').selectOption({ label: 'Double "…"' });
  const excl = dlg.locator('[data-setting="excludeGlobs"]');
  await excl.fill('node_modules, tmp');
  await excl.blur();
  await expect
    .poll(() => saved(ws))
    .toMatchObject({ 'preview.lineBreaks': true, 'daily.folder': 'journal', 'format.printWidth': 120, 'attachments.location': 'subfolder', 'format.singleQuote': false, excludeGlobs: ['node_modules', 'tmp'] });

  // An out-of-range number is not applied and snaps back on blur.
  const width = dlg.locator('[data-setting="format.printWidth"]');
  await width.fill('5');
  await width.blur();
  await expect(width).toHaveValue('120');

  for (const key of ['preview.lineBreaks', 'daily.folder', 'format.printWidth', 'attachments.location', 'format.singleQuote', 'excludeGlobs']) {
    await dlg.locator(`[data-reset="${key}"]`).click();
    await expect(dlg.locator(`[data-reset="${key}"]`)).toHaveCount(0);
  }
  await expect(dlg.locator('[data-setting="daily.folder"]')).toHaveValue('daily');
  await expect(width).toHaveValue('');
  await expect(excl).toHaveValue(/node_modules, \.git, dist/);
  await expect.poll(() => saved(ws)).toMatchObject({ 'preview.lineBreaks': false, 'daily.folder': 'daily', 'format.printWidth': null, 'attachments.location': 'root', 'format.singleQuote': null });
  expect((await saved(ws)).excludeGlobs).toContain('vendor');
});

test('a changed setting really takes effect (daily notes folder)', async ({ page, ws }) => {
  await openWithEditor(page, ws);
  const dlg = await openSettings(page);
  await dlg.locator('[data-setting="daily.folder"]').fill('journal');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.press('Control+Shift+p');
  // The palette chunk is lazy: wait for its input before typing, and for the hit before Enter.
  const pal = page.getByRole('dialog', { name: 'Command palette' });
  await expect(pal.locator('input')).toBeFocused();
  await page.keyboard.type("today's daily");
  await expect(pal.getByText("Open today's daily note")).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value as string)).toMatch(/^journal\/\d{4}-\d{2}-\d{2}\.md$/);
});

test('shortcut table lists "Format document"; search filters it; section nav jumps', async ({ page, ws }) => {
  await openWithEditor(page, ws);
  const dlg = await openSettings(page);
  const table = dlg.getByTestId('shortcuts');
  const fmt = table.locator('tr[data-command="format.document"]');
  await expect(fmt).toContainText('Format document');
  await expect(fmt.locator('kbd')).toHaveText(['Alt+Shift+F']); // duplicate spellings of one chord collapse
  await expect(table.locator('tr', { hasText: 'Move line down' }).locator('kbd')).toHaveText(['Alt+↓']);

  await dlg.locator('[data-nav="shortcuts"]').click();
  await expect(dlg.locator('[data-nav="shortcuts"]')).toHaveClass(/active/);
  await expect(dlg.locator('[data-section="shortcuts"] h3')).toBeInViewport();

  await dlg.getByTestId('settings-search').fill('format document');
  await expect(fmt).toBeVisible();
  await expect(table.locator('tr[data-command]')).toHaveCount(1);

  await dlg.getByTestId('settings-search').fill('zzzqqq');
  await expect(dlg.getByTestId('settings-empty')).toBeVisible();
});

test('window frame is desktop-only: found by "title bar", disabled here, no restart notice, no frame styling', async ({ page, ws }) => {
  await ws.open(page);
  const dlg = await openSettings(page);
  await page.keyboard.type('title bar');
  const row = dlg.locator('[data-row="windowFrame"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Desktop app only.');
  await expect(row.locator('[data-value="native"]')).toBeDisabled();
  await expect(dlg.getByTestId('restart-notice')).toHaveCount(0);
  // Browser mode never gets the integrated frame's drag regions / reserved strip space.
  await expect(page.locator('.se-root')).not.toHaveClass(/frame-integrated/);
  expect(await page.locator('html').getAttribute('data-frame')).toBeNull();
  expect(await page.locator('.se-tabbar').evaluate((e) => getComputedStyle(e).paddingRight)).toBe('0px');
});

test('Escape closes and the focus returns to the editor', async ({ page, ws }) => {
  await openWithEditor(page, ws);
  const dlg = await openSettings(page);
  await page.keyboard.type('font');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.locator('.cm-content')).toBeFocused();
  // …and typing lands in the document, not in a stale input.
  await page.keyboard.type('X');
  await expect(page.locator('.cm-content')).toContainText('X');
});

test('screenshots (dark + light) for visual review', async ({ page, ws }) => {
  test.skip(!process.env.SETTINGS_SHOTS, 'set SETTINGS_SHOTS=1 to write screenshots');
  fs.mkdirSync(SHOTS, { recursive: true });
  await ws.server.service.saveSettings({ 'format.phpVersion': '8.1', 'daily.folder': 'journal', lineNumbers: true });
  await openWithEditor(page, ws);
  for (const theme of ['dark', 'light'] as const) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    const dlg = await openSettings(page);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${theme}-1-top.png` });
    for (const sec of ['formatting', 'links', 'shortcuts']) {
      await dlg.locator(`[data-nav="${sec}"]`).click();
      await page.waitForTimeout(120);
      await page.screenshot({ path: `${SHOTS}/${theme}-2-${sec}.png` });
    }
    await dlg.getByTestId('settings-search').fill('php');
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${SHOTS}/${theme}-3-search.png` });
    await dlg.getByTestId('settings-search').fill('zzzqqq');
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${SHOTS}/${theme}-4-empty.png` });
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
  }
});

test('the Settings nav shows the version and build details; Copy puts them on the clipboard', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWithEditor(page, ws);
  const dlg = await openSettings(page);
  const version = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8')).version as string;
  const build = dlg.getByTestId('settings-build');
  await expect(build).toBeVisible();
  await expect(build).toContainText(`One ${version}`);
  await build.getByRole('button', { name: 'Copy build info' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain(`One ${version} (browser)`);
  expect(text).toMatch(/commit \S+/);
  expect(text).toMatch(/Chromium \d+/);
  // Browser mode adds no CPU arch, so the second part of the platform line is the server's OS version.
  expect(text).toMatch(/platform \S+ · \S+/);
});
