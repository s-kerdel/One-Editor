// Leak guard: 50 cycles of everyday churn (open/close tabs, palette, settings, graph, file overview,
// view modes, sidebar panels, a search) must not grow the heap or the DOM. Heap is measured after a
// forced GC (CDP), compared between cycle 10 (everything lazy is loaded by then) and cycle 50.
import type { Page } from '@playwright/test';
import { test, expect } from './harness';

const press = async (page: Page, key: string, ms = 50) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(ms);
};

async function cycle(page: Page, notes: string[], i: number) {
  for (const n of notes) await page.evaluate((p) => (window as any).__secEdit.openFile(p), n);
  await page.waitForTimeout(60);
  await page.evaluate(async (list) => {
    for (const p of list) await (window as any).__secEdit.closeTab(p);
  }, notes);
  await press(page, 'Control+Shift+p', 100);
  await page.keyboard.type('toggle');
  await press(page, 'Escape');
  await press(page, 'Control+,', 120);
  await press(page, 'Escape');
  await press(page, 'Control+Alt+g', 200);
  await press(page, 'Escape');
  await page.evaluate((p) => (window as any).__secEdit.openFile(p), notes[0]);
  await page.waitForTimeout(60);
  await press(page, 'Control+Alt+b', 100);
  await press(page, 'Control+e', 120);
  await press(page, 'Control+e', 120);
  await press(page, 'Control+Alt+b', 60);
  await page.evaluate(async (q) => {
    const a = (window as any).__secEdit;
    for (const id of ['search', 'outline', 'backlinks', 'tags', 'files']) {
      a.sidebarPanel.value = id;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 15)));
    }
    await (window as any).__secEditSearch.search(q, {}, 'leak');
  }, ['needle', 'kubectl', 'daily', 'welcome'][i % 4]);
  await page.evaluate((p) => (window as any).__secEdit.closeTab(p), notes[0]);
}

test('50 churn cycles leave the heap and the DOM where they were', async ({ page, ws }) => {
  test.setTimeout(180_000);
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 20000 });
  const notes = (await page.evaluate(() => (window as any).__secEdit.files.value.filter((f: string) => f.endsWith('.md')))).slice(0, 5);
  expect(notes.length).toBeGreaterThan(2);
  const cdp = await page.context().newCDPSession(page);
  const measure = async () => {
    await page.waitForTimeout(400);
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize;
    const dom = await page.evaluate(() => document.getElementsByTagName('*').length);
    return { heap, dom };
  };
  for (let i = 1; i <= 10; i++) await cycle(page, notes, i);
  const at10 = await measure();
  for (let i = 11; i <= 50; i++) await cycle(page, notes, i);
  const at50 = await measure();
  const perCycleKB = (at50.heap - at10.heap) / 40 / 1024;
  console.log(`[perf-leaks] heap after GC: cycle 10 ${(at10.heap / 1048576).toFixed(1)} MB → cycle 50 ${(at50.heap / 1048576).toFixed(1)} MB (${perCycleKB.toFixed(1)} KB/cycle); DOM ${at10.dom} → ${at50.dom} nodes`);
  // A real leak (a listener / view / state kept per cycle) is hundreds of KB per cycle; allow noise.
  expect(perCycleKB, 'heap growth per cycle').toBeLessThan(60);
  expect(at50.dom - at10.dom, 'DOM growth').toBeLessThan(50);
});
