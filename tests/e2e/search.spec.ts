import type { Page } from '@playwright/test';
import { test, expect } from './harness';

// The app's "Mod" key is ⌘ on a Mac (Chromium reports MacIntel there) and Ctrl elsewhere.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const SHOTS = process.env.SEC_EDIT_SHOTS_DIR || '/tmp/sec-edit-search';

async function openSearchPanel(page: Page, replace = false) {
  await page.keyboard.press(replace ? `${MOD}+Shift+h` : `${MOD}+Shift+f`);
  const input = page.getByLabel('Search query');
  await expect(input).toBeFocused();
  return input;
}

const resultRow = (page: Page, path: string) => page.locator(`.se-sr-match[data-path="${path}"]`);

async function editorState(page: Page) {
  return page.evaluate(() => {
    const app = (window as any).__secEdit;
    const c = app.editor.getCursor();
    const view = app.editor.getView?.();
    const sel = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : null;
    return { path: app.activePath.value as string | null, line: c.line as number, selectionLength: c.selectionLength as number, sel: sel as string | null };
  });
}

test('Ctrl+Shift+F: --force-with-lease hits README.md as bash code; click selects the match', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  const input = await openSearchPanel(page);
  await input.fill('--force-with-lease');
  const row = resultRow(page, 'README.md');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.se-badge-code')).toHaveText('bash');
  await expect(row.locator('mark.se-hit')).toHaveText('--force-with-lease');
  await expect(page.locator('.se-search-summary')).toContainText('1 result in 1 file');
  // the index lives in a real Web Worker (not the in-thread fallback)
  expect(await page.evaluate(() => (window as any).__secEditSearch.mode.value)).toBe('worker');
  await row.click();
  await expect.poll(async () => (await editorState(page)).path).toBe('README.md');
  await expect.poll(() => editorState(page)).toMatchObject({ line: 10, selectionLength: 18 });
  const st = await editorState(page);
  if (st.sel !== null) expect(st.sel).toBe('--force-with-lease');
  // the editor highlights every occurrence of the query (optional EditorController capability)
  if (await page.evaluate(() => typeof (window as any).__secEdit.editor.highlightSearch === 'function')) {
    await expect(page.locator('.cm-content .se-search-hit').first()).toHaveText('--force-with-lease');
  }
  expect(errors).toEqual([]);
});

test('a file found only by its name (no hit lines) has no fold arrow and opens on click or Enter', async ({ page, ws }) => {
  await ws.write('settings-sample.yaml', 'name: demo\nport: 3\n'); // matches "yaml" by its extension only: no line contains it
  await ws.open(page);
  const input = await openSearchPanel(page);
  await input.fill('yaml');
  const row = page.locator('.se-sr-file[data-path="settings-sample.yaml"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.se-sr-caret svg')).toHaveCount(0);
  await expect(row).not.toHaveAttribute('aria-expanded', /.*/);
  await row.click();
  await expect.poll(async () => (await editorState(page)).path).toBe('settings-sample.yaml');
  // keyboard: Enter on the selected file row opens it too
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await expect.poll(async () => (await editorState(page)).path).toBe('README.md');
  await row.click();
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await expect.poll(async () => (await editorState(page)).path).toBe('README.md');
  await page.locator('.se-search-results').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await editorState(page)).path).toBe('settings-sample.yaml');
});

test('Ctrl+Shift+F pre-fills the editor selection', async ({ page, ws }) => {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md', { line: 11, col: 4, length: 7 }));
  await expect.poll(() => editorState(page)).toMatchObject({ path: 'README.md', selectionLength: 7 });
  await page.keyboard.press(`${MOD}+Shift+f`);
  await expect(page.getByLabel('Search query')).toHaveValue('artisan');
  await expect(resultRow(page, 'README.md')).toHaveCount(1);
});

test('lang:php findOrFail finds UserController.php', async ({ page, ws }) => {
  await ws.open(page);
  const input = await openSearchPanel(page);
  await input.fill('lang:php findOrFail');
  await expect(resultRow(page, 'code/UserController.php')).toHaveCount(1);
  await expect(page.locator('.se-sr-file')).toHaveCount(1);
  await expect(page.locator('.se-chip-filter')).toHaveText('lang:php');
});

test('unsaved typed text is immediately searchable', async ({ page, ws }) => {
  await ws.open(page);
  // Make sure nothing gets written: we want to prove the *unsaved* buffer is indexed.
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, autosave: false };
  });
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  await page.locator('.cm-content').click();
  await page.keyboard.press(`${MOD}+End`);
  await page.keyboard.type('\nzanzibar-quux --dry-run');
  const input = await openSearchPanel(page);
  await input.fill('zanzibar-quux --dry-run');
  await expect(resultRow(page, 'README.md')).toHaveCount(1);
  await expect(resultRow(page, 'README.md').locator('mark.se-hit')).toHaveText('zanzibar-quux --dry-run');
  expect(await ws.read('README.md')).not.toContain('zanzibar');
});

test('typo tolerance: kubctl finds kubernetes.md (flagged fuzzy)', async ({ page, ws }) => {
  await ws.open(page);
  const input = await openSearchPanel(page);
  await input.fill('kubctl');
  await expect(page.locator('.se-search-fuzzy')).toContainText('kubectl');
  await expect(page.locator('.se-sr-file[data-path="notes/kubernetes.md"]')).toBeVisible();
  await expect(page.locator('.se-sr-file[data-path="notes/kubernetes.md"] .se-badge-fuzzy')).toBeVisible();
});

test('keyboard: Enter opens first hit, F4 / Shift+F4 step through results', async ({ page, ws }) => {
  await ws.open(page);
  const input = await openSearchPanel(page);
  await input.fill('kubectl');
  await expect(resultRow(page, 'notes/kubernetes.md')).toHaveCount(3);
  await input.press('Enter');
  await expect.poll(() => editorState(page)).toMatchObject({ path: 'notes/kubernetes.md', line: 5, selectionLength: 7 });
  await page.keyboard.press('F4');
  await expect.poll(() => editorState(page)).toMatchObject({ line: 6 });
  await page.keyboard.press('F4');
  await expect.poll(() => editorState(page)).toMatchObject({ line: 9 });
  await page.keyboard.press('Shift+F4');
  await expect.poll(() => editorState(page)).toMatchObject({ line: 6 });
  // history: ↑ in an empty box recalls the last query
  await page.keyboard.press(`${MOD}+Shift+f`);
  await input.fill('');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('kubectl');
});

test('replace in files writes closed files to disk and updates open docs', async ({ page, ws }) => {
  await ws.open(page);
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  const input = await openSearchPanel(page, true);
  await input.fill('kubectl');
  await page.getByLabel('Replace with').fill('k');
  // preview shows del/ins
  await expect(resultRow(page, 'notes/kubernetes.md').first().locator('mark.se-ins')).toHaveText('k');
  await page.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect.poll(() => ws.read('notes/kubernetes.md')).toContain('k get pods --all-namespaces -o wide');
  expect(await ws.read('notes/kubernetes.md')).not.toContain('kubectl');
  await expect(page.locator('.se-undo-bar')).toContainText('Replaced 3 occurrences in 1 file');

  // regex with capture groups, in an open doc (goes through the editor)
  await page.getByLabel('Use regular expression').click();
  await input.fill('php artisan (\\w+):(\\w+)');
  await page.getByLabel('Replace with').fill('php artisan $2:$1');
  await expect(resultRow(page, 'README.md')).toHaveCount(1);
  await page.getByRole('button', { name: 'Replace all', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent('README.md'))).toContain('php artisan fresh:migrate --seed');
  // undo restores the regex replacement
  await page.locator('.se-undo-bar button').click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent('README.md'))).toContain('php artisan migrate:fresh --seed');
});

test('command palette: "sav" finds Save file, shows its keybinding; recent commands go first', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press(`${MOD}+Shift+p`);
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('>');
  await page.keyboard.type('sav');
  const first = page.locator('.se-pal-item').first();
  // "Save file" — the shell titles it "File: Save"; assert on the command id, not the wording
  await expect(first).toHaveAttribute('data-command-id', 'file.save');
  await expect(first).toContainText('Save');
  await expect(first.locator('kbd').last()).toHaveText(/^⌘?S$/); // one key per chip on Windows / Linux (Ctrl, S), one chip on a Mac (⌘S)
  await expect(first.locator('.se-pal-label mark.se-fz')).toHaveText('Sav');
  // word order doesn't matter
  await input.fill('>save file');
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', 'file.save');
  // run a command via the palette → it becomes "recently used"
  await input.fill('>toggle sidebar');
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', 'view.toggleSidebar');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-sidebar')).toHaveCount(0);
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', 'view.toggleSidebar');
  await expect(page.locator('.se-pal-item').first()).toContainText('recently used');
});

test('quick open: fuzzy files, #headings, file:line and "Found in content"', async ({ page, ws }) => {
  await ws.open(page);
  await page.keyboard.press(`${MOD}+p`);
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await page.keyboard.type('kube');
  await expect(page.locator('.se-pal-item').first()).toContainText('kubernetes.md');
  await expect(page.locator('.se-pal-item').first().locator('mark.se-fz')).toHaveText('kube');
  // content section when file names don't match
  await input.fill('artisan');
  await expect(page.locator('.se-pal-section', { hasText: 'Found in content' })).toBeVisible();
  await expect(page.locator('.se-pal-content').first()).toContainText('php artisan migrate:fresh');
  // workspace headings
  await input.fill('#cheat');
  await expect(page.locator('.se-pal-heading').first()).toContainText('Kubernetes cheatsheet');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await editorState(page)).path).toBe('notes/kubernetes.md');
  // file:line
  await page.keyboard.press(`${MOD}+p`);
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('readme:11');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorState(page)).toMatchObject({ path: 'README.md', line: 10 });
  // @ headings in current file
  await page.keyboard.press(`${MOD}+Shift+o`);
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await expect(page.getByRole('dialog').locator('input')).toHaveValue('@');
  await expect(page.locator('.se-pal-heading')).toHaveCount(2);
  await page.keyboard.type('comm');
  await page.keyboard.press('Enter');
  await expect.poll(() => editorState(page)).toMatchObject({ path: 'README.md', line: 7 });
});

test('openSearch API (tag search) + screenshots of panel and palette', async ({ page, ws }) => {
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openSearch('tag:idea'));
  await expect(resultRow(page, 'README.md')).toHaveCount(1);
  // rich multi-context results for the screenshot
  await page.evaluate(() => (window as any).__secEdit.openSearch('kubectl OR artisan OR render'));
  await expect(page.locator('.se-sr-file')).toHaveCount(3);
  await page.locator('.se-sidebar').evaluate((el) => ((el as HTMLElement).style.width = '340px'));
  await page.screenshot({ path: `${SHOTS}/panel.png` });
  await page.keyboard.press(`${MOD}+Shift+p`);
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('se');
  await page.waitForTimeout(300); // let the pop-in animation finish
  await page.screenshot({ path: `${SHOTS}/palette.png` });
  await page.keyboard.press('Escape');
  // replace preview
  await page.evaluate(() => (window as any).__secEdit.openSearch('kubectl', { replace: true }));
  await page.getByLabel('Replace with').fill('kubectl --context=prod');
  await expect(page.locator('mark.se-ins').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/replace.png` });
  await page.evaluate(() => (window as any).__secEdit.openSearch('', { replace: false }));
  await expect(page.locator('.se-search-hints')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/hints.png` });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.evaluate(() => (window as any).__secEdit.openSearch('kubectl OR artisan OR render'));
  await expect(page.locator('.se-sr-file')).toHaveCount(3);
  await page.screenshot({ path: `${SHOTS}/panel-light.png` });
  await page.keyboard.press(`${MOD}+p`);
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('artisan');
  await expect(page.locator('.se-pal-section', { hasText: 'Found in content' })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/quickopen-light.png` });
});
