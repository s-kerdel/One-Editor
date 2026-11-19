// Journey 5 — "Keyboard-only power user": the mouse is never touched in this file.
// Journey 7 — "Reload persistence": tabs, active tab, view mode, sidebar width and theme survive a reload.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { active, boot, content, cursor, openViaTree, reload, tab, tabs, trackErrors } from './journey.helpers';

const palInput = (page: Page) => page.getByRole('dialog').locator('input');
const editorFocused = (page: Page) => expect(page.locator('.cm-content')).toBeFocused();
const setting = (page: Page, key: string) => page.evaluate((k) => (window as any).__secEdit.settings.value[k], key);

test('keyboard only: quick open, palette, search, tab switching, view toggle, settings', async ({ page, ws }) => {
  const errors = trackErrors(page);
  const kb = page.keyboard;
  await boot(page, ws);

  // Ctrl+P → file by fuzzy name; focus lands in the editor so typing works immediately.
  await kb.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await kb.type('kube');
  await expect(page.locator('.se-pal-item').first()).toContainText('kubernetes.md');
  await kb.press('Enter');
  await expect.poll(() => active(page)).toBe('notes/kubernetes.md');
  await editorFocused(page);

  // Ctrl+P → file#heading
  await kb.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await kb.type('readme#comm');
  await expect(page.locator('.se-pal-item').first()).toContainText('Commands');
  await kb.press('Enter');
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'README.md', line: 7 });
  await editorFocused(page);

  // Ctrl+P → file:line
  await kb.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await kb.type('daily:8');
  await kb.press('Enter');
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'notes/Daily notes.md', line: 7, lineText: '- [ ] Write the release notes' });
  await editorFocused(page);

  // Escape closes the overlay and gives the focus back to the editor.
  await kb.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await kb.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await editorFocused(page);

  // Ctrl+Shift+P → run "Toggle word wrap".
  const wrapBefore = await setting(page, 'wordWrap');
  await kb.press('Control+Shift+p');
  await expect(palInput(page)).toBeFocused();
  await kb.type('Toggle word wrap');
  await expect(page.locator('.se-pal-item').first()).toContainText(/word wrap/i);
  await kb.press('Enter');
  await expect.poll(() => setting(page, 'wordWrap')).toBe(!wrapBefore);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await editorFocused(page);

  // Ctrl+Shift+F → Enter opens the first hit, F4 walks on; the editor has the focus after jumping.
  await kb.press('Control+Shift+f');
  await expect(page.getByLabel('Search query')).toBeFocused();
  await kb.type('kubectl');
  await expect(page.locator('.se-sr-match[data-path="notes/kubernetes.md"]')).toHaveCount(3);
  await kb.press('Enter');
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'notes/kubernetes.md', line: 5, sel: 'kubectl' });
  await kb.press('F4');
  await expect.poll(() => cursor(page)).toMatchObject({ path: 'notes/kubernetes.md', line: 6, sel: 'kubectl' });
  await kb.press('F4');
  await expect.poll(() => cursor(page)).toMatchObject({ line: 9 });
  await editorFocused(page);

  // Ctrl+Tab → most recently used tab (Daily notes), again → back.
  expect(await tabs(page)).toEqual(['notes/kubernetes.md', 'README.md', 'notes/Daily notes.md']);
  await kb.press('Control+Tab');
  await expect.poll(() => active(page)).toBe('notes/Daily notes.md');
  await kb.press('Control+Tab');
  await expect.poll(() => active(page)).toBe('notes/kubernetes.md');
  await editorFocused(page);

  // Ctrl+E → reading view and back; typing goes into the note afterwards.
  await kb.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-preview')).toBeVisible();
  await expect(page.locator('.se-preview h1')).toHaveText('Kubernetes cheatsheet');
  await kb.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-live')).toBeVisible();
  // BUG (shell, see the fixme test below): focus is not returned to the editor here. A keyboard user
  // can recover with Ctrl+P → Escape, so the journey does the same.
  await kb.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await kb.press('Escape');
  await editorFocused(page);
  await kb.press('Control+End');
  await kb.type(' typed-without-mouse');
  await expect.poll(() => ws.read('notes/kubernetes.md'), { timeout: 8000 }).toContain('deployment/web`.\n typed-without-mouse');

  // Ctrl+, → Tab to the theme switch → Space; Escape closes; the theme survives a reload.
  await kb.press('Control+,');
  const dlg = page.getByTestId('settings');
  await expect(dlg).toBeVisible();
  const light = dlg.locator('.se-seg-btn[data-value="light"]');
  for (let i = 0; i < 40 && !(await light.evaluate((el) => el === document.activeElement)); i++) await kb.press('Tab');
  await expect(light).toBeFocused();
  await kb.press('Space');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await kb.press('Escape');
  await expect(dlg).toHaveCount(0); // (focus after closing: see the fixme test below)
  await expect.poll(async () => (await ws.server.service.getSettings()).theme).toBe('light');
  await reload(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await setting(page, 'wordWrap')).toBe(!wrapBefore);
  expect(errors).toEqual([]);
});

test('Ctrl+E to reading view and back returns the focus to the editor', async ({ page, ws }) => {
  await boot(page, ws);
  await page.keyboard.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await page.keyboard.type('kube');
  await page.keyboard.press('Enter');
  await editorFocused(page);
  await page.keyboard.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-preview')).toBeVisible();
  await page.keyboard.press('Control+e');
  await expect(page.locator('.se-editor-area.mode-live')).toBeVisible();
  await editorFocused(page);
});

test('closing Settings with Escape returns the focus to the editor', async ({ page, ws }) => {
  await boot(page, ws);
  await page.keyboard.press('Control+p');
  await expect(palInput(page)).toBeFocused();
  await page.keyboard.type('kube');
  await page.keyboard.press('Enter');
  await editorFocused(page);
  await page.keyboard.press('Control+,');
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toHaveCount(0);
  await editorFocused(page);
});

test('reload persistence: tabs, active tab, view mode, sidebar width and theme', async ({ page, ws }) => {
  await boot(page, ws);
  await openViaTree(page, 'README.md');
  await openViaTree(page, 'code/app.ts');
  await openViaTree(page, 'notes/kubernetes.md');
  await tab(page, 'README.md').click();
  await expect.poll(() => active(page)).toBe('README.md');

  await page.keyboard.press('Control+\\');
  await expect(page.locator('.se-editor-area.mode-split')).toBeVisible();

  const sb = (await page.locator('.se-sidebar').boundingBox())!;
  await page.mouse.move(sb.x + sb.width, sb.y + 300);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width + 90, sb.y + 300, { steps: 5 });
  await page.mouse.up();
  const wide = (await page.locator('.se-sidebar').boundingBox())!.width;
  expect(wide).toBeGreaterThan(sb.width + 60);

  await page.keyboard.press('Control+,');
  await page.getByTestId('settings').locator('.se-seg-btn[data-value="light"]').click();
  await page.keyboard.press('Escape');

  // Wait until everything has been persisted (session saves are debounced), then reload.
  await expect
    .poll(async () => {
      const s = await ws.server.service.getSession();
      const st = await ws.server.service.getSettings();
      return { tabs: s.openTabs, active: s.activeTab, width: Math.round(s.sidebarWidth ?? 0), theme: st.theme, mode: st.viewMode };
    })
    .toEqual({ tabs: ['README.md', 'code/app.ts', 'notes/kubernetes.md'], active: 'README.md', width: Math.round(wide), theme: 'light', mode: 'split' });
  await reload(page);

  await expect.poll(() => tabs(page)).toEqual(['README.md', 'code/app.ts', 'notes/kubernetes.md']);
  await expect.poll(() => active(page)).toBe('README.md');
  await expect(page.locator('.se-tab.active')).toContainText('README.md');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('.se-editor-area.mode-split')).toBeVisible();
  await expect(page.locator('.se-preview h1')).toHaveText('Welcome');
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  expect(Math.abs((await page.locator('.se-sidebar').boundingBox())!.width - wide)).toBeLessThan(2);
  // The restored session is usable right away: the other tabs still open their files.
  await tab(page, 'kubernetes.md').click();
  await expect.poll(() => content(page)).toContain('Kubernetes cheatsheet');
});
