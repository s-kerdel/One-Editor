// Live-preview blocks added in round 2: note embeds, the properties editor, mermaid re-theming.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { content, cursorTo, openNote, setTheme, shot } from './editor-helpers';

const fmOnDisk = async (read: () => Promise<string>) => (/^---\n([\s\S]*?)\n---/.exec(await read()) ?? [, ''])[1];
const prop = (page: Page, key: string) => page.locator(`.se-prop[data-key="${key}"]`);

test('![[note]] and ![[note#Heading]] render as embedded blocks; title opens the note; updates live', async ({ page, ws }) => {
  await ws.write('notes/host.md', '# Host\n\nBefore\n\n![[kubernetes]]\n\n![[README#Commands]]\n\n![[Missing note]]\n\nAfter\n');
  await ws.open(page);
  await openNote(page, 'notes/host.md', 'Before');
  const embeds = page.locator('.se-note-embed');
  await expect(embeds).toHaveCount(3);
  await expect(embeds.nth(0).locator('.se-note-embed-body')).toContainText('kubectl get pods --all-namespaces');
  await expect(embeds.nth(0).locator('.se-note-embed-title')).toHaveText('kubernetes');
  await expect(embeds.nth(1).locator('.se-note-embed-frag')).toHaveText('# Commands');
  await expect(embeds.nth(1).locator('.se-note-embed-body')).toContainText('docker compose up -d');
  await expect(embeds.nth(1).locator('.se-note-embed-body')).not.toContainText('fixture workspace');
  await expect(embeds.nth(2)).toHaveClass(/is-unresolved/);
  // Code inside the embed is highlighted by the preview pipeline.
  await expect(embeds.nth(0).locator('pre')).toBeVisible();
  await setTheme(page, 'dark');
  await page.screenshot({ path: shot('embed-dark.png') });
  await setTheme(page, 'light');
  await page.screenshot({ path: shot('embed-light.png') });
  await setTheme(page, 'dark');

  // Editing the embedded note on disk re-renders the embed.
  await ws.write('notes/kubernetes.md', '# Kubernetes cheatsheet\n\nFreshly edited line.\n');
  await expect(embeds.nth(0).locator('.se-note-embed-body')).toContainText('Freshly edited line', { timeout: 10000 });

  // Cursor on the embed line reveals the raw link.
  await cursorTo(page, { after: '![[kubernetes' });
  await expect(page.locator('.cm-line', { hasText: '![[kubernetes]]' })).toBeVisible();
  await expect(embeds).toHaveCount(2);

  // Title click opens the embedded note.
  await cursorTo(page, { after: 'After' });
  await page.locator('.se-note-embed-title', { hasText: 'README' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
});

test('properties widget: YAML frontmatter as editable rows; edits write valid YAML to disk', async ({ page, ws }) => {
  await ws.write('notes/props.md', '---\ntitle: Plain title\ntags: [journal, daily]\ncount: 3\ndone: false\ndue: 2026-11-19\naliases:\n  - First\n# a comment that must survive\nnested:\n  a: 1\n---\n# Props\n\nBody\n');
  await ws.open(page);
  await openNote(page, 'notes/props.md', 'Body');
  const props = page.locator('.se-props');
  await expect(props).toBeVisible();
  await expect(page.locator('.cm-line', { hasText: 'title: Plain title' })).toHaveCount(0);
  await expect(prop(page, 'tags').locator('.se-pill')).toHaveText(['journal', 'daily']);
  await expect(prop(page, 'done').locator('input[type=checkbox]')).not.toBeChecked();
  await expect(prop(page, 'due').locator('input[type=date]')).toHaveValue('2026-11-19');
  await expect(prop(page, 'nested')).toHaveClass(/se-prop-t-complex/);
  await setTheme(page, 'dark');
  await page.screenshot({ path: shot('props-dark.png') });
  await setTheme(page, 'light');
  await page.screenshot({ path: shot('props-light.png') });
  await setTheme(page, 'dark');

  // Text with colon, quotes, '#', unicode → quoted safely.
  await prop(page, 'title').locator('.se-prop-text').click();
  const input = prop(page, 'title').locator('input');
  await expect(input).toBeFocused();
  await input.fill('Réunion: "Q4" #plan — 日本');
  await page.keyboard.press('Enter');
  await expect.poll(() => fmOnDisk(() => ws.read('notes/props.md')), { timeout: 8000 }).toContain('title: "Réunion: \\"Q4\\" #plan — 日本"');
  await expect(prop(page, 'title').locator('.se-prop-text')).toHaveText('Réunion: "Q4" #plan — 日本');

  // Tags: add with Enter (flow style kept), remove with ×.
  await prop(page, 'tags').locator('.se-pill-input').click();
  await page.keyboard.type('work');
  await page.keyboard.press('Enter');
  await expect(prop(page, 'tags').locator('.se-pill')).toHaveText(['journal', 'daily', 'work']);
  await prop(page, 'tags').locator('.se-pill', { hasText: 'journal' }).locator('.se-pill-x').click();
  await expect.poll(() => fmOnDisk(() => ws.read('notes/props.md')), { timeout: 8000 }).toContain('tags: [daily, work]');

  // Checkbox, number, date.
  await prop(page, 'done').locator('input[type=checkbox]').click();
  await prop(page, 'count').locator('.se-prop-text').click();
  await prop(page, 'count').locator('input').fill('42');
  await page.keyboard.press('Enter');
  await prop(page, 'due').locator('input[type=date]').fill('2026-12-24');
  await expect.poll(() => fmOnDisk(() => ws.read('notes/props.md')), { timeout: 8000 }).toMatch(/count: 42\ndone: true\ndue: 2026-12-24\n/);

  // Add property → name → Enter → value.
  await props.locator('.se-props-add').click();
  await page.keyboard.type('status');
  await page.keyboard.press('Enter');
  await expect(prop(page, 'status').locator('input')).toBeFocused();
  await page.keyboard.type('in progress');
  await page.keyboard.press('Enter');
  // Remove a property.
  await prop(page, 'aliases').hover();
  await prop(page, 'aliases').locator('.se-prop-del').click();
  const fm = await (async () => {
    await expect.poll(() => fmOnDisk(() => ws.read('notes/props.md')), { timeout: 8000 }).toContain('status: in progress');
    return fmOnDisk(() => ws.read('notes/props.md'));
  })();
  expect(fm).toBe('title: "Réunion: \\"Q4\\" #plan — 日本"\ntags: [daily, work]\ncount: 42\ndone: true\ndue: 2026-12-24\n# a comment that must survive\nnested:\n  a: 1\nstatus: in progress');

  // "Edit as YAML" shows the raw lines; leaving the frontmatter brings the widget back.
  await props.locator('.se-props-btn').click();
  await expect(page.locator('.cm-line', { hasText: 'count: 42' })).toBeVisible();
  await expect(page.locator('.se-props')).toHaveCount(0);
  await cursorTo(page, { after: 'Body' });
  await expect(page.locator('.se-props')).toBeVisible();
  // Undo reverts the last property edit (the removal of `aliases`).
  await page.keyboard.press('Control+z');
  await expect.poll(() => content(page)).toContain('due: 2026-12-24\naliases:\n  - First\n# a comment');
});

test('a note opens with the cursor below its frontmatter; typing never breaks the YAML fence', async ({ page, ws }) => {
  await ws.open(page);
  await openNote(page, 'notes/Daily notes.md', 'Daily notes');
  await expect(page.locator('.se-props')).toBeVisible();
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.type('X');
  expect(await content(page)).toMatch(/^---\ntitle: Daily notes\ntags: \[journal, daily\]\n---\nX/);
});

test('mermaid diagrams re-render when the theme changes (no reopen needed)', async ({ page, ws }) => {
  await ws.write('notes/mmd.md', '# Diagram\n\n```mermaid\ngraph LR\n  A[Start] --> B[End]\n```\n\nafter\n');
  await ws.open(page);
  await setTheme(page, 'dark');
  await openNote(page, 'notes/mmd.md', 'Diagram');
  const diagram = page.locator('.se-mermaid');
  await expect(diagram.locator('svg')).toBeVisible({ timeout: 15000 });
  await expect(diagram).toHaveAttribute('data-done', 'dark');
  const darkSvg = await diagram.innerHTML();
  await setTheme(page, 'light');
  await expect(diagram).toHaveAttribute('data-done', 'light', { timeout: 10000 });
  await expect.poll(() => diagram.innerHTML()).not.toBe(darkSvg);
  await expect(diagram.locator('svg')).toBeVisible();
  await page.screenshot({ path: shot('mermaid-light.png') });
  await setTheme(page, 'dark');
  await expect(diagram).toHaveAttribute('data-done', 'dark', { timeout: 10000 });
});
