// Trailing whitespace: pasted terminal / AI output is trimmed (.md and code), Ctrl+Shift+V pastes as
// copied, trim on save touches only edited lines ('changed'), and the settings switch it all off.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { openNote } from './editor-helpers';

const content = (page: Page) => page.evaluate(() => (window as any).__secEdit.editor.getContent() as string);
const PADDED = 'drwxr-xr-x  2 root root 4096 .          \n-rw-r--r--  1 root root  220 .bashrc      \n   \n';

async function setup(page: Page, ws: { root: string; open(p: Page): Promise<void> }, settings: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(ws.root, 'ops'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'ops/out.md'), 'Output:\n');
  fs.writeFileSync(path.join(ws.root, 'ops/run.ts'), 'const a = 1;\n');
  fs.writeFileSync(path.join(ws.root, 'ops/keep.md'), 'untouched  \nedit me\nalso untouched  \n');
  await ws.open(page);
  // The save hook lives in the lazy format chunk: wait until it is in (its real functions have names).
  await page.waitForFunction(() => (window as any).__secEditFormat?.formatDocument?.name !== '', null, { timeout: 15000 });
  if (Object.keys(settings).length)
    await page.evaluate((s) => {
      const app = (window as any).__secEdit;
      app.settings.value = { ...app.settings.value, ...s };
    }, settings);
}

async function pasteAtEnd(page: Page, file: string, text: string, raw = false) {
  await openNote(page, file);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press(raw ? 'Control+Shift+v' : 'Control+v');
}

test.describe('trailing whitespace', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('padded terminal output pastes clean in notes and code; Ctrl+Shift+V pastes exactly as copied', async ({ page, ws }) => {
    await setup(page, ws);
    await pasteAtEnd(page, 'ops/out.md', PADDED);
    await expect.poll(() => content(page)).toBe('Output:\ndrwxr-xr-x  2 root root 4096 .\n-rw-r--r--  1 root root  220 .bashrc\n');
    await page.keyboard.press('Control+z'); // one undo step
    await expect.poll(() => content(page)).toBe('Output:\n');
    await pasteAtEnd(page, 'ops/run.ts', 'let b = 2;    \nlet c = 3;\t\n');
    await expect.poll(() => content(page)).toBe('const a = 1;\nlet b = 2;\nlet c = 3;\n');
    await pasteAtEnd(page, 'ops/out.md', 'raw  \n', true);
    await expect.poll(() => content(page)).toBe('Output:\nraw  \n');
  });

  test("save with 'changed' trims only the edited line; untouched lines keep their spaces", async ({ page, ws }) => {
    await setup(page, ws);
    await openNote(page, 'ops/keep.md', 'edit me');
    await page.locator('.cm-line', { hasText: 'edit me' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' now \t');
    await page.keyboard.press('Control+s');
    await expect.poll(() => ws.read('ops/keep.md')).toBe('untouched  \nedit me now\nalso untouched  \n');
    expect(await content(page)).toBe('untouched  \nedit me now\nalso untouched  \n');
    // Three spaces before a line with text = a Markdown hard break: kept as exactly two.
    await page.keyboard.type('   ');
    await page.keyboard.press('Control+s');
    await expect.poll(() => ws.read('ops/keep.md')).toBe('untouched  \nedit me now  \nalso untouched  \n');
  });

  test('autosave keeps the space you just typed on the caret line', async ({ page, ws }) => {
    await setup(page, ws, { autosaveDelayMs: 150 });
    await openNote(page, 'ops/keep.md', 'edit me');
    await page.locator('.cm-line', { hasText: 'edit me' }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' word ');
    await expect.poll(() => ws.read('ops/keep.md')).toBe('untouched  \nedit me word \nalso untouched  \n');
    await page.keyboard.type('next');
    await expect.poll(() => ws.read('ops/keep.md')).toBe('untouched  \nedit me word next\nalso untouched  \n');
  });

  test('settings off → pasted and saved text stay exactly as they were; palette command trims on demand', async ({ page, ws }) => {
    await setup(page, ws, { 'editor.trimPaste.markdown': false, 'editor.trimOnSave.markdown': 'off' });
    await pasteAtEnd(page, 'ops/out.md', 'padded   \n');
    await expect.poll(() => content(page)).toBe('Output:\npadded   \n');
    await page.keyboard.press('Control+s');
    await expect.poll(() => ws.read('ops/out.md')).toBe('Output:\npadded   \n');
    await page.keyboard.press('Control+Shift+p');
    await page.keyboard.type('Trim trailing whitespace');
    await page.keyboard.press('Enter');
    await expect.poll(() => content(page)).toBe('Output:\npadded\n');
  });
});
