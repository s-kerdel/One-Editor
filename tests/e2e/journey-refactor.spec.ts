// Journey 3 — "Refactor": rename a note that others link to, through the file tree UI, and check that
// links, backlinks, quick open, tabs and search all follow.
import { test, expect } from './harness';
import { active, boot, content, exists, hit, openSearch, openViaTree, quickOpen, row, tab, trackErrors } from './journey.helpers';

const DEEP = 'deep/nested/folder/Deep note.md';

test('F2-rename a linked note: links rewritten, backlinks/quick open/tabs/search follow, undo restores', async ({ page, ws }) => {
  const errors = trackErrors(page);
  await ws.write('notes/refs.md', '# Refs\n\nSee [[kubernetes]] and [[kubernetes#Kubernetes cheatsheet|the sheet]].\n\n`[[kubernetes]]` in code stays.\n');
  await boot(page, ws);
  await openViaTree(page, DEEP); // an *open* linking note (rewritten through the editor)
  await openViaTree(page, 'notes/kubernetes.md');

  // Backlinks before: Deep note + refs (×2).
  await page.keyboard.press('Control+Alt+l');
  const linked = page.locator('.se-kn-backlinks [data-section="linked"]');
  await expect(linked.locator('.se-kn-file-name')).toHaveText(['Deep note', 'refs']);

  // Rename with the keyboard in the tree: F2, type, Enter.
  await page.locator('.se-nav-btn[data-panel="files"]').click();
  await row(page, 'kubernetes').click();
  await page.locator('.se-tree').focus();
  await page.keyboard.press('F2');
  const input = page.locator('.se-tree-input');
  await expect(input).toBeFocused();
  await input.fill('k8s-cheatsheet.md');
  await page.keyboard.press('Enter');

  // Disk: file moved, links in closed AND open notes rewritten, code spans untouched.
  await expect.poll(() => exists(ws.root, 'notes/k8s-cheatsheet.md')).toBe(true);
  expect(exists(ws.root, 'notes/kubernetes.md')).toBe(false);
  await expect.poll(() => ws.read('notes/refs.md')).toBe('# Refs\n\nSee [[k8s-cheatsheet]] and [[k8s-cheatsheet#Kubernetes cheatsheet|the sheet]].\n\n`[[kubernetes]]` in code stays.\n');
  await expect.poll(() => ws.read(DEEP), { timeout: 8000 }).toContain('Mentions [[k8s-cheatsheet]] and');

  // Tab + active file follow the rename; no ghost of the old name.
  await expect(tab(page, 'k8s-cheatsheet.md')).toBeVisible();
  await expect(tab(page, 'kubernetes.md')).toHaveCount(0);
  expect(await active(page)).toBe('notes/k8s-cheatsheet.md');
  await expect(page.locator('.cm-content')).toContainText('Kubernetes cheatsheet');

  // Backlinks panel of the renamed note still lists both linking notes.
  await page.keyboard.press('Control+Alt+l');
  await expect(linked.locator('.se-kn-file-name')).toHaveText(['Deep note', 'refs']);
  await expect(linked.locator('.se-kn-ctx mark').first()).toContainText('k8s-cheatsheet');

  // Quick open: new name is found, the old file name is gone.
  await quickOpen(page, 'k8s');
  await expect(page.locator('.se-pal-item').first()).toContainText('k8s-cheatsheet.md');
  // "kubernetes" now only matches by content/heading — under the new path.
  await page.getByRole('dialog').locator('input').fill('kubernetes');
  await expect(page.locator('.se-pal-content', { hasText: 'notes/k8s-cheatsheet.md' }).first()).toBeVisible();
  await expect(page.locator('.se-pal-item', { hasText: 'kubernetes.md' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Search lists the content under the new path only.
  const search = await openSearch(page);
  await search.fill('kubectl logs -f deployment/api');
  await expect(hit(page, 'notes/k8s-cheatsheet.md')).toHaveCount(1);
  await expect(hit(page, 'notes/kubernetes.md')).toHaveCount(0);

  // Undo inside the open linking note brings the old link text back.
  await tab(page, 'Deep note.md').click();
  await expect.poll(() => content(page)).toContain('[[k8s-cheatsheet]]');
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+z');
  await expect.poll(() => content(page)).toContain('Mentions [[kubernetes]] and');
  expect(errors).toEqual([]);
});

test('context-menu rename updates links in closed notes (CRLF kept) and keeps the note reachable by its link', async ({ page, ws }) => {
  await ws.write('notes/crlf-links.md', '# Links\r\n\r\nSee [[daily notes]] and [d](Daily%20notes.md).\r\n');
  await boot(page, ws);
  await openViaTree(page, 'README.md');
  await row(page, 'notes').click();
  await row(page, 'Daily notes').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Rename' }).click();
  const input = page.locator('.se-tree-input');
  await expect(input).toBeFocused();
  await input.fill('Journal.md');
  await page.keyboard.press('Enter');
  await expect.poll(() => exists(ws.root, 'notes/Journal.md')).toBe(true);
  await expect.poll(() => ws.read('README.md'), { timeout: 8000 }).toContain('- [[Journal]] link');
  // Case-insensitive link in a Windows (CRLF) note: rewritten, line endings untouched.
  await expect.poll(() => ws.read('notes/crlf-links.md')).toBe('# Links\r\n\r\nSee [[Journal]] and [d](Journal.md).\r\n');
  // Following the rewritten link (Ctrl+click) opens the renamed note.
  const link = page.locator('.se-wikilink', { hasText: 'Journal' }).first();
  await expect(link).toBeVisible();
  await link.click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => active(page)).toBe('notes/Journal.md');
  await expect(page.locator('.cm-content')).toContainText('Write the release notes');
});
