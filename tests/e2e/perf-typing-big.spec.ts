// Typing in a 1 MB note stays smooth with the busy panels open: a live search-panel query (it
// refreshes as the index changes), the file overview (links, outline, stats of that note) and the
// knowledge index re-extracting it. Before: p95 424 ms (Electron), every panel recomputing per edit.
import { test, expect } from './harness';
import { cpuLoadMeter, describeLoad, skipIfBusy } from './cpu-load';
// @ts-expect-error plain .mjs helper without types
import { noteContent } from '../perf/gen-workspace.mjs';

test('typing in a 1 MB note with search, overview and knowledge live: p95 key→frame stays low', async ({ page, ws }) => {
  test.setTimeout(120_000);
  await ws.write('notes/huge-1mb.md', noteContent(5, 2000, 1_000_000));
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 30000 });
  await page.evaluate(() => ((window as any).__secEdit.sidebarPanel.value = 'search'));
  await page.getByLabel('Search query').fill('rollback');
  await expect(page.locator('.se-search-summary')).toContainText('result');
  await page.keyboard.press('Control+Alt+b'); // file overview
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/huge-1mb.md'));
  await page.waitForFunction(() => ((window as any).__secEdit.editor?.getContent('notes/huge-1mb.md')?.length ?? 0) > 900_000, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const w = window as any;
    w.__kt = [];
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' });
    addEventListener('keydown', () => {
      const s = performance.now();
      requestAnimationFrame(() => setTimeout(() => w.__kt.push(performance.now() - s), 0));
    }, true);
  });
  const meter = cpuLoadMeter();
  await page.keyboard.type(' typing latency check in a one megabyte note with the panels open', { delay: 30 });
  const load = meter.stop();
  await page.waitForTimeout(2500); // debounced consumers (index, overview, knowledge, autosave) run
  const r = await page.evaluate(() => {
    const w = window as any;
    const t = (w.__kt as number[]).slice().sort((a, b) => a - b);
    const q = (p: number) => Math.round(t[Math.min(t.length - 1, Math.floor(t.length * p))]);
    return { keys: t.length, median: q(0.5), p95: q(0.95), max: q(1), longTasks: (w.__lt as number[]).length, longest: Math.max(0, ...(w.__lt as number[])) };
  });
  console.log(`[perf-typing-big] 1 MB note, search + overview + knowledge live: ${JSON.stringify(r)}; ${describeLoad(load)}`);
  expect(r.keys).toBeGreaterThan(40);
  skipIfBusy(load, '1 MB typing');
  // Generous for a loaded CI box: on an idle machine median ~12 ms, p95 ~20 ms.
  expect(r.median, 'median key→frame').toBeLessThan(40);
  expect(r.p95, 'p95 key→frame').toBeLessThan(100);
});
