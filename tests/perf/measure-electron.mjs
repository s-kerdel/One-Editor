// Reproducible memory / idle-CPU / startup / typing / leak measurement of the real Electron app.
//   node tests/perf/measure-electron.mjs --app <staged app dir> --ws <workspace> [--alt <2nd workspace>]
//        [--out report.json] [--idle 60] [--hidden 20] [--cycles 50] [--label before] [--skip typing,churn,…]
// Stage the app first:  node scripts/stage.mjs --out .tmp/perf2/app
// Big workspace:        node tests/perf/gen-workspace.mjs .tmp/perf2/big   (+ git init/commit for git)
// Linux: needs an X server (DISPLAY, default :99 — ~/.local/xvfb/start-xvfb.sh :99).
// Per process: Linux USS (private) + PSS from /proc/<pid>/smaps_rollup, Electron's working set,
// CPU from /proc/<pid>/stat; per V8 isolate (renderer page, each worker): heap used after GC via CDP.
import { _electron } from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const APP = path.resolve(opt('app', 'release/app'));
const WS = path.resolve(opt('ws', 'tests/fixtures/workspace'));
const ALT = opt('alt', null) && path.resolve(opt('alt'));
const OUT = opt('out', null);
const IDLE_S = Number(opt('idle', 60));
const HIDDEN_S = Number(opt('hidden', 20));
const CYCLES = Number(opt('cycles', 50));
const LABEL = opt('label', 'run');
const SKIP = new Set(String(opt('skip', '')).split(',').filter(Boolean));
const TMP = path.resolve(opt('tmp', '.tmp/perf2'));
const HZ = 100; // USER_HZ (clock ticks per second in /proc/<pid>/stat)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (b) => Math.round((b / 1048576) * 10) / 10;

function procMem(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    const kb = (k) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(s)?.[1] ?? 0);
    return { rss: kb('Rss') / 1024, pss: kb('Pss') / 1024, uss: (kb('Private_Clean') + kb('Private_Dirty')) / 1024 };
  } catch {
    return null;
  }
}
function procTicks(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]); // utime + stime
  } catch {
    return null;
  }
}
/** Every thread of a process: name → ticks (to find who burns idle CPU). */
function threadTicks(pid) {
  const out = {};
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const s = fs.readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
      const name = s.slice(s.indexOf('(') + 1, s.lastIndexOf(')'));
      const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
      out[`${name}#${tid}`] = Number(f[11]) + Number(f[12]);
    }
  } catch {}
  return out;
}

async function launch(ws, userData) {
  const app = await _electron.launch({
    args: ['--disable-gpu', APP, ws],
    // Generated workspaces live under the project's .tmp/: keep the project's own repo out of them.
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', SEC_EDIT_TEST: '1', SEC_EDIT_USER_DATA: userData, GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES || path.resolve('.tmp') },
    timeout: 60000,
  });
  const stdout = [];
  app.process().stdout?.on('data', (d) => stdout.push(String(d)));
  return { app, stdout };
}

/** CDP from the main process (webContents.debugger): page + every worker, flattened sessions. */
async function wireCdp(app) {
  await app.evaluate(async ({ BrowserWindow }) => {
    const g = (globalThis.__perf ??= { sessions: new Map() });
    const win = BrowserWindow.getAllWindows()[0];
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    if (g.wired) return;
    g.wired = true;
    dbg.on('message', (_e, method, params) => {
      if (method === 'Target.attachedToTarget') g.sessions.set(params.sessionId, params.targetInfo);
      if (method === 'Target.detachedFromTarget') g.sessions.delete(params.sessionId);
    });
    await dbg.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });
}

/** Memory of every process + JS heap of every isolate (after GC). */
async function snapshot(app, label) {
  await wireCdp(app);
  const r = await app.evaluate(async ({ app: eapp, BrowserWindow }) => {
    const g = globalThis.__perf;
    const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger;
    const heap = async (sessionId) => {
      try {
        await dbg.sendCommand('HeapProfiler.collectGarbage', {}, sessionId);
        const u = await dbg.sendCommand('Runtime.getHeapUsage', {}, sessionId);
        return u.usedSize;
      } catch (e) {
        return -1;
      }
    };
    const isolates = { renderer: await heap(undefined) };
    for (const [sid, info] of g.sessions) isolates[`${info.type}:${info.title || info.url.split('/').pop()}`] = await heap(sid);
    if (globalThis.gc) globalThis.gc();
    const m = process.memoryUsage();
    return {
      isolates,
      main: { rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers },
      procs: eapp.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, name: p.name || p.serviceName || '', ws: p.memory.workingSetSize * 1024 })),
    };
  });
  const procs = r.procs.map((p) => ({ ...p, ...(procMem(p.pid) ?? {}) }));
  const byType = {};
  for (const p of procs) {
    const k = p.type === 'Utility' ? `Utility:${p.name}` : p.type;
    byType[k] = (byType[k] ?? 0) + (p.uss ?? 0);
  }
  const isolates = Object.fromEntries(Object.entries(r.isolates).map(([k, v]) => [k, mb(v)]));
  const total = procs.reduce((s, p) => s + (p.pss ?? 0), 0);
  const out = { label, ussMB: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, Math.round(v * 10) / 10])), pssTotalMB: Math.round(total), isolatesMB: isolates, mainHeapMB: mb(r.main.heapUsed), mainRssMB: mb(r.main.rss) };
  console.log(`[mem] ${label.padEnd(22)} total PSS ${out.pssTotalMB} MB | USS ${JSON.stringify(out.ussMB)} | heaps ${JSON.stringify(isolates)} | main heap ${out.mainHeapMB}`);
  return out;
}

async function pids(app) {
  return app.evaluate(({ app: eapp }) => eapp.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type === 'Utility' ? `Utility:${p.name || p.serviceName}` : p.type })));
}

/** CPU % of one core per process over `seconds` (and the busiest threads). */
async function idleCpu(app, seconds, label) {
  const list = await pids(app);
  const t0 = list.map((p) => procTicks(p.pid));
  const th0 = list.map((p) => threadTicks(p.pid));
  const w0 = Date.now();
  await sleep(seconds * 1000);
  const wall = (Date.now() - w0) / 1000;
  const per = {};
  const threads = [];
  list.forEach((p, i) => {
    const t1 = procTicks(p.pid);
    if (t1 === null || t0[i] === null) return;
    per[p.type] = Math.round(((per[p.type] ?? 0) + ((t1 - t0[i]) / HZ / wall) * 100) * 100) / 100;
    const th1 = threadTicks(p.pid);
    for (const [k, v] of Object.entries(th1)) {
      const d = v - (th0[i][k] ?? 0);
      if (d > 0) threads.push({ proc: p.type, thread: k, ticks: d });
    }
  });
  threads.sort((a, b) => b.ticks - a.ticks);
  const total = Math.round(Object.values(per).reduce((s, v) => s + v, 0) * 100) / 100;
  console.log(`[cpu] ${label} ${seconds}s: total ${total}% of a core | ${JSON.stringify(per)} | top threads ${threads.slice(0, 6).map((t) => `${t.proc}/${t.thread}=${t.ticks}`).join(' ')}`);
  return { total, per, threads: threads.slice(0, 12) };
}

/** keydown → next frame (in page), long tasks while typing. */
async function typing(page, file, text) {
  await page.evaluate((f) => window.__secEdit.openFile(f), file);
  await page.waitForFunction((f) => window.__secEdit.activePath.value === f && window.__secEdit.editor?.getContent(f)?.length > 0, file, { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.evaluate(() => {
    const w = window;
    w.__keyTimes = [];
    w.__lt = [];
    w.__ltObs ??= (() => {
      try {
        const o = new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__lt.push(Math.round(e.duration))));
        o.observe({ type: 'longtask' });
        return o;
      } catch {
        return null;
      }
    })();
    w.__keyListener ??= window.addEventListener(
      'keydown',
      () => {
        const s = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.__keyTimes.push(performance.now() - s), 0));
      },
      true,
    );
  });
  await page.keyboard.type(text, { delay: 30 });
  await page.waitForTimeout(1500); // debounced consumers (search, knowledge, overview, git, autosave)
  const r = await page.evaluate(() => ({ times: window.__keyTimes.slice().sort((a, b) => a - b), lt: window.__lt.slice() }));
  const t = r.times;
  const q = (p) => Math.round(t[Math.min(t.length - 1, Math.floor(t.length * p))] * 10) / 10;
  return { median: q(0.5), p95: q(0.95), max: q(1), longTasks: r.lt.length, longestTask: Math.max(0, ...r.lt) };
}

async function waitIndexes(page, timeout = 180000) {
  const t0 = Date.now();
  await page.waitForFunction(() => window.__secEditSearch?.status.value === 'ready' && window.__secEditKnowledgeReady === true, null, { timeout, polling: 100 });
  return Date.now() - t0;
}

const press = async (page, k, wait = 60) => {
  await page.keyboard.press(k);
  await page.waitForTimeout(wait);
};

async function churnCycle(page, notes, i) {
  // open/close tabs
  for (const n of notes) await page.evaluate((p) => window.__secEdit.openFile(p), n);
  await page.waitForTimeout(80);
  await page.evaluate(async (list) => {
    for (const p of list) await window.__secEdit.closeTab(p);
  }, notes);
  // overlays: palette, settings, graph
  await press(page, 'Control+Shift+p', 120);
  await page.keyboard.type('toggle');
  await press(page, 'Escape', 60);
  await press(page, 'Control+,', 150);
  await press(page, 'Escape', 60);
  await press(page, 'Control+Alt+g', 250);
  await press(page, 'Escape', 60);
  // overview + view modes on an open note
  await page.evaluate((p) => window.__secEdit.openFile(p), notes[0]);
  await page.waitForTimeout(80);
  await press(page, 'Control+Alt+b', 120);
  await press(page, 'Control+e', 150);
  await press(page, 'Control+e', 150);
  await press(page, 'Control+Alt+b', 80);
  // sidebar panels + a search
  await page.evaluate(async (q) => {
    const a = window.__secEdit;
    for (const id of ['search', 'outline', 'backlinks', 'tags', 'files']) {
      a.sidebarPanel.value = id;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
    }
    await window.__secEditSearch.search(q, {}, 'perf');
  }, ['rollback', 'deploy cluster', 'kubectl', 'invoice'][i % 4]);
  await page.evaluate((p) => window.__secEdit.closeTab(p), notes[0]);
}

/**
 * Indexing: launch → search + knowledge indexes ready. Samples CPU ticks of every app process every
 * 100 ms: `coresAvg` = CPU seconds / wall seconds, `coresPeak` = busiest 500 ms window.
 * Runs `cold` (fresh user data) then `warm` (same user data again: persistent caches, if any).
 */
async function indexing(runs) {
  const out = [];
  const ud = await fsp.mkdtemp(path.join(TMP, `ud-index-${LABEL}-`));
  for (let i = 0; i < runs; i++) {
    const kind = i === 0 ? 'cold' : 'warm';
    const t0 = Date.now();
    const { app } = await launch(WS, ud);
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 60000 });
    const readyAt = Date.now() - t0;
    const list = await pids(app);
    const samples = [];
    let done = false;
    const sampler = (async () => {
      while (!done) {
        samples.push({ t: Date.now(), ticks: list.reduce((s, p) => s + (procTicks(p.pid) ?? 0), 0) });
        await sleep(100);
      }
    })();
    // RPC latency (open a file + a trivial call, every 25 ms) and long tasks while the indexes build.
    const probe = page.evaluate(async () => {
      const a = window.__secEdit;
      const files = a.files.value.filter((f) => f.endsWith('.md')).slice(0, 300);
      const lt = [];
      try {
        new PerformanceObserver((l) => l.getEntries().forEach((e) => lt.push(Math.round(e.duration)))).observe({ type: 'longtask' });
      } catch {}
      const lat = [];
      const ready = () => window.__secEditSearch?.status.value === 'ready' && window.__secEditKnowledgeReady === true;
      for (let i = 0; !ready() && i < 20000; i++) {
        const s = performance.now();
        await a.backend.readFile(files[i % files.length]);
        await a.backend.getWorkspace();
        lat.push(performance.now() - s);
        await new Promise((r) => setTimeout(r, 25));
      }
      lat.sort((x, y) => x - y);
      const q = (p) => Math.round(lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0);
      return { probes: lat.length, p50: q(0.5), p95: q(0.95), max: q(1), longTasks: lt.length, longestTask: Math.max(0, ...lt) };
    });
    const s = await page.waitForFunction(() => window.__secEditSearch?.status.value === 'ready' && window.__secEditSearch.indexed.value > 0, null, { timeout: 300000, polling: 20 }).then(() => Date.now() - t0);
    const k = await page.waitForFunction(() => window.__secEditKnowledgeReady === true, null, { timeout: 300000, polling: 20 }).then(() => Date.now() - t0);
    done = true;
    await sampler;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const cpuS = (last.ticks - first.ticks) / HZ;
    const wallS = Math.max(0.001, (last.t - first.t) / 1000);
    let peak = 0;
    for (let a = 0, b = 0; b < samples.length; b++) {
      while (samples[b].t - samples[a].t > 500) a++;
      const dt = (samples[b].t - samples[a].t) / 1000;
      if (dt >= 0.3) peak = Math.max(peak, (samples[b].ticks - samples[a].ticks) / HZ / dt);
    }
    const rpc = await probe.catch(() => null);
    const info = await page.evaluate(() => ({ indexed: window.__secEditSearch.indexed.value, shards: window.__secEditSearch.shardCount?.value ?? 1 }));
    const mem = await snapshot(app, `index ${kind}`);
    const r = { kind, readyMs: readyAt, searchReadyMs: s, knowledgeReadyMs: k, indexReadyMs: Math.max(s, k), indexed: info.indexed, shards: info.shards, cpuSeconds: Math.round(cpuS * 100) / 100, coresAvg: Math.round((cpuS / wallS) * 100) / 100, coresPeak: Math.round(peak * 100) / 100, pssTotalMB: mem.pssTotalMB, ussMB: mem.ussMB, isolatesMB: mem.isolatesMB, rpc };
    console.log(`[index] ${JSON.stringify(r)}`);
    out.push(r);
    await app.close();
  }
  await fsp.rm(ud, { recursive: true, force: true });
  return out;
}

async function main() {
  await fsp.mkdir(TMP, { recursive: true });
  if (opt('mode', 'full') === 'index') {
    const runs = await indexing(Number(opt('runs', 3)));
    if (OUT) await fsp.writeFile(OUT, JSON.stringify({ label: LABEL, ws: WS, runs }, null, 2));
    return;
  }
  const report = { label: LABEL, ws: WS, at: new Date().toISOString(), snapshots: [], cpu: {}, startup: {}, typing: {}, leak: {} };
  const userData = await fsp.mkdtemp(path.join(TMP, `ud-${LABEL}-`));
  const big20 = 'notes/big-note.md';
  const huge = 'notes/huge-1mb.md';
  const backups = {};
  for (const f of [big20, huge]) {
    const abs = path.join(WS, f);
    if (fs.existsSync(abs)) backups[f] = fs.readFileSync(abs);
  }

  // ---- startup (3 cold launches, best + median) ----
  const starts = [];
  for (let i = 0; i < (SKIP.has('startup') ? 0 : 3); i++) {
    const ud = await fsp.mkdtemp(path.join(TMP, `ud-start-`));
    const t0 = Date.now();
    const { app, stdout } = await launch(WS, ud);
    const page = await app.firstWindow();
    await page.waitForSelector('html[data-ready="true"]', { timeout: 60000 });
    const wall = Date.now() - t0;
    let timings = null;
    for (let k = 0; k < 60 && !timings; k++) {
      const line = stdout.join('').split('\n').find((l) => l.startsWith('[sec-edit:timings]'));
      if (line) timings = JSON.parse(line.slice('[sec-edit:timings] '.length));
      else await sleep(50);
    }
    const idx = await waitIndexes(page);
    starts.push({ wall, shown: timings?.shown, rendererReady: timings?.rendererReady, boot: timings ? timings['r.ready'] - timings['r.start'] : null, indexesAfterReadyMs: idx });
    await app.close();
    await fsp.rm(ud, { recursive: true, force: true });
  }
  if (starts.length) {
    const med = (k) => starts.map((s) => s[k]).sort((a, b) => a - b)[1];
    report.startup = { runs: starts, wallMedian: med('wall'), shownMedian: med('shown'), rendererReadyMedian: med('rendererReady'), bootMedian: med('boot'), indexesMedian: med('indexesAfterReadyMs') };
    console.log(`[startup] ${JSON.stringify(report.startup)}`);
  }

  const { app } = await launch(WS, userData);
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.warn('[pageerror]', e.message));
  await page.waitForSelector('html[data-ready="true"]', { timeout: 60000 });
  await page.waitForTimeout(500);
  report.snapshots.push(await snapshot(app, 'boot'));
  await waitIndexes(page);
  await page.waitForTimeout(1500); // idle loaders (git, preview warm-up, popups)
  report.snapshots.push(await snapshot(app, 'indexes ready'));

  const files = await page.evaluate(() => window.__secEdit.files.value.filter((f) => f.endsWith('.md') && !f.includes('huge')));
  const twenty = files.filter((_, i) => i % Math.max(1, Math.floor(files.length / 20)) === 0).slice(0, 20);

  if (!SKIP.has('idle')) report.cpu.idleAfterIndex = await idleCpu(app, IDLE_S, 'idle (visible, no tabs)');

  for (const f of twenty) await page.evaluate((p) => window.__secEdit.openFile(p), f);
  await page.waitForTimeout(1500);
  report.snapshots.push(await snapshot(app, '20 notes open'));
  if (!SKIP.has('idle')) report.cpu.idle20Tabs = await idleCpu(app, Math.min(IDLE_S, 30), 'idle (visible, 20 tabs)');
  await page.evaluate(async (list) => {
    for (const p of list) await window.__secEdit.closeTab(p);
  }, twenty);
  await page.waitForTimeout(1500);
  report.snapshots.push(await snapshot(app, '20 notes closed'));

  // ---- hidden / minimised window ----
  if (!SKIP.has('hidden')) {
    await page.evaluate((p) => window.__secEdit.openFile(p), twenty[0]);
    await page.waitForTimeout(500);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await sleep(1500);
    const vis = await page.evaluate(() => document.visibilityState);
    report.cpu.hidden = { ...(await idleCpu(app, HIDDEN_S, `idle (minimised, visibility=${vis})`)), visibility: vis };
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.restore();
      w.show();
    });
    await page.waitForTimeout(500);
    await page.evaluate((p) => window.__secEdit.closeTab(p), twenty[0]);
  }

  // ---- typing latency: 20 KB and 1 MB notes with overview + search + git live ----
  if (!SKIP.has('typing')) {
    await page.evaluate(() => {
      window.__secEdit.sidebarPanel.value = 'search';
    });
    await page.getByLabel('Search query').fill('rollback');
    await page.waitForTimeout(800);
    const ovOpen = await page.locator('.se-overview, [data-overview]').count();
    if (!ovOpen) await press(page, 'Control+Alt+b', 400);
    if (fs.existsSync(path.join(WS, big20))) report.typing.note20k = await typing(page, big20, ' typing latency check with all panels live and git active');
    if (fs.existsSync(path.join(WS, huge))) report.typing.note1mb = await typing(page, huge, ' typing latency check in a one megabyte note');
    console.log(`[typing] ${JSON.stringify(report.typing)}`);
    await page.evaluate(() => window.__secEdit.saveFile?.());
    await page.evaluate(async () => {
      for (const t of [...window.__secEdit.tabs.value]) await window.__secEdit.closeTab(t.path);
    });
    await press(page, 'Control+Alt+b', 300);
    await page.evaluate(() => {
      window.__secEdit.sidebarPanel.value = 'files';
    });
    await page.waitForTimeout(1000);
    report.snapshots.push(await snapshot(app, 'after typing'));
  }

  // ---- leaks: N churn cycles; heap after GC at cycle 10 vs N ----
  if (!SKIP.has('churn')) {
    const notes = twenty.slice(0, 5);
    const heapAt = {};
    for (let i = 1; i <= CYCLES; i++) {
      await churnCycle(page, notes, i);
      if (i === 10 || i === CYCLES) {
        await page.waitForTimeout(1200);
        const s = await snapshot(app, `churn ${i}`);
        heapAt[i] = s;
        report.snapshots.push(s);
      }
    }
    const a = heapAt[10]?.isolatesMB.renderer;
    const b = heapAt[CYCLES]?.isolatesMB.renderer;
    const dom = await page.evaluate(() => ({ nodes: document.getElementsByTagName('*').length }));
    report.leak = { rendererHeapAt10: a, [`rendererHeapAt${CYCLES}`]: b, growthPerCycleKB: a && b ? Math.round(((b - a) * 1024) / (CYCLES - 10)) : null, domNodes: dom.nodes };
    console.log(`[leak] ${JSON.stringify(report.leak)}`);
  }

  // ---- workspace switch twice ----
  if (ALT && !SKIP.has('switch')) {
    for (const target of [ALT, WS]) {
      await app.evaluate(({ BrowserWindow }, dir) => BrowserWindow.getAllWindows()[0].webContents.send('app:openRequest', [dir]), target);
      await page.waitForFunction((root) => window.__secEdit.workspace.value?.root === root, target, { timeout: 30000 });
      await page.waitForTimeout(300);
      await waitIndexes(page);
      await page.waitForTimeout(1500);
    }
    report.snapshots.push(await snapshot(app, 'after 2 ws switches'));
  }

  if (OUT) {
    await fsp.mkdir(path.dirname(path.resolve(OUT)), { recursive: true });
    await fsp.writeFile(OUT, JSON.stringify(report, null, 2));
  }
  await app.close();
  for (const [f, buf] of Object.entries(backups)) fs.writeFileSync(path.join(WS, f), buf);
  await fsp.rm(userData, { recursive: true, force: true });
  console.log(`[done] ${OUT ?? ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
