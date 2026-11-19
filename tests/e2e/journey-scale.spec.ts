// Journey 6 — "Big-ish workspace sanity": 1,500 notes. Boot stays under a second, quick open and search
// answer within 300 ms of the last keystroke, measured inside the page.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './harness';
import { active, cursor, indexesReady, reload } from './journey.helpers';

const N = 1500;
const id = (i: number) => String(i).padStart(4, '0');
const relOf = (i: number) => `bulk/d${String(i % 30).padStart(2, '0')}/note-${id(i)}.md`;

function generate(root: string) {
  for (let d = 0; d < 30; d++) fs.mkdirSync(path.join(root, 'bulk', `d${String(d).padStart(2, '0')}`), { recursive: true });
  for (let i = 0; i < N; i++) {
    const body = [
      `# Note ${id(i)}`,
      '',
      `Service notes for cluster ${i % 17}, see [[note-${id((i + 1) % N)}]] and #team/${i % 9}.`,
      '',
      '```bash',
      `kubectl scale deployment/svc-${id(i)} --replicas=${(i % 5) + 1} --namespace=team-${i % 9}`,
      `docker build -t registry.example.test/svc-${id(i)}:latest .`,
      '```',
      '',
      'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, relOf(i)), body);
  }
}

/**
 * Milliseconds between the user's last keystroke/input and the moment an element matching
 * `selector` containing `text` is on screen. Measured in the page (no Playwright polling latency).
 */
async function armTimer(page: Page, selector: string, text: string) {
  await page.evaluate(
    ([sel, txt]) => {
      (window as any).__qaTimer = new Promise<number>((resolve) => {
        let last = 0;
        const mark = () => (last = performance.now());
        window.addEventListener('input', mark, true);
        const check = () => {
          const found = last && [...document.querySelectorAll(sel)].some((el) => (el.textContent ?? '').includes(txt));
          if (!found) return void requestAnimationFrame(check);
          window.removeEventListener('input', mark, true);
          resolve(Math.max(0, performance.now() - last));
        };
        requestAnimationFrame(check);
      });
    },
    [selector, text] as const,
  );
}
const readTimer = (page: Page) => page.evaluate(() => (window as any).__qaTimer as Promise<number>);

test('1,500 notes: boot < 1 s, quick open and search respond < 300 ms', async ({ page, ws }) => {
  test.setTimeout(90_000);
  generate(ws.root);

  // Boot: navigation start → html[data-ready], recorded in the page. Best of 3 so a busy box does not fail us.
  await page.addInitScript(() => {
    new MutationObserver((_, o) => {
      if (document.documentElement?.dataset.ready !== 'true') return;
      (window as any).__qaReadyAt = performance.now(); // relative to navigation start
      o.disconnect();
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-ready'] }); // <html> may not exist yet
  });
  const boots: number[] = [];
  for (let i = 0; i < 3; i++) {
    if (i) await reload(page);
    else await ws.open(page);
    boots.push(await page.evaluate(() => (window as any).__qaReadyAt as number));
  }
  console.log(`[journey scale] boot → ready (ms): ${boots.map((x) => x.toFixed(0)).join(', ')}`);
  await expect(page.locator('.se-tree-row[data-path="bulk"]')).toBeVisible();

  await indexesReady(page);
  await page.evaluate(() => (window as any).__secEditSearch.whenReady());
  expect(await page.evaluate(() => (window as any).__secEditSearch.indexed.value)).toBeGreaterThanOrEqual(N);

  // Quick open by file name.
  await page.keyboard.press('Control+p');
  await expect(page.getByRole('dialog').locator('input')).toBeFocused();
  await armTimer(page, '.se-pal-item', 'note-1234.md');
  await page.keyboard.type('note1234');
  const quickMs = await readTimer(page);
  await expect(page.locator('.se-pal-item').first()).toContainText('note-1234.md');
  await page.keyboard.press('Enter');
  await expect.poll(() => active(page)).toBe(relOf(1234));

  // Full-text search for a command that exists in exactly one of the 1,500 notes.
  await page.keyboard.press('Control+Shift+f');
  const input = page.getByLabel('Search query');
  await expect(input).toBeFocused();
  const cmd = 'kubectl scale deployment/svc-0777 --replicas=3 --namespace=team-3';
  await armTimer(page, `.se-sr-match[data-path="${relOf(777)}"]`, 'svc-0777');
  await input.fill(cmd);
  const searchMs = await readTimer(page);
  const engineMs = await page.locator('.se-search-summary').innerText();
  console.log('[journey scale] summary:', engineMs);
  await expect(page.locator('.se-sr-match')).toHaveCount(1);
  await expect(page.locator('.se-sr-match .se-badge-code')).toHaveText('bash');
  await expect(page.locator('.se-search-summary')).toContainText('in 1 file');

  // A broad term (in every note) must not freeze the UI either.
  await armTimer(page, '.se-search-summary', 'files');
  await input.fill('--namespace=team-4');
  const broadMs = await readTimer(page);
  await expect(page.locator('.se-search-summary')).toContainText(/in 16[67] files/);

  await input.fill(cmd);
  await expect(page.locator('.se-sr-match')).toHaveCount(1);
  await input.press('Enter');
  await expect.poll(() => cursor(page)).toMatchObject({ path: relOf(777), line: 5, sel: cmd });

  console.log(`[journey scale] quick open ${quickMs.toFixed(0)} ms, search ${searchMs.toFixed(0)} ms, broad search ${broadMs.toFixed(0)} ms`);
  expect(Math.min(...boots)).toBeLessThan(1000);
  expect(quickMs).toBeLessThan(300);
  expect(searchMs).toBeLessThan(300);
  expect(broadMs).toBeLessThan(300);
});
