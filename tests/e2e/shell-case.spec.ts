// Names that differ only in case (`Note.md` + `note.md`, `Docs/` + `docs/`) on a case-sensitive file
// system (Linux, and WSL roots opened from Windows): creating, opening, deleting and renaming one must
// never touch, hide or re-point the other — on disk, in the tree, tabs, search, quick open and links.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

// Deletes go to a private "trash" (inside the project's .tmp) instead of the real ~/.local/share/Trash.
process.env.SEC_EDIT_TRASH_DIR ??= fs.mkdtempSync(path.resolve('.tmp/e2e-trash-'));

const row = (page: Page, rel: string) => page.locator(`.se-tree-row[data-path="${rel}"]`);
const tab = (page: Page, rel: string) => page.locator(`.se-tab[data-path="${rel}"]`);
const onDisk = (root: string, dir: string) => fs.readdirSync(path.join(root, dir)).sort();
const state = (page: Page) =>
  page.evaluate(() => {
    const a = (window as any).__secEdit;
    return {
      caseSensitive: a.workspace.value?.caseSensitive as boolean | undefined,
      tabs: a.tabs.value.map((t: any) => t.path) as string[],
      files: (a.files.value as string[]).filter((f) => f.startsWith('cases/')).sort(),
      docs: [...a.docs.keys()].filter((f: string) => f.startsWith('cases/')).sort(),
    };
  });
const backlinks = (page: Page, rel: string) => page.evaluate((p) => ((window as any).__secEdit.knowledge.backlinks(p) as Array<{ from: string }>).map((b) => b.from), rel);

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => {
    throw e;
  });
});

/** Tree context menu → New note → type the name (the inline rename of untitled-N.md). */
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

async function quickOpen(page: Page, q: string) {
  await page.keyboard.press('Control+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await input.fill(q);
  return page.locator('.se-pal-item.se-pal-file');
}

test('Note.md + note.md, Docs/ + docs/: deleting one keeps the other everywhere', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'cases'));
  fs.writeFileSync(path.join(ws.root, 'linker.md'), '# Linker\n\nSee [[cases/Note]] here.\n\nAnd [[cases/note]] there.\n');
  await ws.open(page);
  await expect(row(page, 'cases')).toBeVisible();
  expect((await state(page)).caseSensitive, 'probed per folder, not guessed from the OS').toBe(true);

  await newNote(page, 'cases', 'Note', 'upper zebracase');
  await newNote(page, 'cases', 'note', 'lower yakcase');
  await newFolder(page, 'cases', 'Docs');
  await newFolder(page, 'cases', 'docs');
  await expect.poll(() => ws.read('cases/Note.md'), { timeout: 5000 }).toContain('upper zebracase');
  await expect.poll(() => ws.read('cases/note.md'), { timeout: 5000 }).toContain('lower yakcase');
  expect(onDisk(ws.root, 'cases')).toEqual(['Docs', 'Note.md', 'docs', 'note.md']);
  expect(await state(page)).toMatchObject({ tabs: ['cases/Note.md', 'cases/note.md'], files: ['cases/Note.md', 'cases/note.md'] });
  // Each spelling links to its own note, even though link lookup is case-insensitive.
  await expect.poll(() => backlinks(page, 'cases/Note.md'), { timeout: 10000 }).toEqual(['linker.md']);
  await expect.poll(() => backlinks(page, 'cases/note.md')).toEqual(['linker.md']);

  await deleteRow(page, 'cases/note.md');
  await expect.poll(() => onDisk(ws.root, 'cases')).toEqual(['Docs', 'Note.md', 'docs']);
  await expect(row(page, 'cases/note.md')).toHaveCount(0);
  await expect(row(page, 'cases/Note.md')).toBeVisible();
  await expect(tab(page, 'cases/note.md')).toHaveCount(0);
  await expect(tab(page, 'cases/Note.md')).toBeVisible();
  expect(await state(page)).toMatchObject({ tabs: ['cases/Note.md'], files: ['cases/Note.md'], docs: ['cases/Note.md'] });
  expect(await ws.read('cases/Note.md')).toContain('upper zebracase');

  await deleteRow(page, 'cases/docs');
  await expect.poll(() => onDisk(ws.root, 'cases')).toEqual(['Docs', 'Note.md']);
  await expect(row(page, 'cases/Docs')).toBeVisible();
  await expect(row(page, 'cases/docs')).toHaveCount(0);

  // Search, quick open, links and recent files still know the survivor (and only it).
  await page.keyboard.press('Control+Shift+f');
  await page.getByLabel('Search query').fill('zebracase');
  await expect(page.locator('.se-sr-match[data-path="cases/Note.md"]')).toHaveCount(1);
  await page.getByLabel('Search query').fill('yakcase');
  await expect(page.locator('.se-search-summary')).toContainText(/No results/i);
  const items = await quickOpen(page, 'cases/note');
  await expect(items.first()).toHaveAttribute('data-path', 'cases/Note.md');
  await expect(page.locator('.se-pal-item[data-path="cases/note.md"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect.poll(() => backlinks(page, 'cases/Note.md')).toEqual(['linker.md', 'linker.md']); // [[cases/note]] now finds the survivor
  const recent = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('se-search:recent:')).flatMap(([, v]) => JSON.parse(v as string) as string[]));
  expect(recent).toContain('cases/Note.md');
});

test('case-insensitive folder (NTFS; simulated in the renderer): "note" next to Note.md says why and creates nothing', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'cases'));
  fs.writeFileSync(path.join(ws.root, 'cases', 'Note.md'), 'upper\n');
  await ws.open(page);
  // What the backend's probe reports for an NTFS / APFS folder (this test server runs on ext4).
  await page.evaluate(() => {
    const a = (window as any).__secEdit;
    a.workspace.value = { ...a.workspace.value, caseSensitive: false };
  });
  await row(page, 'cases').click();
  await row(page, 'cases').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'New folder' }).click();
  await page.locator('.se-tree-input').fill('note.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-tree-error')).toContainText('“Note.md” already exists: names that differ only in case are the same file in this folder');
  await page.keyboard.press('Escape');
  expect(onDisk(ws.root, 'cases')).toEqual(['Note.md']);
  await expect(page.locator('.se-tree-row[data-path^="cases/"]')).toHaveCount(1); // no phantom second entry
});

test('case-only rename a.md → A.md, and a rename onto an existing other-case file is refused', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'cases'));
  fs.writeFileSync(path.join(ws.root, 'cases', 'a.md'), 'small a\n');
  fs.writeFileSync(path.join(ws.root, 'cases', 'b.md'), 'small b\n');
  fs.writeFileSync(path.join(ws.root, 'cases', 'B.md'), 'big B\n');
  await ws.open(page);
  await row(page, 'cases').click();
  await row(page, 'cases/a.md').click();
  await expect(tab(page, 'cases/a.md')).toBeVisible();

  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  await page.locator('.se-tree-input').fill('A.md');
  await page.keyboard.press('Enter');
  await expect(row(page, 'cases/A.md')).toBeVisible();
  await expect(row(page, 'cases/a.md')).toHaveCount(0);
  await expect(tab(page, 'cases/A.md')).toBeVisible();
  expect(onDisk(ws.root, 'cases')).toEqual(['A.md', 'B.md', 'b.md']);

  // b.md → B.md: B.md is another file here, so this is a clash, not a case-only rename.
  await row(page, 'cases/b.md').click();
  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  await page.locator('.se-tree-input').fill('B.md');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-tree-error')).toContainText('already exists');
  await page.keyboard.press('Escape');
  expect(fs.readFileSync(path.join(ws.root, 'cases', 'b.md'), 'utf8')).toBe('small b\n');
  expect(fs.readFileSync(path.join(ws.root, 'cases', 'B.md'), 'utf8')).toBe('big B\n');
  await expect(row(page, 'cases/b.md')).toBeVisible();
  await expect(row(page, 'cases/B.md')).toBeVisible();

  // An external case-only rename (git checkout, terminal) leaves exactly one row.
  fs.renameSync(path.join(ws.root, 'cases', 'A.md'), path.join(ws.root, 'cases', 'aa.md'));
  fs.renameSync(path.join(ws.root, 'cases', 'aa.md'), path.join(ws.root, 'cases', 'a.md'));
  await expect(row(page, 'cases/a.md')).toBeVisible();
  await expect(row(page, 'cases/A.md')).toHaveCount(0);
});
