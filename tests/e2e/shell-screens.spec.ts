// Visual review helper: SEC_EDIT_SHOTS=<dir> npx playwright test tests/e2e/shell-screens  (skipped otherwise)
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect, RENDERER_DIR } from './harness';
import { startServer } from '../../src/server/server';

const SHOTS = process.env.SEC_EDIT_SHOTS;
test.skip(!SHOTS, 'set SEC_EDIT_SHOTS=<dir> to capture screenshots');

for (const theme of ['dark', 'light'] as const) {
  test(`screens ${theme}`, async ({ page, ws }) => {
    await fsp.mkdir(SHOTS!, { recursive: true });
    await ws.server.service.saveSettings({ theme });
    // Welcome without a folder: separate server with no root but the same recent list.
    const cfg = await fsp.mkdtemp(path.join(os.tmpdir(), 'sec-edit-shots-'));
    const bare = await startServer({ rendererDir: RENDERER_DIR, configDir: cfg });
    await bare.service.saveSettings({ theme });
    await bare.service.openWorkspace(ws.root);
    bare.service.workspace?.dispose();
    bare.service.workspace = null;
    await page.goto(bare.url);
    await page.waitForSelector('html[data-ready="true"]');
    await page.screenshot({ path: `${SHOTS}/welcome-${theme}.png` });
    await bare.close();

    await ws.open(page);
    await page.locator('.se-tree-row', { hasText: 'notes' }).first().click();
    await page.locator('.se-tree-row', { hasText: 'kubernetes' }).click();
    await expect(page.locator('.cm-content')).toBeVisible();
    await page.locator('.se-tree-row', { hasText: 'README' }).click();
    await page.locator('.se-tree-row', { hasText: 'code' }).first().click();
    await page.locator('.se-tree-row', { hasText: 'app.ts' }).click();
    await page.locator('.se-tab', { hasText: 'kubernetes' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/editor-${theme}.png` });
    await page.locator('.se-mode[data-mode="split"]').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/split-${theme}.png` });
    await page.locator('.se-tree-row', { hasText: 'README' }).click({ button: 'right' });
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${SHOTS}/menu-${theme}.png` });
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5);
    await page.keyboard.press('Control+,');
    await expect(page.getByTestId('settings')).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/settings-${theme}.png` });
    await page.keyboard.press('Escape');
    // Dirty doc changed on disk → conflict banner; plus the delete confirmation dialog.
    await ws.server.service.saveSettings({ autosave: false });
    await page.locator('.se-mode[data-mode="live"]').click();
    await page.locator('.cm-content').click();
    await page.keyboard.type('local edit ');
    await ws.write('notes/kubernetes.md', '# Kubernetes cheatsheet\n\nEdited elsewhere.\n');
    await expect(page.locator('.se-banner')).toBeVisible();
    await page.locator('.se-tree-row', { hasText: 'Daily notes' }).click({ button: 'right' });
    await page.locator('.se-menu-item', { hasText: 'Delete' }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${SHOTS}/dialog-${theme}.png` });
  });
}
