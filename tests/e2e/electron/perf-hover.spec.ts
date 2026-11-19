// Hover cost in the real app (user report: hovering folders / files in the tree raises CPU noticeably;
// Windows, integrated frame, shelf). A real pointer (XTEST, private Xvfb display) sweeps the file tree
// for a few seconds; we record CPU per process (/proc) and the renderer's own work (CDP Performance metrics).
//   SEC_EDIT_HOVER_MATRIX=1  → the full matrix (frame × sidebar style × workspace size) + a bare-Electron floor, printed
//     (narrow it with SEC_EDIT_HOVER_SIZES / _STYLES / _FRAMES / _PHASES, comma-separated)
//   SEC_EDIT_HOVER_TRACE=<dir> → also write a Chrome trace per run and print its top events
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import type { ElectronApplication, Page } from '@playwright/test';
import { test, expect, path, type ElectronFixture } from './fixture';
import { connectXTest, type XPointer } from './xtest';
// @ts-expect-error plain .mjs helper without types
import { generate } from '../../perf/gen-workspace.mjs';

const XVFB = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');
test.skip(process.platform !== 'linux' || !fs.existsSync(XVFB), 'needs /proc and the sudo-free Xvfb');

/** Own X display per worker: the sweep's real pointer must not land in another test's window. */
function privateDisplay(): string {
  const d = `:${170 + test.info().parallelIndex}`;
  execSync(`${XVFB} ${d}`, { stdio: 'ignore' });
  return d;
}

const ticks = (pid: number) => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return Number(f[11]) + Number(f[12]);
  } catch {
    return 0;
  }
};

type Cfg = { frame: 'integrated' | 'native'; style: 'shelf' | 'classic'; big: boolean };
type Sample = { cpu: Record<string, number>; perf: Record<string, number>; ms: number };
const PERF_KEYS = ['RecalcStyleCount', 'RecalcStyleDuration', 'LayoutCount', 'LayoutDuration', 'ScriptDuration', 'TaskDuration'];

/** CPU (% of one core, per process type) and renderer metric deltas while `during` runs. */
async function sample(app: ElectronApplication, during: () => Promise<void>): Promise<Sample> {
  const procs: Array<{ pid: number; type: string }> = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type })));
  const metrics = () =>
    app.evaluate(async ({ BrowserWindow }) => {
      const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger;
      if (!dbg.isAttached()) {
        dbg.attach('1.3');
        await dbg.sendCommand('Performance.enable', {});
      }
      const r = (await dbg.sendCommand('Performance.getMetrics')) as { metrics: Array<{ name: string; value: number }> };
      return Object.fromEntries(r.metrics.map((m) => [m.name, m.value]));
    });
  const m0 = await metrics();
  const t0 = procs.map((p) => ticks(p.pid));
  const start = Date.now();
  await during();
  const ms = Date.now() - start;
  const t1 = procs.map((p) => ticks(p.pid));
  const m1 = await metrics();
  const cpu: Record<string, number> = {};
  procs.forEach((p, i) => (cpu[p.type] = (cpu[p.type] ?? 0) + ((t1[i] - t0[i]) / 100 / (ms / 1000)) * 100));
  const perf = Object.fromEntries(PERF_KEYS.map((k) => [k, k.endsWith('Duration') ? Math.round((m1[k] - m0[k]) * 1000) : m1[k] - m0[k]]));
  return { cpu, perf, ms };
}

/** Moves the real pointer up and down over the tree rows (about one mouse report every 8 ms); returns
 *  how many rows it covered and how often the row under the pointer changed. */
async function sweep(page: Page, x: XPointer, ms: number) {
  const r = await page.locator('.se-tree').evaluate((el) => {
    const rows = [...el.querySelectorAll('.se-tree-row')].map((e) => e.getBoundingClientRect()).filter((b) => b.bottom <= el.getBoundingClientRect().bottom);
    return { x: rows[0].left + 60, top: rows[0].top + 4, bottom: rows[rows.length - 1].bottom - 4, tops: rows.map((b) => b.top) };
  });
  const rowAt = (y: number) => r.tops.filter((t) => t <= y).length;
  const end = Date.now() + ms;
  let y = r.top;
  let dy = 3;
  let changes = 0;
  let last = rowAt(y);
  while (Date.now() < end) {
    await x.motion(r.x, y);
    await new Promise((res) => setTimeout(res, 8));
    if (rowAt(y) !== last) (changes++, (last = rowAt(y)));
    y += dy;
    if (y > r.bottom || y < r.top) (dy = -dy), (y += 2 * dy);
  }
  return { n: r.tops.length, changes };
}

/** Injects one phase's CSS (replacing the previous one) and starts counting tree DOM mutations. */
async function applyPhase(page: Page, phase: string) {
  await page.evaluate(({ css, phase }) => {
    document.getElementById('se-hover-exp')?.remove();
    const st = document.createElement('style');
    st.id = 'se-hover-exp';
    st.textContent = css;
    document.head.append(st);
    // Native tooltips: rows carry title=path; drop them for one phase to see what they cost.
    document.querySelectorAll<HTMLElement>('.se-tree-row').forEach((r) => {
      if (phase === 'no-title') {
        r.dataset.t = r.title;
        r.removeAttribute('title');
      } else if (r.dataset.t) r.title = r.dataset.t;
    });
    (window as any).__mut = 0;
    (window as any).__mo?.disconnect();
    (window as any).__mo = new MutationObserver((l) => ((window as any).__mut += l.length));
    (window as any).__mo.observe(document.querySelector('.se-tree')!, { subtree: true, childList: true, attributes: true, characterData: true });
  }, { css: PHASES[phase] ?? '', phase });
  await page.waitForTimeout(400);
}

async function launchFor(el: ElectronFixture, cfg: Cfg, display: string) {
  await fsp.mkdir(el.userData, { recursive: true });
  await fsp.writeFile(path.join(el.userData, 'settings.json'), JSON.stringify({ windowFrame: cfg.frame, sidebarStyle: cfg.style, theme: 'dark' }));
  await fsp.writeFile(path.join(el.userData, 'window-state.json'), JSON.stringify({ x: 0, y: 0, width: 1200, height: 880 }));
  const { app, page } = await el.launch([el.ws], { env: { DISPLAY: display } });
  // Tree with enough rows to sweep (the same rows in both sizes); big: + 10k notes, 60 tabs, a big note open.
  const open = async (p: string) => {
    const row = page.locator(`.se-tree-row.dir[data-path="${p}"]`);
    await row.waitFor();
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
  };
  if (cfg.big) {
    await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 90000 });
    const tabs = Array.from({ length: 60 }, (_, i) => `gen/notes/area-${String(i % 25).padStart(2, '0')}/topic-${String(Math.floor(i / 25) % 16).padStart(2, '0')}/Note ${String(i).padStart(5, '0')}.md`);
    await page.evaluate(async (list) => {
      for (const p of list) await (window as any).__secEdit.openFile(p);
      await (window as any).__secEdit.openFile('gen/notes/big-note.md');
    }, tabs);
  }
  await open('many');
  await expect(page.locator('.se-tree-row')).not.toHaveCount(0);
  await page.waitForTimeout(3000); // idle loaders, cache writes, read threads wind down
  return { app, page };
}

/** Chrome trace (JSON, all processes) through the window's DevTools protocol, written by main. */
const startTrace = (app: ElectronApplication) =>
  app.evaluate(async ({ BrowserWindow }) => {
    const dbg = BrowserWindow.getAllWindows()[0].webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    const g = globalThis as any;
    g.__hoverTrace = { events: [] as unknown[], done: null as null | Promise<void> };
    g.__hoverTrace.done = new Promise<void>((resolve) => {
      const on = (_e: unknown, method: string, params: any) => {
        if (method === 'Tracing.dataCollected') g.__hoverTrace.events.push(...params.value);
        if (method === 'Tracing.tracingComplete') (dbg.off('message', on), resolve());
      };
      dbg.on('message', on);
    });
    const cats = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'viz', 'gpu', 'input', 'benchmark', 'toplevel'];
    await dbg.sendCommand('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: cats, excludedCategories: ['*'] } });
  });
const stopTrace = (app: ElectronApplication, file: string) =>
  app.evaluate(async ({ BrowserWindow }, file) => {
    const g = globalThis as any;
    await BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand('Tracing.end');
    await g.__hoverTrace.done;
    g.process.mainModule.require('fs').writeFileSync(file, JSON.stringify({ traceEvents: g.__hoverTrace.events }));
    g.__hoverTrace = null;
  }, file);

/** Trace summary: frames produced, busy time per thread (top-level slices), top events on the main threads. */
function summarizeTrace(file: string, rendererPid: number) {
  type Ev = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: any };
  const { traceEvents } = JSON.parse(fs.readFileSync(file, 'utf8')) as { traceEvents: Ev[] };
  const threads = new Map<string, string>();
  for (const e of traceEvents) if (e.ph === 'M' && e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args?.name);
  const where = (e: Ev) => `${e.pid === rendererPid ? 'R' : 'P' + e.pid}/${threads.get(`${e.pid}:${e.tid}`) ?? e.tid}`;
  const xs = traceEvents.filter((e) => e.ph === 'X' && e.dur).sort((a, b) => a.ts - b.ts);
  const busy = new Map<string, number>();
  const lastEnd = new Map<string, number>();
  const sum = new Map<string, { n: number; us: number }>();
  const FRAMES = ['Display::DrawAndSwap', 'ProxyMain::BeginMainFrame', 'LayerTreeHostImpl::PrepareToDraw', 'Paint', 'RasterTask', 'UpdateLayoutTree', 'Layout', 'HitTest', 'EventDispatch'];
  const frames: Record<string, number> = {};
  for (const e of xs) {
    const w = where(e);
    if (e.ts >= (lastEnd.get(w) ?? 0)) {
      busy.set(w, (busy.get(w) ?? 0) + e.dur!);
      lastEnd.set(w, e.ts + e.dur!);
    }
    if (FRAMES.includes(e.name)) frames[e.name] = (frames[e.name] ?? 0) + 1;
    if (/CrRendererMain|CrBrowserMain/.test(w)) {
      const k = `${w} ${e.name}`;
      const s = sum.get(k) ?? { n: 0, us: 0 };
      s.n++;
      s.us += e.dur!;
      sum.set(k, s);
    }
  }
  return [
    'counts ' + FRAMES.map((f) => `${f} ${frames[f] ?? 0}`).join(', '),
    'busy ms ' + [...busy].filter(([, us]) => us > 2000).sort((a, b) => b[1] - a[1]).map(([w, us]) => `${w} ${(us / 1000).toFixed(0)}`).join(', '),
    ...[...sum].sort((a, b) => b[1].us - a[1].us).slice(0, 12).map(([k, s]) => `${k}: ${s.n}× ${(s.us / 1000).toFixed(1)} ms`),
  ];
}

/** Experiments: CSS injected for one sweep each (empty = as shipped). The baseline sweeps the same pixels
 *  at the same speed, but the rows ignore the pointer: what moving the mouse costs without any hover.
 *  `pre-fix` restores the v0.3.0 hover (0.1 s transitions, `display` icon swap, classic ext 1 ↔ 0.8). */
const PHASES: Record<string, string> = {
  baseline: '.se-tree-row { pointer-events: none !important; }',
  hover: '',
  'pre-fix': `.se-tree-row { transition: background 0.1s, color 0.1s !important; } .se-tree-ext { transition: opacity 0.12s !important; }
    .se-tree-chev { display: none !important; visibility: visible !important; } .se-tree-row.dir:hover .se-tree-chev { display: block !important; }
    .ui-shelf .se-tree-row.dir:hover .se-ficon-folder { display: none !important; } .ui-classic .se-tree-row:hover .se-tree-ext { opacity: 0.8 !important; }`,
  'tree-layer': '.se-tree-inner { will-change: transform; }',
  'no-title': '',
};

async function measure(el: ElectronFixture, cfg: Cfg, display: string, x: XPointer, label: string, phases: string[]) {
  const { app, page } = await launchFor(el, cfg, display);
  const out: Array<{ phase: string; s: Sample; rows: number; mutations: number; top: string[] }> = [];
  out.push({ phase: 'idle', s: await sample(app, () => page.waitForTimeout(3000)), rows: 0, mutations: 0, top: [] });
  const traceDir = process.env.SEC_EDIT_HOVER_TRACE;
  for (const phase of phases) {
    await applyPhase(page, phase);
    let rows = 0;
    const s = await sample(app, async () => {
      rows = (await sweep(page, x, 4000)).n;
    });
    const mutations = await page.evaluate(() => (window as any).__mut as number);
    let top: string[] = [];
    if (traceDir && (phase === 'hover' || phase === 'baseline')) {
      const file = path.resolve(traceDir, `${label}-${phase}.json`);
      await startTrace(app);
      await sweep(page, x, 3000);
      await stopTrace(app, file);
      const rpid: number = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId());
      top = summarizeTrace(file, rpid);
    }
    out.push({ phase, s, rows, mutations, top });
  }
  await app.close();
  return out;
}

const fmt = (s: Sample) =>
  `CPU ${Object.entries(s.cpu)
    .filter(([, v]) => v >= 0.5)
    .map(([k, v]) => `${k} ${v.toFixed(1)}%`)
    .join(', ')} · ${PERF_KEYS.map((k) => `${k.replace('Duration', 'Ms').replace('Count', '#')} ${s.perf[k]}`).join(' ')}`;

/** A folder with 20 sub-folders and 30 notes: folders and files to hover (both have hover styles). */
function manyNotes(ws: string) {
  for (let i = 0; i < 20; i++) {
    fs.mkdirSync(path.join(ws, 'many', `folder-${i}`), { recursive: true });
    fs.writeFileSync(path.join(ws, 'many', `folder-${i}`, 'a.md'), '# a\n');
  }
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(ws, 'many', `note-${i}.md`), `# note ${i}\n`);
}

test('hover matrix (frame × style × size): CPU and renderer work per sweep', async ({ el }) => {
  test.skip(!process.env.SEC_EDIT_HOVER_MATRIX, 'set SEC_EDIT_HOVER_MATRIX=1');
  test.setTimeout(900_000);
  manyNotes(el.ws);
  const sizes = (process.env.SEC_EDIT_HOVER_SIZES ?? 'small,big').split(',');
  if (sizes.includes('big')) generate(path.join(el.ws, 'gen'), 10000, 2000);
  const display = privateDisplay();
  const x = await connectXTest(display);
  if (process.env.SEC_EDIT_HOVER_TRACE) await fsp.mkdir(process.env.SEC_EDIT_HOVER_TRACE, { recursive: true });
  try {
    const styles = (process.env.SEC_EDIT_HOVER_STYLES ?? 'shelf,classic').split(',') as Array<'shelf' | 'classic'>;
    const frames = (process.env.SEC_EDIT_HOVER_FRAMES ?? 'integrated,native').split(',') as Array<'integrated' | 'native'>;
    for (const size of sizes)
      for (const style of styles)
        for (const frame of frames) {
          const label = `${size}-${style}-${frame}`;
          const phases = (process.env.SEC_EDIT_HOVER_PHASES ?? 'baseline,hover,pre-fix').split(',');
          const r = await measure(el, { frame, style, big: size === 'big' }, display, x, label, phases);
          console.log(`[hover] ${label}\n` + r.map((p) => `  ${p.phase.padEnd(20)} ${fmt(p.s)}${p.rows ? ` · ${p.rows} rows, ${p.mutations} tree mutations` : ''}${p.top.length ? '\n    ' + p.top.join('\n    ') : ''}`).join('\n'));
        }
  } finally {
    x.close();
  }
});

/** Chromium's floor: a bare Electron window with 40 rows that change background on hover (no transitions). */
async function minimalApp(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'hover-floor', main: 'main.cjs' }));
  await fsp.writeFile(
    path.join(dir, 'main.cjs'),
    `const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => new BrowserWindow({ x: 0, y: 0, width: 1200, height: 880, backgroundColor: '#16181c' }).loadFile(require('path').join(__dirname, 'index.html')));`,
  );
  const rows = Array.from({ length: 40 }, (_, i) => `<div class="se-tree-row">row ${i}</div>`).join('');
  await fsp.writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><html data-ready="true"><style>html,body{height:100%}body{margin:0;background:#16181c;color:#ccc;font:13.5px system-ui}
.se-tree{position:absolute;left:10px;top:100px;width:260px;height:700px;overflow:auto}.se-tree-row{height:28px;line-height:28px;padding-left:8px;border-radius:8px}
.se-tree-row:hover{background:#2a2d33;color:#fff}</style><div class="se-tree">${rows}</div></html>`,
  );
}

test('hover floor: a bare Electron page with hoverable rows', async ({ el }) => {
  test.skip(!process.env.SEC_EDIT_HOVER_MATRIX, 'set SEC_EDIT_HOVER_MATRIX=1');
  const display = privateDisplay();
  const x = await connectXTest(display);
  const dir = path.join(el.tmp, 'floor');
  await minimalApp(dir);
  try {
    const { app, page } = await el.launch([], { appDir: dir, env: { DISPLAY: display } });
    await page.waitForTimeout(1500);
    const lines: string[] = [];
    for (const phase of ['baseline', 'hover']) {
      await page.evaluate((css) => {
        document.getElementById('se-hover-exp')?.remove();
        const st = Object.assign(document.createElement('style'), { id: 'se-hover-exp', textContent: css });
        document.head.append(st);
      }, PHASES[phase]);
      await page.waitForTimeout(400);
      const s = await sample(app, async () => void (await sweep(page, x, 4000)));
      lines.push(`  ${phase.padEnd(20)} ${fmt(s)}`);
    }
    console.log('[hover] floor (bare Electron page)\n' + lines.join('\n'));
  } finally {
    x.close();
  }
});

test('real pointer over the tree: one style pass per row change, no layout, no animation (shelf, integrated)', async ({ el }) => {
  test.setTimeout(90_000);
  manyNotes(el.ws);
  const display = privateDisplay();
  const x = await connectXTest(display);
  try {
    const { app, page } = await launchFor(el, { frame: 'integrated', style: 'shelf', big: false }, display);
    const run = async (phase: string) => {
      await applyPhase(page, phase);
      let sw = { n: 0, changes: 0 };
      const s = await sample(app, async () => void (sw = await sweep(page, x, 3000)));
      return { ...s, ...sw };
    };
    const base = await run('baseline');
    const hover = await run('hover');
    console.log(`[hover] real app, ${hover.n} rows, ${hover.changes} row changes\n  baseline ${fmt(base)}\n  hover    ${fmt(hover)}`);
    expect(hover.changes).toBeGreaterThan(20);
    expect(hover.perf.LayoutCount - base.perf.LayoutCount, 'layouts caused by hover').toBeLessThanOrEqual(2);
    expect(hover.perf.RecalcStyleCount - base.perf.RecalcStyleCount, 'style passes caused by hover').toBeLessThanOrEqual(Math.ceil(hover.changes * 1.5) + 4);
    await app.close();
  } finally {
    x.close();
  }
});

