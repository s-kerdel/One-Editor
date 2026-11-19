// Helpers shared by the editor E2E specs (not a spec itself).
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect } from './harness';

/** Screenshots go to the editor agent's private temp dir (never /tmp). */
export const SHOTS = path.resolve('.tmp/editor/shots');
export const shot = (name: string) => path.join(SHOTS, name);

export async function openNote(page: Page, p: string, text?: string) {
  await page.waitForFunction(() => !!(window as any).__secEdit?.editor);
  await page.waitForFunction((f) => (window as any).__secEdit.files.value.includes(f), p);
  await page.evaluate((f) => (window as any).__secEdit.openFile(f), p);
  if (text) await expect(page.locator('.cm-content')).toContainText(text);
}

export const content = (page: Page) => page.evaluate(() => (window as any).__secEdit.editor.getContent() as string);

/** Cursor to `pos` ('end' = end of doc, or the end of the first line containing a needle) and focus. */
export async function cursorTo(page: Page, where: 'end' | { after: string } | { lineOf: string }) {
  await page.evaluate((w) => {
    const view = (window as any).__secEdit.editor.getView();
    const doc: string = view.state.doc.toString();
    let pos = doc.length;
    if (typeof w === 'object' && 'after' in w) pos = doc.indexOf(w.after) + w.after.length;
    if (typeof w === 'object' && 'lineOf' in w) pos = view.state.doc.lineAt(doc.indexOf(w.lineOf)).to;
    view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
    view.focus();
  }, where);
}

export async function setTheme(page: Page, theme: 'dark' | 'light') {
  await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
}
