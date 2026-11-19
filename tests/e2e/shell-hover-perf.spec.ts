// Hovering the file tree must be cheap (user report: hovering folders / files raised CPU noticeably):
// no hover transitions (each one animates ~6 frames of style + paint + raster per row change) and no
// layout (the shelf's folder icon ↔ chevron swap must not toggle `display`). The baseline sweeps the same
// pixels at the same pace with rows that ignore the pointer. Counts, not CPU: deterministic.
// tests/e2e/electron/perf-hover.spec.ts measures CPU with a real pointer in the desktop app.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { CDPSession, Page } from '@playwright/test';
import { test, expect, type WsFixture } from './harness';

async function setup(page: Page, ws: WsFixture, style: 'shelf' | 'classic') {
  for (let i = 0; i < 20; i++) {
    await fsp.mkdir(path.join(ws.root, 'many', `folder-${i}`), { recursive: true });
    await ws.write(`many/folder-${i}/a.md`, '# a\n');
  }
  for (let i = 0; i < 30; i++) await ws.write(`many/note-${i}.md`, `# note ${i}\n`);
  await ws.server.service.saveSettings({ sidebarStyle: style });
  await ws.open(page);
  await page.locator('.se-tree-row.dir[data-path="many"]').click();
  await expect(page.locator('.se-tree-row[data-path="many/folder-0"]')).toHaveCount(1);
}

const metrics = async (cdp: CDPSession) => {
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const get = (n: string) => m.find((x) => x.name === n)!.value;
  return { style: get('RecalcStyleCount'), layout: get('LayoutCount') };
};

/** Pointer back and forth over the visible `items` of `within` (rows: vertically, tabs: horizontally, near
 *  their top edge, clear of the close buttons); returns the work done and how often the item under it changed. */
async function sweep(page: Page, cdp: CDPSession, o: { within: string; items: string; css: string }) {
  await page.evaluate((css) => {
    document.getElementById('se-hover-test')?.remove();
    document.head.append(Object.assign(document.createElement('style'), { id: 'se-hover-test', textContent: css }));
  }, o.css);
  const { boxes, vertical } = await page.locator(o.within).evaluate((box, sel) => {
    const v = box.getBoundingClientRect();
    const all = [...box.querySelectorAll(sel)].map((r) => r.getBoundingClientRect()).filter((r) => r.bottom <= v.bottom && r.right <= v.right && r.width > 0);
    const vertical = all.length > 1 && all[1].top > all[0].top;
    return { vertical, boxes: all.map((r) => (vertical ? { at: r.left + 60, from: r.top, to: r.bottom } : { at: r.top + 5, from: r.left, to: r.right })) };
  }, o.items);
  const steps: number[] = [];
  for (let p = boxes[0].from + 2; p < boxes.at(-1)!.to - 2; p += 4) steps.push(p);
  const path = [...steps, ...steps.slice().reverse()];
  const move = (p: number) => (vertical ? page.mouse.move(boxes[0].at, p) : page.mouse.move(p, boxes[0].at));
  await move(path[0]);
  await page.waitForTimeout(400); // the first hover settles before counting
  const before = await metrics(cdp);
  let changes = 0;
  let last = -1;
  for (const p of path) {
    await move(p);
    await page.waitForTimeout(8);
    const i = boxes.findIndex((b) => p >= b.from && p < b.to);
    if (i !== last) (changes += last === -1 ? 0 : 1), (last = i);
  }
  await page.waitForTimeout(400); // a running transition would still tick here
  const after = await metrics(cdp);
  return { style: after.style - before.style, layout: after.layout - before.layout, changes, items: boxes.length };
}

/** Hover vs. baseline (same sweep, items ignore the pointer): one style pass per change at most, no layout. */
async function expectCheapHover(page: Page, label: string, within: string, items: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const base = await sweep(page, cdp, { within, items, css: `${items} { pointer-events: none !important; }` });
  const hover = await sweep(page, cdp, { within, items, css: '' });
  console.log(`[hover] ${label}: ${hover.items} items, ${hover.changes} changes — style passes ${hover.style} (baseline ${base.style}), layouts ${hover.layout} (baseline ${base.layout})`);
  expect(hover.changes).toBeGreaterThan(2 * hover.items - 4);
  expect(hover.layout - base.layout, 'layouts caused by hover').toBeLessThanOrEqual(2);
  expect(hover.style - base.style, 'style passes caused by hover').toBeLessThanOrEqual(Math.ceil(hover.changes * 1.5) + 4);
  return hover;
}

for (const style of ['shelf', 'classic'] as const) {
  test(`${style}: hovering tree rows costs one style pass per row change, no layout, no animation`, async ({ page, ws }) => {
    await setup(page, ws, style);
    const r = await expectCheapHover(page, `${style} tree`, '.se-tree', '.se-tree-row');
    expect(r.items).toBeGreaterThan(15);
    // The hover feedback itself is unchanged (now instant): shelf folders swap their icon for the
    // disclosure chevron in the same spot; note rows hint their extension.
    const dir = page.locator('.se-tree-row.dir[data-path="many/folder-3"]');
    const look = () =>
      dir.evaluate((row) => {
        const vis = (sel: string) => {
          const el = row.querySelector(sel);
          return el ? getComputedStyle(el).visibility : 'absent';
        };
        const center = (sel: string) => {
          const r = row.querySelector(sel)?.getBoundingClientRect();
          return r ? `${r.x + r.width / 2},${r.y + r.height / 2}` : null;
        };
        return { folder: vis('.se-ficon-folder'), chev: vis('.se-tree-chev'), sameBox: center('.se-tree-lead > .se-ficon-folder') === center('.se-tree-lead > .se-tree-chev') };
      });
    await page.mouse.move(5, 5);
    expect(await look()).toEqual(style === 'shelf' ? { folder: 'visible', chev: 'hidden', sameBox: true } : { folder: 'visible', chev: 'absent', sameBox: false });
    await dir.hover();
    expect(await look()).toEqual(style === 'shelf' ? { folder: 'hidden', chev: 'visible', sameBox: true } : { folder: 'visible', chev: 'absent', sameBox: false });
    const note = page.locator('.se-tree-row[data-path="many/note-0.md"]');
    await note.scrollIntoViewIfNeeded();
    await note.hover();
    const ext = await note.locator('.se-tree-ext').evaluate((e) => getComputedStyle(e).opacity);
    expect(ext).toBe(style === 'shelf' ? '0.8' : '1');
  });
}

test('hovering tabs: one style pass per tab change, no layout, no animation', async ({ page, ws }) => {
  await setup(page, ws, 'shelf');
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await (window as any).__secEdit.openFile(`many/note-${i}.md`);
  });
  await expect(page.locator('.se-tab')).toHaveCount(8);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // no caret blink in the counts
  await expectCheapHover(page, 'tabs', '.se-tabs', '.se-tab');
});
