// Status-bar corner (far right: │ MCP · web server · shield). All three are desktop features, tested in
// tests/e2e/electron/ (mcp-corner, web-server, update-check). Here, browser mode: the corner stays empty —
// no icons, no │ — and the chunk that carries the MCP icon and the web-server pill is never fetched.
import { test, expect } from './harness';

test('browser build: empty corner, no │, and no corner chunk fetched', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.open(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  // The open file's items are in (the corner would follow them)…
  await expect(page.locator('.se-status [data-testid="language"]')).toBeVisible();
  // …and the idle Popups chunk, which pulls the corner's chunks in on the desktop, has loaded.
  await expect.poll(() => page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/Popups-[\w-]+\.js$/.test(e.name)))).toBe(true);
  await page.waitForTimeout(300);

  await expect(page.locator('.se-status-corner')).toHaveCount(0);
  await expect(page.locator('[data-testid="mcp-indicator"], [data-testid="webserver-pill"], [data-testid="updates-shield"]')).toHaveCount(0);
  // The status bar ends with the file's own items (view mode / language), no separator after them.
  const last = await page.locator('.se-status').evaluate((bar) => {
    const el = bar.lastElementChild as HTMLElement;
    return { cls: el.className, after: getComputedStyle(el, '::after').content, before: getComputedStyle(el, '::before').content };
  });
  expect(last.cls).not.toContain('se-status-corner');
  expect([last.after, last.before]).toEqual(['none', 'none']);
  const fetched = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
  expect(fetched.filter((n) => /web-server-ui|mcp-ui|updates-ui/.test(n))).toEqual([]);
  expect(errors).toEqual([]);
});
