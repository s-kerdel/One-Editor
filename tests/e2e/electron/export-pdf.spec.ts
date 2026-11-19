// "Export note to PDF…" in the real Electron app: hidden-window printToPDF, save-dialog stub, page setup,
// remembered folder, and the hidden window's lockdown (no script, no file access).
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, fs, path } from './fixture';
import { makePng, readPdf, renderPage } from './pdf-helpers';

const SHOTS = process.env.SEC_EDIT_SHOTS || '';

const REPORT = `---
author: Ada
tags: [report, pdf]
---

# Quarterly Report

A paragraph with **bold**, *italic*, \`inline code\`, a [link](https://example.com) and inline math $E = mc^2$ in the middle of the sentence, long enough to wrap onto a second line of the page.

## Highlights

- Revenue grew in every region
- Churn went down
  - nested bullet point

- [x] Ship the exporter
- [ ] Write the release notes

| Region | Owner | Revenue |
|---|---|---:|
| North | Alice | 1,200 |
| South | Bob | 980 |
| East | Chandra | 1,510 |

\`\`\`php
<?php
function greetUser(string $name): string {
    // A comment that is long enough to need wrapping when printed on paper, instead of being cut off at the margin.
    return "Hello, {$name}!";
}
\`\`\`

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

![Sales chart](img/chart.png)

> [!warning] Heads up
> Callout body text survives the export.

\`\`\`mermaid
graph LR
  Draft --> Review --> Published
\`\`\`

\\pagebreak

## Appendix

Second page content.
`;

async function writeReport(ws: string) {
  await fsp.mkdir(path.join(ws, 'export', 'img'), { recursive: true });
  await fsp.writeFile(path.join(ws, 'export', 'Report.md'), REPORT);
  // A gradient, so a missing image (blank box) and a present one are easy to tell apart in the PNG.
  await fsp.writeFile(path.join(ws, 'export', 'img', 'chart.png'), makePng(320, 120, (x, y) => [40 + ((x * 180) / 320) | 0, 90 + ((y * 100) / 120) | 0, 200]));
}

async function runCommand(page: Page, title: string) {
  await page.keyboard.press('Control+Shift+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
}

const openNote = (page: Page, p: string) => page.evaluate((x) => (window as any).__secEdit.openFile(x), p);
const saveSettings = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate(async (p) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings(p);
  }, patch);

test('exports a rich note to a real PDF next to the note', async ({ el }) => {
  await writeReport(el.ws);
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_SAVE_PATH: 'default' } });
  await openNote(page, 'export/Report.md');
  await expect(page.locator('.se-tab.active')).toContainText('Report.md');
  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: 'Exported to export/Report.pdf' })).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.se-toast', { hasText: 'Exported to' }).getByRole('button', { name: 'Open' })).toBeVisible();
  // Written through the workspace → the tree knows it at once.
  await expect(page.locator('.se-tree-row', { hasText: 'Report.pdf' })).toBeVisible();

  const file = path.join(el.ws, 'export', 'Report.pdf');
  expect(fs.readFileSync(file).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pdf = await readPdf(file);
  expect(pdf.pages).toBeGreaterThanOrEqual(2); // \pagebreak before the appendix
  expect(Math.round(pdf.size[0])).toBe(595); // A4 portrait in points
  expect(Math.round(pdf.size[1])).toBe(842);
  const all = pdf.text.join('\n');
  expect(all).not.toContain('author'); // frontmatter properties stay out of the document
  for (const s of ['Quarterly Report', 'Highlights', 'Revenue grew', 'Ship the exporter', 'Region', 'Chandra', '1,510', 'greetUser', 'Hello', 'Heads up', 'Callout body text', 'Review']) expect(all, s).toContain(s);
  expect(all).toMatch(/cut\s+off\s+at\s+the\s+margin/); // long code line wrapped, not clipped
  expect(all).toContain('∫'); // block math (MathML)
  expect(pdf.text[0]).toContain(`1 / ${pdf.pages}`); // footer page numbers
  expect(pdf.text[pdf.pages - 1]).toContain('Appendix');
  expect(pdf.text[0]).not.toContain('Appendix');
  expect(pdf.images).toBeGreaterThanOrEqual(1); // the workspace PNG was inlined and painted
  expect(pdf.links).toContain('https://example.com/'); // links stay clickable
  expect(pdf.outline).toEqual(expect.arrayContaining(['Quarterly Report', 'Highlights', 'Appendix'])); // bookmarks

  if (SHOTS) {
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.copyFileSync(file, path.join(SHOTS, 'Report.pdf'));
    for (let i = 1; i <= pdf.pages; i++) await renderPage(file, i, path.join(SHOTS, `pdf-page${i}.png`));
  }
});

test('page setup from settings, cancel, and the remembered folder', async ({ el }) => {
  await writeReport(el.ws);
  const outDir = path.join(el.tmp, 'pdf-out');
  await fsp.mkdir(outDir);
  const { app, page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_SAVE_PATH: 'cancel' } });
  await openNote(page, 'export/Report.md');
  await expect(page.locator('.se-tab.active')).toContainText('Report.md');

  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: 'PDF export cancelled' })).toBeVisible({ timeout: 30000 });
  expect(fs.existsSync(path.join(el.ws, 'export', 'Report.pdf'))).toBe(false);

  // Letter, narrow margins, no page numbers; saved outside the workspace (extension added).
  await saveSettings(page, { 'export.pdfPageSize': 'Letter', 'export.pdfMargins': 'narrow', 'export.pdfPageNumbers': false });
  await app.evaluate((_e, p) => void (process.env.SEC_EDIT_TEST_SAVE_PATH = p), path.join(outDir, 'custom'));
  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: `Exported to ${path.join(outDir, 'custom.pdf')}` })).toBeVisible({ timeout: 30000 });
  const pdf = await readPdf(path.join(outDir, 'custom.pdf'));
  expect(pdf.size.map(Math.round)).toEqual([612, 792]);
  expect(pdf.text[0]).not.toMatch(/\b1 \/ \d/);

  // Next export suggests the folder chosen last time.
  await app.evaluate(() => void (process.env.SEC_EDIT_TEST_SAVE_PATH = 'default'));
  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: `Exported to ${path.join(outDir, 'Report.pdf')}` })).toBeVisible({ timeout: 30000 });
  expect(fs.existsSync(path.join(outDir, 'Report.pdf'))).toBe(true);
});

test('editor and tab menus offer the export; works from reading view', async ({ el }) => {
  await writeReport(el.ws);
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_SAVE_PATH: 'default' } });
  await openNote(page, 'export/Report.md');
  await page.locator('.cm-content').click({ button: 'right' });
  await expect(page.locator('.se-menu-item', { hasText: 'Export to PDF…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await saveSettings(page, { viewMode: 'preview' });
  await page.evaluate(() => (window as any).__secEdit.editor?.setViewMode('preview'));
  await expect(page.locator('.se-preview h1')).toContainText('Quarterly Report');
  await page.locator('.se-tab.active').click({ button: 'right' });
  await page.locator('.se-menu-item', { hasText: 'Export to PDF…' }).click();
  await expect(page.locator('.se-toast', { hasText: 'Exported to export/Report.pdf' })).toBeVisible({ timeout: 30000 });
});

const para = (n: number) => `Paragraph ${n}: ${'Plain words that fill the line and wrap like real prose would on paper. '.repeat(3)}`;
const LONG = [
  '# Pagination check',
  ...Array.from({ length: 5 }, (_, s) => [`## Section ${s + 1}`, ...Array.from({ length: 4 + s }, (_, i) => para(s * 10 + i))]).flat(),
  ['```ts', ...Array.from({ length: 70 }, (_, i) => `const line${i} = compute(${i}); // ${'x'.repeat(i % 3 ? 10 : 140)}`), '```'].join('\n'),
  [
    '| Col A | Col B | Col C | A rather long header | E | F | G | H |',
    '|---|---|---|---|---|---|---|---|',
    ...Array.from({ length: 60 }, (_, i) => `| a${i} | b${i} | c${i} | ${i % 7 ? 'short' : 'a much longer cell that has to wrap inside its column'} | e | f | g | https://example.com/a/very/long/url/that/must/not/overflow/${i} |`),
  ].join('\n'),
  '### Final words',
  'The end.',
].join('\n\n');

test('long notes paginate cleanly: code splits, table header repeats, no orphaned headings', async ({ el }) => {
  await fsp.writeFile(path.join(el.ws, 'Long.md'), LONG);
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_SAVE_PATH: 'default' } });
  await openNote(page, 'Long.md');
  await runCommand(page, 'Export note to PDF');
  await expect(page.locator('.se-toast', { hasText: 'Exported to Long.pdf' })).toBeVisible({ timeout: 30000 });
  const file = path.join(el.ws, 'Long.pdf');
  const pdf = await readPdf(file);
  if (SHOTS) for (let i = 1; i <= pdf.pages; i++) await renderPage(file, i, path.join(SHOTS, `long-page${i}.png`), 1);
  expect(pdf.pages).toBeGreaterThanOrEqual(4);
  const pagesWith = (s: string) => pdf.text.map((t, i) => (t.includes(s) ? i : -1)).filter((i) => i >= 0);
  // A 70-line block is allowed to split (no half-empty page in front of it).
  expect(pagesWith('line0 ')[0]).not.toBe(pagesWith('line69 ')[0]);
  // The table header repeats on every page the table spans.
  const tablePages = new Set([...pagesWith(' a0 '), ...pagesWith(' a59 ')]);
  expect(pagesWith('A rather long header').length).toBeGreaterThanOrEqual(Math.max(...tablePages) - Math.min(...tablePages) + 1);
  expect(pdf.text.join(' ')).toMatch(/must\/not\/over\s*fl\s*ow\/59/); // long URL wrapped inside its cell ("fl" is a ligature)
  // A heading is never the last thing on a page (footer excluded).
  for (const [i, items] of pdf.items.entries()) {
    const body = items.filter((it) => it.y < pdf.size[1] - 50); // the footer lives in the bottom margin
    const last = body[body.length - 1]?.str ?? '';
    expect(last, `page ${i + 1} ends with a heading`).not.toMatch(/^(Section \d|Final words|Pagination check)/);
  }
});

test('hidden print window: no script, no file or app access, IPC input validated', async ({ el }) => {
  await writeReport(el.ws);
  await fsp.writeFile(path.join(el.tmp, 'secret.txt'), 'TOP-SECRET-CONTENT');
  const out = path.join(el.tmp, 'evil.pdf');
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_SAVE_PATH: out } });
  const secretUrl = 'file://' + path.join(el.tmp, 'secret.txt');
  // Bypass the renderer's sanitizer on purpose: the main process must hold the line by itself.
  const html =
    `<!doctype html><html><head><title>x</title></head><body><h1>Visible heading</h1>` +
    `<script>document.write('SCRIPT-RAN')</script><img src=x alt="" onerror="document.write('ONERROR-RAN')">` +
    `<iframe src="${secretUrl}"></iframe><object data="${secretUrl}"></object><embed src="${secretUrl}">` +
    `<iframe src="app://sec-edit/index.html"></iframe><img alt="" src="app://sec-edit/__ws/export/img/chart.png">` +
    `<link rel="stylesheet" href="${secretUrl}"><meta http-equiv="refresh" content="0;url=${secretUrl}"></body></html>`;
  const call = (args: unknown[]) => page.evaluate(([m, a]) => (window as any).secEditBridge.invoke(m, a), ['exportPdf', args] as const);
  const r = await call([{ path: 'export/Report.md', html, pageSize: 'A4', margins: 'normal', pageNumbers: false }]);
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const pdf = await readPdf(out);
  const text = pdf.text.join(' ');
  expect(text).toContain('Visible heading');
  for (const bad of ['SCRIPT-RAN', 'ONERROR-RAN', 'TOP-SECRET', 'sec-edit']) expect(text).not.toContain(bad);
  expect(pdf.images).toBe(0);

  const bad = async (req: Record<string, unknown>, code: string) => {
    const res = await call([{ path: 'export/Report.md', html: '<p>x</p>', pageSize: 'A4', margins: 'normal', pageNumbers: true, ...req }]);
    expect(res.ok, JSON.stringify(req)).toBe(false);
    expect(res.error.code).toBe(code);
  };
  await bad({ path: 'code/app.ts' }, 'EINVAL');
  await bad({ path: '../outside.md' }, 'OUTSIDE_WORKSPACE');
  await bad({ path: path.join(el.ws, 'export', 'Report.md') }, 'OUTSIDE_WORKSPACE');
  await bad({ pageSize: 'A0' }, 'EINVAL');
  // Only files this session exported may be opened / revealed.
  const show = await page.evaluate((p) => (window as any).secEditBridge.invoke('showExportedFile', [p, 'open']), path.join(el.tmp, 'secret.txt'));
  expect(show.ok).toBe(false);
  expect(show.error.code).toBe('EACCES');
  // The app window is untouched.
  expect(await page.evaluate(() => location.href)).toMatch(/^app:\/\/sec-edit\//);
});
