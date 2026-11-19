// Idle and memory guards on the real app (Linux: CPU from /proc; skipped elsewhere).
//   · once both indexes are built, the app sits still: ~0 % CPU when idle, nothing when minimised
//   · the renderer holds no workspace text (the knowledge index keeps metadata only), and the search
//     workers stay compact (the interning tokenizer keeps no copies of documents)
import fs from 'node:fs';
import { test, expect, path } from './fixture';
// @ts-expect-error plain .mjs helper without types
import { generate } from '../../perf/gen-workspace.mjs';

const ticks = (pid: number) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
};

test.skip(process.platform !== 'linux', 'reads /proc');

test('a built workspace idles at ~0 % CPU; memory stays compact (2,000 notes)', async ({ el }) => {
  test.setTimeout(120_000);
  generate(path.join(el.ws, 'gen'), 2000, 400); // ~5 MB of notes + code, next to the fixture
  const { app, page } = await el.launch();
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 60000 });
  await page.waitForTimeout(3000); // idle loaders, cache write, read threads wind down
  const pids: number[] = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => p.pid));
  const cpu = async (ms: number) => {
    const t0 = pids.map(ticks);
    await page.waitForTimeout(ms);
    return (pids.reduce((s, p, i) => s + ticks(p) - t0[i], 0) / 100 / (ms / 1000)) * 100; // % of one core
  };
  const idle = await cpu(10_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
  await page.waitForTimeout(500);
  const hidden = await cpu(5_000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());

  // JS heaps after GC: the page and every worker (CDP from main, flattened sessions).
  const heaps: Record<string, number> = await app.evaluate(async ({ BrowserWindow }) => {
    const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const sessions = new Map<string, string>();
    dbg.on('message', (_e, method, params) => method === 'Target.attachedToTarget' && sessions.set(params.sessionId, params.targetInfo.title || params.targetInfo.url));
    await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await new Promise((r) => setTimeout(r, 300));
    const heap = async (sid?: string) => {
      await dbg.sendCommand('HeapProfiler.collectGarbage', {}, sid);
      return ((await dbg.sendCommand('Runtime.getHeapUsage', {}, sid)) as { usedSize: number }).usedSize / 1048576;
    };
    const out: Record<string, number> = { renderer: await heap() };
    for (const [sid, name] of sessions) out[name] = await heap(sid).catch(() => -1);
    return out;
  });
  const search = Object.entries(heaps).filter(([k]) => k.startsWith('sec-edit-search')).reduce((s, [, v]) => s + v, 0);
  console.log(`[perf-idle] CPU idle ${idle.toFixed(2)} % · minimised ${hidden.toFixed(2)} % of a core; heaps MB ${JSON.stringify(Object.fromEntries(Object.entries(heaps).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`);
  // Generous bounds (parallel test runs share the box); a timer loop, a polling watcher or a spinning
  // worker shows up as several % here.
  expect(idle, 'idle CPU (% of one core)').toBeLessThan(3);
  expect(hidden, 'minimised CPU (% of one core)').toBeLessThan(2);
  // ~5 MB of text: kept once in the search workers, not in the renderer.
  expect(heaps.renderer, 'renderer heap MB').toBeLessThan(45);
  expect(search, 'search workers heap MB (all shards)').toBeLessThan(60);
});
