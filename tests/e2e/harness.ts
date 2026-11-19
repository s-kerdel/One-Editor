// Shared E2E harness. Each Playwright worker gets its own server + temp copy of the fixture workspace,
// so test files (and concurrently running agents) never interfere.
//
//   import { test, expect } from './harness';
//   test('x', async ({ page, ws }) => { await ws.open(page); ... });
import { test as base, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { startServer, type RunningServer } from '../../src/server/server';

export const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/workspace');
export const RENDERER_DIR = process.env.SEC_EDIT_RENDERER_OUT || path.resolve(__dirname, '../../.e2e-dist/renderer');

export interface WsFixture {
  root: string; // temp copy of the fixture workspace
  server: RunningServer;
  /** Navigate and wait until the app has booted. */
  open(page: Page): Promise<void>;
  read(rel: string): Promise<string>;
  write(rel: string, content: string): Promise<void>;
}

export const test = base.extend<{ ws: WsFixture }>({
  ws: async ({}, use) => {
    // Temp files stay inside the project (.tmp/, gitignored) rather than the system temp dir.
    const base = process.env.SEC_EDIT_E2E_TMP || path.resolve(__dirname, '../../.tmp/e2e');
    await fsp.mkdir(base, { recursive: true });
    const tmp = await fsp.mkdtemp(path.join(base, 'sec-edit-e2e-'));
    const root = path.join(tmp, 'workspace');
    await fsp.cp(FIXTURE_DIR, root, { recursive: true });
    const configDir = path.join(tmp, 'config');
    if (!fs.existsSync(path.join(RENDERER_DIR, 'index.html'))) throw new Error(`Renderer not built at ${RENDERER_DIR} (globalSetup should build it)`);
    const server = await startServer({ root, port: 0, rendererDir: RENDERER_DIR, configDir });
    await use({
      root,
      server,
      async open(page) {
        await page.goto(server.url);
        await page.waitForSelector('html[data-ready="true"]', { timeout: 15000 });
      },
      read: (rel) => fsp.readFile(path.join(root, rel), 'utf8'),
      write: (rel, c) => fsp.writeFile(path.join(root, rel), c),
    });
    await server.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  },
});

export { expect };
