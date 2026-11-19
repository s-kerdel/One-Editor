// Scale check in the real app: thousands of notes indexed by the worker without freezing the UI.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './harness';
import { synthDocs } from '../unit/search/synth';

test('3,000 notes: worker indexing keeps the UI responsive; queries stay fast', async ({ page, ws }) => {
  test.setTimeout(60_000);
  const docs = synthDocs(3000, 7);
  for (const d of docs) {
    await fsp.mkdir(path.join(ws.root, path.dirname(d.path)), { recursive: true });
    await fsp.writeFile(path.join(ws.root, d.path), d.content);
  }
  await ws.open(page);
  await page.keyboard.press('Control+Shift+f');
  await expect(page.getByLabel('Search query')).toBeFocused();
  // Measure the longest main-thread gap between animation frames while the worker (re)indexes.
  const gap = await page.evaluate(async () => {
    const client = (window as any).__secEditSearch;
    await client.whenReady();
    let last = performance.now();
    let max = 0;
    let run = true;
    const tick = () => {
      const t = performance.now();
      max = Math.max(max, t - last);
      last = t;
      if (run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const t0 = performance.now();
    await client.reindex();
    await client.whenReady();
    const total = performance.now() - t0;
    run = false;
    return { max, total, count: client.indexed.value, workerMs: client.indexMs.value };
  });
  console.log(`[e2e perf] reindexed ${gap.count} files in ${gap.total.toFixed(0)}ms (worker ${gap.workerMs.toFixed(0)}ms), longest frame gap ${gap.max.toFixed(0)}ms`);
  expect(gap.count).toBeGreaterThanOrEqual(3000);
  expect(gap.max).toBeLessThan(250);

  const input = page.getByLabel('Search query');
  await input.fill('php artisan migrate:fresh --seed');
  await expect(page.locator('.se-search-summary')).toContainText('files');
  const took = await page.evaluate(async () => (await (window as any).__secEditSearch.search('php artisan migrate:fresh --seed', {}, 'probe')).tookMs);
  console.log(`[e2e perf] query in worker: ${took.toFixed(1)}ms`);
  expect(took).toBeLessThan(100);
  await expect(page.locator('.se-sr-file').first()).toBeVisible();
});

test('catastrophic regex: UI stays responsive, watchdog stops it, search recovers', async ({ page, ws }) => {
  test.setTimeout(60_000);
  await ws.write('evil.txt', 'a'.repeat(34) + 'b\n');
  await ws.open(page);
  await page.keyboard.press('Control+Shift+f');
  const input = page.getByLabel('Search query');
  await expect(input).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as any).__secEditSearch.status.value)).toBe('ready');
  await input.fill('/(a+)+$/');
  // While the worker is stuck, the main thread still works: quick open responds.
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await page.keyboard.type('kube');
  await expect(page.locator('.se-pal-item').first()).toContainText('kubernetes.md');
  await page.keyboard.press('Escape');
  await expect(page.locator('.se-search-error')).toContainText('took too long', { timeout: 15_000 });
  // The worker was restarted and re-indexed: normal searches work again.
  await input.fill('--force-with-lease');
  await expect(page.locator('.se-sr-match[data-path="README.md"]')).toHaveCount(1, { timeout: 15_000 });
});
