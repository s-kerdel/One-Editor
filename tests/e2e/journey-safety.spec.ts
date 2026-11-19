// Journey 4 — "Conflict & safety": the app must never silently lose or mangle what is on disk.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { boot, content, exists, focusEditorEnd, openViaTree, rawBytes, reload, tab, tabs, trackErrors } from './journey.helpers';

const banner = (page: Page) => page.locator('.se-banner');

async function autosaveOff(page: Page, ws: { server: { service: { saveSettings(s: object): Promise<unknown> } } }) {
  await ws.server.service.saveSettings({ autosave: false });
  await reload(page);
}

for (const choice of ['Use disk version', 'Keep mine'] as const) {
  test(`external change while typing (autosave on) → conflict banner → "${choice}"`, async ({ page, ws }) => {
    const errors = trackErrors(page);
    await boot(page, ws);
    await openViaTree(page, 'README.md');
    await focusEditorEnd(page);
    await page.keyboard.type('my local edit');
    // Someone else writes the file before our autosave (800 ms) fires.
    await ws.write('README.md', '# Changed outside\n');
    await expect(banner(page)).toContainText('changed on disk');
    await expect(tab(page, 'README.md')).toHaveClass(/conflict/);
    // Nothing is overwritten while the user has not decided — also not by autosave.
    await page.keyboard.type(' and more');
    await page.waitForTimeout(1200); // > autosave delay: proves the absence of a write
    expect(await ws.read('README.md')).toBe('# Changed outside\n');
    expect(await content(page)).toContain('my local edit and more');

    await banner(page).locator('.se-btn', { hasText: choice }).click();
    await expect(banner(page)).toHaveCount(0);
    if (choice === 'Use disk version') {
      await expect.poll(() => content(page)).toBe('# Changed outside\n');
      expect(await ws.read('README.md')).toBe('# Changed outside\n');
    } else {
      await expect.poll(() => ws.read('README.md')).toContain('my local edit and more');
      expect(await ws.read('README.md')).toContain('# Welcome');
      expect(await content(page)).toBe(await ws.read('README.md'));
    }
    await expect(tab(page, 'README.md').locator('.se-tab-dirty')).toHaveCount(0);
    // After resolving, editing and autosave work normally again.
    await focusEditorEnd(page);
    await page.keyboard.type('\nafter the conflict');
    await expect.poll(() => ws.read('README.md'), { timeout: 8000 }).toContain('after the conflict');
    expect(errors).toEqual([]);
  });
}

test('closing a dirty tab: autosave saves; without autosave the user is asked (Cancel / Don’t save / Save)', async ({ page, ws }) => {
  await boot(page, ws);
  // Autosave on: Ctrl+W right after typing must not lose the text.
  await openViaTree(page, 'README.md');
  await focusEditorEnd(page);
  await page.keyboard.type('typed right before closing');
  await page.keyboard.press('Control+w');
  await expect(tab(page, 'README.md')).toHaveCount(0);
  await expect.poll(() => ws.read('README.md')).toContain('typed right before closing');

  await autosaveOff(page, ws);
  await openViaTree(page, 'notes/kubernetes.md');
  const original = await ws.read('notes/kubernetes.md');
  await focusEditorEnd(page);
  await page.keyboard.type('\nunsaved line');
  await expect(tab(page, 'kubernetes.md').locator('.se-tab-dirty')).toHaveCount(1);
  const dialog = page.locator('.se-dialog');

  await page.keyboard.press('Control+w');
  await expect(dialog).toContainText('Save changes to kubernetes.md?');
  await dialog.locator('.se-btn', { hasText: 'Cancel' }).click();
  await expect(tab(page, 'kubernetes.md')).toHaveCount(1);
  expect(await content(page)).toContain('unsaved line');

  await page.keyboard.press('Control+w');
  await dialog.locator('.se-btn', { hasText: 'Don’t save' }).click();
  await expect(tab(page, 'kubernetes.md')).toHaveCount(0);
  expect(await ws.read('notes/kubernetes.md')).toBe(original);

  // Reopen: the discarded text is really gone; this time save from the dialog.
  await openViaTree(page, 'notes/kubernetes.md');
  expect(await content(page)).toBe(original);
  await focusEditorEnd(page);
  await page.keyboard.type('\nkept line');
  await page.keyboard.press('Control+w');
  await dialog.locator('.se-btn', { hasText: /^Save$/ }).click();
  await expect(tab(page, 'kubernetes.md')).toHaveCount(0);
  await expect.poll(() => ws.read('notes/kubernetes.md')).toBe(original + '\nkept line');
});

test('open file deleted on disk: banner, Restore (save) brings it back, Close tab drops it', async ({ page, ws }) => {
  const errors = trackErrors(page);
  await boot(page, ws);
  await openViaTree(page, 'notes/kubernetes.md');
  const original = await ws.read('notes/kubernetes.md');
  await fsp.rm(path.join(ws.root, 'notes/kubernetes.md'));
  await expect(banner(page)).toContainText('was deleted on disk');
  expect(await content(page)).toBe(original); // the text is still in the editor
  await banner(page).locator('.se-btn', { hasText: 'Restore' }).click();
  await expect.poll(() => exists(ws.root, 'notes/kubernetes.md')).toBe(true);
  expect(await ws.read('notes/kubernetes.md')).toBe(original);
  await expect(banner(page)).toHaveCount(0);

  await fsp.rm(path.join(ws.root, 'notes/kubernetes.md'));
  await expect(banner(page)).toContainText('was deleted on disk');
  await banner(page).locator('.se-btn', { hasText: 'Close tab' }).click();
  await expect.poll(() => tabs(page)).toEqual([]);
  expect(exists(ws.root, 'notes/kubernetes.md')).toBe(false); // closing must not resurrect it
  await expect(page.locator('.se-tree-row[data-path="notes/kubernetes.md"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('CRLF stays CRLF and a BOM stays a (single) BOM after editing + autosave', async ({ page, ws }) => {
  await ws.write('notes/bom.md', '﻿# BOM note\r\n\r\ntext\r\n');
  await boot(page, ws);

  await openViaTree(page, 'notes/windows-crlf.md');
  await expect(page.getByTestId('eol')).toHaveText('CRLF');
  await focusEditorEnd(page);
  await page.keyboard.type('Third line');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Fourth line');
  await expect.poll(() => ws.read('notes/windows-crlf.md'), { timeout: 8000 }).toContain('Fourth line');
  const crlf = await ws.read('notes/windows-crlf.md');
  expect(crlf).toBe('Line one\r\nLine two with CRLF\r\nThird line\r\nFourth line');
  expect(crlf.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // no lone CR or LF anywhere

  await openViaTree(page, 'notes/bom.md');
  expect(await content(page)).toBe('# BOM note\n\ntext\n'); // BOM and CRs never leak into the editor
  await focusEditorEnd(page);
  await page.keyboard.type('more');
  await expect.poll(() => ws.read('notes/bom.md'), { timeout: 8000 }).toContain('more');
  const bytes = rawBytes(ws.root, 'notes/bom.md');
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(bytes.subarray(3).toString('utf8')).toBe('# BOM note\r\n\r\ntext\r\nmore');
});
