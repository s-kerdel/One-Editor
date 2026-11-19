// Perf guard: switching notes with the overview's Connections section open stays inside a frame
// (render → commit, and the local graph's layout) in a 10k-note workspace.
// Workspace: generated once under .tmp/knowledge/big-<n> (tests/perf/gen-workspace.mjs, notes only).
// SEC_EDIT_PERF_SKIP_SCALE=1 skips it, like the other scale tests.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, RENDERER_DIR } from './harness';
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
