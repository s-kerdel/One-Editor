// File type associations (setting `files.associations`): "open *.ctp files as PHP". From Settings and from the
// status bar's language picker; open files re-highlight without a reload, and mapped files are searched.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

// The app's "Mod" key is ⌘ on a Mac (Chromium reports MacIntel there) and Ctrl elsewhere.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const NEEDLE = 'zebraquokka';

const saved = async (ws: WsFixture) => ((await ws.server.service.getSettings()) as Record<string, unknown>)['files.associations'];
const editorLang = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.editor?.getLanguage?.(x) ?? null, p);
/** Spans the syntax highlighter styled in the visible document (a plain-text file has none). */
const tokens = (page: Page) => page.locator('.cm-content .cm-line span[class^="se-t-"]').count();

async function seed(ws: WsFixture) {
  fs.mkdirSync(path.join(ws.root, 'View'), { recursive: true });
  await ws.write('View/index.ctp', "<?php\nclass IndexView {\n    public function title() { return 'home'; }\n}\n?>\n<h1>Hello</h1>\n");
  await ws.write('View/other.ctp', `<?php\nfunction otherTemplateHelper() { return '${NEEDLE}'; }\n`);
}

async function openFile(page: Page, file: string) {
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), file);
  await expect(page.locator('.se-tab.active')).toContainText(file.split('/').pop()!);
  await expect(page.locator('.cm-content')).toBeVisible();
}

async function openSettings(page: Page) {
  await page.keyboard.press(`${MOD}+,`);
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  return dlg;
}

test('Settings: *.ctp → PHP re-highlights the open file live, survives a reload, and the files are searched', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await seed(ws);
  await ws.open(page);
  await openFile(page, 'View/index.ctp');
  const lang = page.getByTestId('language');
  await expect(lang).toHaveText('Plain text');
  expect(await tokens(page)).toBe(0);

  // Not text for the index yet: a file that is not open is not found.
  await page.keyboard.press(`${MOD}+Shift+f`);
  const query = page.getByLabel('Search query');
  await expect(query).toBeFocused();
  await query.fill(NEEDLE);
  await expect(page.locator('.se-search-summary')).toBeVisible();
  await expect(page.locator('.se-sr-match[data-path="View/other.ctp"]')).toHaveCount(0);

  const dlg = await openSettings(page);
  await dlg.getByTestId('settings-search').fill('file type');
  const row = dlg.locator('[data-row="files.associations"]');
  await expect(row).toBeVisible();
  const box = row.locator('#set-files-associations');
  // Validation as you type.
  await box.fill('src/*.ctp');
  await expect(row.locator('.se-assoc-note')).toContainText('Folders are not part of a pattern');
  await expect(row.getByTestId('assoc-add')).toBeDisabled();
  await box.fill('.CTP');
  await expect(row.locator('.se-assoc-note')).toHaveText('Files ending in .ctp.');
  await row.getByTestId('assoc-language').selectOption({ label: 'PHP' });
  await expect(row.locator('.se-assoc-note')).toHaveText('Files ending in .ctp open as PHP.');
  await row.getByTestId('assoc-add').click();
  await expect(row.locator('.se-assoc-item')).toHaveCount(1);
  await expect(row.locator('[data-pattern="*.ctp"] select')).toHaveValue('php');
  await expect(row).toHaveClass(/changed/);
  // Live, behind the dialog: no reload, no reopen.
  await expect(lang).toHaveText('PHP');
  await expect.poll(() => saved(ws)).toEqual({ '*.ctp': 'php' });
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(await editorLang(page, 'View/index.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
  await expect.poll(() => tokens(page)).toBeGreaterThan(3);

  // The index follows (the backend now reads *.ctp as text, each search shard knows it is PHP).
  await expect(async () => {
    await query.fill('');
    await query.fill(`lang:php ${NEEDLE}`);
    await expect(page.locator('.se-sr-match[data-path="View/other.ctp"]')).toHaveCount(1, { timeout: 1500 });
  }).toPass({ timeout: 20_000 });

  // A reload starts with it: the first document is PHP at once.
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  await expect(page.locator('.se-tab.active')).toContainText('index.ctp');
  await expect(lang).toHaveText('PHP');
  await expect.poll(() => tokens(page)).toBeGreaterThan(3);

  // Removing the row puts the file back, live.
  const dlg2 = await openSettings(page);
  await dlg2.locator('[data-pattern="*.ctp"] button').click();
  await expect(dlg2.locator('.se-assoc-item')).toHaveCount(0);
  await expect(lang).toHaveText('Plain text');
  await expect.poll(() => saved(ws)).toBeNull();
  await page.keyboard.press('Escape');
  await expect.poll(() => tokens(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('status bar: "Set language for all *.ctp files…" maps the extension; other files of the kind follow', async ({ page, ws }) => {
  await seed(ws);
  await ws.open(page);
  await openFile(page, 'View/other.ctp');
  await openFile(page, 'View/index.ctp');
  const lang = page.getByTestId('language');
  await expect(lang).toHaveText('Plain text');

  await lang.click();
  const picker = page.getByTestId('picker');
  await expect(picker).toBeVisible();
  // The file's own modes stay where they were; the association entry sits after them.
  const options = picker.locator('[role="option"]');
  await expect(options.nth(0)).toContainText('Auto-detect');
  await expect(options.nth(1)).toHaveText('Plain text');
  await expect(options.nth(2)).toHaveText('Set language for all *.ctp files…');
  await options.nth(2).click();
  await expect(picker).toBeVisible();
  await expect(picker.locator('[aria-checked="true"]')).toContainText('No association');
  await page.keyboard.type('php');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);

  await expect(lang).toHaveText('PHP');
  await expect.poll(() => saved(ws)).toEqual({ '*.ctp': 'php' });
  expect(await editorLang(page, 'View/index.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
  // The background tab too, and it is not a per-file override.
  expect(await editorLang(page, 'View/other.ctp')).toEqual({ id: 'php', name: 'PHP', auto: true });
  expect(((await ws.server.service.getSession()) as any)?.languageOverrides ?? {}).toEqual({});
  await page.locator('.se-tab', { hasText: 'other.ctp' }).click();
  await expect(lang).toHaveText('PHP');
  await expect.poll(() => tokens(page)).toBeGreaterThan(3);

  // Shown in the picker and in Settings; "No association" undoes it.
  await lang.click();
  await expect(picker.locator('[role="option"]').nth(0)).toContainText('by file type association');
  await picker.locator('[role="option"]').nth(2).click();
  await expect(picker.locator('[aria-checked="true"]')).toHaveText('PHP');
  await picker.locator('[role="option"]', { hasText: 'No association' }).click();
  await expect(lang).toHaveText('Plain text');
  await expect.poll(() => saved(ws)).toBeNull();

  // Markdown notes have no such entry: they always open as notes.
  await openFile(page, 'README.md');
  await lang.click();
  await expect(picker.locator('[role="option"]', { hasText: 'Set language for all' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});
