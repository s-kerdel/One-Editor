import { test, expect } from './harness';
import { content, cursorTo, openNote, setTheme, shot } from './editor-helpers';

const menu = (page: import('@playwright/test').Page) => page.locator('.se-slash');
const selected = (page: import('@playwright/test').Page) => page.locator('.se-slash-item.is-selected .se-slash-title');

async function freshLine(page: import('@playwright/test').Page) {
  await openNote(page, 'README.md', 'Welcome');
  await cursorTo(page, 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
}

test('slash menu: "/" opens grouped menu; "/table" + Enter + Enter inserts a 3×3 table', async ({ page, ws }) => {
  await ws.open(page);
  await freshLine(page);
  await page.keyboard.type('/');
  await expect(menu(page)).toBeVisible();
  await expect(page.locator('.se-slash-group').first()).toHaveText('Basic');
  await expect(selected(page)).toHaveText('Heading 1');
  await setTheme(page, 'dark');
  await page.screenshot({ path: shot('slash-root-dark.png') });
  await setTheme(page, 'light');
  await page.screenshot({ path: shot('slash-root-light.png') });
  await setTheme(page, 'dark');
  await page.keyboard.type('table');
  await expect(selected(page)).toHaveText('Table');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-slash-grid')).toBeVisible();
  await expect(page.locator('.se-slash-grid-label')).toContainText('3 × 3');
  await page.screenshot({ path: shot('slash-table-grid.png') });
  await page.keyboard.press('Enter');
  await expect(menu(page)).toHaveCount(0);
  const text = await content(page);
  expect(text).toMatch(/\n\| Column 1 \| Column 2 \| Column 3 \|\n\| -+ \| -+ \| -+ \|\n\| +\| +\| +\|\n\| +\| +\| +\|\n?$/);
  expect(text).not.toContain('/table');
  // Header cell text is selected, ready to be typed over.
  await page.keyboard.type('Name');
  expect(await content(page)).toContain('| Name ');
});

test('slash menu: keywords/aliases ("todo", "warn", "pre") and code-block language completion', async ({ page, ws }) => {
  await ws.open(page);
  await freshLine(page);
  await page.keyboard.type('/todo');
  await expect(selected(page)).toHaveText('Task list');
  await page.keyboard.press('Enter');
  await page.keyboard.type('buy milk');
  expect(await content(page)).toMatch(/\n- \[ \] buy milk$/);

  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // empty item exits the list
  await page.keyboard.type('/warn');
  await expect(selected(page)).toHaveText('Warning callout');
  await page.keyboard.press('Enter');
  await page.keyboard.type('careful');
  expect(await content(page)).toMatch(/> \[!warning\] Warning\n> careful$/);

  await cursorTo(page, 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/pre');
  await expect(selected(page)).toHaveText('Code block');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await page.keyboard.type('typescr');
  await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected]')).toContainText('typescript');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const x = 1;');
  expect(await content(page)).toMatch(/\n```typescript\nconst x = 1;\n```$/);
});

test('slash menu: Esc closes; "/" in code, inline code, URLs and mid-word does nothing', async ({ page, ws }) => {
  await ws.write('notes/slash.md', '# Slash\n\n```js\nconst a = 1;\n```\n\nsee `code` and https://example.com\n\nword\n');
  await ws.open(page);
  await openNote(page, 'notes/slash.md', 'Slash');
  await cursorTo(page, { after: 'const a = 1;' });
  await page.keyboard.type(' /');
  await expect(menu(page)).toHaveCount(0);
  await cursorTo(page, { after: 'see `co' });
  await page.keyboard.type(' /');
  await expect(menu(page)).toHaveCount(0);
  await cursorTo(page, { after: 'https://example.com' });
  await page.keyboard.type('/');
  await expect(menu(page)).toHaveCount(0);
  await cursorTo(page, { after: 'word' });
  await page.keyboard.type('/');
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type(' /hea');
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu(page)).toHaveCount(0);
  await page.keyboard.type('d');
  await expect(menu(page)).toHaveCount(0);
  expect(await content(page)).toContain('word/ /head');
  // No match + space closes it too, so Enter keeps making new lines.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/zzz ');
  await expect(menu(page)).toHaveCount(0);
});

test('slash menu: mouse, submenus (callout, date, table grid), back navigation and Run command…', async ({ page, ws }) => {
  await ws.open(page);
  await freshLine(page);
  // Callout submenu with the mouse.
  await page.keyboard.type('/');
  await page.locator('.se-slash-item', { hasText: 'Callout' }).first().click();
  await expect(page.locator('.se-slash-head')).toHaveText('Callout');
  await expect(page.locator('.se-slash-item')).toHaveCount(13);
  await page.screenshot({ path: shot('slash-callouts-dark.png') });
  await setTheme(page, 'light');
  await page.screenshot({ path: shot('slash-callouts-light.png') });
  await setTheme(page, 'dark');
  // ← goes back to the root menu, typing filters again.
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.se-slash-head')).toHaveCount(0);
  await page.keyboard.type('callout');
  await page.keyboard.press('Enter');
  await page.keyboard.type('tip');
  await expect(selected(page)).toHaveText('Tip');
  await page.locator('.se-slash-item', { hasText: 'Tip' }).click();
  expect(await content(page)).toMatch(/> \[!tip\] Tip\n> $/);

  // Date submenu.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/today');
  await page.keyboard.press('Enter');
  expect(await content(page)).toMatch(/\n\d{4}-\d{2}-\d{2}$/);

  // Table grid by mouse: 4 columns × 3 rows.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await page.keyboard.press('Enter');
  await page.locator('.se-slash-cell[data-cols="4"][data-rows="3"]').hover();
  await expect(page.locator('.se-slash-grid-label')).toContainText('4 × 3');
  await page.locator('.se-slash-cell[data-cols="4"][data-rows="3"]').click();
  expect(await content(page)).toMatch(/\| Column 1 \| Column 2 \| Column 3 \| Column 4 \|\n(\|.*\|\n){2}\|.*\|\n?$/);

  // Run command… → "Heading 2" applies to the current line.
  await cursorTo(page, 'end');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Big title /command');
  await expect(selected(page)).toHaveText('Run command…');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-slash-head')).toHaveText('Run command');
  await page.keyboard.type('format heading 2');
  await expect(selected(page)).toHaveText('Format: Heading 2');
  await page.keyboard.press('Enter');
  await expect.poll(() => content(page)).toMatch(/\n## Big title ?$/);
});

test('slash menu: divider, footnote, link-to-note completion and properties', async ({ page, ws }) => {
  await ws.write('notes/slash2.md', 'Intro line\n');
  await ws.open(page);
  await openNote(page, 'notes/slash2.md', 'Intro');
  await cursorTo(page, 'end');
  await page.keyboard.type('/divider');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Text with note/');
  await expect(page.locator('.se-slash')).toHaveCount(0); // mid-word
  await page.keyboard.type(' /footnote');
  await page.keyboard.press('Enter');
  await page.keyboard.type('the footnote text');
  let text = await content(page);
  expect(text).toContain('Intro line\n\n---\nText with note/ [^1]');
  expect(text).toMatch(/\n\n\[\^1\]: the footnote text$/);

  await cursorTo(page, { after: 'Intro line' });
  await page.keyboard.type(' /link');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-tooltip-autocomplete')).toBeVisible();
  await page.keyboard.type('kuber');
  await expect(page.locator('.cm-tooltip-autocomplete li[aria-selected]')).toContainText('kubernetes');
  await page.keyboard.press('Enter');
  expect(await content(page)).toContain('Intro line [[kubernetes]]');

  // Properties: creates the frontmatter and starts "add property".
  await page.keyboard.type(' /propert');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-props .se-prop-key-input')).toBeFocused();
  await page.keyboard.type('status');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-prop[data-key="status"] input')).toBeFocused();
  await page.keyboard.type('draft');
  await page.keyboard.press('Enter');
  await expect.poll(() => content(page)).toMatch(/^---\nstatus: draft\n---\nIntro line \[\[kubernetes\]\] ?\n/);
  await expect.poll(() => ws.read('notes/slash2.md'), { timeout: 8000 }).toContain('status: draft');
});

test('slash menu: Template… inserts a template (variables filled); Image… embeds a workspace image', async ({ page, ws }) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.mkdirSync(path.join(ws.root, 'templates'), { recursive: true });
  fs.mkdirSync(path.join(ws.root, 'pics'), { recursive: true });
  fs.writeFileSync(path.join(ws.root, 'templates', 'Meeting.md'), '## {{title}} meeting on {{date:YYYY}}\n\n- attendees:\n');
  fs.writeFileSync(path.join(ws.root, 'pics', 'diagram.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await ws.write('notes/tpl.md', 'Top\n');
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('templates/Meeting.md'));
  await openNote(page, 'notes/tpl.md', 'Top');
  await cursorTo(page, 'end');
  await page.keyboard.type('/templ');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-slash-head')).toHaveText('Template');
  await expect(selected(page)).toHaveText('Meeting');
  await page.keyboard.press('Enter');
  await expect.poll(() => content(page)).toBe(`Top\n## tpl meeting on ${new Date().getFullYear()}\n\n- attendees:\n`);

  await cursorTo(page, 'end');
  await page.keyboard.type('/image');
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-slash-item').first()).toContainText('Upload from computer');
  await page.keyboard.type('diag');
  await expect(selected(page)).toHaveText('diagram.png');
  await page.keyboard.press('Enter');
  await expect.poll(() => content(page)).toMatch(/- attendees:\n!\[\[diagram\.png\]\]$/);
});
