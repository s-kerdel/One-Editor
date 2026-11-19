// Perf guard: switching notes with the overview's Connections section open stays inside a frame
// (render → commit, and the local graph's layout) in a 10k-note workspace.
// Workspace: generated once under .tmp/knowledge/big-<n> (tests/perf/gen-workspace.mjs, notes only).
// SEC_EDIT_PERF_SKIP_SCALE=1 skips it, like the other scale tests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, RENDERER_DIR } from './harness';
import { cpuLoadMeter, describeLoad, skipIfBusy } from './cpu-load';
import { startServer, type RunningServer } from '../../src/server/server';
// @ts-expect-error plain .mjs helper without types
import { generate, notePath } from '../perf/gen-workspace.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOTES = Number(process.env.SEC_EDIT_PERF_NOTES ?? 10000);
const BIG = path.join(ROOT, '.tmp/knowledge', `big-${NOTES}`);
const FRAME_MS = 16;

test.describe.configure({ mode: 'serial' });
test.skip(!!process.env.SEC_EDIT_PERF_SKIP_SCALE, 'scale tests disabled');

let server: RunningServer;
test.beforeAll(async () => {
  if (!fs.existsSync(path.join(BIG, 'README.md'))) generate(BIG, NOTES, 0);
  const configDir = path.join(ROOT, '.tmp/knowledge', `config-${process.pid}-${Date.now()}`);
  await fsp.mkdir(configDir, { recursive: true });
  server = await startServer({ root: BIG, port: 0, rendererDir: RENDERER_DIR, configDir });
});
test.afterAll(async () => {
  await server?.close();
});

test(`switching notes with Connections open (${NOTES} notes) stays under ${FRAME_MS} ms of main thread`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 180_000, polling: 500 });
  const notes = Array.from({ length: 30 }, (_, k) => notePath((k * 331) % NOTES));
  const open = (p: string) => page.evaluate((f) => (window as any).__secEdit.openFile(f), p);
  await open(notes[0]);
  await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.se-overview [data-sub="cn-in"]')).toBeVisible({ timeout: 15000 });
  // Shown: everything (graph, mentions) the way a user has it.
  const settle = (p: string) =>
    page.evaluate(
      (f) =>
        new Promise<void>((res) => {
          const check = () => (document.querySelector('.se-ov')?.getAttribute('data-path') === f && document.querySelector('.se-cn-graph') ? requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 30))) : requestAnimationFrame(check));
          check();
        }),
      p,
    );
  for (const p of notes.slice(0, 6)) {
    await open(p);
    await settle(p); // warm-up (JIT, first derive)
  }
  await page.evaluate(() => {
    const s = (window as any).__secEditConnectionsPerf;
    s.render.length = 0;
    s.graph.length = 0;
  });
  for (const p of notes.slice(6)) {
    await open(p);
    await settle(p);
  }
  const perf = await page.evaluate(() => {
    const s = (window as any).__secEditConnectionsPerf;
    return { render: [...s.render] as number[], graph: [...s.graph] as number[] };
  });
  const stats = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return { n: s.length, median: s[s.length >> 1], max: s[s.length - 1] };
  };
  const r = stats(perf.render);
  const g = stats(perf.graph);
  console.log(`[perf] Connections @${NOTES} notes — render: median ${r.median.toFixed(2)} ms, max ${r.max.toFixed(2)} ms (${r.n}) · graph layout: median ${g.median.toFixed(2)} ms, max ${g.max.toFixed(2)} ms (${g.n})`);
  expect(r.n).toBeGreaterThanOrEqual(notes.length - 6);
  expect(r.max, 'Connections render → commit on a note switch').toBeLessThan(FRAME_MS);
  expect(g.max, 'local graph layout on a note switch').toBeLessThan(FRAME_MS);
});


// The first derive (all links of all notes) runs in slices after the build: opening the panels that
// need it never freezes the UI, and they fill in when it completes.
test(`opening Backlinks and Connections right after indexing (${NOTES} notes): no renderer task over 50 ms`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 180_000, polling: 100 });
  const meter = cpuLoadMeter();
  await page.evaluate(() => {
    const w = window as any;
    w.__lt = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(Math.round(e.duration)))).observe({ type: 'longtask' });
  });
  await page.evaluate((f) => (window as any).__secEdit.openFile(f), notePath(17));
  await page.locator('.se-nav-btn[data-panel="backlinks"]').click();
  await page.waitForTimeout(100);
  if (!(await page.locator('aside.se-overview [data-sub="cn-in"]').isVisible())) await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.se-overview [data-sub="cn-in"]')).toBeVisible({ timeout: 15000 });
  // Derive finished → the panels show every backlink.
  await page.waitForFunction(() => !(window as any).__secEdit.knowledge.isBuilding(), null, { timeout: 60_000, polling: 50 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({ lt: (window as any).__lt as number[], back: (window as any).__secEdit.knowledge.backlinks((window as any).__secEdit.activePath?.value ?? '').length }));
  const load = meter.stop();
  console.log(`[perf] open Backlinks + Connections @${NOTES}: long tasks ${JSON.stringify(r.lt)}; ${describeLoad(load)}`);
  skipIfBusy(load, 'panel open after indexing');
  expect(Math.max(0, ...r.lt), 'longest renderer task while the panels open and the links derive').toBeLessThan(50);
});

test(`creating and deleting notes with Connections open (${NOTES} notes): each index update and render stays inside a frame`, async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]', { timeout: 30000 });
  await page.waitForFunction(() => (window as any).__secEditKnowledgeReady === true, null, { timeout: 180_000, polling: 200 });
  const open = notePath(42);
  await page.evaluate((f) => (window as any).__secEdit.openFile(f), open);
  await page.waitForTimeout(300);
  // The overview's open state is remembered per workspace (an earlier test may have opened it).
  if (!(await page.locator('aside.se-overview [data-sub="cn-in"]').isVisible())) await page.keyboard.press('Control+Alt+b');
  await expect(page.locator('aside.se-overview [data-sub="cn-in"]')).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => !(window as any).__secEdit.knowledge.isBuilding(), null, { timeout: 60_000, polling: 50 });
  await page.waitForTimeout(500);
  // Time every index mutation (the batched re-resolve runs in the next query: inside the Connections render).
  await page.evaluate(() => {
    const w = window as any;
    const k = w.__secEdit.knowledge;
    w.__kt = [];
    for (const m of ['update', 'remove', 'setFiles', 'prune', 'rename']) {
      const orig = k[m].bind(k);
      k[m] = (...a: unknown[]) => {
        const t0 = performance.now();
        try {
          return orig(...a);
        } finally {
          w.__kt.push([m, performance.now() - t0]);
        }
      };
    }
    w.__frames = [];
    let last = performance.now();
    const tick = (t: number) => {
      w.__frames.push(t - last);
      last = t;
      if (!w.__stopFrames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__secEditConnectionsPerf.render.length = 0;
  });
  const dir = `created-${process.pid}`;
  const meter = cpuLoadMeter();
  try {
    for (let k = 0; k < 5; k++) {
      const rel = `${dir}/Created ${k}.md`;
      // Links the open note's neighbourhood, so Connections has something to recompute.
      await fsp.mkdir(path.join(BIG, dir), { recursive: true });
      await fsp.writeFile(path.join(BIG, rel), `# Created ${k}\n\n[[${path.basename(open, '.md')}]] and [[${path.basename(notePath(k * 97), '.md')}]]\n`);
      await page.waitForFunction((p) => !!(window as any).__secEdit.knowledge.note(p), rel, { timeout: 20_000 });
      await page.waitForTimeout(150); // panels re-read (coalesced bump)
    }
  } finally {
    await fsp.rm(path.join(BIG, dir), { recursive: true, force: true });
  }
  await page.waitForFunction((d) => !(window as any).__secEdit.knowledge.files().some((f: string) => f.startsWith(`${d}/`)), dir, { timeout: 20_000 });
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const w = window as any;
    w.__stopFrames = true;
    return { calls: w.__kt as Array<[string, number]>, render: [...w.__secEditConnectionsPerf.render] as number[], frames: (w.__frames as number[]).slice(1) };
  });
  const load = meter.stop();
  const worst = (xs: number[]) => Math.round(Math.max(0, ...xs) * 10) / 10;
  const byKind = Object.entries(r.calls.reduce<Record<string, number[]>>((a, [m, ms]) => ((a[m] ??= []).push(ms), a), {})).map(([m, v]) => `${m} ×${v.length} max ${worst(v)}`);
  console.log(`[perf] create/delete with Connections @${NOTES}: index ${byKind.join(', ')} ms · Connections render max ${worst(r.render)} ms (${r.render.length}) · worst frame ${worst(r.frames)} ms; ${describeLoad(load)}`);
  expect(r.calls.filter(([m]) => m === 'update').length, 'creates reached the index').toBeGreaterThanOrEqual(5);
  expect(r.render.length, 'Connections re-rendered').toBeGreaterThan(0);
  skipIfBusy(load, 'create/delete with Connections open');
  expect(worst(r.calls.map(([, ms]) => ms)), 'longest index update on create / delete').toBeLessThan(FRAME_MS);
  expect(worst(r.render), 'Connections render → commit after a create / delete (incl. re-resolving links)').toBeLessThan(FRAME_MS);
  expect(worst(r.frames), 'worst frame while creating / deleting').toBeLessThan(50);
});
