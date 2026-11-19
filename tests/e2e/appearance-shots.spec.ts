// Visual review helper (not a test): APPEARANCE_SHOTS=<dir> writes screenshots of the appearance
// options, the language picker and the hidden-sidebar tab strip in dark + light, shelf + classic.
import fs from 'node:fs';
import { test, expect } from './harness';

const SHOTS = process.env.APPEARANCE_SHOTS || '';

for (const style of ['shelf', 'classic'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`screenshots ${style} ${theme}`, async ({ page, ws }) => {
      test.skip(!SHOTS, 'set APPEARANCE_SHOTS=<dir> to write screenshots');
      test.setTimeout(90_000);
      fs.mkdirSync(SHOTS, { recursive: true });
      const shot = (name: string, clip?: { x: number; y: number; width: number; height: number }) => page.screenshot({ path: `${SHOTS}/${style}-${theme}-${name}.png`, clip });
      const set = (patch: Record<string, unknown>) => page.evaluate((p) => (window as any).__secEdit.backend.saveSettings(p), patch);
      await ws.server.service.saveSettings({ sidebarStyle: style, theme });
      await ws.open(page);
      await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
      await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
      await expect(page.locator('.cm-content')).toContainText('Daily notes');
      await page.waitForTimeout(400);
      await shot('1-default');

      // language picker hanging off the status bar
      await page.getByTestId('language').click();
      await expect(page.getByTestId('picker')).toBeVisible();
      await page.waitForTimeout(200);
      await shot('2-language-picker');
      await page.keyboard.type('sc');
      await page.waitForTimeout(150);
      await shot('2b-language-filtered', { x: 860, y: 460, width: 500, height: 400 });
      await page.keyboard.press('Escape');

      // settings → appearance, with an accent picked
      await page.keyboard.press('Control+,');
      const dlg = page.getByTestId('settings');
      await dlg.locator('[data-setting="accentColor"] [data-value="#f97316"]').click();
      await page.waitForTimeout(250);
      await shot('3-settings-accent-orange');
      await dlg.locator('[data-setting="accentColor"] [data-value="#22c55e"]').click();
      await dlg.locator('[data-setting="cornerStyle"] [data-value="square"]').click();
      await dlg.locator('[data-setting="uiDensity"] [data-value="compact"]').click();
      await page.waitForTimeout(250);
      await shot('4-settings-green-square-compact');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      await shot('5-green-square-compact');

      await page.evaluate(() => (window as any).__secEdit.settings.value && null);
      await page.keyboard.press('Control+,');
      await dlg.locator('[data-setting="cornerStyle"] [data-value="rounded"]').click();
      await dlg.locator('[data-setting="uiDensity"] [data-value="spacious"]').click();
      await dlg.locator('[data-setting="accentColor"] [data-value="#8b5cf6"]').click();
      await page.keyboard.press('Escape');
      await page.getByTestId('content-width').click();
      await page.waitForTimeout(250);
      await shot('6-violet-spacious-wide');

      // sidebar hidden: the tab strip starts with the "show sidebar" cell (shelf)
      await page.keyboard.press('Control+,');
      await dlg.locator('[data-setting="uiDensity"] [data-value="comfortable"]').click();
      await dlg.locator('[data-setting="accentColor"] [data-value=""]').click();
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+Shift+B');
      await page.waitForTimeout(250);
      await shot('7-sidebar-hidden');
      await shot('7b-sidebar-hidden-zoom', { x: 0, y: 0, width: 420, height: 110 });
      if (style === 'shelf') {
        await page.locator('.se-shelf-reveal').hover();
        await page.waitForTimeout(150);
        await shot('7c-reveal-hover', { x: 0, y: 0, width: 420, height: 110 });
      }
      void set;
    });
  }
}
