// Regression: clicking a line in live preview must put the cursor on that line, also below block widgets
// (properties, tables, math, embeds) and decorated lines (headings, callouts, code blocks). Block widgets
// with vertical margins used to desync CodeMirror's height map (margins aren't measured), so clicks in the
// lower part of a line landed on the line below.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { openNote, shot } from './editor-helpers';

const NOTE = [
  '---',
  'title: Click test',
  'tags: [alpha, beta]',
  'status: draft',
  '---',
  '',
  'Para after props alpha.',
  'Second line after props bravo.',
  '',
  '# Heading charlie',
  '',
  'Para after heading delta.',
  '',
  '## Second heading echo',
  'Para under h2 foxtrot.',
  '',
  '> [!note] Callout golf',
  '> Callout body hotel.',
  '',
  'Para after callout india.',
  '',
  '> A plain quote juliet.',
  '',
  '| A | B |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Para after table kilo.',
  '',
  '```js',
  'const lima = 1;',
  '```',
  '',
  'Para after code mike.',
  '',
  '$$',
  'x^2 + y^2',
  '$$',
  '',
  'Para after math november.',
  '',
  '![[README]]',
  '',
  'Para after embed oscar.',
  '',
  '- list papa',
  '- [ ] task quebec',
  '',
  'Inline math $e^{i\\pi} + 1 = 0$ sierra and **bold tango** and [link uniform](https://example.com).',
  '',
  'Para end romeo.',
].join('\n');

const NEEDLES = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'sierra', 'romeo'];

/** Scrolls the line containing `needle` to the middle of the editor and returns its DOM rect. */
async function lineRect(page: Page, needle: string) {
  await page.evaluate((n) => {
    const view = (window as any).__secEdit.editor.getView();
    const pos = view.state.doc.toString().indexOf(n);
    view.dispatch({ effects: view.constructor.scrollIntoView(pos, { y: 'center' }) });
  }, needle);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return page.evaluate((n) => {
    const line = [...document.querySelectorAll<HTMLElement>('.cm-content > .cm-line')].find((l) => l.textContent?.includes(n));
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, width: r.width };
  }, needle);
}

const cursorLineText = (page: Page) =>
  page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    return view.state.doc.lineAt(view.state.selection.main.head).text as string;
  });

test('clicks near the top and bottom edge of a line land on that line (live preview)', async ({ page, ws }) => {
  await ws.write('notes/click-test.md', NOTE);
  await ws.open(page);
  await openNote(page, 'notes/click-test.md', 'Para after props alpha');
  await page.screenshot({ path: shot('click-test-live.png') });
  // Async content must have settled: KaTeX, the embed body.
  await lineRect(page, 'november');
  await expect(page.locator('.se-math-block .katex').first()).toBeVisible();
  await lineRect(page, 'oscar');
  await expect(page.locator('.se-note-embed-body:not(.is-loading)').first()).toBeVisible();

  const misses: string[] = [];
  for (const needle of NEEDLES) {
    for (const edge of ['top', 'bottom'] as const) {
      const r = await lineRect(page, needle);
      expect(r, `line ${needle} rendered`).not.toBeNull();
      const y = edge === 'top' ? r!.top + 2 : r!.bottom - 2;
      await page.mouse.click(r!.left + Math.min(40, r!.width / 2), y);
      const text = await cursorLineText(page);
      if (!text.includes(needle)) misses.push(`${needle}@${edge} → "${text}"`);
    }
  }
  expect(misses).toEqual([]);
});

test('no vertical jump when the cursor enters/leaves lines with hidden syntax', async ({ page, ws }) => {
  await ws.write('notes/click-test.md', NOTE);
  await ws.open(page);
  await page.setViewportSize({ width: 1360, height: 2400 }); // whole note in the viewport
  await openNote(page, 'notes/click-test.md', 'Para end romeo');
  await expect(page.locator('.se-math-block .katex').first()).toBeVisible();
  // Heights of every line before/after putting the cursor on lines with hidden markup.
  const heights = () =>
    page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.cm-content > .cm-line')].map((l) => Math.round(l.getBoundingClientRect().height)));
  await page.evaluate(() => (window as any).__secEdit.editor.focus());
  const base = await heights();
  // Cursor inside headings, callout title, quote, list, task, code block, inline math, bold, link.
  for (const needle of ['charlie', 'echo', 'golf', 'juliet', 'papa', 'quebec', 'lima', 'e^{i', 'tango', 'uniform']) {
    await page.evaluate((n) => {
      const view = (window as any).__secEdit.editor.getView();
      const doc: string = view.state.doc.toString();
      view.dispatch({ selection: { anchor: doc.indexOf(n) } });
      view.focus();
    }, needle);
    await page.waitForTimeout(50);
    const now = await heights();
    expect(now.length, `line count stable with cursor on ${needle}`).toBe(base.length);
    expect(now, `line heights stable with cursor on ${needle}`).toEqual(base);
  }
});
