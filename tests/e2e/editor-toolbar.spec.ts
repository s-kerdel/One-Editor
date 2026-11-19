// Formatting toolbar (live mode), right-click menu, markdown line numbers, language override, content width.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { openNote, content, cursorTo } from './editor-helpers';

const editorFocused = (page: Page) => page.evaluate(() => document.activeElement?.classList.contains('cm-content') ?? false);
const setViewMode = (page: Page, mode: string) =>
  page.evaluate((m) => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, viewMode: m };
    app.editor.setViewMode(m);
  }, mode);
const select = (page: Page, needle: string, len = needle.length) =>
  page.evaluate(
    ({ needle, len }) => {
      const v = (window as any).__secEdit.editor.getView();
      const at = v.state.doc.toString().indexOf(needle);
      v.dispatch({ selection: { anchor: at, head: at + len } });
      v.focus();
    },
    { needle, len },
  );

/** Right-clicks the middle of the first occurrence of `needle` (exact text coordinates). */
async function rightClickText(page: Page, needle: string) {
  const at = await page.evaluate((n) => {
    const v = (window as any).__secEdit.editor.getView();
    const pos = v.state.doc.toString().indexOf(n) + Math.floor(n.length / 2);
    const c = v.coordsAtPos(pos);
    return { x: c.left, y: (c.top + c.bottom) / 2 };
  }, needle);
  await page.mouse.click(at.x, at.y, { button: 'right' });
}

async function palette(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+P');
  await page.keyboard.type(title);
  await expect(page.locator('.se-pal-item.selected')).toContainText(title, { ignoreCase: true });
  await page.keyboard.press('Enter');
}

test('toolbar: shown in live mode only, buttons keep focus + selection, active states follow the cursor', async ({ page, ws }) => {
  await ws.write('notes/tb.md', '# Title\n\nSome **bold** and *it* text here.\n\n- item\n\n> quote\n');
  await ws.open(page);
  await openNote(page, 'notes/tb.md', 'Some');
  const bar = page.locator('.se-fmtbar');
  await expect(bar).toBeVisible();
  await expect(bar.locator('[role="toolbar"]')).toHaveAttribute('aria-label', 'Formatting');

  // Active states.
  await cursorTo(page, { after: 'Some **bo' });
  await expect(bar.locator('[data-tool="bold"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(bar.locator('[data-tool="italic"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(bar.locator('.se-fmt-block-label')).toHaveText('Paragraph');
  await cursorTo(page, { after: '# Ti' });
  await expect(bar.locator('.se-fmt-block-label')).toHaveText('Heading 1');
  await expect(bar.locator('[data-tool="bold"]')).toHaveAttribute('aria-pressed', 'false');
  await cursorTo(page, { after: '- it' });
  await expect(bar.locator('[data-tool="bullet"]')).toHaveAttribute('aria-pressed', 'true');
  await cursorTo(page, { after: '> quo' });
  await expect(bar.locator('[data-tool="quote"]')).toHaveAttribute('aria-pressed', 'true');

  // Click Bold on a selection: wraps it, the editor keeps focus and the selection.
  await select(page, 'text here', 4);
  await bar.locator('[data-tool="italic"]').click();
  expect(await content(page)).toContain('*text* here');
  expect(await editorFocused(page)).toBe(true);
  await expect(bar.locator('[data-tool="italic"]')).toHaveAttribute('aria-pressed', 'true');
  await bar.locator('[data-tool="italic"]').click(); // toggles back off
  expect(await content(page)).toContain('and *it* text here');

  // Block-type dropdown → Heading 2 (menu entries carry their shortcuts).
  await cursorTo(page, { after: 'Some ' });
  await bar.locator('.se-fmt-block').click();
  const menu = page.locator('.se-fmt-menu');
  await expect(menu.locator('.se-menu-item')).toHaveCount(7);
  await expect(menu.locator('.se-menu-item', { hasText: 'Heading 2' })).toContainText('Ctrl+2');
  await menu.locator('.se-menu-item', { hasText: 'Heading 2' }).click();
  await expect(menu).toHaveCount(0);
  expect(await content(page)).toContain('## Some **bold**');
  await expect(bar.locator('.se-fmt-block-label')).toHaveText('Heading 2');
  expect(await editorFocused(page)).toBe(true);

  // Lists / tasks toggle per line; callout menu inserts the chosen type.
  await cursorTo(page, { after: '- item' });
  await bar.locator('[data-tool="task"]').click();
  expect(await content(page)).toContain('- [ ] item');
  await bar.locator('[data-tool="ordered"]').click();
  expect(await content(page)).toContain('1. item');
  await cursorTo(page, 'end');
  await bar.locator('[data-tool="callout"]').click();
  await menu.locator('.se-menu-item', { hasText: 'Warning' }).click();
  expect(await content(page)).toContain('> [!warning] Title');

  // Tooltip shows the shortcut.
  await bar.locator('[data-tool="bold"]').hover();
  await expect(page.locator('.se-fmt-tip')).toBeVisible();
  await expect(page.locator('.se-fmt-tip')).toContainText('Bold');
  await expect(page.locator('.se-fmt-tip')).toContainText('Ctrl+B');

  // Hidden in source / split / reading view.
  for (const m of ['source', 'split', 'preview']) {
    await setViewMode(page, m);
    await expect(bar).toHaveCount(0);
  }
  await setViewMode(page, 'live');
  await expect(bar).toBeVisible();

  // Hidden for code files.
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(page.locator('.se-codefile')).toBeVisible();
  await expect(bar).toHaveCount(0);
});

test('toolbar: keyboard access (Alt+F10, arrows, Enter, Escape), overflow menu, palette toggle', async ({ page, ws }) => {
  await ws.write('notes/kb.md', 'alpha beta\n');
  await ws.open(page);
  await openNote(page, 'notes/kb.md', 'alpha');
  await select(page, 'alpha');
  await page.keyboard.press('Alt+F10');
  const block = page.locator('.se-fmt-block');
  await expect(block).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-tool="bold"]')).toBeFocused();
  await expect(page.locator('.se-fmt-tip')).toContainText('Ctrl+B');
  await page.keyboard.press('Enter');
  expect(await content(page)).toContain('**alpha** beta');
  expect(await editorFocused(page)).toBe(true);
  // Dropdown by keyboard: focus moves into the menu, Escape closes it.
  await page.keyboard.press('Alt+F10');
  await expect(page.locator('[data-tool="bold"]')).toBeFocused(); // roving tabindex remembers
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-fmt-menu [aria-checked="true"]')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await content(page)).toContain('# **alpha** beta');
  await page.keyboard.press('Alt+F10');
  await page.keyboard.press('Escape');
  expect(await editorFocused(page)).toBe(true);

  // Narrow window: trailing tools move into the "more" menu.
  await page.setViewportSize({ width: 760, height: 800 });
  const more = page.locator('.se-fmt-more');
  await expect(more).toBeVisible();
  await expect(page.locator('[data-tool="attach"]')).toBeHidden();
  await more.click();
  await expect(page.locator('.se-fmt-menu')).toContainText('Image or file');
  await page.locator('.se-fmt-menu .se-menu-item', { hasText: 'Divider' }).click();
  expect(await content(page)).toContain('---');
  await page.setViewportSize({ width: 1360, height: 860 });
  await expect(more).toBeHidden();
  await expect(page.locator('[data-tool="attach"]')).toBeVisible();

  // Palette toggles the setting (persisted through the shell's settings path).
  await palette(page, 'Toggle formatting toolbar');
  await expect(page.locator('.se-fmtbar')).toHaveCount(0);
  await expect.poll(async () => (await ws.server.service.getSettings()).formatToolbar).toBe(false);
  await palette(page, 'Toggle formatting toolbar');
  await expect(page.locator('.se-fmtbar')).toBeVisible();
});

test('context menu: clipboard, formatting on a selection, links, search, format document', async ({ page, ws, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ws.write('notes/cm.md', 'Hello world here.\n\nSee [docs](https://example.com/docs) now.\n');
  await ws.open(page);
  await openNote(page, 'notes/cm.md', 'Hello');
  const menu = page.locator('.se-menu');
  const item = (label: string) => menu.locator('.se-menu-item', { hasText: label }).first();

  // Caret only: cut/copy disabled, insert items offered.
  const line = page.locator('.cm-line', { hasText: 'Hello world' });
  const box = (await line.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' });
  await expect(menu).toBeVisible();
  await expect(item('Cut')).toBeDisabled();
  await expect(item('Paste as plain text')).toBeEnabled();
  await expect(item('Insert table')).toBeVisible();
  await expect(item('Format document')).toBeVisible();
  // (Click away rather than Escape: the menu may not hold focus yet on its first, lazily loaded open.)
  // Beyond the menu's max width (320px; long items like "Compare Text with Previous Selection").
  await page.mouse.click(box.x + 20 + 340, box.y + box.height / 2);
  await expect(menu).toHaveCount(0);

  // Selection: Bold from the menu; copy + paste through the clipboard.
  await select(page, 'world');
  await rightClickText(page, 'world');
  await expect(item('Search “world” in files')).toBeVisible();
  await item('Bold').click();
  expect(await content(page)).toContain('Hello **world** here.');
  await select(page, 'here');
  await rightClickText(page, 'here');
  await item('Copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('here');
  await cursorTo(page, 'end');
  await page.evaluate(() => navigator.clipboard.writeText('PASTED'));
  const last = (await page.locator('.cm-line').last().boundingBox())!;
  await page.mouse.click(last.x + 4, last.y + last.height / 2, { button: 'right' });
  await item('Paste').first().click();
  await expect.poll(() => content(page)).toContain('PASTED');

  // Search in files hands the selected text to the search panel.
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.__searched = null;
    const orig = app.openSearch;
    app.openSearch = (q: string) => ((app.__searched = q), orig?.(q));
  });
  await select(page, 'Hello');
  await rightClickText(page, 'Hello');
  await item('Search “Hello” in files').click();
  expect(await page.evaluate(() => (window as any).__secEdit.__searched)).toBe('Hello');

  // On a rendered link: open / copy link.
  await cursorTo(page, { after: 'Hello' });
  const link = page.locator('.se-mdlink', { hasText: 'docs' });
  await link.click({ button: 'right' });
  await expect(item('Open link in browser')).toBeVisible();
  await item('Copy link').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/docs');
});

test('context menu paste without clipboard permission shows a hint instead of failing silently', async ({ page, ws }) => {
  await ws.write('notes/cm2.md', 'abc\n');
  await ws.open(page);
  await openNote(page, 'notes/cm2.md', 'abc');
  await page.evaluate(() => {
    // Simulate a browser that denies clipboard reads.
    Object.defineProperty(navigator, 'clipboard', { value: { read: () => Promise.reject(new Error('denied')), readText: () => Promise.reject(new Error('denied')) }, configurable: true });
  });
  const line = (await page.locator('.cm-line', { hasText: 'abc' }).boundingBox())!;
  await page.mouse.click(line.x + 10, line.y + line.height / 2, { button: 'right' });
  await page.locator('.se-menu .se-menu-item', { hasText: /^Paste\s*Ctrl\+V$/ }).click();
  await expect(page.locator('.se-toast')).toContainText('press Ctrl+V');
  expect(await content(page)).toBe('abc\n');
});

test('line numbers: markdown only in source + split (setting), code files always; palette toggles the setting', async ({ page, ws }) => {
  await ws.open(page);
  await openNote(page, 'notes/Daily notes.md', 'Daily notes');
  const nums = page.locator('.cm-lineNumbers');
  await expect(nums).toHaveCount(0); // live
  await setViewMode(page, 'source');
  await expect(nums).toHaveCount(1);
  // The gutter hugs the centred text column (not the far left of a wide window).
  const gap = await page.evaluate(() => {
    const g = document.querySelector('.cm-gutters')!.getBoundingClientRect();
    const c = document.querySelector('.cm-content')!.getBoundingClientRect();
    return c.left - g.right;
  });
  expect(Math.abs(gap)).toBeLessThan(4);
  await setViewMode(page, 'split');
  await expect(nums).toHaveCount(1);
  await setViewMode(page, 'live');
  await expect(nums).toHaveCount(0);
  await setViewMode(page, 'source');
  await palette(page, 'Toggle line numbers');
  await expect(nums).toHaveCount(0);
  await expect.poll(async () => (await ws.server.service.getSettings()).markdownLineNumbers).toBe(false);
  // Code files keep them regardless.
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(page.locator('.se-codefile .cm-lineNumbers')).toHaveCount(1);
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/Daily notes.md'));
  await palette(page, 'Toggle line numbers');
  await expect(nums).toHaveCount(1);
});

test('language override: markdown → code view and back keeps the doc + undo; getLanguage / onLanguageChange', async ({ page, ws }) => {
  await ws.open(page);
  await openNote(page, 'notes/Daily notes.md', 'Daily notes');
  const ed = page.locator('.cm-editor');
  await expect(ed).toHaveClass(/se-live/);
  expect(await page.evaluate(() => (window as any).__secEdit.editor.getLanguage())).toEqual({ id: 'markdown', name: 'Markdown', auto: true });
  await cursorTo(page, 'end');
  await page.keyboard.type('typed');
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.__langEvents = [];
    app.editor.onLanguageChange((p: string) => app.__langEvents.push(p));
    app.editor.setLanguage('notes/Daily notes.md', 'yaml');
  });
  await expect(ed).toHaveClass(/se-codefile/);
  await expect(ed).not.toHaveClass(/se-live/);
  await expect(page.locator('.se-fmtbar')).toHaveCount(0);
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(1);
  await expect(page.locator('.se-props')).toHaveCount(0); // raw YAML, no widgets
  expect(await page.evaluate(() => (window as any).__secEdit.editor.getLanguage())).toEqual({ id: 'yaml', name: 'YAML', auto: false });
  expect(await page.evaluate(() => (window as any).__secEdit.__langEvents)).toEqual(['notes/Daily notes.md']);
  // Highlighting arrives once the grammar is loaded.
  await expect(page.locator('.cm-content .se-t-property, .cm-content .se-t-string, .cm-content .se-t-atom').first()).toBeVisible();
  expect(await content(page)).toContain('typed');

  // Plain text: no highlighting; then back to markdown restores live preview.
  await page.evaluate(() => (window as any).__secEdit.editor.setLanguage('notes/Daily notes.md', 'text'));
  await expect(page.locator('.cm-content .se-t-property')).toHaveCount(0);
  await page.evaluate(() => (window as any).__secEdit.editor.setLanguage('notes/Daily notes.md', null));
  await expect(ed).toHaveClass(/se-live/);
  await expect(page.locator('.se-props')).toBeVisible();
  await expect(page.locator('.se-fmtbar')).toBeVisible();
  // Undo history survived both switches.
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+z');
  await expect.poll(() => content(page)).not.toContain('typed');

  // A code file can be switched too; picking its own language = auto.
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(page.locator('.se-codefile')).toBeVisible();
  const lang = () => page.evaluate(() => (window as any).__secEdit.editor.getLanguage('code/app.ts'));
  expect(await lang()).toEqual({ id: 'typescript', name: 'TypeScript', auto: true });
  await page.evaluate(() => (window as any).__secEdit.editor.setLanguage('code/app.ts', 'json'));
  expect(await lang()).toEqual({ id: 'json', name: 'JSON', auto: false });
  await page.evaluate(() => (window as any).__secEdit.editor.setLanguage('code/app.ts', 'typescript'));
  expect(await lang()).toEqual({ id: 'typescript', name: 'TypeScript', auto: true });
});

test('content width: markdown column follows --content-width (live, source, preview); code is full width', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ contentWidth: 'readable' });
  await ws.open(page);
  await openNote(page, 'notes/Daily notes.md', 'Daily notes');
  const width = (sel: string) => page.evaluate((s) => document.querySelector(s)!.getBoundingClientRect().width, sel);
  expect(await width('.cm-content')).toBeLessThanOrEqual(861);
  const tb = await page.evaluate(() => {
    const a = document.querySelector('.se-fmtbar-inner')!.getBoundingClientRect();
    const c = document.querySelector('.cm-content')!.getBoundingClientRect();
    return { a: a.left, c: c.left, w: a.width };
  });
  expect(Math.abs(tb.a - tb.c)).toBeLessThan(2); // toolbar sits over the text column
  const lh = await page.evaluate(() => getComputedStyle(document.querySelector('.cm-scroller')!).lineHeight);
  expect(parseFloat(lh) / 15).toBeCloseTo(1.65, 1);
  await page.evaluate(() => document.documentElement.style.setProperty('--content-width', 'none'));
  expect(await width('.cm-content')).toBeGreaterThan(900);
  await page.evaluate(() => document.documentElement.style.setProperty('--content-width', '1200px'));
  expect(await width('.cm-content')).toBeLessThanOrEqual(1201);
  await setViewMode(page, 'source');
  expect(await width('.cm-content')).toBeGreaterThan(900);
  await page.evaluate(() => document.documentElement.style.setProperty('--content-width', '860px'));
  await setViewMode(page, 'preview');
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, viewMode: 'preview' };
  });
  await expect(page.locator('.se-preview').first()).toBeVisible();
  expect(await width('.se-preview')).toBeLessThanOrEqual(861);
  await setViewMode(page, 'live');
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, viewMode: 'live' };
  });
  await page.evaluate(() => (window as any).__secEdit.openFile('code/app.ts'));
  await expect(page.locator('.se-codefile')).toBeVisible();
  expect(await width('.cm-content')).toBeGreaterThan(900);
});
