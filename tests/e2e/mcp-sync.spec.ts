// MCP writes are outside changes for One: the server is its own process with its own Workspace, so the
// app's watcher reports them like any other program's edit. A clean tab reloads; a tab with unsaved
// edits gets the usual "changed on disk" banner (browser mode here; the desktop uses the same flow).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test, expect } from './harness';
import { MCP_WRITES_ENABLED } from '../../src/shared/mcp';
import { TOKEN_ENV, generateToken, hashToken, tokenHint } from '../../src/mcp/tokens';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
let CLI = process.env.SEC_EDIT_MCP_CLI ?? '';

test.beforeAll(() => {
  if (CLI) return;
  const out = path.join(ROOT, '.tmp/mcp/dist');
  // Same build as tests/e2e/mcp.spec.ts (fast esbuild job).
  const r = spawn(process.execPath, [path.join(ROOT, 'scripts/build-node.mjs'), '--only', 'mcp', '--outdir', out], { cwd: ROOT, stdio: 'ignore' });
  CLI = path.join(out, 'mcp/cli.mjs');
  return new Promise<void>((res, rej) => r.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build exited ${c}`)))));
});

const row = (page: Page, name: string) => page.locator('.se-tree-row', { hasText: name }).first();

test('an MCP write reloads a clean tab; with unsaved edits the conflict banner shows', async ({ page, ws }) => {
  test.skip(!MCP_WRITES_ENABLED, 'writes are switched off in this build (MCP_WRITES_ENABLED)');
  const config = path.join(path.dirname(ws.root), 'mcp-config');
  fs.mkdirSync(config, { recursive: true });
  const token = generateToken(); // every client needs one: mcp.json keeps the hash, the client's env the token
  const tokens = [{ id: 'c0ffee02', name: 'sync-e2e', sha256: hashToken(token), hint: tokenHint(token), created: Date.now() }];
  fs.writeFileSync(path.join(config, 'mcp.json'), JSON.stringify({ version: 1, enabled: true, folders: [{ id: 'a1b2c3d4', alias: 'ws', path: ws.root, mode: 'write' }], tokens }));
  const run = path.dirname(ws.root);
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, '--stdio'], env: { PATH: process.env.PATH ?? '', HOME: run, XDG_DATA_HOME: path.join(run, 'xdg'), SEC_EDIT_CONFIG_DIR: config, [TOKEN_ENV]: token }, stderr: 'pipe' });
  const client = new Client({ name: 'sync-e2e', version: '1' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    expect(r.isError, r.content[0].text).toBeFalsy();
    return r.content[0].text as string; // plain text: a summary line (path · etag …), then the text
  };
  try {
    await ws.open(page);
    await ws.server.service.saveSettings({ autosave: false });
    await page.reload();
    await page.waitForSelector('html[data-ready="true"]');
    await row(page, 'README').click();
    await expect(page.locator('.cm-content')).toContainText('Welcome');

    const etag = /etag (\S+)/.exec(await call('read_file', { path: 'README.md' }))![1];
    await call('write_file', { path: 'README.md', content: '# Rewritten by the AI\n', if_match: etag });
    await expect(page.locator('.cm-content')).toContainText('Rewritten by the AI');
    await expect(page.locator('.se-banner')).toHaveCount(0);

    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nmy unsaved edit');
    await call('append_file', { path: 'README.md', content: 'AI addition' });
    await expect(page.locator('.se-banner')).toContainText('changed on disk');
    // The user's text is still in the editor, the AI's on disk.
    await expect(page.locator('.cm-content')).toContainText('my unsaved edit');
    expect(await ws.read('README.md')).toContain('AI addition');
  } finally {
    await client.close();
  }
});
