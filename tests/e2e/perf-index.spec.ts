// Indexing guards on a big workspace (10k notes + 2k code files, generated): the search index is
// sharded over several workers — faster than one worker, with identical results.
// Set SEC_EDIT_PERF_SKIP_SCALE=1 to skip (like perf-scale.spec.ts).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, RENDERER_DIR } from './harness';
import { startServer, type RunningServer } from '../../src/server/server';
// @ts-expect-error plain .mjs helper without types
import { generate } from '../perf/gen-workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES = Number(process.env.SEC_EDIT_PERF_NOTES ?? 10000);
const CODE = Number(process.env.SEC_EDIT_PERF_CODE ?? 2000);
// Read-only for this spec (perf-scale.spec.ts edits its own copy).
const BIG = path.join(ROOT, '.tmp/perf', `index-e2e-${NOTES}-${CODE}`);

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.SEC_EDIT_PERF_SKIP_SCALE, 'scale tests disabled');

let server: RunningServer;
test.beforeAll(async () => {
  if (!fs.existsSync(path.join(BIG, 'README.md'))) generate(BIG, NOTES, CODE);
  const configDir = path.join(ROOT, '.tmp/perf', `index-config-${process.pid}-${Date.now()}`);
  await fsp.mkdir(configDir, { recursive: true });
  server = await startServer({ root: BIG, port: 0, rendererDir: RENDERER_DIR, configDir });
});
test.afterAll(async () => {
  await server?.close();
});

/** Rebuilds with `search.workers` = n (0 = automatic): wall ms, slowest shard's engine ms, shard count. */
async function rebuild(page: Page, workers: number): Promise<{ ms: number; engine: number; shards: number; indexed: number }> {
  return page.evaluate(async (n) => {
    const a = (window as any).__secEdit;
    const c = (window as any).__secEditSearch;
    a.settings.value = { ...a.settings.value, 'search.workers': n };
    await c.reindex();
    await c.whenReady();
    return { ms: Math.round(c.indexMs.value), engine: Math.max(...c.lastBuild.engineMs), shards: c.shardCount.value, indexed: c.indexed.value };
  }, workers);
}

const QUERIES = ['rollback', 'deploy cluster', 'kubectl -n', 'force-with-lease', 'kubctl', 'tag:ops migration', 'ext:php find'];
const answers = (page: Page) =>
  page.evaluate(async (qs) => {
    const c = (window as any).__secEditSearch;
    const out: unknown[] = [];
    for (const q of qs) {
      const r = await c.search(q, { limit: 50 }, 'probe');
      out.push({ ...r, tookMs: 0, results: r.results.map((x: any) => ({ path: x.path, score: x.score, rows: x.matches.length, total: x.totalMatches })) });
    }
    return out;
  }, QUERIES);

test(`sharded index (${NOTES} notes + ${CODE} code files) builds faster than one worker, same answers`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 120000 });
  const cores = await page.evaluate(() => navigator.hardwareConcurrency || 1);
  test.skip(cores < 4, `needs ≥ 4 cores (has ${cores})`);

  // Best of two each (the backend's text cache is warm after the first build: this times indexing).
  const one = [await rebuild(page, 1), await rebuild(page, 1)];
  const oneAnswers = await answers(page);
  const many = [await rebuild(page, 0), await rebuild(page, 0)];
  const manyAnswers = await answers(page);
  const best = (r: typeof one) => Math.min(...r.map((x) => x.engine));
  console.log(
    `[perf-index] 1 shard: wall ${one.map((x) => x.ms).join(', ')} ms, engine ${one.map((x) => x.engine).join(', ')} ms · ${many[0].shards} shards: wall ${many.map((x) => x.ms).join(', ')} ms, slowest shard ${many.map((x) => x.engine).join(', ')} ms (${many[0].indexed} docs, ${cores} cores)`,
  );

  expect(one[0].shards).toBe(1);
  expect(many[0].shards, 'a big folder is sharded').toBeGreaterThan(1);
  expect(many[0].indexed).toBe(one[0].indexed);
  expect(manyAnswers, 'sharding never changes results').toEqual(oneAnswers);
  // Indexing CPU must split over the shards. Engine time, not wall time: in browser mode the HTTP
  // transport of the text (not indexing) bounds the wall clock; Electron's IPC is ~4× faster, and
  // there 8 shards rebuild in ~0.4 s vs ~0.7 s on one worker (tests/perf/measure-electron.mjs).
  expect(best(many), 'slowest shard vs one worker (engine ms)').toBeLessThan(best(one) * 0.6);
});

test('search answers while the index is still building (progressive), then completes', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready', null, { timeout: 120000 });
  const r = await page.evaluate(async () => {
    const c = (window as any).__secEditSearch;
    const build = c.reindex();
    // Ask straight away, without waiting for the build.
    const early = await c.search('rollback', { limit: 5 }, 'early', { progressive: true });
    const progress = c.progress.value;
    await build;
    await c.whenReady();
    const late = await c.search('rollback', { limit: 5 }, 'late');
    return { early: { partial: !!early?.partial, files: early?.totalFiles ?? -1 }, progress, late: { partial: !!late?.partial, files: late.totalFiles } };
  });
  console.log(`[perf-index] progressive: ${JSON.stringify(r)}`);
  expect(r.early.files, 'answered during the build').toBeGreaterThanOrEqual(0);
  expect(r.late.partial).toBe(false);
  expect(r.late.files).toBeGreaterThan(0);
  expect(r.early.files).toBeLessThanOrEqual(r.late.files);
});
