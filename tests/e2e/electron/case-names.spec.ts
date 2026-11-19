// Desktop app, case-sensitive folder (Linux; a \\wsl.localhost root on Windows behaves the same): two
// names that differ only in case are two files — deleting one (to the trash, or permanently when the
// trash is unavailable) must leave the other on disk, in the tree and in its tab.
import type { Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';

const row = (page: Page, rel: string) => page.locator(`.se-tree-row[data-path="${rel}"]`);
const tab = (page: Page, rel: string) => page.locator(`.se-tab[data-path="${rel}"]`);

async function newNote(page: Page, folder: string, name: string, body: string) {
  await row(page, folder).click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'New note' }).click();
  await expect(page.locator('.se-tree-input')).toBeFocused();
  await page.locator('.se-tree-input').fill(name);
  await page.keyboard.press('Enter');
  await expect(tab(page, `${folder}/${name}.md`)).toBeVisible();
  await expect(page.locator('.cm-content')).toBeFocused();
  await page.keyboard.type(body);
}

async function newFolder(page: Page, folder: string, name: string) {
  await row(page, folder).click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'New folder' }).click();
  await page.locator('.se-tree-input').fill(name);
  await page.keyboard.press('Enter');
  await expect(row(page, `${folder}/${name}`)).toBeVisible();
}

async function deleteRow(page: Page, rel: string) {
  await row(page, rel).click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Delete' }).click();
  await page.locator('.se-dialog .se-btn.danger').click();
}

test('Note.md + note.md and Docs/ + docs/: delete to trash, then permanently, keeps the twin', async ({ el }) => {
  fs.mkdirSync(path.join(el.ws, 'cases'));
  const ls = () => fs.readdirSync(path.join(el.ws, 'cases')).sort();
  const xdg = path.join(el.tmp, 'xdg-data');
  const a = await el.launch([el.ws], { env: { XDG_DATA_HOME: xdg } }); // no D-Bus under Xvfb: freedesktop trash
  let page = a.page;
  expect(await page.evaluate(() => (window as any).__secEdit.workspace.value.caseSensitive)).toBe(true);
  await newNote(page, 'cases', 'Note', 'upper zebracase');
  await newNote(page, 'cases', 'note', 'lower yakcase');
  await newFolder(page, 'cases', 'Docs');
  await newFolder(page, 'cases', 'docs');
  await expect.poll(() => fs.readFileSync(path.join(el.ws, 'cases', 'note.md'), 'utf8'), { timeout: 5000 }).toContain('lower yakcase');
  await expect.poll(() => fs.readFileSync(path.join(el.ws, 'cases', 'Note.md'), 'utf8'), { timeout: 5000 }).toContain('upper zebracase');
  expect(ls()).toEqual(['Docs', 'Note.md', 'docs', 'note.md']);

  await deleteRow(page, 'cases/note.md');
  await expect.poll(ls).toEqual(['Docs', 'Note.md', 'docs']);
  expect(fs.readFileSync(path.join(xdg, 'Trash', 'files', 'note.md'), 'utf8')).toContain('lower yakcase');
  await expect(row(page, 'cases/note.md')).toHaveCount(0);
  await expect(row(page, 'cases/Note.md')).toBeVisible();
  await expect(tab(page, 'cases/note.md')).toHaveCount(0);
  await expect(tab(page, 'cases/Note.md')).toBeVisible();
  await a.app.close();

  // Trash unavailable (its folder cannot be created) → the app offers a permanent delete.
  const blocker = path.join(el.tmp, 'not-a-dir');
  fs.writeFileSync(blocker, '');
  const b = await el.launch([el.ws], { env: { XDG_DATA_HOME: path.join(blocker, 'xdg') } });
  page = b.page;
  await expect(row(page, 'cases')).toBeVisible();
  // The restored session may already have the folder open.
  const open = await row(page, 'cases/docs').waitFor({ timeout: 1500 }).then(() => true, () => false);
  if (!open) await row(page, 'cases').click();
  await deleteRow(page, 'cases/docs');
  await expect(page.locator('.se-dialog', { hasText: 'Delete “docs” permanently?' })).toBeVisible();
  await page.locator('.se-dialog .se-btn.danger').click();
  await expect.poll(ls).toEqual(['Docs', 'Note.md']);
  await expect(row(page, 'cases/docs')).toHaveCount(0);
  await expect(row(page, 'cases/Docs')).toBeVisible();
  await expect(row(page, 'cases/Note.md')).toBeVisible();
});
