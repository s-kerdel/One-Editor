// Connected notes: the overview's Connections section (local graph, incoming with context, outgoing,
// unlinked mentions → Link / Link all, shared tags, related), the link hover preview (editor + reading
// view, #heading sections) and the orphan / no-incoming lists. Screenshots: KNOWLEDGE_SHOTS=<dir>.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

const SHOTS = process.env.KNOWLEDGE_SHOTS;
async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), clip });
}

async function boot(page: Page, ws: WsFixture) {
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 15000 });
}
const openFile = (page: Page, p: string) => page.evaluate((f) => (window as any).__secEdit.openFile(f), p);
const active = (page: Page) => page.evaluate(() => (window as any).__secEdit.activePath.value);
const overview = (page: Page) => page.locator('aside.se-overview');
const count = (page: Page, sub: string) => overview(page).locator(`[data-sub="${sub}"] .se-cn-n`);
async function setMode(page: Page, mode: 'live' | 'source' | 'preview') {
  await page.evaluate(async (m) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ viewMode: m });
    app.editor?.setViewMode(m);
    app.events.emit('settings:changed', app.settings.value);
  }, mode);
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, theme: t };
    document.documentElement.dataset.theme = t;
  }, theme);
}
async function runFromPalette(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type(title);
  await expect(page.locator('.se-pal-item.selected')).toContainText(title);
  await page.keyboard.press('Enter');
}

test('Connections: incoming links with their line, Link turns a mention into a link and the counts follow', async ({ page, ws }) => {
  await ws.write('notes/mention.md', '# Mention\n\nI should read the daily notes more often. See [[kubernetes]] and #journal.\n');
  await boot(page, ws);
  await openFile(page, 'notes/Daily notes.md');
  await page.keyboard.press('Control+Alt+b');
  const col = overview(page);
  const sec = col.locator('[data-section="connections"]');
  await expect(sec).toBeVisible();

  // Incoming: README links here — with the line it appears in.
  await expect(col.locator('[data-sub="cn-in"] .se-ov-back .se-ov-name')).toHaveText(['README']);
  await expect(col.locator('[data-sub="cn-in"] .se-ov-back mark')).toHaveText('[[Daily notes]]');
  await expect(count(page, 'cn-in')).toHaveText('1');
  // Outgoing + shared tags (#journal is in mention.md too) + related (mention.md shares #journal).
  await expect(col.locator('[data-sub="cn-out"] .se-ov-link .se-ov-text')).toHaveText(['README']);
  await expect(col.locator('[data-sub="cn-tags"] .se-cn-tag[data-tag="journal"] .se-ov-meta')).toHaveText('1 note');
  await expect(col.locator('[data-sub="cn-related"] .se-cn-rel .se-ov-name')).toContainText(['mention']);

  // Unlinked mention → Link → it becomes a link: incoming +1, mentions -1.
  const mention = col.locator('[data-sub="cn-mentions"] .se-cn-mention');
  await expect(mention).toHaveCount(1);
  await expect(mention.locator('mark')).toHaveText('daily notes');
  await expect(count(page, 'cn-mentions')).toHaveText('1');
  await shot(page, 'connections-dark');
  await setTheme(page, 'light');
  await shot(page, 'connections-light');
  await setTheme(page, 'dark');
  await mention.getByRole('button', { name: 'Link' }).click();
  await expect.poll(() => ws.read('notes/mention.md')).toContain('read the [[Daily notes|daily notes]] more often');
  await expect(count(page, 'cn-in')).toHaveText('2');
  await expect(count(page, 'cn-mentions')).toHaveText('0');
  await expect(col.locator('[data-sub="cn-in"] .se-ov-back .se-ov-name')).toHaveText(['mention', 'README']);

  // Clicking an incoming link jumps to that line in the linking note.
  await col.locator('[data-sub="cn-in"] .se-ov-back', { hasText: 'README' }).click();
  await expect.poll(() => active(page)).toBe('README.md');
  await expect.poll(() => page.evaluate(() => (window as any).__secEdit.editor.getCursor().line)).toBe(4);
});

test('Connections: Link all, local graph click opens a note, sub-sections remember being folded', async ({ page, ws }) => {
  await ws.write('notes/a.md', '# A\n\nkubernetes is great. Also Kubernetes again.\n');
  await ws.write('notes/b.md', '# B\n\nNothing about kubernetes here… well, once.\n');
  await boot(page, ws);
  await openFile(page, 'notes/kubernetes.md');
  await page.keyboard.press('Control+Alt+b');
  const col = overview(page);
  await expect(count(page, 'cn-mentions')).toHaveText('3');
  await col.getByRole('button', { name: 'Link all' }).click();
  await expect.poll(() => ws.read('notes/a.md')).toBe('# A\n\n[[kubernetes]] is great. Also [[kubernetes|Kubernetes]] again.\n');
  await expect.poll(() => ws.read('notes/b.md')).toContain('Nothing about [[kubernetes]] here');
  await expect(count(page, 'cn-in')).toHaveText('4'); // Deep note + 2 in a.md + b.md
  await expect(count(page, 'cn-mentions')).toHaveText('0');

  // Local graph: kubernetes + Deep note, a, b. Click a node → opens it.
  const canvas = col.locator('canvas.se-cn-canvas');
  await expect(col.locator('.se-cn-graph')).toHaveAttribute('data-nodes', '4');
  await expect.poll(() => canvas.evaluate((c: any) => c.__graph.nodeScreenPos('notes/a.md'))).not.toBeNull();
  // Depth 2 reaches nothing new here; depth stays a choice.
  await col.getByRole('button', { name: '2', exact: true }).click();
  await expect(col.locator('.se-cn-graph')).toHaveAttribute('data-nodes', '4');
  await col.getByRole('button', { name: '1', exact: true }).click();
  const pos = await canvas.evaluate((c: any) => c.__graph.nodeScreenPos('deep/nested/folder/Deep note.md'));
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + pos.x, box.y + pos.y);
  await expect(col.locator('.se-cn-graph-hint')).toHaveText('Deep note');
  await shot(page, 'local-graph-dark', { ...(await col.locator('[data-section="connections"]').boundingBox())!, height: 260 });
  await page.mouse.click(box.x + pos.x, box.y + pos.y);
  await expect.poll(() => active(page)).toBe('deep/nested/folder/Deep note.md');
  await expect(col.locator('.se-cn-graph')).toHaveAttribute('data-nodes', '2');

  // Folding a sub-section survives a reload.
  await col.locator('[data-sub="cn-related"] .se-cn-toggle').click();
  await expect(col.locator('[data-sub="cn-related"] .se-cn-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await page.waitForSelector('html[data-ready="true"]');
  await openFile(page, 'notes/kubernetes.md');
  await expect(overview(page).locator('[data-sub="cn-related"] .se-cn-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(overview(page).locator('[data-sub="cn-in"] .se-cn-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('Ctrl+hover previews a linked note — its #heading section — in the editor and the reading view', async ({ page, ws }) => {
  await ws.write('notes/hover.md', '# Hover\n\nSee [[README#Commands]] and [the cheatsheet](kubernetes.md) here.\n');
  await boot(page, ws);
  await openFile(page, 'notes/hover.md');
  const pv = page.locator('.se-linkpv');
  const wiki = page.locator('.cm-content .se-wikilink', { hasText: 'README' });
  await expect(wiki).toBeVisible();
  let b = (await wiki.boundingBox())!;

  // Without Ctrl: nothing.
  await page.mouse.move(b.x + 4, b.y + b.height / 2);
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.waitForTimeout(700);
  await expect(pv).toHaveCount(0);

  // Ctrl held: the README#Commands section, not the start of README.
  await page.keyboard.down('Control');
  await page.mouse.move(b.x + 12, b.y + b.height / 2);
  await expect(pv).toBeVisible();
  await expect(pv.locator('.se-linkpv-title')).toHaveText('README');
  await expect(pv.locator('.se-linkpv-frag')).toHaveText('# Commands');
  await expect(pv.locator('.se-linkpv-body')).toContainText('git push --force-with-lease');
  await expect(pv.locator('.se-linkpv-body')).not.toContainText('fixture workspace');
  // Placed under the link, inside the window.
  const p = (await pv.boundingBox())!;
  expect(p.y).toBeGreaterThanOrEqual(b.y + b.height);
  await page.keyboard.up('Control');
  await shot(page, 'hover-preview-dark');
  await setTheme(page, 'light');
  await shot(page, 'hover-preview-light');
  await setTheme(page, 'dark');
  // Escape dismisses.
  await page.keyboard.press('Escape');
  await expect(pv).toHaveCount(0);

  // A Markdown link to a local note previews too (start of the note).
  const md = page.locator('.cm-content .se-mdlink', { hasText: 'the cheatsheet' });
  b = (await md.boundingBox())!;
  await page.keyboard.down('Control');
  await page.mouse.move(b.x + 6, b.y + b.height / 2);
  await page.mouse.move(b.x + 14, b.y + b.height / 2);
  await expect(pv.locator('.se-linkpv-title')).toHaveText('kubernetes');
  await expect(pv.locator('.se-linkpv-body')).toContainText('Kubernetes cheatsheet');
  // Moving off the link dismisses it.
  await page.mouse.move(b.x + 6, b.y - 40); // the heading above (not under: the popup is there)
  await expect(pv).toHaveCount(0);
  await page.keyboard.up('Control');

  // Ctrl+click still opens.
  await page.keyboard.down('Control');
  await page.mouse.click(b.x + 14, b.y + b.height / 2);
  await page.keyboard.up('Control');
  await expect.poll(() => active(page)).toBe('notes/kubernetes.md');

  // Reading view: same popup, same section.
  await openFile(page, 'notes/hover.md');
  await setMode(page, 'preview');
  const a = page.locator('.se-preview a.se-wikilink', { hasText: 'README' });
  await expect(a).toBeVisible();
  b = (await a.boundingBox())!;
  await page.keyboard.down('Control');
  await page.mouse.move(b.x + 4, b.y + b.height / 2);
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await expect(pv.locator('.se-linkpv-frag')).toHaveText('# Commands');
  await expect(pv.locator('.se-linkpv-body')).toContainText('git push');
  await page.keyboard.up('Control');
  await shot(page, 'hover-preview-reading-dark');
  // Scrolling dismisses.
  await page.mouse.wheel(0, 200);
  await expect(pv).toHaveCount(0);

  // Setting: preview on plain hover.
  await page.evaluate(() => {
    const app = (window as any).__secEdit;
    app.settings.value = { ...app.settings.value, 'links.hoverPreview': 'hover' };
  });
  await page.mouse.move(0, 0);
  b = (await a.boundingBox())!;
  await page.mouse.move(b.x + 4, b.y + b.height / 2);
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await expect(pv.locator('.se-linkpv-title')).toHaveText('README');
});

test('palette: "Show orphan notes" and "Show notes without incoming links" list them with counts', async ({ page, ws }) => {
  await ws.write('notes/lonely.md', '# Lonely\n\nno links at all\n');
  await boot(page, ws);
  await openFile(page, 'README.md');
  await runFromPalette(page, 'Show orphan notes');
  const p = page.locator('.se-kn-backlinks');
  const orphans = p.locator('[data-section="orphans"]');
  await expect(orphans.locator('.se-kn-section-head')).toHaveAttribute('aria-expanded', 'true');
  await expect(orphans.locator('.se-kn-out-name')).toHaveText(['lonely', 'windows-crlf']);
  await expect(orphans.locator('.se-kn-section-head .se-kn-count')).toHaveText('2');

  await runFromPalette(page, 'Show notes without incoming links');
  const none = p.locator('[data-section="noIncoming"]');
  await expect(none.locator('.se-kn-out-name')).toHaveText(['Deep note', 'lonely', 'windows-crlf']);
  await expect(none.locator('.se-kn-section-head .se-kn-count')).toHaveText('3');
  await shot(page, 'orphans-dark');
  await setTheme(page, 'light');
  await shot(page, 'orphans-light');
  await setTheme(page, 'dark');

  // Linking one updates the list; clicking a row opens it.
  await ws.write('notes/lonely.md', '# Lonely\n\nnow see [[README]]\n');
  await expect(orphans.locator('.se-kn-out-name')).toHaveText(['windows-crlf']);
  await orphans.locator('.se-kn-out', { hasText: 'windows-crlf' }).click();
  await expect.poll(() => active(page)).toBe('notes/windows-crlf.md');
});

test('on-demand index: Connections shows the note’s own links, then everything after "Build now"', async ({ page, ws }) => {
  await ws.server.service.saveSettings({ 'search.indexing': 'onDemand' } as any);
  await ws.open(page);
  await openFile(page, 'notes/Daily notes.md');
  await page.keyboard.press('Control+Alt+b');
  const col = overview(page);
  await expect(col.locator('[data-section="connections"] .se-cn-build')).toBeVisible();
  await expect(col.locator('[data-sub="cn-out"] .se-ov-link .se-ov-text')).toHaveText(['README']);
  await expect(col.locator('[data-sub="cn-tags"] .se-cn-pill')).toHaveText(['#journal', '#daily']);
  expect(await page.evaluate(() => (window as any).__secEditKnowledgeReady === true)).toBe(false);
  await shot(page, 'connections-ondemand-dark');
  await col.locator('.se-cn-build').click();
  await expect(col.locator('[data-sub="cn-in"] .se-ov-back .se-ov-name')).toHaveText(['README'], { timeout: 15000 });
  await expect(col.locator('.se-cn-build')).toHaveCount(0);
});

test('source mode: Ctrl+hover over a [[link]] previews it too', async ({ page, ws }) => {
  await ws.write('notes/hover.md', '# Hover\n\nSee [[kubernetes]] here.\n');
  await boot(page, ws);
  await setMode(page, 'source');
  await openFile(page, 'notes/hover.md');
  await expect(page.locator('.cm-content')).toContainText('[[kubernetes]]');
  const pt = await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    const c = view.coordsAtPos(view.state.doc.toString().indexOf('[[kubernetes') + 5);
    return { x: c.left + 2, y: (c.top + c.bottom) / 2 };
  });
  await page.keyboard.down('Control');
  await page.mouse.move(pt.x - 3, pt.y);
  await page.mouse.move(pt.x, pt.y);
  await expect(page.locator('.se-linkpv .se-linkpv-title')).toHaveText('kubernetes');
  await expect(page.locator('.se-linkpv .se-linkpv-body')).toContainText('Kubernetes cheatsheet');
  await page.keyboard.up('Control');
});

test('classic sidebar style, both themes (screenshots)', async ({ page, ws }) => {
  test.skip(!SHOTS, 'screenshot-only');
  await ws.server.service.saveSettings({ sidebarStyle: 'classic' });
  await ws.write('notes/mention.md', '# Mention\n\nI should read the daily notes more often. See [[kubernetes]] and #journal.\n');
  await boot(page, ws);
  await openFile(page, 'notes/Daily notes.md');
  await page.keyboard.press('Control+Alt+b');
  await expect(overview(page).locator('[data-sub="cn-mentions"] .se-cn-mention')).toHaveCount(1);
  await page.waitForTimeout(300);
  await shot(page, 'connections-classic-dark');
  await setTheme(page, 'light');
  await page.waitForTimeout(200);
  await shot(page, 'connections-classic-light');
});
