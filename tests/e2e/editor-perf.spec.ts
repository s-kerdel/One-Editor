import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { cpuLoadMeter, describeLoad, skipIfBusy } from './cpu-load';

test.use({ trace: 'off' }); // trace snapshots of a 1 MB DOM make every Playwright call slow

// A realistic note chunk (~2 KB): headings, prose with inline markup, lists, tasks, a table, code, a callout.
function chunk(i: number): string {
  return [
    `## Section ${i}`,
    '',
    `Some **bold** and *italic* text with \`inline code\`, a [[README]] link, a [link](https://example.com/${i}) and #tag${i % 7}. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor. '.repeat(3)}`,
    '',
    `- item one with ==highlight==`,
    `- item two`,
    `  - nested item ${i}`,
    `- [ ] task ${i}`,
    `- [x] done task`,
    '',
    '| Name | Value |',
    '|------|-------|',
    `| a    | ${i}  |`,
    '',
    '```js',
    `const x${i} = ${i};`,
    'console.log(x);',
    '```',
    '',
    '> [!note] Callout',
    `> Body text ${i} with $x^2$ math.`,
    '',
    `${'Another paragraph of prose to make the note longer. '.repeat(8)}`,
    '',
  ].join('\n');
}

function makeNote(bytes: number): string {
  let out = '---\ntitle: Perf\ntags: [a, b]\n---\n\n# Perf note\n\n';
  for (let i = 0; out.length < bytes; i++) out += chunk(i);
  return out;
}

async function measureTyping(page: Page, path: string, text: string, at: number) {
  await page.evaluate(
    ({ p, at }) => {
      const app = (window as any).__secEdit;
      const view = app.editor.getView();
      const doc: string = view.state.doc.toString();
      // Middle of a prose line near `at` so typing hits live-preview decorations, not code.
      const idx = doc.indexOf('Lorem ipsum', at);
      view.dispatch({ selection: { anchor: idx + 5 }, scrollIntoView: true });
      view.focus();
      const w = window as any;
      w.__lat = [];
      w.__long = [];
      if (!w.__latInstalled) {
        w.__latInstalled = true;
        new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ type: 'longtask' });
        document.addEventListener(
          'keydown',
          () => {
            const t0 = performance.now();
            // rAF fires before the frame that shows the keystroke; the macrotask after it runs once that frame is done.
            requestAnimationFrame(() => setTimeout(() => w.__lat.push(performance.now() - t0), 0));
          },
          true,
        );
      }
      void p;
    },
    { p: path, at },
  );
  await page.waitForTimeout(300); // let the viewport settle after scrolling
  await page.keyboard.type(text, { delay: 40 });
  await page.waitForTimeout(200);
  const r = await page.evaluate(() => {
    const w = window as any;
    const lat: number[] = w.__lat.slice().sort((a: number, b: number) => a - b);
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
    return { n: lat.length, median: q(0.5), p95: q(0.95), max: lat[lat.length - 1], longTasks: w.__long.length, maxLong: Math.max(0, ...w.__long) };
  });
  return r;
}

/** Synchronous cost of one typed character: dispatch + decoration rebuild + DOM update (no paint). */
async function measureDispatch(page: Page, n: number) {
  return page.evaluate((n) => {
    const view = (window as any).__secEdit.editor.getView();
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const pos = view.state.selection.main.head;
      const t0 = performance.now();
      view.dispatch({ changes: { from: pos, insert: 'x' }, selection: { anchor: pos + 1 }, userEvent: 'input.type' });
      (view as any).measure?.(); // force the layout read CodeMirror would do in the next frame
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[Math.floor(n / 2)], p95: times[Math.floor(n * 0.95)], max: times[n - 1] };
  }, n);
}

// Budgets: CPU per keystroke (dispatch + decorations + DOM) and key → next painted frame (frame-aligned,
// so ~8–17 ms at 60 Hz even for zero work). Typical notes must stay well inside one frame.
for (const [label, size, cpuBudget, frameBudget] of [
  ['20 KB', 20_000, 8, 20],
  ['290 KB', 290_000, 16, 34],
  ['950 KB', 950_000, 25, 50],
  ['1 MB', 1_000_000, 25, 50],
] as const) {
  test(`typing latency in live mode: ${label} note`, async ({ page, ws }) => {
    test.setTimeout(90_000);
    const note = makeNote(size);
    await ws.write(`perf-${size}.md`, note);
    await ws.open(page);
    await page.waitForFunction((p) => (window as any).__secEdit.files.value.includes(p), `perf-${size}.md`);
    await page.evaluate((p) => (window as any).__secEdit.openFile(p), `perf-${size}.md`);
    await expect(page.locator('.cm-content')).toContainText('Perf note');
    await page.waitForTimeout(500);
    const meter = cpuLoadMeter();
    const top = await measureTyping(page, `perf-${size}.md`, 'quick brown fox jumps', Math.floor(note.length * 0.02));
    const mid = await measureTyping(page, `perf-${size}.md`, 'lazy dog again here', Math.floor(note.length * 0.5));
    const sync = await measureDispatch(page, 60);
    const load = meter.stop();
    console.log(
      `[latency] ${label} (${(note.length / 1000).toFixed(0)}K chars): key→frame top median ${top.median.toFixed(1)} p95 ${top.p95.toFixed(1)} max ${top.max.toFixed(1)} ms; ` +
        `mid median ${mid.median.toFixed(1)} p95 ${mid.p95.toFixed(1)} max ${mid.max.toFixed(1)} ms; long tasks ${top.longTasks + mid.longTasks} (max ${Math.max(top.maxLong, mid.maxLong).toFixed(0)} ms); ` +
        `dispatch+measure median ${sync.median.toFixed(2)} p95 ${sync.p95.toFixed(2)} max ${sync.max.toFixed(2)} ms`,
    );
    console.log(`[latency] ${label}: ${describeLoad(load)}`);
    skipIfBusy(load, `${label} typing`);
    expect(sync.median).toBeLessThan(cpuBudget);
    expect(top.median).toBeLessThan(frameBudget);
    expect(mid.median).toBeLessThan(frameBudget);
  });
}

/** ms from the call until the frame after it has been painted. */
async function timeToFrame(page: Page, fn: string, arg: unknown): Promise<number> {
  return page.evaluate(
    async ({ fn, arg }) => {
      const app = (window as any).__secEdit;
      const t0 = performance.now();
      await (new Function('app', 'arg', `return (${fn})(app, arg)`) as (a: unknown, b: unknown) => Promise<void>)(app, arg);
      await new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    },
    { fn, arg },
  );
}

const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('perf report: note open, tab switch, scroll decorations, 20-tab memory', async ({ page, ws }) => {
  test.setTimeout(120_000);
  const small = makeNote(20_000);
  const big = makeNote(1_000_000);
  const mid = makeNote(290_000);
  for (let i = 0; i < 20; i++) await ws.write(`perf-tab${i}.md`, small.replace('# Perf note', `# Perf note ${i}`));
  await ws.write('perf-big.md', big);
  await ws.write('perf-mid.md', mid);
  await ws.open(page);
  await page.waitForFunction(() => (window as any).__secEdit.files.value.includes('perf-big.md') && !!(window as any).__secEdit.editor);
  const open = (p: string) => timeToFrame(page, '(app, p) => app.openFile(p)', p);

  // First open (read + state creation + parse + decorations + first paint) and re-activation of an open tab.
  await open('README.md'); // warm-up: lazy chunks, fonts, JIT
  const openSmall = await open('perf-tab0.md');
  const openBig = await open('perf-big.md');
  const switches: number[] = [];
  const switchesBig: number[] = [];
  await open('perf-tab1.md');
  for (let i = 0; i < 6; i++) {
    switches.push(await open(i % 2 ? 'perf-tab1.md' : 'perf-tab0.md'));
    switchesBig.push(await open('perf-big.md'));
    await open('perf-tab1.md');
  }

  // Scrolling a long note in live mode: synchronous cost of viewport update + decoration rebuild + DOM.
  await open('perf-mid.md');
  await page.waitForTimeout(300);
  const scroll = await page.evaluate(() => {
    const view = (window as any).__secEdit.editor.getView();
    const times: number[] = [];
    for (let i = 1; i <= 80; i++) {
      const t0 = performance.now();
      view.scrollDOM.scrollTop = i * 900;
      view.measure();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { median: times[40], p95: times[76], max: times[79] };
  });

  // Heap after GC with 20 small notes + the two big ones open.
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    return ((await cdp.send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize / 1048576;
  };
  const before = await heap();
  for (let i = 2; i < 20; i++) await open(`perf-tab${i}.md`);
  const after20 = await heap();

  console.log(
    `[perf] open 20 KB ${openSmall.toFixed(0)} ms, open 1 MB ${openBig.toFixed(0)} ms; tab switch 20 KB median ${median(switches).toFixed(1)} ms, to 1 MB median ${median(switchesBig).toFixed(1)} ms; ` +
      `scroll 290 KB step median ${scroll.median.toFixed(2)} p95 ${scroll.p95.toFixed(2)} max ${scroll.max.toFixed(2)} ms; ` +
      `heap ${before.toFixed(1)} MB (4 notes) → ${after20.toFixed(1)} MB (22 notes), +${((after20 - before) / 18).toFixed(2)} MB per 20 KB tab`,
  );
  expect(openSmall).toBeLessThan(400);
  expect(median(switches)).toBeLessThan(60);
  expect(scroll.median).toBeLessThan(25);
});
