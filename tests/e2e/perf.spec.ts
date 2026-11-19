// Launch-speed regression guards (browser mode, fixture workspace):
//   · startup JS stays under budget (what index.html pulls in before first paint)
//   · boot → ready is fast, and only startup + editor chunks are requested before ready
//   · heavy libraries (Prettier, Shiki, KaTeX, Mermaid, graph) are never requested until needed
//   · lazily loaded features still obey shortcuts pressed while their chunk is in flight
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect, RENDERER_DIR } from './harness';
// @ts-expect-error plain .mjs helper without types
import { startupAssets, startupTotals } from '../perf/bundle-report.mjs';

/** Budgets for the code parsed before first paint (minified bytes on disk / gzip -9). */
// Target is < 100 kB (99.0 kB when this guard was written); the hard limit leaves ~5% for small shell changes.
const STARTUP_JS_TARGET = 100_000;
// Hard guard against accidental heavy imports at startup (a stray Shiki/Prettier import is MBs).
// Raised 104 → 110 kB (2026-11-19) to fit both sidebar styles, the appearance system and the status
// breadcrumb; measured boot → ready stayed ~45 ms. The 100 kB target above still warns.
const STARTUP_JS_BUDGET = 110_000;
// Raised 40 000 → 41 000 B (2026-11-19, approved by the lead) for git: the Source control pill (icon +
// lazy panel), the idle loader and the tree / status-bar slots cost ~760 B gzip (measured 40 547).
// Everything else git (store, marks, gutter, diff view, pane, CSS) stays in lazy chunks.
const STARTUP_JS_GZIP_BUDGET = 41_000;
const STARTUP_CSS_BUDGET = 40_000;
/** Renderer boot (module start → ready) on the fixture workspace. */
const BOOT_BUDGET_MS = 150;

const HEAVY = /katex|mermaid|standalone|shiki|onig|\.wasm|cytoscape|elk|babel|estree|postcss|typescript-|GraphView|plugin-/i;
const assetName = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

/** Static-import closure of the given chunks (what loading them necessarily pulls in). */
function closure(names: string[]): Set<string> {
  const dir = path.join(RENDERER_DIR, 'assets');
  const seen = new Set<string>();
  const queue = [...names];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !fs.existsSync(path.join(dir, f))) continue;
    seen.add(f);
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/(?:^|[;}\n])\s*(?:import|export)\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) queue.push(m[1]);
  }
  return seen;
}

const chunks = (re: RegExp) => fs.readdirSync(path.join(RENDERER_DIR, 'assets')).filter((f) => re.test(f));

function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/assets/')) urls.push(assetName(r.url()));
  });
  return urls;
}

test('startup bundle stays within budget and contains no lazy feature code', () => {
  const t = startupTotals(RENDERER_DIR) as { js: number; jsGzip: number; css: number; assets: Array<{ file: string; bytes: number }> };
  console.log(`[perf] startup JS ${(t.js / 1000).toFixed(1)} kB (gzip ${(t.jsGzip / 1000).toFixed(1)} kB) in ${t.assets.filter((a) => a.file.endsWith('.js')).length} chunks, CSS ${(t.css / 1000).toFixed(1)} kB`);
  if (t.js >= STARTUP_JS_TARGET) console.warn(`[perf] startup JS is over the ${STARTUP_JS_TARGET / 1000} kB target — run: node tests/perf/bundle-report.mjs <renderer dir>`);
  expect(t.js, 'startup JS bytes').toBeLessThan(STARTUP_JS_BUDGET);
  expect(t.jsGzip, 'startup JS gzip bytes').toBeLessThan(STARTUP_JS_GZIP_BUDGET);
  expect(t.css, 'startup CSS bytes').toBeLessThan(STARTUP_CSS_BUDGET);
  // Feature implementations must stay behind import(): their marker strings may not appear at startup.
  const startupSrc = t.assets
    .filter((a) => a.file.endsWith('.js'))
    .map((a) => fs.readFileSync(path.join(RENDERER_DIR, a.file), 'utf8'))
    .join('\n');
  for (const marker of ['se-search-summary', 'se-palette-input', 'se-kn-', 'sec-edit-search', 'Document changed while formatting', 'se-settings', 'se-menu-item', 'se-welcome', 'se-ov-sec']) {
    expect(startupSrc.includes(marker), `"${marker}" leaked into the startup chunks`).toBe(false);
  }
});

test('boots fast; only startup + editor chunks are fetched before ready', async ({ page, ws }) => {
  const boots: number[] = [];
  let early: string[] = [];
  for (let i = 0; i < 3; i++) {
    await ws.open(page);
    const r = await page.evaluate(() => {
      const t = (window as any).__secEditTimings as Record<string, number>;
      const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return { boot: (window as any).__secEditBootMs as number, early: res.filter((e) => e.startTime < t.ready && e.name.includes('/assets/')).map((e) => e.name), timings: t };
    });
    boots.push(Math.round(r.boot * 10) / 10);
    early = r.early.map(assetName);
  }
  console.log(`[perf] boot → ready: ${boots.join(', ')} ms (budget ${BOOT_BUDGET_MS}); ${early.length} assets before ready`);
  // Best of three: one slow sample on a loaded box is noise, three are a regression.
  expect(Math.min(...boots), 'renderer boot → ready').toBeLessThan(BOOT_BUDGET_MS);

  const startup = (startupAssets(RENDERER_DIR) as Array<{ file: string }>).map((a) => path.basename(a.file));
  // The editor is deliberately fetched in parallel with boot (session restore needs it).
  const allowed = closure([...startup, ...chunks(/^(editor|languages|Welcome)-.*\.(js|css)$/)]);
  for (const f of chunks(/^editor-.*\.css$/)) allowed.add(f);
  const unexpected = early.filter((f) => /\.(js|css)$/.test(f) && !allowed.has(f));
  expect(unexpected, 'chunks requested before ready that are not on the startup path').toEqual([]);
  expect(early.filter((f) => HEAVY.test(f))).toEqual([]);
});

test('heavy libraries and workers load only when needed', async ({ page, ws }) => {
  const requested = trackRequests(page);
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(assetName(w.url())));
  // By role: the knowledge extractor has its own chunk name; search and format workers are both "worker-*".
  const knowledgeWorkers = () => workers.filter((w) => /^extract-worker-/.test(w));
  const otherWorkers = () => workers.filter((w) => !/^extract-worker-/.test(w));
  await ws.open(page);
  // Idle after boot: search + knowledge + format stubs pull their chunks, the search worker indexes —
  // note metadata for the knowledge index included (no separate extraction worker for a build).
  await page.waitForFunction(() => (window as any).__secEditSearch?.status.value === 'ready' && (window as any).__secEditKnowledgeReady === true, null, { timeout: 15000 });
  expect(otherWorkers().length, `only the search worker runs after an idle boot (got ${workers.join(', ')})`).toBe(1);
  expect(knowledgeWorkers().length, 'no extraction worker just for the build').toBe(0);
  expect(requested.filter((f) => HEAVY.test(f)), 'heavy chunks fetched without any user action').toEqual([]);

  // Plain typing in a prose note needs none of them either.
  await page.locator('.se-tree-row', { hasText: 'notes' }).first().click();
  await page.locator('.se-tree-row', { hasText: 'windows-crlf' }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.type('hello');
  await page.waitForTimeout(300);
  expect(requested.filter((f) => /standalone|babel|estree|postcss|mermaid|cytoscape|elk|GraphView/i.test(f)), 'formatter / diagram chunks fetched while just typing').toEqual([]);
  expect(otherWorkers().length, 'no formatter worker until something is formatted').toBe(1);

  // …and the formatter arrives on demand.
  await page.keyboard.press('Shift+Alt+f');
  await expect.poll(() => otherWorkers().length, { timeout: 15000 }).toBe(2);
  expect(knowledgeWorkers().length).toBe(0);
});

test('shortcuts pressed while a lazy chunk is still loading are queued, typed text included', async ({ page, ws }) => {
  // Hold back the search/palette implementation so the key press definitely races the load.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  await page.route(/\/assets\/impl-[^/]+\.js$/, async (route) => {
    held++;
    await gate;
    await route.continue();
  });
  await ws.open(page);
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click();
  await expect(page.locator('.cm-content')).toContainText('Welcome');
  await page.locator('.cm-content').click();
  const before = await page.evaluate(() => (window as any).__secEdit.editor.getContent());

  await page.keyboard.press('Control+p');
  await page.keyboard.type('deepnote');
  expect(await page.locator('[role="dialog"]').count(), 'palette cannot be open yet: its chunk is held back').toBe(0);
  expect(held).toBeGreaterThan(0);
  release();

  const input = page.getByRole('dialog').locator('input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('deepnote');
  expect(await page.evaluate(() => (window as any).__secEdit.editor.getContent()), 'typed-ahead text must not leak into the editor').toBe(before);
  await page.keyboard.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('needle in a haystack');
});

test('lazy panels and overlays open from a cold start', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  // No waiting for idle preloads: every one of these must work straight after ready.
  await page.keyboard.press('Control+Shift+f');
  await expect(page.getByLabel('Search query')).toBeFocused();
  await page.keyboard.press('Control+Alt+o');
  await expect(page.locator('.se-sidebar[data-panel="outline"]')).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.locator('.se-settings, [aria-label="Settings"][role="dialog"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.se-nav-btn[data-panel="files"]').click();
  await page.locator('.se-tree-row', { hasText: 'README.md' }).click({ button: 'right' });
  await expect(page.locator('.se-menu-item', { hasText: 'Rename' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type('format on save');
  await expect(page.getByRole('dialog').locator('input')).toHaveValue('>format on save');
  await expect(page.locator('.se-pal-item[data-command-id="format.toggleOnSave"]')).toBeVisible();
  expect(errors).toEqual([]);
});
