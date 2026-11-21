// Settings → MCP server in the real desktop app: off by default; turning on, sharing a folder, allowing
// writes / code files, undo off and every token step go through main's native dialogs (stubbed by
// SEC_EDIT_TEST_MCP_*); main writes mcp.json; "Copy setup" puts the snippet with its access token on the
// clipboard from main (the page never sees the token); that setup really starts the server (this Electron in
// Node mode), which serves the shared folder, logs to the activity list and exits when its token is revoked.
import { spawn } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect, fs, path } from './fixture';
import { MCP_WRITES_ENABLED } from '../../../src/shared/mcp';

const TOKEN = /one_[A-Za-z0-9_-]{43}/;
const clipboardText = (app: ElectronApplication) => app.evaluate(({ clipboard }) => clipboard.readText());
/** The LM Studio setup main copied: its server entry (command, args, env with the token). */
const copiedServer = async (app: ElectronApplication) => JSON.parse(await clipboardText(app)).mcpServers.one as { command: string; args: string[]; env: Record<string, string> };
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
  const { page, app } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow', SEC_EDIT_TEST_MCP_FOLDER: shared } });
  await openMcpSettings(page);
  const file = () => JSON.parse(fs.readFileSync(path.join(el.userData, 'mcp.json'), 'utf8'));

  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
  await expect(page.locator('[data-testid="mcp-no-folders"]')).toBeVisible();
  await expect(page.locator('[data-setting="mcp.maxReadKB"]')).toBeVisible();
  expect(fs.existsSync(path.join(el.userData, 'mcp.json'))).toBe(false);

  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'yes');
  expect(file().enabled).toBe(true);
  // Turning on made the first token and copied its setup (main → clipboard); the page has its name only.
  await expect(page.locator('[data-testid="mcp-token"]')).toHaveCount(1);
  const raw = TOKEN.exec(await clipboardText(app))![0];
  expect(JSON.stringify(file())).not.toContain(raw);
  expect(JSON.stringify(await status(page))).not.toContain(raw);
  expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(raw);

  await page.locator('[data-testid="mcp-add-folder"]').click();
  const row = page.locator('[data-testid="mcp-folder"]');
  await expect(row).toHaveAttribute('data-alias', 'shared-notes');
  expect(file().folders).toEqual([expect.objectContaining({ alias: 'shared-notes', path: fs.realpathSync(shared), mode: 'read' })]);

  if (MCP_WRITES_ENABLED) {
    await row.locator('[data-testid="mcp-mode-write"]').click();
    await expect(row.locator('[data-testid="mcp-mode-write"]')).toHaveAttribute('aria-checked', 'true');
    expect(file().folders[0].mode).toBe('write');
    // Code files: a per-folder grant (asks first), stored by main in mcp.json.
    await row.locator('[data-testid="mcp-allow-code"]').check();
    await expect.poll(() => file().folders[0].allowCode).toBe(true);
    await row.locator('[data-testid="mcp-allow-code"]').uncheck();
    await expect.poll(() => file().folders[0].allowCode).toBeUndefined();
  } else {
    // This build ships read-only: the control is off, and main refuses even when asked directly.
    await expect(row.locator('[data-testid="mcp-mode-write"]')).toBeDisabled();
    await expect(page.locator('[data-testid="mcp-folders-note"]')).toContainText('next build');
    const id = file().folders[0].id;
    expect(await page.evaluate((x) => (window as any).secEditBridge.mcp.setMode(x, 'write'), id)).toMatchObject({ ok: false, error: { code: 'ENOTSUP' } });
    expect(file().folders[0].mode).toBe('read');
  }

  // LM Studio first; Codex CLI as TOML. The preview masks the token.
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('"mcpServers"');
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('"ONE_MCP_TOKEN": "one_••••"');
  await page.locator('[data-testid="mcp-client-codex"]').click();
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('[mcp_servers.one]');
  await expect(page.locator('[data-testid="mcp-snippet"]')).toContainText('dist/mcp/cli.mjs');
  await page.locator('[data-testid="mcp-client-lmstudio"]').click();

  // "Copy setup": main copies; the bridge answer is only "copied".
  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  const id = (await status(page)).tokens[0].id as string;
  const answer = await page.evaluate((x) => (window as any).secEditBridge.mcp.copySetup(x, 'lmstudio'), id);
  expect(answer).toEqual({ ok: true, result: { copied: true } });
  const server = await copiedServer(app);
  expect(server.env).toEqual({ ELECTRON_RUN_AS_NODE: '1', ONE_MCP_TOKEN: raw });
  expect(server.args.join(' ')).not.toContain('one_'); // env, never argv
  const launch = (await status(page)).launch as { command: string; args: string[]; env: Record<string, string> };
  expect(launch.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' }); // the page's copy has no token

  // Start the server exactly as the copied setup says (+ the test profile's data folder).
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, ...server.env, SEC_EDIT_CONFIG_DIR: el.userData, SEC_EDIT_MCP_POLL_MS: '150' }, stderr: 'pipe' });
  const client = new Client({ name: 'electron-e2e', version: '1' });
  await client.connect(transport);
  let closed = false;
  transport.onclose = () => void (closed = true);
  try {
    const folders = ((await client.callTool({ name: 'list_folders', arguments: {} })) as any).content[0].text as string;
    expect(folders).toMatch(new RegExp(`^1 folder\nshared-notes \\(Shared Notes\\) · ${MCP_WRITES_ENABLED ? 'read-write' : 'read-only'} · `));
    const read = (await client.callTool({ name: 'read_file', arguments: { path: 'hello.md' } })) as any;
    expect(read.content.map((c: any) => c.text).join('\n')).toContain('from the shared folder');

    // The call shows up under Recent activity.
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(page.locator('[data-testid="mcp-activity"]')).toContainText('read_file');
    await expect(page.locator('[data-testid="mcp-activity"]')).toContainText('First app'); // the token's name

    // Back to read-only needs no dialog; revoking the token (asks first) ends the running server.
    if (MCP_WRITES_ENABLED) await row.locator('[data-testid="mcp-mode-read"]').click();
    await expect.poll(() => file().folders[0].mode).toBe('read');
    await page.locator('[data-testid="mcp-token-revoke"]').click();
    await expect(page.locator('[data-testid="mcp-token"]')).toHaveCount(0);
    expect(file().tokens).toEqual([]);
    await expect.poll(() => closed, { timeout: 8000 }).toBe(true);
    await page.locator('[data-testid="mcp-enable"]').click();
    await expect(page.locator('[data-testid="mcp-state"]')).toHaveAttribute('data-on', 'no');
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
  const { page, app } = await el.launch([el.ws], { env: { SEC_EDIT_TEST_MCP_CONFIRM: 'allow', SEC_EDIT_TEST_MCP_FOLDER: shared, SEC_EDIT_TRASH_DIR: path.join(el.tmp, 'trash') } });
  await openMcpSettings(page);
  await page.locator('[data-testid="mcp-enable"]').click();
  await expect(page.locator('[data-testid="mcp-token"]')).toHaveCount(1);
  await page.locator('[data-testid="mcp-add-folder"]').click();
  await page.locator('[data-testid="mcp-folder"] [data-testid="mcp-mode-write"]').click();
  await expect(page.locator('[data-testid="mcp-folder"] [data-testid="mcp-mode-write"]')).toHaveAttribute('aria-checked', 'true');
  const server = await copiedServer(app); // copied when MCP was turned on
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: { PATH: process.env.PATH ?? '', HOME: el.tmp, XDG_DATA_HOME: path.join(el.tmp, 'xdg'), ...server.env, SEC_EDIT_CONFIG_DIR: el.userData, SEC_EDIT_MCP_POLL_MS: '150' }, stderr: 'pipe' });
  const client = new Client({ name: 'revert-e2e', version: '1' });
  await client.connect(transport);
  const rows = page.locator('[data-testid="mcp-activity"] [data-testid="mcp-call"]');
  try {
    expect(((await client.callTool({ name: 'append_file', arguments: { path: 'n.md', content: 'ai line' } })) as any).isError).toBeFalsy();
    expect(fs.readFileSync(path.join(shared, 'n.md'), 'utf8')).toBe('original\nai line\n');
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(rows.first()).toContainText('append_file');
    await rows.first().locator('[data-testid="mcp-revert"]').click();
    await expect.poll(() => fs.readFileSync(path.join(shared, 'n.md'), 'utf8')).toBe('original\n');
    await expect(page.locator('[data-testid="mcp-reverted"]')).toHaveCount(1);
    await expect(rows.first()).toContainText('revert');

    // Undo copies off (asks first; main writes mcp.json, the running server picks it up): no Revert next time.
    await page.locator('[data-testid="mcp-undo-on"]').uncheck();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(el.userData, 'mcp.json'), 'utf8')).undo?.on).toBe(false);
    await expect(page.locator('[data-testid="mcp-undo-days"]')).toBeDisabled();
    await page.waitForTimeout(600);
    expect(((await client.callTool({ name: 'append_file', arguments: { path: 'n.md', content: 'no undo' } })) as any).isError).toBeFalsy();
    await page.locator('[data-testid="mcp-activity-refresh"]').click();
    await expect(rows.first()).toContainText('append_file');
    await expect(rows.first().locator('[data-testid="mcp-revert"]')).toHaveCount(0);
    // A page cannot switch grants through settings: main drops mcp.* grant keys (the limits stay settable).
    const saved = await page.evaluate(() => (window as any).secEditBridge.invoke('saveSettings', [{ 'mcp.journal': true, 'mcp.allowCode': true, 'mcp.maxResults': 7 }]));
    expect(saved.ok).toBe(true);
    expect(saved.result['mcp.allowCode']).toBeUndefined();
    expect(saved.result['mcp.journal']).toBeUndefined();
    expect(saved.result['mcp.maxResults']).toBe(7);
  } finally {
    await client.close().catch(() => {});
  }
});
