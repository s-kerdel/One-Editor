// Shared helpers for the QA journey specs (cross-module, user-level flows).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, type WsFixture } from './harness';

// Deletes go to a private "trash" instead of the real ~/.local/share/Trash.
process.env.SEC_EDIT_TRASH_DIR ??= fs.mkdtempSync(path.join(os.tmpdir(), 'sec-edit-qa-trash-'));

export const row = (page: Page, name: string) => page.locator('.se-tree-row', { hasText: name }).first();
export const tab = (page: Page, name: string) => page.locator('.se-tab', { hasText: name });
export const hit = (page: Page, p: string) => page.locator(`.se-sr-match[data-path="${p}"]`);
export const hitFiles = (page: Page) => page.locator('.se-sr-file');
export const exists = (root: string, rel: string) => fs.existsSync(path.join(root, rel));
export const rawBytes = (root: string, rel: string) => fs.readFileSync(path.join(root, rel));

export const content = (page: Page, p?: string) => page.evaluate((x) => (window as any).__secEdit.editor.getContent(x ?? undefined) as string, p ?? null);
export const active = (page: Page) => page.evaluate(() => (window as any).__secEdit.activePath.value as string | null);
export const tabs = (page: Page) => page.evaluate(() => (window as any).__secEdit.tabs.value.map((t: any) => t.path) as string[]);

export async function cursor(page: Page) {
  return page.evaluate(() => {
    const a = (window as any).__secEdit;
    const c = a.editor.getCursor();
    const v = a.editor.getView?.();
    const sel = v ? (v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to) as string) : '';
    const lineText = v ? (v.state.doc.lineAt(v.state.selection.main.head).text as string) : '';
    return { path: a.activePath.value as string | null, line: c.line as number, sel, lineText };
  });
}

/** Collects uncaught renderer exceptions; assert `toEqual([])` at the end of a journey. */
export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

export async function indexesReady(page: Page) {
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 20000 });
}

/** Boot and wait for the link index (it builds in idle time after first paint). */
export async function boot(page: Page, ws: WsFixture) {
  await ws.open(page);
  await indexesReady(page);
}

export async function reload(page: Page) {
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]', { timeout: 15000 });
}

/** Open a file by clicking through the file tree like a user (expands parent folders as needed). */
export async function openViaTree(page: Page, rel: string) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const child = parts.slice(0, i + 1).join('/');
    if (!(await page.locator(`.se-tree-row[data-path="${child}"]`).count())) await page.locator(`.se-tree-row[data-path="${dir}"]`).click();
  }
  await page.locator(`.se-tree-row[data-path="${rel}"]`).click();
  await expect.poll(() => active(page)).toBe(rel);
}

export async function openSearch(page: Page) {
  await page.keyboard.press('Control+Shift+f');
  const input = page.getByLabel('Search query');
  await expect(input).toBeFocused();
  return input;
}

/** Quick open (Ctrl+P) and type a query with the real keyboard. */
export async function quickOpen(page: Page, query: string) {
  await page.keyboard.press('Control+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await page.keyboard.type(query);
  return input;
}

export async function focusEditorEnd(page: Page) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
}
