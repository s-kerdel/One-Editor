// Browser mode: the integrated terminal is desktop-only. Ctrl+` shows a short note, nothing can start
// a shell (no "Run in terminal" buttons, RPC refused), and the panel closes again without side effects.
import { test, expect } from './harness';

test('browser build: Ctrl+` shows the desktop-only note; no shell anywhere', async ({ page, ws }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await ws.write('notes/run.md', '# Run\n\n```bash\necho hi\n```\n');
  await ws.open(page);
  await expect(page.locator('[data-testid="terminal-panel"]')).toHaveCount(0); // starts closed

  await page.keyboard.press('Control+Backquote');
  const panel = page.locator('[data-testid="terminal-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-testid="terminal-note"]')).toHaveText('The terminal is available in the desktop app only.');
  await expect(panel.locator('[data-testid="terminal-new"]')).toHaveCount(0);
  // xterm.js is never fetched in the browser build.
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => /\/view-[\w-]+\.js$/.test(e.name)))).toBe(false);
  await panel.locator('[data-testid="terminal-hide"]').click();
  await expect(panel).toHaveCount(0);

  // Shell code blocks get no "Run in terminal" button (live editor and preview).
  await page.locator('.se-tree-row', { hasText: 'notes' }).click();
  await page.locator('.se-tree-row', { hasText: 'run.md' }).click();
  await expect(page.locator('.se-cb-header').first()).toBeVisible();
  await expect(page.locator('.se-cb-run')).toHaveCount(0);

  // The server refuses terminal RPCs outright.
  const r = await page.evaluate(async () => {
    const token = sessionStorage.getItem('sec-edit-token')!; // the tab's access key (never in the page)
    const res = await fetch('./api/rpc/terminalSpawn', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sec-edit-token': token }, body: JSON.stringify({ args: [{}] }) });
    return res.json();
  });
  expect(r).toMatchObject({ ok: false, error: { code: 'ENOTSUP' } });
  expect(errors).toEqual([]);
});
