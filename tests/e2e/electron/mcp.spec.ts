// Settings → MCP server in the real desktop app: off by default; turning on, sharing a folder and allowing
// writes go through main's native dialogs (stubbed by SEC_EDIT_TEST_MCP_*); main writes mcp.json; the setup
// snippet's command really starts the server (this Electron in Node mode), which serves the shared folder,
// logs to the activity list and exits when MCP is switched off.
import { spawn } from 'node:child_process';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect, fs, path } from './fixture';
import { MCP_WRITES_ENABLED } from '../../../src/shared/mcp';

const ready = (page: Page) => page.waitForFunction(() => !!(window as any).__secEditMcp, null, { timeout: 15000 });
const status = (page: Page) => page.evaluate(() => (window as any).__secEditMcp.status());

async function openMcpSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.locator('[data-nav="mcp"]').click();
  await expect(page.locator('[data-testid="mcp-settings"]')).toBeVisible();
  await ready(page);
}

test('on (asks first), share a folder (dialog), allow writes (asks), setup snippet starts a server that obeys mcp.json', async ({ el }) => {
  const shared = path.join(el.tmp, 'Shared Notes');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'hello.md'), '# Hello\n\nfrom the shared folder');
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow', SEC_EDIT_TEST_MCP_FOLDER: shared } });
  await openMcpSettings(page);
  const file = () => JSON.parse(fs.readFileSync(path.join(el.userData, 'mcp.json'), 'utf8'));

  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
  await expect(page.locator('[data-testid="mcp-no-folders"]')).toBeVisible();
  await expect(page.locator('[data-setting="mcp.maxReadKB"]')).toBeVisible();
  expect(fs.existsSync(path.join(el.userData, 'mcp.json'))).toBe(false);

  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'yes');
  expect(file().enabled).toBe(true);

  await page.locator('[data-testid="mcp-add-folder"]').click();
  const row = page.locator('[data-testid="mcp-folder"]');
  await expect(row).toHaveAttribute('data-alias', 'shared-notes');
  expect(file().folders).toEqual([expect.objectContaining({ alias: 'shared-notes', path: fs.realpathSync(shared), mode: 'read' })]);

  if (MCP_WRITES_ENABLED) {
    await row.locator('[data-testid="mcp-mode-write"]').click();
    await expect(row.locator('[data-testid="mcp-mode-write"]')).toHaveAttribute('aria-checked', 'true');
    expect(file().folders[0].mode).toBe('write');
  } else {
    // This build ships read-only: the control is off, and main refuses even when asked directly.
    await expect(row.locator('[data-testid="mcp-mode-write"]')).toBeDisabled();
    await expect(page.locator('[data-testid="mcp-folders-note"]')).toContainText('next build');
    const id = file().folders[0].id;
    expect(await page.evaluate((x) => (window as any).secEditBridge.mcp.setMode(x, 'write'), id)).toMatchObject({ ok: false, error: { code: 'ENOTSUP' } });
    expect(file().folders[0].mode).toBe('read');
  }

  // LM Studio first; Codex CLI as TOML.
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('"mcpServers"');
  await page.locator('[data-testid="mcp-client-codex"]').click();
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('[mcp_servers.one]');
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('dist/mcp/cli.mjs');

  // Start the server exactly as the snippet says (+ the test profile's data folder).
  const launch = (await status(page)).launch as { command: string; args: string[]; env: Record<string, string> };
  expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' });
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, ...launch.env, SEC_EDIT_CONFIG_DIR: el.userData, SEC_EDIT_MCP_POLL_MS: '150' }, stderr: 'pipe' });
  const client = new Client({ name: 'electron-e2e', version: '1' });
  await client.connect(transport);
  let closed = false;
  transport.onclose = () => void (closed = true);
  try {
    const folders = JSON.parse((await client.callTool({ name: 'list_folders', arguments: {} }) as any).content[0].text).folders;
    expect(folders).toEqual([expect.objectContaining({ folder: 'shared-notes', mode: MCP_WRITES_ENABLED ? 'read-write' : 'read-only' })]);
    const read = (await client.callTool({ name: 'read_file', arguments: { path: 'hello.md' } })) as any;
    expect(read.content[1].text).toContain('from the shared folder');

    // The call shows up under Recent activity.
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(page.locator('[data-testid="mcp-activity"]')).toContainText('read_file');
    await expect(page.locator('[data-testid="mcp-activity"]')).toContainText('electron-e2e');

    // Back to read-only needs no dialog; switching off ends the running server.
    if (MCP_WRITES_ENABLED) await row.locator('[data-testid="mcp-mode-read"]').click();
    await expect.poll(() => file().folders[0].mode).toBe('read');
    await page.locator('[data-testid="mcp-enable"]').click();
    await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
    await expect.poll(() => closed, { timeout: 8000 }).toBe(true);
  } finally {
    await client.close().catch(() => {});
  }
  await row.locator('[data-testid="mcp-remove"]').click();
  await expect(page.locator('[data-testid="mcp-no-folders"]')).toBeVisible();
  expect(file().folders).toEqual([]);
});

test('a "no" in the native dialog changes nothing, and the page cannot name a folder or skip the dialog', async ({ el }) => {
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'deny', SEC_EDIT_TEST_MCP_FOLDER: 'cancel' } });
  await openMcpSettings(page);
  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
  // Straight through the bridge: an extra path argument is ignored (main opens its own dialog, here cancelled).
  const r = await page.evaluate(() => (window as any).secEditBridge.mcp.addFolder('/etc'));
  expect(r).toMatchObject({ ok: true, result: { folders: [] } });
  expect(await page.evaluate(() => (window as any).secEditBridge.mcp.setEnabled(true))).toMatchObject({ ok: true, result: { enabled: false } });
  expect(fs.existsSync(path.join(el.userData, 'mcp.json'))).toBe(false);
  // And a server started anyway refuses to run.
  const launch = (await status(page)).launch as { command: string; args: string[]; env: Record<string, string> };
  const child = spawn(launch.command, launch.args, { env: { PATH: process.env.PATH ?? '', ...launch.env, SEC_EDIT_CONFIG_DIR: el.userData } });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  expect(await new Promise((res) => child.on('exit', res))).toBe(1);
  expect(err).toContain('switched off');
});

test('Recent activity: Revert undoes an AI edit; with undo copies switched off a new edit has no Revert', async ({ el }) => {
  test.skip(!MCP_WRITES_ENABLED, 'writes are switched off in this build (MCP_WRITES_ENABLED)');
  const shared = path.join(el.tmp, 'notes');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'n.md'), 'original\n');
  const { page } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow', SEC_EDIT_TEST_MCP_FOLDER: shared, SEC_EDIT_TRASH_DIR: path.join(el.tmp, 'trash') } });
  await openMcpSettings(page);
  await page.locator('[data-testid="mcp-enable"]').click();
  await page.locator('[data-testid="mcp-add-folder"]').click();
  await page.locator('[data-testid="mcp-folder"] [data-testid="mcp-mode-write"]').click();
  await expect(page.locator('[data-testid="mcp-folder"] [data-testid="mcp-mode-write"]')).toHaveAttribute('aria-checked', 'true');
  const launch = (await status(page)).launch as { command: string; args: string[]; env: Record<string, string> };
  const transport = new StdioClientTransport({ command: launch.command, args: launch.args, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, XDG_DATA_HOME: path.join(el.tmp, 'xdg'), ...launch.env, SEC_EDIT_CONFIG_DIR: el.userData, SEC_EDIT_MCP_POLL_MS: '150' }, stderr: 'pipe' });
  const client = new Client({ name: 'revert-e2e', version: '1' });
  await client.connect(transport);
  const rows = page.locator('[data-testid="mcp-activity"] tr');
  try {
    expect(((await client.callTool({ name: 'append_file', arguments: { path: 'n.md', content: 'ai line' } })) as any).isError).toBeFalsy();
    expect(fs.readFileSync(path.join(shared, 'n.md'), 'utf8')).toBe('original\nai line\n');
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(rows.first()).toContainText('append_file');
    await rows.first().locator('[data-testid="mcp-revert"]').click();
    await expect.poll(() => fs.readFileSync(path.join(shared, 'n.md'), 'utf8')).toBe('original\n');
    await expect(page.locator('[data-testid="mcp-reverted"]')).toHaveCount(1);
    await expect(rows.first()).toContainText('revert');

    // Undo copies off (settings.json; the running server picks it up): the next edit has no Revert.
    await page.locator('[data-setting="mcp.journal"]').click();
    const journalSetting = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(el.userData, 'settings.json'), 'utf8'))['mcp.journal'];
      } catch {
        return undefined; // written a moment later (debounced)
      }
    };
    await expect.poll(journalSetting).toBe(false);
    await page.waitForTimeout(600);
    expect(((await client.callTool({ name: 'append_file', arguments: { path: 'n.md', content: 'no undo' } })) as any).isError).toBeFalsy();
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(rows.first()).toContainText('append_file');
    await expect(rows.first().locator('[data-testid="mcp-revert"]')).toHaveCount(0);
    await expect(page.locator('[data-setting="mcp.journalDays"]')).toBeDisabled();
  } finally {
    await client.close().catch(() => {});
  }
});
