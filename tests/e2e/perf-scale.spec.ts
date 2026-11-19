// Scale guard: a 12k-file workspace (10k notes + 2k code files) must stay interactive.
// Measures time to interactive, file tree scrolling, quick open, search + knowledge index builds,
// main-thread long tasks, typing latency with every panel live, and memory.
// The workspace is generated (deterministically) under .tmp/perf/big-e2e — see tests/perf/gen-workspace.mjs.
// Tune with SEC_EDIT_PERF_NOTES / SEC_EDIT_PERF_CODE; set SEC_EDIT_PERF_SKIP_SCALE=1 to skip.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, RENDERER_DIR } from './harness';
import { startServer, type RunningServer } from '../../src/server/server';
// @ts-expect-error plain .mjs helper without types
import { generate, noteContent, noteName } from '../perf/gen-workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES = Number(process.env.SEC_EDIT_PERF_NOTES ?? 10000);
const CODE = Number(process.env.SEC_EDIT_PERF_CODE ?? 2000);
const BIG = path.join(ROOT, '.tmp/perf', `big-e2e-${NOTES}-${CODE}`);

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.SEC_EDIT_PERF_SKIP_SCALE, 'scale tests disabled');

let server: RunningServer;

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(BIG, 'README.md'))) generate(BIG, NOTES, CODE);
  // The typing test edits this note (autosave): always start from the pristine 20 KB version.
  await fsp.writeFile(path.join(BIG, 'notes/big-note.md'), noteContent(NOTES + 1, NOTES, 20000));
  // Fresh config per run (no restored session); the workspace itself is only read, except big-note.md.
  const configDir = path.join(ROOT, '.tmp/perf', `config-${process.pid}-${Date.now()}`);
  await fsp.mkdir(configDir, { recursive: true });
  server = await startServer({ root: BIG, port: 0, rendererDir: RENDERER_DIR, configDir });
});
test.afterAll(async () => {
  await server?.close();
});

/** Collect long tasks + paint timing from the very first script on. */
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__longTasks = [] as Array<{ start: number; duration: number }>;
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__longTasks.push({ start: Math.round(e.startTime), duration: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true });
    } catch {}
  });
}

const longTasks = (page: Page) => page.evaluate(() => (window as any).__longTasks as Array<{ start: number; duration: number }>);
const firstPaint = (page: Page) => page.evaluate(() => Math.round(performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint')?.startTime ?? 0));

/** Longest gap between animation frames while `fn` runs in the page (main-thread smoothness). */
async function maxFrameGap(page: Page, ms: number): Promise<number> {
  return page.evaluate(
    (dur) =>
      new Promise<number>((resolve) => {
        let last = performance.now();
        let max = 0;
        const end = last + dur;
        const tick = () => {
          const t = performance.now();
          max = Math.max(max, t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else resolve(Math.round(max));
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );
}

test(`big workspace (${NOTES} notes + ${CODE} code files): launch, tree, quick open, indexes, long tasks`, async ({ page }) => {
  test.setTimeout(180_000);
  await instrument(page);
  const t0 = Date.now();
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  const wallReady = Date.now() - t0;
  const timings = await page.evaluate(() => (window as any).__secEditTimings as Record<string, number>);
  const fcp = await firstPaint(page);
  await expect(page.locator('.se-tree-row').first()).toBeVisible();
  const files = await page.evaluate(() => (window as any).__secEdit.files.value.length);
  expect(files).toBeGreaterThanOrEqual(NOTES + CODE);

  // ---- indexes build in the background: wait for both, tracking frame gaps meanwhile ----
  const gapWhileIndexing = await maxFrameGap(page, 3000);
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 120000 });
  const search = await page.evaluate(() => {
    const c = (window as any).__secEditSearch;
    return { indexed: c.indexed.value, workerMs: Math.round(c.indexMs.value), readyAt: Math.round(performance.now()), mode: c.mode.value };
  });
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 120000 });
  const knowledgeReadyAt = await page.evaluate(() => Math.round(performance.now()));

  // ---- file tree: open a few folders (100+ rows), then fling-scroll through it ----
  // Expand a few large folders by clicking (real interaction), then measure scroll frame times.
  await page.locator('.se-tree-row[data-path="notes"]').click(); // by path: rows also show a child-count badge
  await page.locator('.se-tree-row', { hasText: 'area-00' }).first().click();
  // Bottom-up, so the next folder to open is still inside the virtualized window.
  for (const t of ['topic-05', 'topic-04', 'topic-03', 'topic-02', 'topic-01', 'topic-00']) await page.locator('.se-tree-row', { hasText: t }).first().click();
  const scroll = await page.evaluate(
    () =>
      new Promise<{ rowsInDom: number; scrollHeight: number; maxGap: number; frames: number }>((resolve) => {
        const el = [...document.querySelectorAll<HTMLElement>('.se-tree, .se-tree *')].find((e) => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY !== 'visible')!;
        let last = performance.now();
        let max = 0;
        let frames = 0;
        const step = () => {
          const t = performance.now();
          max = Math.max(max, t - last);
          last = t;
          el.scrollTop += 480; // 20 rows per frame: a fast fling
          if (++frames < 90 && el.scrollTop + el.clientHeight < el.scrollHeight - 1) requestAnimationFrame(step);
          else resolve({ rowsInDom: document.querySelectorAll('.se-tree-row').length, scrollHeight: el.scrollHeight, maxGap: Math.round(max), frames });
        };
        requestAnimationFrame(step);
      }),
  );

  // ---- quick open: per-keystroke latency (input event → next frame) over 12k files ----
  await page.keyboard.press('Control+p');
  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  const target = noteName(Math.min(7261, NOTES - 1));
  const quickOpen: number[] = [];
  for (const ch of target.replace(' ', '')) {
    await page.keyboard.type(ch);
    quickOpen.push(
      await page.evaluate(
        () =>
          new Promise<number>((r) => {
            const s = performance.now();
            requestAnimationFrame(() => r(Math.round((performance.now() - s) * 10) / 10));
          }),
      ),
    );
  }
  await expect(page.locator('.se-pal-item').first()).toContainText(target);
  const quickOpenTyping = await page.evaluate(async (text) => {
    // In-page: set the query in one go and time handler + render to the next frame.
    const el = document.querySelector('[role="dialog"] input') as HTMLInputElement;
    const times: number[] = [];
    for (const q of ['', 'n', 'no', 'note0', text]) {
      const s = performance.now();
      el.value = q;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      times.push(Math.round((performance.now() - s) * 10) / 10);
    }
    return times;
  }, target);
  await page.keyboard.press('Enter');
  await expect(page.locator('.se-tab.active')).toContainText(target);

  // ---- search: first query through the worker ----
  const query = await page.evaluate(async () => {
    const c = (window as any).__secEditSearch;
    const s = performance.now();
    const r = await c.search('force-with-lease rollback', {}, 'probe');
    return { ms: Math.round(performance.now() - s), worker: Math.round(r.tookMs), files: r.totalFiles };
  });
  expect(query.files).toBeGreaterThan(0);

  const tasks = await longTasks(page);
  const afterPaint = tasks.filter((t) => t.start > fcp);
  const heap = await page.evaluate(() => Math.round(((performance as any).memory?.usedJSHeapSize ?? 0) / 1e6));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfterGc = Math.round(((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 1e6);

  console.log(
    `[perf-scale] files ${files} | ready ${Math.round(timings.ready)} ms (boot ${Math.round(timings.ready - timings.start)} ms, wall ${wallReady} ms), FCP ${fcp} ms\n` +
      `[perf-scale] search index: ${search.indexed} docs, worker ${search.workerMs} ms, ready at ${search.readyAt} ms (${search.mode}); first query ${query.ms} ms (worker ${query.worker} ms, ${query.files} files)\n` +
      `[perf-scale] knowledge index ready at ${knowledgeReadyAt} ms; frame gap while indexing ${gapWhileIndexing} ms\n` +
      `[perf-scale] tree: ${scroll.rowsInDom} rows in DOM, scrollHeight ${scroll.scrollHeight}px, scroll max frame gap ${scroll.maxGap} ms over ${scroll.frames} frames\n` +
      `[perf-scale] quick open: key→frame ${quickOpen.join(',')} ms; query→render ${quickOpenTyping.join(',')} ms\n` +
      `[perf-scale] long tasks after first paint: ${afterPaint.length} (max ${Math.max(0, ...afterPaint.map((t) => t.duration))} ms): ${afterPaint.map((t) => `${t.duration}@${t.start}`).join(' ')}\n` +
      `[perf-scale] heap ${heap} MB used, ${heapAfterGc} MB after GC`,
  );

  // Regression bounds (loose enough for a loaded CI box, tight enough to catch an accidental O(n²) / sync build).
  expect(timings.ready - timings.start, 'renderer boot on a 12k-file workspace').toBeLessThan(1500);
  expect(scroll.rowsInDom, 'file tree must stay virtualized').toBeLessThan(200);
  expect(scroll.maxGap, 'tree scroll frame gap').toBeLessThan(120);
  expect(Math.max(...quickOpenTyping), 'quick open query→render').toBeLessThan(250);
  expect(search.mode).toBe('worker');
  expect(Math.max(0, ...afterPaint.map((t) => t.duration)), 'longest main-thread task after first paint').toBeLessThan(400);
});

test('typing in a 20 KB note stays smooth with search, outline and backlinks live', async ({ page }) => {
  test.setTimeout(180_000);
  await instrument(page);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 120000 });
  await page.evaluate(() => (window as any).__secEdit.openFile('notes/big-note.md'));
  await expect(page.locator('.cm-content')).toContainText('Note');
  expect((await fsp.stat(path.join(BIG, 'notes/big-note.md'))).size).toBeGreaterThan(19000);

  const results: Record<string, { median: number; p95: number; max: number }> = {};
  for (const panel of ['search', 'outline', 'backlinks', 'tags']) {
    await page.locator(`.se-nav-btn[data-panel="${panel}"]`).click();
    if (panel === 'search') {
      await page.getByLabel('Search query').fill('rollback');
      await expect(page.locator('.se-search-summary')).toContainText('result');
    }
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    // keydown → next painted frame, measured in the page (excludes Playwright round-trips).
    await page.evaluate(() => {
      const w = window as any;
      w.__keyTimes = [];
      w.__keyListener ??= window.addEventListener(
        'keydown',
        () => {
          const s = performance.now();
          requestAnimationFrame(() => setTimeout(() => w.__keyTimes.push(performance.now() - s), 0));
        },
        true,
      );
    });
    await page.keyboard.type(' typing latency check with all panels live', { delay: 25 });
    await page.waitForTimeout(400); // debounced consumers (index updates, panels) run
    const times = (await page.evaluate(() => (window as any).__keyTimes as number[])).sort((a, b) => a - b);
    results[panel] = { median: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, p95: Math.round(times[Math.floor(times.length * 0.95)] * 10) / 10, max: Math.round(times[times.length - 1] * 10) / 10 };
  }
  const tasks = (await longTasks(page)).filter((t) => t.start > 0);
  console.log(
    `[perf-scale] typing 20 KB note, key→frame (median/p95/max ms): ${Object.entries(results)
      .map(([k, v]) => `${k} ${v.median}/${v.p95}/${v.max}`)
      .join(' · ')}; long tasks total ${tasks.length} (max ${Math.max(0, ...tasks.map((t) => t.duration))} ms)`,
  );
  for (const [panel, r] of Object.entries(results)) {
    expect(r.median, `median key→frame with ${panel} panel`).toBeLessThan(40);
    expect(r.p95, `p95 key→frame with ${panel} panel`).toBeLessThan(120);
  }
});
