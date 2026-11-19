// Launch-speed guard on the real app with a sizeable folder (2,400 notes + code files):
//   · the folder is walked once at launch — the renderer's first listTree shares (or reuses) the
//     walk the watcher starts at open; a second walk of 10k+ entries once cost ~60 ms of boot
//   · renderer boot (module start → ready) stays well inside budget. Before the fix: ~134 ms on 12k
//     files vs ~63 ms after (v0.1.0: ~107 ms); the bound is generous for parallel test runs.
import fsp from 'node:fs/promises';
import { test, expect, path } from './fixture';
// @ts-expect-error plain .mjs helper without types
import { generate } from '../../perf/gen-workspace.mjs';

const BOOT_BUDGET_MS = 250;

test('launch walks the folder once and boots within budget', async ({ el }) => {
  test.setTimeout(90_000);
  generate(path.join(el.ws, 'gen'), 2000, 400);
  const boots: number[] = [];
  for (let i = 0; i < 2; i++) {
    const { app, page, timings } = await el.launch();
    const t = await timings();
    expect(t).toBeTruthy();
    boots.push(t!['r.ready'] - t!['r.start']);
    // Indexing has started by now (it asks for the tree too): still one walk.
    await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 60000 });
    const walks = await app.evaluate(() => (globalThis as any).__secEditService?.workspace?.fullWalks);
    expect(walks, 'full tree walks at launch').toBe(1);
    await app.close();
  }
  console.log(`[perf-startup] renderer boot → ready: ${boots.map(Math.round).join(', ')} ms (budget ${BOOT_BUDGET_MS})`);
  expect(Math.min(...boots), 'renderer boot → ready').toBeLessThan(BOOT_BUDGET_MS);
});

test('index on demand: launch starts no indexer, readers or search workers; find in files builds and finds', async ({ el }) => {
  test.setTimeout(90_000);
  generate(path.join(el.ws, 'gen'), 2000, 400);
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ 'search.indexing': 'onDemand' }));
  const { app, page, timings } = await el.launch();
  const t = await timings();
  const boot = t!['r.ready'] - t!['r.start'];
  console.log(`[perf-startup] on demand: renderer boot → ready ${Math.round(boot)} ms`);
  expect(boot, 'renderer boot → ready (on demand)').toBeLessThan(BOOT_BUDGET_MS);
  await page.waitForTimeout(4000); // past the idle moment that builds the index "at launch"
  const main = await app.evaluate(() => {
    const ws = (globalThis as any).__secEditService?.workspace;
    return { walks: ws?.fullWalks, indexer: !!ws?.host };
  });
  expect(main.walks, 'full tree walks at launch').toBe(1);
  expect(main.indexer, 'indexer thread (it owns the reader threads and the cache read)').toBe(false);
  const ui = await page.evaluate(() => {
    const s = (window as any).__secEditSearch;
    return { status: s?.status.value ?? 'idle', shards: s?.ports?.length ?? 0 };
  });
  expect(ui, 'search shard workers').toEqual({ status: 'idle', shards: 0 });
  await expect(page.getByTestId('index-on-demand')).toBeVisible();

  await page.keyboard.press('Control+Shift+f');
  await page.getByLabel('Search query').fill('needle in a haystack');
  await expect(page.locator('.se-search').getByText('Deep note').first()).toBeVisible({ timeout: 30000 });
  expect(await app.evaluate(() => !!(globalThis as any).__secEditService?.workspace?.host)).toBe(true);
  await expect(page.getByTestId('index-on-demand')).toHaveCount(0);
});
