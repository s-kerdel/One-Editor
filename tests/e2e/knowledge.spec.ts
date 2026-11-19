import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const SHOTS = process.env.KNOWLEDGE_SHOTS; // set to a directory to capture screenshots

async function boot(page: Page, ws: WsFixture) {
  await ws.open(page);
  // The link index builds in idle time after boot.
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 15000 });
}

const openFile = (page: Page, p: string) => page.evaluate((f) => (window as any).__secEdit.openFile(f), p);
const panel = (page: Page, id: string) => page.locator(`.se-nav-btn[data-panel="${id}"]`);
async function runFromPalette(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+p');
  // The palette focuses its input after mounting — typing earlier would land in the editor.
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
}
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

test('exposes a feature-detectable knowledge API', async ({ page, ws }) => {
  await boot(page, ws);
  const r = await page.evaluate(() => {
    const k = (window as any).__secEdit.knowledge;
    return {
      resolve: k.resolve('daily notes', 'README.md'),
      back: k.backlinks('notes/Daily notes.md').map((b: any) => [b.from, b.line, b.context.text]),
      tags: k.tags().map((t: any) => t.tag),
      headings: k.headings('README.md').map((h: any) => h.text),
      unresolved: k.unresolvedLinks().length,
      hasOpenLink: typeof (window as any).__secEdit.openLink === 'function',
    };
  });
  expect(r.resolve).toBe('notes/Daily notes.md');
  expect(r.back).toEqual([['README.md', 4, '- [[Daily notes]] link']]);
  expect(r.tags).toEqual(expect.arrayContaining(['idea', 'tag', 'journal', 'daily']));
  expect(r.headings).toEqual(['Welcome', 'Commands']);
  expect(r.unresolved).toBe(0);
  expect(r.hasOpenLink).toBe(true);
});

test('backlinks panel shows linked mentions and links an unlinked mention', async ({ page, ws }) => {
  await ws.write('notes/mention.md', '# Mention\n\nI should read the daily notes more often.\n');
  await boot(page, ws);
  await openFile(page, 'notes/Daily notes.md');
  await panel(page, 'backlinks').click();
  const p = page.locator('.se-kn-backlinks');
  await expect(p.locator('[data-section="linked"] .se-kn-file-name')).toHaveText(['README']);
  await expect(p.locator('[data-section="linked"] .se-kn-ctx mark')).toHaveText('[[Daily notes]]');
  // Sidebar tab icons are SVG, not text.
  await expect(panel(page, 'backlinks').locator('svg')).toHaveCount(1);

  const mention = p.locator('[data-section="unlinked"] .se-kn-mention');
  await expect(mention).toHaveCount(1);
  await expect(mention.locator('mark')).toHaveText('daily notes');
  await shot(page, 'backlinks-dark');
  await mention.getByRole('button', { name: /Link/ }).click();
  await expect.poll(() => ws.read('notes/mention.md')).toContain('read the [[Daily notes|daily notes]] more often');
  await expect(p.locator('[data-section="linked"] .se-kn-file-name')).toHaveText(['mention', 'README']);
  await expect(p.locator('[data-section="unlinked"] .se-kn-mention')).toHaveCount(0);

  // Clicking a backlink jumps to the linking line.
  await p.locator('[data-section="linked"] .se-kn-group[data-file="README.md"] .se-kn-ctx').click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(4);
});

test('outline lists headings live, follows the cursor and navigates', async ({ page, ws }) => {
  await boot(page, ws);
  await openFile(page, 'README.md');
  await panel(page, 'outline').click();
  const rows = page.locator('.se-kn-outline .se-kn-ol-row');
  await expect(rows.locator('.se-kn-ol-text')).toHaveText(['Welcome', 'Commands']);

  await rows.nth(1).click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(7);
  await expect(rows.nth(1)).toHaveClass(/active/);

  // Live: typing a new heading shows up without saving.
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+End');
  await page.keyboard.type('\n\n## Fresh heading\n\n### Nested one\n');
  await expect(rows.locator('.se-kn-ol-text')).toHaveText(['Welcome', 'Commands', 'Fresh heading', 'Nested one']);
  await expect(rows.nth(3)).toHaveClass(/active/);
  await shot(page, 'outline-dark');

  // Collapsing a parent hides its children.
  await rows.nth(2).locator('.se-kn-twisty').click();
  await expect(rows).toHaveCount(3);
  await rows.nth(0).click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(0);
  await expect(rows.nth(0)).toHaveClass(/active/);
});

test('tags panel shows a hierarchical tree and lists notes for a tag', async ({ page, ws }) => {
  await boot(page, ws);
  await panel(page, 'tags').click();
  const p = page.locator('.se-kn-tags');
  await expect(p.locator('.se-kn-tag[data-tag="idea"]')).toBeVisible();
  await expect(p.locator('.se-kn-tag[data-tag="tag"] .se-kn-count')).toHaveText('1');
  await expect(p.locator('.se-kn-tag[data-tag="tag/project"] .se-kn-tag-name')).toHaveText('project');
  await expect(p.locator('.se-kn-tag[data-tag="journal"]')).toBeVisible(); // from frontmatter
  await expect(p.locator('.se-kn-tag[data-tag="bash"]')).toHaveCount(0);

  await p.locator('.se-kn-tag[data-tag="tag/project"]').click();
  await expect(p.locator('.se-kn-tag-notes .se-kn-out-name')).toHaveText(['README']);
  await shot(page, 'tags-dark');
  await p.locator('.se-kn-tag-notes .se-kn-out').click();
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(15);

  // Live: a tag typed into the open note appears after the index catches up.
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' #brand-new/child');
  await expect(p.locator('.se-kn-tag[data-tag="brand-new/child"]')).toBeVisible();
});

test('openLink resolves headings and aliases, and creates missing notes', async ({ page, ws }) => {
  await ws.write('notes/aliased.md', '---\naliases: [The Alias]\n---\n# Aliased\n\ntext\n\n## Target section\n\nmore ^blk9\n');
  await boot(page, ws);
  await openFile(page, 'README.md');

  await page.evaluate(() => (window as any).__secEdit.openLink('The Alias#Target section', 'README.md'));
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('notes/aliased.md');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(7);
  await page.evaluate(() => (window as any).__secEdit.openLink('aliased#^blk9', 'README.md'));
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(9);

  await page.evaluate(() => (window as any).__secEdit.openLink('Brand new note', 'README.md'));
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('Brand new note.md');
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'Brand new note.md'))).toBe(true);
  expect(await ws.read('Brand new note.md')).toBe('# Brand new note\n\n');
  await expect(page.locator('.cm-content')).toContainText('Brand new note');

  // Created next to the linking note, like Obsidian.
  await page.evaluate(() => (window as any).__secEdit.openLink('Sibling idea|shown', 'notes/kubernetes.md'));
  await expect.poll(() => fs.existsSync(path.join(ws.root, 'notes/Sibling idea.md'))).toBe(true);
  // And it's immediately resolvable.
  expect(await page.evaluate(() => (window as any).__secEdit.knowledge.resolve('sibling idea'))).toBe('notes/Sibling idea.md');
});

test('renaming a note rewrites links on disk and in open editors', async ({ page, ws }) => {
  await ws.write('notes/refs.md', '# Refs\n\n[md link](Daily%20notes.md#Daily%20notes) and [[Daily notes#Daily notes|alias]] and ![[Daily notes]]\n\n`[[Daily notes]]` stays\n');
  await boot(page, ws);
  await openFile(page, 'README.md'); // open doc → rewritten through the editor
  await page.evaluate(async () => {
    const app = (window as any).__secEdit;
    await app.backend.rename('notes/Daily notes.md', 'notes/Journal.md');
    app.events.emit('file:renamed', 'notes/Daily notes.md', 'notes/Journal.md');
  });
  await expect(page.locator('.se-toast', { hasText: 'Updated links in 2 notes' })).toBeVisible();
  await expect.poll(() => ws.read('notes/refs.md')).toBe('# Refs\n\n[md link](Journal.md#Daily%20notes) and [[Journal#Daily notes|alias]] and ![[Journal]]\n\n`[[Daily notes]]` stays\n');
  // (live preview may hide the brackets, so read the editor model rather than the DOM)
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getContent('README.md'))).toContain('- [[Journal]] link');
  await expect(page.locator('.cm-content')).toContainText('Journal');
  await expect.poll(() => ws.read('README.md')).toContain('- [[Journal]] link'); // autosaved
  const back = await page.evaluate(() => (window as any).__secEdit.knowledge.backlinks('notes/Journal.md').map((b: any) => b.from));
  expect(back.sort()).toEqual(['README.md', 'notes/refs.md', 'notes/refs.md', 'notes/refs.md']);

  // Moving to another folder keeps bare [[links]] untouched but fixes relative markdown links.
  await page.evaluate(async () => {
    const app = (window as any).__secEdit;
    await app.backend.rename('notes/Journal.md', 'deep/Journal.md');
    app.events.emit('file:renamed', 'notes/Journal.md', 'deep/Journal.md');
  });
  await expect.poll(() => ws.read('notes/refs.md')).toContain('[md link](../deep/Journal.md#Daily%20notes) and [[Journal#Daily notes|alias]]');
  expect(await ws.read('README.md')).toContain('- [[Journal]] link');
});

test('renaming a folder updates path-style links everywhere', async ({ page, ws }) => {
  await ws.write('root-ref.md', '[k](notes/kubernetes.md) and [[notes/kubernetes|k8s]] and [[kubernetes]]\n');
  await ws.write('notes/inner.md', '[sibling](kubernetes.md) [up](../README.md)\n');
  await boot(page, ws);
  await page.evaluate(async () => {
    const app = (window as any).__secEdit;
    await app.backend.rename('notes', 'journal');
    app.events.emit('file:renamed', 'notes', 'journal');
  });
  await expect.poll(() => ws.read('root-ref.md')).toBe('[k](journal/kubernetes.md) and [[journal/kubernetes|k8s]] and [[kubernetes]]\n');
  // Links between files that moved together are still valid and must not be touched.
  expect(await ws.read('journal/inner.md')).toBe('[sibling](kubernetes.md) [up](../README.md)\n');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.knowledge.resolve('kubernetes'))).toBe('journal/kubernetes.md');
});

test('links.updateOnRename = false leaves links alone', async ({ page, ws }) => {
  await boot(page, ws);
  await page.evaluate(async () => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, 'links.updateOnRename': false };
    await app.backend.rename('notes/kubernetes.md', 'notes/k8s.md');
    app.events.emit('file:renamed', 'notes/kubernetes.md', 'notes/k8s.md');
  });
  await page.waitForTimeout(600);
  expect(await ws.read('deep/nested/folder/Deep note.md')).toContain('[[kubernetes]]');
  expect(await page.evaluate(() => (window as any).__secEdit.knowledge.unresolvedLinks().map((u: any) => u.target))).toEqual(['kubernetes']);
});

test('graph view opens, draws nodes, filters, and opens a note on click', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page, ws);
  await openFile(page, 'notes/Daily notes.md');
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+Alt+g');
  const canvas = page.locator('canvas.se-kn-g-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-nodes', '5'); // all markdown fixtures
  await expect(canvas).toHaveAttribute('data-edges', '2');

  const painted = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n;
    });
  await expect.poll(painted).toBeGreaterThan(200);
  // Let the layout settle, then capture.
  await page.waitForTimeout(1500);
  await shot(page, 'graph-dark');

  // Tags as nodes + local mode.
  await page.getByText('Tags', { exact: true }).click();
  await expect(canvas).toHaveAttribute('data-nodes', '9');
  await page.getByRole('tab', { name: 'Local' }).click();
  await page.getByRole('button', { name: 'Depth 1' }).click();
  await expect(canvas).toHaveAttribute('data-nodes', '4'); // Daily notes, README, #journal, #daily
  await page.getByText('Tags', { exact: true }).click();
  await expect(canvas).toHaveAttribute('data-nodes', '2');
  await page.waitForTimeout(800);
  await shot(page, 'graph-local-dark');

  // Click the README node → opens it and closes the graph.
  const pos = await canvas.evaluate((c: any) => c.__graph.nodeScreenPos('README.md'));
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + pos.x, box.y + pos.y);
  await expect(page.locator('.se-kn-g-hint')).toHaveText('README.md');
  await page.mouse.click(box.x + pos.x, box.y + pos.y);
  await expect(canvas).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe('README.md');
  expect(errors).toEqual([]);
});

test('daily note and template commands', async ({ page, ws }) => {
  fs.mkdirSync(path.join(ws.root, 'templates'), { recursive: true });
  await ws.write('templates/Meeting.md', '## Meeting {{title}} on {{date}}\n');
  await boot(page, ws);

  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await runFromPalette(page, "today's daily note");
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.activePath.value)).toBe(`daily/${today}.md`);
  expect(await ws.read(`daily/${today}.md`)).toBe(`# ${today}\n\n`);

  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  await page.keyboard.press('Control+End');
  await runFromPalette(page, 'Insert template');
  const dlg = page.getByRole('dialog', { name: 'Insert template' });
  await expect(dlg.locator('.se-palette-item')).toHaveText([/Meeting/]);
  await expect(dlg.locator('input')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText(`Meeting ${today} on ${today}`);
});

test('light theme renders panels and graph', async ({ page, ws }) => {
  test.skip(!SHOTS, 'screenshot-only');
  await ws.write('notes/mention.md', '# Mention\n\nI should read the daily notes more often. See [[kubernetes]] and [[Deep note]].\n');
  await boot(page, ws);
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, theme: 'light' };
    document.documentElement.dataset.theme = 'light';
  });
  await openFile(page, 'notes/Daily notes.md');
  await panel(page, 'backlinks').click();
  await expect(page.locator('.se-kn-backlinks [data-section="unlinked"] .se-kn-mention')).toHaveCount(1);
  await shot(page, 'backlinks-light');
  await page.keyboard.press('Control+Alt+g');
  await expect(page.locator('canvas.se-kn-g-canvas')).toBeVisible();
  await page.waitForTimeout(1800);
  await shot(page, 'graph-light');
});
