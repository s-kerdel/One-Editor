// Calm file tree options: "Git colours in the file tree" (git keeps working, no extra git runs) and
// "Folder colours" (per top-level folder ↔ one colour, classic grey by default, a custom colour tuned
// per theme). Both independent of each other and of zen mode, and they combine.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';
import { gitReady, initRepo } from './git-helpers';

const MARKS = '.se-tree .se-git-letter, .se-tree .se-git-dot, .se-tree .se-tree-row[class*="se-git-"]';
const saved = async (ws: WsFixture) => (await ws.server.service.getSettings()) as Record<string, unknown>;
const folderColours = (page: Page) => page.$$eval('.se-tree-row.dir .se-ficon-folder', (els) => els.map((e) => getComputedStyle(e).color));

async function runFromPalette(page: Page, query: string) {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('.se-palette-input')).toBeFocused();
  await page.keyboard.type(query);
  await expect(page.locator('.se-palette-list [aria-selected="true"]')).toContainText(query, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

async function setting(page: Page, key: string, value?: string) {
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await dlg.locator(value === undefined ? `[data-setting="${key}"]` : `[data-setting="${key}"] [data-value="${value}"]`).click();
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
}

/** git runs the backend reported (activity log: every status / index refresh, with its trigger). */
const gitRuns = (page: Page) => page.evaluate(() => ((window as any).__secEditActivity.value as Array<{ kind: string; trigger: string }>).filter((e) => e.kind === 'git').map((e) => e.trigger));

async function repoWithChanges(page: Page, ws: WsFixture) {
  initRepo(ws.root);
  fs.appendFileSync(path.join(ws.root, 'notes/kubernetes.md'), '\nedited\n');
  fs.writeFileSync(path.join(ws.root, 'notes/brand new.md'), 'new\n');
  await ws.open(page);
  await gitReady(page);
  await page.locator('.se-tree-row[data-path="notes"]').click(); // expand
  await expect(page.locator('.se-tree-row[data-path="notes/kubernetes.md"] .se-git-letter')).toHaveText('M');
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: git colours off — no marks in the tree, git itself keeps working, no extra git run`, async ({ page, ws }) => {
    await repoWithChanges(page, ws);
    if (style === 'classic') await setting(page, 'sidebarStyle', 'classic');
    await expect(page.locator(MARKS).first()).toBeVisible();
    await page.waitForTimeout(1600); // past the monitor's debounce: whatever the launch started has run
    const runs = (await gitRuns(page)).length;
    expect(runs, 'the activity log sees git runs').toBeGreaterThan(0);

    await runFromPalette(page, 'toggle git colours in file tree');
    await expect(page.locator(MARKS)).toHaveCount(0);
    await page.waitForTimeout(1600);
    expect(await gitRuns(page), 'toggling the colours runs no git').toHaveLength(runs);
    await expect.poll(async () => (await saved(ws))['git.treeColors']).toBe(false);
    // Git is unaffected: branch item + dirty dot, Source control lists both changes.
    await expect(page.getByTestId('git-branch').locator('.se-git-branch-dirty')).toBeVisible();
    await page.keyboard.press('Control+Shift+g');
    await expect(page.getByTestId('scm').locator('[data-group="changes"] .se-scm-row')).toHaveCount(2);
    await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'files'));
    await expect(page.locator('.se-tree-row[data-path="notes/brand new.md"]')).toBeVisible();
    await expect(page.locator(MARKS)).toHaveCount(0);

    // Back on from Settings → Files.
    await setting(page, 'git.treeColors');
    await expect(page.locator('.se-tree-row[data-path="notes/kubernetes.md"] .se-git-letter')).toHaveText('M');
    await expect(page.locator('.se-tree-row[data-path="notes"]')).toHaveClass(/se-git-has-changes/);
  });
}

test('folder colours: per top-level folder by default; one colour = classic grey, a custom pick, reset; both themes; before first paint', async ({ page, ws }) => {
  await ws.open(page);
  // New users: every top-level folder its own hue (shelf).
  const hued = await folderColours(page);
  expect(hued.length).toBeGreaterThanOrEqual(3);
  expect(new Set(hued).size).toBe(hued.length);
  const greyDark = 'rgb(143, 150, 163)'; // --ft-folder, dark
  const greyLight = 'rgb(125, 133, 144)'; // --ft-folder, light

  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg.locator('#set-tree-folderColor [data-value=""]')).toBeDisabled(); // needs "One colour"
  await dlg.locator('[data-setting="tree.folderColors"] [data-value="one"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => greyDark));
  await dlg.locator('[data-setting="theme"] [data-value="light"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => greyLight));
  await dlg.locator('[data-setting="theme"] [data-value="dark"]').click();
  // A swatch: used as picked when it reads well on the theme …
  await dlg.locator('[data-setting="tree.folderColor"] [data-value="#ef4444"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => 'rgb(239, 68, 68)'));
  await expect.poll(async () => (await saved(ws))['tree.folderColor']).toBe('#ef4444');
  // … a custom colour too, darkened on the light theme until it stays visible.
  await dlg.getByTestId('set-tree-folderColor-custom').evaluate((el: HTMLInputElement) => {
    el.value = '#eab308';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => 'rgb(234, 179, 8)'));
  await dlg.locator('[data-setting="theme"] [data-value="light"]').click();
  const light = (await folderColours(page))[0];
  expect(light).not.toBe('rgb(234, 179, 8)');
  expect(new Set(await folderColours(page)).size).toBe(1);
  await dlg.locator('[data-setting="theme"] [data-value="dark"]').click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400); // settings save (debounced)

  // Refresh: mode + colour are on the page before the app bundle runs.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  const nav = page.reload();
  await page.waitForSelector('.sk-main', { state: 'attached' });
  const early = await page.evaluate(() => ({ mode: document.documentElement.dataset.folders, colour: getComputedStyle(document.documentElement).getPropertyValue('--folder-color').trim() }));
  release();
  await nav;
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' });
  expect(early).toEqual({ mode: 'one', colour: '#eab308' });
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => 'rgb(234, 179, 8)'));

  // Reset → classic grey; per folder again → the hues.
  await page.keyboard.press('Control+,');
  await dlg.locator('[data-reset="tree.folderColor"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => greyDark));
  await dlg.locator('[data-setting="tree.folderColors"] [data-value="hue"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued);
  // Classic's own look is unchanged by default: one grey.
  await dlg.locator('[data-setting="sidebarStyle"] [data-value="classic"]').click();
  await expect.poll(() => folderColours(page)).toEqual(hued.map(() => greyDark));
});

test('combined: zen + keep file tree + git colours off + one folder colour = a calm tree; each stays independent', async ({ page, ws }) => {
  await repoWithChanges(page, ws);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+,');
  const dlg = page.getByTestId('settings');
  await dlg.locator('[data-setting="zen.keepFileTree"]').click();
  await dlg.locator('[data-setting="tree.folderColors"] [data-value="one"]').click();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen .se-sidebar[data-panel="files"]')).toBeVisible();
  await expect(page.locator(MARKS).first()).toBeVisible();
  // Toggling the colours in zen applies at once.
  await runFromPalette(page, 'toggle git colours in file tree');
  await expect(page.locator(MARKS)).toHaveCount(0);
  expect(new Set(await folderColours(page)).size).toBe(1);
  // Leaving zen keeps the colour choice; zen again keeps it too.
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-tabbar')).toBeVisible();
  await expect(page.locator(MARKS)).toHaveCount(0);
  await page.keyboard.press('Control+Alt+z');
  await expect(page.locator('.se-root.se-zen .se-tree-row').first()).toBeVisible();
  await expect(page.locator(MARKS)).toHaveCount(0);
  await runFromPalette(page, 'toggle git colours in file tree');
  await expect(page.locator(MARKS).first()).toBeVisible();
  expect((await page.evaluate(() => (window as any).__secEdit.settings.value))['zen.keepFileTree']).toBe(true);
});
