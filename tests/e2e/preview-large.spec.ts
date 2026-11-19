import type { Page } from '@playwright/test';
import { test, expect } from './harness';

test.use({ trace: 'off' }); // trace snapshots of a 1 MB DOM make every Playwright call take seconds

const P = '.se-preview';
async function setMode(page: Page, mode: 'split' | 'preview') {
  await page.evaluate(async (m) => {
    const app = (window as any).__secEdit;
    app.settings.value = await app.backend.saveSettings({ viewMode: m });
    app.editor?.setViewMode(m);
    app.events.emit('settings:changed', app.settings.value);
  }, mode);
}

test('1 MB document: first render under 300 ms, non-blocking mount, incremental edits', async ({ page, ws }) => {
  const chunk = (i: number) =>
    `## Chapter ${i}\n\nSome *text* with \`code\`, a [[README]] link, #tag and $x^${i}$ math. ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}\n\n- [ ] task ${i}\n- item\n\n| a | b |\n|---|---|\n| 1 | ${i} |\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\n`;
  let src = '# Big\n\n';
  let chapters = 0;
  for (; src.length < 1_050_000; chapters++) src += chunk(chapters);
  await ws.write('big.md', src);
  await ws.open(page);
  await setMode(page, 'split');
  const m = await page.evaluate(async (total) => {
    const app = (window as any).__secEdit;
    const long: number[] = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => long.push(e.duration))).observe({ entryTypes: ['longtask'] });
    const t0 = performance.now();
    await app.openFile('big.md');
    const count = () => document.querySelectorAll('.se-preview h2').length;
    let firstPaint = 0;
    const all = await new Promise<number>((res) => {
      const tick = () => {
        if (count() && !firstPaint) firstPaint = performance.now() - t0;
        if (count() >= total) res(performance.now() - t0);
        else setTimeout(tick, 16);
      };
      tick();
    });
    return { firstPaint, all, firstRender: Number((document.querySelector('.se-preview') as HTMLElement).dataset.renderMs), maxLongTask: Math.max(0, ...long) };
  }, chapters);
  console.log(`1MB doc (${(src.length / 1e6).toFixed(2)} MB, ${chapters} sections): first render ${m.firstRender} ms, visible ${m.firstPaint.toFixed(0)} ms after open, fully mounted ${m.all.toFixed(0)} ms, longest main-thread task ${m.maxLongTask.toFixed(0)} ms`);
  expect(m.firstRender).toBeLessThan(300);
  expect(m.firstPaint).toBeLessThan(1000);
  expect(m.maxLongTask).toBeLessThan(1000); // whole app (editor loading 1 MB included); typically ~100-250 ms
  const pv = page.locator(P);
  await expect(pv.locator('h1')).toHaveText('Big');

  // Full pass over an unchanged document (split + diff, no DOM work).
  const noop = await page.evaluate(() => {
    const app = (window as any).__secEdit;
    const text = app.editor.getContent();
    const t0 = performance.now();
    app.preview.render('big.md', text);
    return performance.now() - t0;
  });
  // An edit re-renders one section only; untouched sections keep their DOM nodes.
  await pv.locator('.se-sec').nth(500).evaluate((el) => ((el as any).__keep = true));
  const edit = await page.evaluate(() => {
    const app = (window as any).__secEdit;
    const text = app.editor.getContent().replace('## Chapter 3\n', '## Chapter 3 edited\n\nInserted paragraph.\n');
    const t0 = performance.now();
    app.preview.render('big.md', text);
    return performance.now() - t0;
  });
  console.log(`1MB doc: unchanged re-render ${noop.toFixed(1)} ms, single edit ${edit.toFixed(1)} ms`);
  expect(noop).toBeLessThan(100);
  expect(edit).toBeLessThan(100);
  await expect(pv.locator('h2', { hasText: 'Chapter 3 edited' })).toHaveCount(1);
  expect(await pv.locator('.se-sec').nth(500).evaluate((el) => (el as any).__keep)).toBe(true);

  // Jumping far into the document lands exactly on the requested line.
  const target = await page.evaluate(() => (window as any).__secEdit.editor.getContent().split('\n').indexOf('## Chapter 1500'));
  await page.evaluate((l) => (window as any).__secEdit.preview.scrollToLine(l), target);
  await page.waitForTimeout(400);
  const off = await page.evaluate(() => {
    const host = document.querySelector('.se-preview-scroller')!;
    const h = [...host.querySelectorAll('h2')].find((x) => x.textContent!.startsWith('Chapter 1500'))!;
    return h.getBoundingClientRect().top - host.getBoundingClientRect().top;
  });
  expect(Math.abs(off)).toBeLessThan(40);
  // Code near the viewport gets highlighted lazily; far away blocks are left alone.
  await expect.poll(() => page.evaluate(() => document.querySelectorAll('.se-preview .se-code[data-hl="1"]').length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.querySelectorAll('.se-preview .se-code[data-hl="1"]').length)).toBeLessThan(200);
});
