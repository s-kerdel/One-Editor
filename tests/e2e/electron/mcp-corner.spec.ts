// Status-bar corner in the real desktop app: the MCP icon shows while MCP is on (muted, "no app connected"),
// turns accent when a real stdio server (started from the copied setup, with its token) writes its live file,
// pulses on a call, goes back to muted when that server ends, and disappears when MCP is off. Its click opens
// Settings → MCP server at Recent activity. With the web server running too, the order is MCP · :port.
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect, fs, path } from './fixture';

const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());
const copiedServer = async (app: ElectronApplication) => JSON.parse(await clipboardText(app)).mcpServers.one as { command: string; args: string[]; env: Record<string, string> };
const icon = (page: Page) => page.locator('[data-testid="mcp-indicator"]');
const corner = (page: Page) => page.locator('.se-status-corner');
const cornerIds = (page: Page) => corner(page).evaluate((c) => [...c.children].map((x) => x.getAttribute('data-testid')));
const liveFiles = (userData: string) => fs.readdirSync(path.join(userData, 'mcp-live')).filter((f) => f.endsWith('.json'));

async function runCommand(page: Page, text: string, id: string) {
  await page.keyboard.press('Control+Shift+p');
  await page.keyboard.type(text);
  await expect(page.locator('.se-pal-item').first()).toHaveAttribute('data-command-id', id);
  await page.keyboard.press('Enter');
}

test('MCP icon: on → muted; a live session → accent + pulse on a call; session ends → muted; off → gone; click → Recent activity', async ({ el }) => {
  test.setTimeout(90_000);
  const shared = path.join(el.tmp, 'Shared Notes');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.md'), '# Hello\n');
  const { page, app } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow', SEC_EDIT_TEST_MCP_FOLDER: shared } });
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.waitForFunction(() => !!(window as any).__secEditWebServer, null, { timeout: 15000 }); // the corner's chunk is in

  // Off (the default): nothing in the corner.
  await expect(icon(page)).toHaveCount(0);
  await expect(corner(page)).toHaveCount(0);

  // On (asks first) + a shared folder: the icon is there, muted.
  await page.keyboard.press('Control+,');
  await page.locator('[data-nav="mcp"]').click();
  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'yes');
  await page.locator('[data-testid="mcp-add-folder"]').click();
  await expect(page.locator('[data-testid="mcp-folder"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="settings"]')).toHaveCount(0);
  await expect(icon(page)).toHaveAttribute('data-state', 'on');
  await expect(icon(page)).toHaveText('MCP');
  await expect(icon(page)).toHaveAttribute('title', 'MCP server on · no app connected');
  // Far right, after the open file's items, behind its │.
  expect(await page.locator('.se-status').evaluate((bar) => bar.lastElementChild!.className)).toBe('se-status-corner');
  expect(await corner(page).evaluate((c) => getComputedStyle(c, '::before').width)).toBe('1px');
  expect(await cornerIds(page)).toEqual(['mcp-indicator']);

  // A real server from the copied setup (its token) → its live file → main pushes the session.
  await page.evaluate(() => {
    const w = window as any;
    w.__pulses = 0;
    new MutationObserver((ms) => ms.forEach((m) => (m.target as Element).hasAttribute('data-pulse') && w.__pulses++)).observe(document.querySelector('.se-status')!, { subtree: true, attributes: true, attributeFilter: ['data-pulse'] });
  });
  const server = await copiedServer(app);
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, ...server.env, SEC_EDIT_CONFIG_DIR: el.userData }, stderr: 'pipe' });
  const client = new Client({ name: 'corner-e2e', version: '1' });
  await client.connect(transport);
  try {
    await expect(icon(page)).toHaveAttribute('data-state', 'live', { timeout: 15000 });
    expect(liveFiles(el.userData)).toHaveLength(1);
    await expect(icon(page)).toHaveAttribute('title', /^First app connected · no calls yet$/);
    await expect(icon(page).locator('[data-testid="mcp-indicator-count"]')).toHaveCount(0);

    // A call: the live file's lastCall (throttled to 5 s after start) → "last call hh:mm" + one pulse.
    await client.callTool({ name: 'list_folders', arguments: {} });
    await expect(icon(page)).toHaveAttribute('title', /^First app connected · last call \S/, { timeout: 15000 });
    await expect.poll(() => page.evaluate(() => (window as any).__pulses)).toBeGreaterThan(0);
    await expect(icon(page)).not.toHaveAttribute('data-pulse', /.*/, { timeout: 3000 }); // ~1 s, then gone

    // With the web server running too: MCP first, then the port.
    await runCommand(page, 'start web server', 'webServer.start');
    await page.locator('[data-testid="webserver-info"] .se-btn', { hasText: 'Close' }).click();
    await expect(page.locator('.se-status-corner [data-testid="webserver-pill"]')).toBeVisible();
    expect(await cornerIds(page)).toEqual(['mcp-indicator', 'webserver-pill']);
    await runCommand(page, 'stop web server', 'webServer.stop');
    await expect(page.locator('[data-testid="webserver-pill"]')).toHaveCount(0);
    expect(await cornerIds(page)).toEqual(['mcp-indicator']);

    // Click → Settings → MCP server, scrolled to Recent activity.
    await icon(page).click();
    await expect(page.locator('[data-testid="settings"]')).toBeVisible();
    await expect(page.locator('[data-testid="mcp-recent"]')).toBeInViewport();
    await expect(page.locator('[data-nav="mcp"]')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[data-testid="mcp-recent"]')).toContainText('list_folders');
    await page.keyboard.press('Escape');
  } finally {
    await client.close().catch(() => {});
  }

  // The server ended (its live file went): back to muted.
  await expect(icon(page)).toHaveAttribute('data-state', 'on', { timeout: 15000 });
  await expect(icon(page)).toHaveAttribute('title', 'MCP server on · no app connected');
  expect(liveFiles(el.userData)).toEqual([]);

  // Off: gone, and the corner (with its │) with it.
  await page.keyboard.press('Control+,');
  await page.locator('[data-nav="mcp"]').click();
  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
  await page.keyboard.press('Escape');
  await expect(icon(page)).toHaveCount(0);
  await expect(corner(page)).toHaveCount(0);
});

test('MCP on at launch: the icon arrives with the idle chunk, the startup chunks carry none of it', async ({ el }) => {
  fs.mkdirSync(el.userData, { recursive: true });
  fs.writeFileSync(path.join(el.userData, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [] }));
  const { page } = await el.launch([el.ws]);
  await expect(icon(page)).toHaveAttribute('data-state', 'on', { timeout: 15000 });
  await expect(icon(page)).toHaveAttribute('title', 'MCP server on · no app connected');
  // Not the Settings / mcp-ui chunks: only the idle web-server-ui one (with the icon in it). Resource timing
  // skips app:// loads; Vite's preload helper adds a <link> per chunk (+ its CSS) it loads.
  const loaded = await page.evaluate(() => [...document.querySelectorAll('link[href]')].map((l) => l.getAttribute('href')!.split('/').pop()!));
  expect(loaded.some((n) => /^web-server-ui-[\w-]+\.js$/.test(n))).toBe(true);
  expect(loaded.filter((n) => /^(Settings|mcp-ui)-/.test(n))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__secEditMcp)).toBeUndefined(); // mcp-ui's install() never ran
});
