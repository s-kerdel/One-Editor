import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { shot } from './editor-helpers';

// Opens a file through the app API (independent of the file-tree UI) and waits for the editor.
async function open(page: Page, path: string, text: string) {
  await page.waitForFunction(() => !!(window as any).__secEdit?.editor);
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), path);
  await expect(page.locator('.cm-content')).toContainText(text);
}

/** Put the cursor at the end of the first line containing `needle` (via the CM view). */
async function cursorAtEndOf(page: Page, needle: string) {
  await page.evaluate((n) => {
    const view = (window as any).__secEdit.editor.getView();
    const text: string = view.state.doc.toString();
    const idx = text.indexOf(n);
    const line = view.state.doc.lineAt(idx);
    view.dispatch({ selection: { anchor: line.to } });
    view.focus();
  }, needle);
}

const lineText = (page: Page, has: string) => page.locator('.cm-line', { hasText: has }).first();

test('live preview hides ** markers away from the cursor and reveals them on the cursor line', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'fixture workspace');
  await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    view.dispatch({ selection: { anchor: 0 } });
  });
  const bold = lineText(page, 'fixture workspace');
  await expect(bold).toHaveText('This is the fixture workspace used by the test-suite.');
  await expect(bold.locator('.se-t-strong')).toHaveText('fixture workspace');
  // Heading marker hidden too
  await expect(lineText(page, 'Commands')).toHaveText('Commands');
  await page.locator('.se-t-strong', { hasText: 'fixture workspace' }).click();
  await expect(bold).toHaveText('This is the **fixture workspace** used by the test-suite.');
});

test('clicking a task checkbox writes [x] to disk', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/Daily notes.md', 'Write the release notes');
  const box = lineText(page, 'Write the release notes').locator('.se-task');
  await expect(box).toHaveAttribute('aria-checked', 'false');
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => ws.read('notes/Daily notes.md'), { timeout: 8000 }).toContain('- [x] Write the release notes');
});

test('Enter continues a list, empty item Enter exits it', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'External');
  await cursorAtEndOf(page, '- [External](https://example.com)');
  await page.keyboard.press('Enter');
  await page.keyboard.type('third item');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('after');
  const content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('- [External](https://example.com)\n- third item\nafter');
});

test('Tab indents a list item and Mod-b toggles bold', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'External');
  await cursorAtEndOf(page, '- [External](https://example.com)');
  await page.keyboard.press('Tab');
  let content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('- [[Daily notes]] link\n  - [External](https://example.com)');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.type('word');
  await page.keyboard.press('Control+b');
  content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('\n- **word**');
});

test('PHP file gets syntax-highlighted tokens and line numbers', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'code/UserController.php', 'UserController');
  await expect(page.locator('.cm-content .se-t-keyword', { hasText: 'class' }).first()).toBeVisible();
  await expect(page.locator('.cm-content .se-t-keyword', { hasText: 'function' }).first()).toBeVisible();
  await expect(page.locator('.cm-content .se-t-variable, .cm-content .se-t-def', { hasText: '$users' }).first()).toBeVisible();
  await expect(page.locator('.cm-lineNumbers .cm-gutterElement', { hasText: /^8$/ })).toBeVisible();
  await expect(page.locator('.se-editor')).toHaveClass(/se-codefile/);
});

test('Mod+click on [[Daily notes]] in README opens that note', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Daily notes');
  const link = page.locator('.se-wikilink', { hasText: 'Daily notes' }).first();
  await expect(link).toBeVisible();
  await link.click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/Daily notes.md');
  await expect(page.locator('.cm-content')).toContainText('Write the release notes');
});

test('fenced code block shows language label, copy button and highlighted tokens', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.open(page);
  await open(page, 'README.md', 'git push');
  const header = page.locator('.se-cb-header').first();
  await expect(header.locator('.se-cb-lang')).toHaveText('bash');
  const copy = header.locator('.se-cb-copy');
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveClass(/se-copied/);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('git push --force-with-lease origin main\nphp artisan migrate:fresh --seed\ndocker compose up -d');
  // Fence syntax is hidden while the cursor is elsewhere
  await expect(page.locator('.cm-line', { hasText: '```' })).toHaveCount(0);
});

test('callouts, tables, math and frontmatter render in live mode; source mode shows raw text', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/Daily notes.md', 'Daily notes');
  await expect(page.locator('.se-callout-title')).toContainText('Callout title');
  await expect(page.locator('.se-table th', { hasText: 'Name' })).toBeVisible();
  await expect(page.locator('.se-math .katex').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.se-props .se-prop-key', { hasText: 'title' })).toBeVisible();
  await page.evaluate(() => (window as any).__secEdit.editor.setViewMode('source'));
  await expect(page.locator('.se-editor')).toHaveClass(/se-source/);
  await expect(page.locator('.cm-line', { hasText: '| Name | Value |' })).toBeVisible();
  await expect(page.locator('.se-table')).toHaveCount(0);
  // Switching back keeps the same state (no reload)
  await page.evaluate(() => (window as any).__secEdit.editor.setViewMode('live'));
  await expect(page.locator('.se-table th', { hasText: 'Name' })).toBeVisible();
});

test('[[ autocompletes note names', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Welcome');
  await cursorAtEndOf(page, '#tag/project #idea');
  await page.keyboard.press('Enter');
  await page.keyboard.type('See [[kube');
  const option = page.locator('.cm-tooltip-autocomplete li', { hasText: 'kubernetes' });
  await expect(option).toBeVisible();
  await page.waitForTimeout(150); // CM ignores keys for 75ms after the popup opens (interactionDelay)
  await page.keyboard.press('Enter');
  const content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('See [[kubernetes]]');
});

test('tabs keep their own undo history and scroll position', async ({ page, ws }) => {
  await ws.write('notes/long.md', Array.from({ length: 400 }, (_, i) => `Line ${i + 1} of a long note`).join('\n'));
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('notes/long.md'));
  await open(page, 'notes/long.md', 'Line 1 of');
  await page.evaluate(() => (window as any).__secEdit.editor.scrollToLine(250));
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getTopLine())).toBeGreaterThan(240);
  await open(page, 'README.md', 'Welcome');
  await cursorAtEndOf(page, '#tag/project #idea');
  await page.keyboard.type(' edited');
  await open(page, 'notes/kubernetes.md', 'Kubernetes');
  await open(page, 'README.md', 'edited');
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+z');
  const content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).not.toContain('edited');
  await open(page, 'notes/long.md', 'Line 2');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getTopLine())).toBeGreaterThan(240);
});

test('Mod-f opens the themed search panel; Mod-g go to line', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Welcome');
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+f');
  await expect(page.locator('.cm-search input[name=search]')).toBeFocused();
  await page.keyboard.type('docker');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-searchMatch').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+g');
  await expect(page.locator('.cm-goto-line input')).toBeFocused();
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(4);
});

test('screenshots of live preview (dark + light)', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/Daily notes.md', 'Daily notes');
  await expect(page.locator('.se-math .katex').first()).toBeVisible({ timeout: 10000 });
  await page.evaluate(() => (window as any).__secEdit.editor.getView().dispatch({ selection: { anchor: 0 } }));
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: shot('live.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await page.screenshot({ path: shot('live-light.png') });
  await open(page, 'code/UserController.php', 'UserController');
  await expect(page.locator('.cm-content .se-t-keyword').first()).toBeVisible();
  await page.screenshot({ path: shot('code-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: shot('code.png') });
});

test('foldable callouts toggle; clicking a rendered table reveals its source', async ({ page, ws }) => {
  await ws.write('notes/fold.md', '# Fold\n\n> [!warning]- Careful\n> hidden body\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nend\n');
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('notes/fold.md'));
  await open(page, 'notes/fold.md', 'Careful');
  await expect(page.locator('.cm-line', { hasText: 'hidden body' })).toHaveCount(0);
  await page.locator('.se-callout-fold').click();
  await expect(page.locator('.cm-line', { hasText: 'hidden body' })).toBeVisible();
  await page.locator('.se-callout-fold').click();
  await expect(page.locator('.cm-line', { hasText: 'hidden body' })).toHaveCount(0);
  await page.locator('.se-table td', { hasText: '2' }).click();
  await expect(page.locator('.se-table')).toHaveCount(0);
  await expect(page.locator('.cm-line', { hasText: '| 1 | 2 |' })).toBeVisible();
  const cur = await page.evaluate(() => (window as any).__secEdit.editor.getCursor());
  expect(cur.line).toBe(7);
});

test('typing ** auto-closes and steps over the closing pair', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Welcome');
  await cursorAtEndOf(page, '#tag/project #idea');
  await page.keyboard.type(' **bold** done');
  const content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('#tag/project #idea **bold** done');
});

test('code editing: Mod-/ comments, Alt-Down moves lines, Mod-d adds the next occurrence', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'code/UserController.php', 'UserController');
  await cursorAtEndOf(page, 'use App\\Models\\User;');
  await page.keyboard.press('Control+/');
  let content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('// use App\\Models\\User;');
  await page.keyboard.press('Alt+ArrowDown');
  content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('class UserController extends Controller {\n// use App\\Models\\User;');
  await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    const i = view.state.doc.toString().indexOf('$users');
    view.dispatch({ selection: { anchor: i, head: i + 6 } });
    view.focus();
  });
  await page.keyboard.press('Control+d');
  const ranges = await page.evaluate(() => (window as any).__secEdit.editor.getView().state.selection.ranges.length);
  expect(ranges).toBe(2);
});

test('external change reloads the open note and keeps the cursor', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/kubernetes.md', 'Kubernetes');
  await cursorAtEndOf(page, 'Restart a rollout');
  const before = await page.evaluate(() => (window as any).__secEdit.editor.getCursor());
  const text = await ws.read('notes/kubernetes.md');
  await ws.write('notes/kubernetes.md', text.replace('# Kubernetes cheatsheet', '# Kubernetes cheatsheet (edited outside)'));
  await expect(page.locator('.cm-content')).toContainText('edited outside', { timeout: 10000 });
  const after = await page.evaluate(() => (window as any).__secEdit.editor.getCursor());
  expect(after.line).toBe(before.line);
});

test('heading fold arrow folds the section', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Commands');
  const heading = page.locator('.cm-line.se-h2', { hasText: 'Commands' });
  await heading.hover();
  await heading.locator('.se-heading-fold').click();
  await expect(page.locator('.se-cb-header')).toHaveCount(0);
  await expect(page.locator('.cm-foldPlaceholder')).toBeVisible();
  await heading.locator('.se-heading-fold').click();
  await expect(page.locator('.se-cb-header')).toHaveCount(1);
});

test('editor commands are in the palette with their editor-local shortcuts', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'README.md', 'Welcome');
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('toggle bold');
  const item = page.getByRole('dialog').getByText('Toggle bold').first();
  await expect(item).toBeVisible();
  await page.keyboard.press('Escape');
  // run one through the registry and check it acted on the editor
  await cursorAtEndOf(page, '#tag/project #idea');
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('insert table');
  await expect(page.locator('.se-pal-item.selected')).toContainText('Table');
  await expect(page.locator('.se-pal-item.selected')).toContainText('Insert');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent())).toContain('| Column 1 | Column 2 |');
});

test('[[Note# completes headings and # completes tags', async ({ page, ws }) => {
  await ws.open(page);
  await open(page, 'notes/kubernetes.md', 'Kubernetes');
  await cursorAtEndOf(page, 'Restart a rollout');
  await page.keyboard.type('\nSee [[README#Com');
  const heading = page.locator('.cm-tooltip-autocomplete li', { hasText: 'Commands' });
  await expect(heading).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.keyboard.type(' and #ide');
  await expect(page.locator('.cm-tooltip-autocomplete li', { hasText: 'idea' })).toBeVisible();
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  const content = await page.evaluate(() => (window as any).__secEdit.editor.getContent());
  expect(content).toContain('See [[README#Commands]] and #idea');
});

test('mermaid blocks render as diagrams; Mod+hover on a wikilink shows a page preview', async ({ page, ws }) => {
  await ws.write('notes/diagram.md', '# Diagram\n\nSee [[kubernetes]] for details.\n\n```mermaid\ngraph LR\n  A[Start] --> B[End]\n```\n\nafter\n');
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('notes/diagram.md'));
  await open(page, 'notes/diagram.md', 'Diagram');
  await expect(page.locator('.se-mermaid svg')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.cm-line', { hasText: 'graph LR' })).toHaveCount(0);
  const link = page.locator('.se-wikilink', { hasText: 'kubernetes' });
  await page.keyboard.down('Control');
  const box = (await link.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.move(box.x + 12, box.y + box.height / 2);
  await expect(page.locator('.se-hover-preview')).toContainText('Kubernetes cheatsheet', { timeout: 5000 });
  await page.keyboard.up('Control');
  await page.screenshot({ path: shot('hover-preview.png') });
});

test('Mod-k uses a URL from the clipboard as the link target', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.open(page);
  await open(page, 'README.md', 'Welcome');
  await page.evaluate(() => navigator.clipboard.writeText('https://codemirror.net'));
  await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    const i = view.state.doc.toString().indexOf('test-suite');
    view.dispatch({ selection: { anchor: i, head: i + 'test-suite'.length } });
    view.focus();
  });
  await page.keyboard.press('Control+k');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent())).toContain('[test-suite](https://codemirror.net)');
});
