// Terminal start latency + memory in the real app (bash under Xvfb). Logs the marks
// (command → panel → shells → view → spawned → ready → first output → prompt) and guards generous bounds.
import fsp from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, path } from './fixture';

async function launch(el: Parameters<Parameters<typeof test>[2]>[0]['el']) {
  const home = path.join(el.tmp, 'home');
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, '.bashrc'), 'PS1="term$ "\n');
  const r = await el.launch([el.ws], { env: { SHELL: '/bin/bash', HOME: home } });
  r.page.on('pageerror', (e) => console.log('[pageerror]', e.message, e.stack?.split('\n').slice(0, 4).join(' | ')));
  r.page.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text()));
  return r;
}

/** Runs `start` in the page and waits (in the page, 2 ms polls) until a NEW terminal shows its prompt. */
function startAndWait(page: Page, how: 'ctrl-backquote' | 'launcher') {
  return page.evaluate(async (how) => {
    const w = window as any;
    const sessions = () => w.__secEditTerminal?.manager.sessions.value.length ?? 0;
    const n0 = sessions();
    const t0 = performance.now();
    if (how === 'launcher') (document.querySelector('[data-testid="terminal-new"]') as HTMLElement).click();
    else window.dispatchEvent(new KeyboardEvent('keydown', { key: '`', code: 'Backquote', ctrlKey: true, bubbles: true, cancelable: true }));
    let visible = 0;
    for (;;) {
      if (!visible && document.querySelector('[data-testid="terminal-panel"]')) visible = performance.now() - t0;
      const m = w.__secEditTerminal?.manager;
      if (m && sessions() > n0 && (m.active?.view.element.textContent ?? '').includes('term$')) break;
      if (performance.now() - t0 > 20000) {
        const m2 = w.__secEditTerminal?.manager;
        throw new Error(`no prompt: ${JSON.stringify({ how, open: w.__secEditTerminal?.panelOpen?.value, panel: !!document.querySelector('[data-testid="terminal-panel"]'), impl: !!m2, sessions: sessions(), n0, stats: m2?.stats(), err: m2?.error.value, text: m2?.active?.view.element.textContent?.slice(0, 200), toasts: w.__secEdit.toasts.value.map((t: any) => t.message) })}`);
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    const total = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 200)); // let the "prompt" mark settle
    const T = w.__secEditTerminal.manager.timings.at(-1);
    const rel: Record<string, number> = {};
    for (const [k, v] of Object.entries(T)) {
      if (typeof v === 'number' && k !== 't0') rel[k] = Math.round(v - T.t0);
      if (typeof v === 'boolean') rel[k] = v ? 1 : 0;
    }
    return { total: Math.round(total), panelVisible: Math.round(visible), marks: rel };
  }, how);
}

test('terminal start latency: first after launch, first after idle, subsequent', async ({ el }) => {
  test.setTimeout(120000);
  const results: Record<string, unknown> = {};
  {
    const { page, app } = await launch(el);
    results.coldFirst = await startAndWait(page, 'ctrl-backquote'); // right after ready: chunks may still be loading
    const next: unknown[] = [];
    for (let i = 0; i < 5; i++) next.push(await startAndWait(page, 'launcher'));
    results.subsequent = next;
    // "Keep a terminal ready": the next new terminal is the spare (shell already started).
    await page.evaluate(() => {
      const a = (window as any).__secEdit;
      a.settings.value = { ...a.settings.value, 'terminal.prewarm': true };
    });
    await startAndWait(page, 'launcher'); // schedules the first spare
    const warm: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      await page.waitForFunction(() => !!(window as any).__secEditTerminal.manager.spareSession?.outputSeen, null, { timeout: 10000 });
      warm.push(await startAndWait(page, 'launcher'));
    }
    results.prewarmed = warm;
    await app.close();
  }
  {
    const { page, app } = await launch(el);
    await page.waitForTimeout(5000); // the app went idle: idle preloads had their chance
    results.preloaded = await page.evaluate(() => ({ resources: performance.getEntriesByType('resource').length, impl: !!(window as any).__secEditTerminal, shells: !!(window as any).__secEditTerminal?.manager.shells.value }));
    results.idleFirst = await startAndWait(page, 'ctrl-backquote');
    await app.close();
  }
  console.log(`[terminal-perf] ${JSON.stringify(results)}`);
  const sub = results.subsequent as Array<{ total: number }>;
  expect((results.idleFirst as { total: number }).total).toBeLessThan(3000);
  expect(Math.max(...sub.map((s) => s.total))).toBeLessThan(2000);
  for (const w of results.prewarmed as Array<{ marks: { prewarmed?: number } }>) expect(w.marks.prewarmed).toBe(1); // taken from the spare
});

test('memory: 50 open/close cycles leave nothing behind; scrollback cost per terminal', async ({ el }) => {
  test.setTimeout(180000);
  const { page, app } = await launch(el);
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    return page.evaluate(() => (performance as any).memory.usedJSHeapSize as number);
  };
  const nodes = () => page.evaluate(() => document.getElementsByTagName('*').length);
  const bashKids = async () => {
    const { execFileSync } = await import('node:child_process');
    try {
      return execFileSync('pgrep', ['-P', String(app.process().pid), '-x', 'bash'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length;
    } catch {
      return 0;
    }
  };
  await startAndWait(page, 'ctrl-backquote'); // one terminal stays open (the panel stays up)
  const cycle = async () => {
    await startAndWait(page, 'launcher');
    await page.evaluate(async () => {
      const m = (window as any).__secEditTerminal.manager;
      await m.close(m.active.id);
    });
  };
  for (let i = 0; i < 5; i++) await cycle(); // warm caches / JIT first
  await page.waitForTimeout(500);
  const h0 = await heap();
  const n0 = await nodes();
  for (let i = 0; i < 25; i++) await cycle();
  await page.waitForTimeout(1500);
  const h25 = await heap();
  for (let i = 0; i < 25; i++) await cycle();
  await page.waitForTimeout(1500); // exits + flush timers settle
  const h1 = await heap();
  const n1 = await nodes();
  const stats = await page.evaluate(() => (window as any).__secEditTerminal.manager.stats());
  await expect.poll(bashKids, { timeout: 5000 }).toBe(1); // only the one still open

  // Per-terminal cost of a full scrollback (2000 = new default, 5000 = old one), 160 columns of output.
  const fill = async (lines: number) => {
    await page.evaluate((n) => {
      const a = (window as any).__secEdit;
      a.settings.value = { ...a.settings.value, 'terminal.scrollback': n };
    }, lines);
    await startAndWait(page, 'launcher');
    const before = await heap();
    await page.keyboard.type(`for i in $(seq 1 ${lines + 500}); do printf '%0160d\\n' $i; done; echo FILLED\n`);
    await expect.poll(() => page.evaluate(() => (window as any).__secEditTerminal.manager.active.view.allText().includes('\nFILLED')), { timeout: 30000 }).toBe(true);
    const after = await heap();
    await page.evaluate(async () => {
      const m = (window as any).__secEditTerminal.manager;
      await m.close(m.active.id);
    });
    return Math.round((after - before) / 1e5) / 10;
  };
  const mb2000 = await fill(2000);
  const mb5000 = await fill(5000);
  console.log(`[terminal-mem] ${JSON.stringify({ heapGrowthKB: Math.round((h1 - h0) / 1024), heapGrowthKB_first25: Math.round((h25 - h0) / 1024), heapGrowthKB_last25: Math.round((h1 - h25) / 1024), domNodes: n1 - n0, stats, scrollbackMB: { 2000: mb2000, 5000: mb5000 } })}`);
  expect(n1 - n0).toBeLessThan(20);
  expect(h1 - h0).toBeLessThan(3 * 1024 * 1024);
  expect(stats).toMatchObject({ sessions: 1, spare: 0, early: 0, earlyExit: 0, hostWaiters: 0 });
});

test('stress: first Ctrl+` right after launch always opens a usable terminal', async ({ el }) => {
  test.skip(!process.env.SEC_EDIT_TERM_STRESS, 'set SEC_EDIT_TERM_STRESS=1');
  test.setTimeout(300000);
  for (let i = 0; i < 8; i++) {
    const { page, app } = await launch(el);
    await startAndWait(page, 'ctrl-backquote');
    await app.close();
  }
});

