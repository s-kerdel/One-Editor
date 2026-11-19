// The app stays usable while a big multi-project folder is indexed — modelled as the user's setup:
// the Windows app on a `\\wsl.localhost\…` root, where every open / stat / readdir crosses the 9P
// bridge (SEC_EDIT_TEST_FS_LATENCY_MS adds that delay to each call; SEC_EDIT_TEST_BRIDGE_ROOT=1 makes
// the backend treat the folder as a bridge root: 32 reader threads, folder-mtime polling instead of
// fs.watch). Set SEC_EDIT_TEST_BRIDGE_ROOT=0 for a local disk with slow opens (antivirus):
//   · opening files / other RPCs stay fast during a full index pass (cold and warm cache)
//   · no long main-thread task in the renderer while indexing
//   · an fs-event storm (a build writing thousands of files into a git-ignored folder, plus a few
//     hundred real notes) costs no full index pass and no full tree walk; real notes are indexed
//     incrementally, ignored files are never read.
// Set SEC_EDIT_PERF_SKIP_SCALE=1 to skip (like the other scale specs).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, RENDERER_DIR } from './harness';
import { startServer, type RunningServer } from '../../src/server/server';
// @ts-expect-error plain .mjs helper without types
import { generateMulti } from '../perf/gen-multi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WS = path.join(ROOT, '.tmp/perf', 'responsive-multi-5x2000');
const DELAY = process.env.SEC_EDIT_TEST_FS_LATENCY_MS ?? '3';
const BRIDGE = process.env.SEC_EDIT_TEST_BRIDGE_ROOT ?? '1';

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.SEC_EDIT_PERF_SKIP_SCALE, 'scale tests disabled');

let server: RunningServer;
let configDir: string;
const counts = { listTree: 0, fullPasses: 0, readFile: 0, readFileIgnored: 0 };

test.beforeAll(async () => {
  if (!fs.existsSync(path.join(WS, 'project-4/README.md'))) generateMulti(WS, 5, 10000);
  await fsp.rm(path.join(WS, 'project-0/coverage/storm'), { recursive: true, force: true });
  await fsp.rm(path.join(WS, 'project-0/docs/storm'), { recursive: true, force: true });
  process.env.SEC_EDIT_TEST_FS_LATENCY_MS = DELAY;
  process.env.SEC_EDIT_TEST_BRIDGE_ROOT = BRIDGE;
  configDir = path.join(ROOT, '.tmp/perf', `responsive-config-${process.pid}-${Date.now()}`);
  await fsp.mkdir(configDir, { recursive: true });
  server = await startServer({ root: WS, port: 0, rendererDir: RENDERER_DIR, configDir });
  // Count what the renderer asks the backend for (works for any indexing design).
  const svc = server.service as any;
  const wrap = (name: string, fn: (...a: any[]) => void) => {
    const orig = svc[name].bind(svc);
    svc[name] = (...a: any[]) => {
      fn(...a);
      return orig(...a);
    };
  };
  wrap('listTree', () => counts.listTree++);
  wrap('readAllTextPage', (o) => !o?.cursor && counts.fullPasses++);
  wrap('readFile', (p: string) => {
    counts.readFile++;
    if (String(p).includes('/coverage/')) counts.readFileIgnored++;
  });
  const ws = svc.workspace;
  if (ws?.onPass) ws.onPass(() => counts.fullPasses++); // indexer-owned passes
});
test.afterAll(async () => {
  delete process.env.SEC_EDIT_TEST_FS_LATENCY_MS;
  delete process.env.SEC_EDIT_TEST_BRIDGE_ROOT;
  await server?.close();
  await fsp.rm(path.join(WS, 'project-0/coverage/storm'), { recursive: true, force: true });
  await fsp.rm(path.join(WS, 'project-0/docs/storm'), { recursive: true, force: true });
});

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true });
  });
}

/** Probes RPC latency (open a file + a trivial call) every 25 ms until both indexes are ready. */
async function probeWhileIndexing(page: Page) {
  return page.evaluate(async () => {
    const a = (window as any).__secEdit;
    const files: string[] = a.files.value.filter((f: string) => f.endsWith('.md')).slice(0, 400);
    const lat: number[] = [];
    const slow: Array<[number, number]> = [];
    let i = 0;
    const t0 = performance.now();
    const ready = () => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true;
    // Indexing starts on idle after boot: wait until it runs, then probe until it is done.
    while (!(window as any).__secEditSearch || (window as any).__secEditSearch.status.value === 'idle') await new Promise((r) => setTimeout(r, 20));
    const startedAt = performance.now();
    while (!ready() && performance.now() - t0 < 120000) {
      const f = files[i++ % files.length];
      const s = performance.now();
      await a.backend.readFile(f);
      await a.backend.getWorkspace();
      const d = performance.now() - s;
      lat.push(d);
      if (d > 40) slow.push([Math.round(s - startedAt), Math.round(d)]);
      await new Promise((r) => setTimeout(r, 25));
    }
    const doneAt = performance.now();
    const lt = ((window as any).__lt as Array<{ at: number; ms: number }>).filter((t) => t.at >= startedAt && t.at <= doneAt);
    lat.sort((x, y) => x - y);
    const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0);
    return { indexMs: Math.round(doneAt - startedAt), probes: lat.length, p50: q(0.5), p95: q(0.95), max: q(1), slow: slow.slice(0, 6), longTasks: lt.length, longestTask: Math.max(0, ...lt.map((t) => t.ms)) };
  });
}

test('opening files stays fast and the UI thread stays free during a full index pass (cold + warm)', async ({ page }) => {
  test.setTimeout(300_000);
  await instrument(page);
  const runs: Record<string, unknown> = {};
  for (const kind of ['cold', 'warm']) {
    await page.goto(server.url);
    await page.waitForSelector('html[data-ready="true"]', { timeout: 60000 });
    const r = await probeWhileIndexing(page);
    runs[kind] = r;
    console.log(`[perf-responsive] ${kind} (fs latency ${DELAY} ms, bridge root ${BRIDGE === '1'}): ${JSON.stringify(r)}`);
  }
  for (const r of Object.values(runs) as Array<{ p95: number; longestTask: number; probes: number }>) {
    expect(r.probes, 'probed during indexing').toBeGreaterThan(2);
    expect(r.p95, 'readFile + RPC latency p95 while indexing').toBeLessThan(100);
    expect(r.longestTask, 'longest renderer task while indexing').toBeLessThan(50);
  }
});

test('an fs-event storm never triggers a full index pass or tree walk; ignored files are never read', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 60000 });
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  const before = { ...counts };
  // A build writing 5,000 files into a git-ignored folder, and 300 real notes being synced in.
  const ign = path.join(WS, 'project-0/coverage/storm');
  const notes = path.join(WS, 'project-0/docs/storm');
  await fsp.mkdir(ign, { recursive: true });
  await fsp.mkdir(notes, { recursive: true });
  const t0 = Date.now();
  for (let i = 0; i < 5000; i++) {
    await fsp.writeFile(path.join(ign, `chunk-${i}.html`), `<html>generated ${i} stormignored</html>`);
    if (i % 17 === 0) await fsp.writeFile(path.join(notes, `storm-note-${i}.md`), `# Storm note ${i}\n\nstormuniqueword ${i} links to [[note-0-1]]\n`);
  }
  const writeMs = Date.now() - t0;
  // Real notes become searchable (incrementally) — within a few seconds of the storm.
  await expect
    .poll(async () => page.evaluate(async () => (await (window as any).__secEditSearch.search('stormuniqueword', { limit: 1000 }, 'storm'))?.totalFiles ?? 0), { timeout: 30000 })
    .toBe(Math.ceil(5000 / 17));
  await page.waitForTimeout(1500);
  const d = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v - (before as any)[k]]));
  const ignoredHits = await page.evaluate(async () => (await (window as any).__secEditSearch.search('stormignored', {}, 'storm2'))?.totalFiles ?? -1);
  console.log(`[perf-responsive] storm: wrote 5,000 ignored + ${Math.ceil(5000 / 17)} notes in ${writeMs} ms → ${JSON.stringify(d)}; ignored files in search: ${ignoredHits}`);
  expect(d.fullPasses, 'full index passes during the storm').toBe(0);
  expect(d.listTree, 'full tree walks during the storm').toBe(0);
  expect(d.readFileIgnored, 'ignored files read by the renderer').toBe(0);
  expect(ignoredHits, 'ignored build output is not searchable').toBe(0);
});
