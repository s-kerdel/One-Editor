// search.indexing = "onDemand": at launch only the tree walk + watcher run — no indexer thread, no
// reader threads, no search workers, no index requests. Going to a file by name stays index-free;
// the first consumer (find in files, backlinks, the overview's "Build now") builds it.
import { test, expect, type Page } from '@playwright/test';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../../src/server/server';
import { FIXTURE_DIR, RENDERER_DIR } from './harness';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let server: RunningServer;
let tmp = '';

// A fresh server + config per test: no index, no saved session (a restored Backlinks panel would build it).
test.beforeEach(async () => {
  const base = process.env.SEC_EDIT_E2E_TMP || path.resolve(__dirname, '../../.tmp/e2e');
  await fsp.mkdir(base, { recursive: true });
  tmp = await fsp.mkdtemp(path.join(base, 'ondemand-'));
  const root = path.join(tmp, 'workspace');
  const configDir = path.join(tmp, 'config');
  await fsp.cp(FIXTURE_DIR, root, { recursive: true });
  await fsp.mkdir(configDir, { recursive: true });
  await fsp.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ 'search.indexing': 'onDemand' }));
  server = await startServer({ root, port: 0, rendererDir: RENDERER_DIR, configDir });
});
test.afterEach(async () => {
  await server?.close();
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

const backendIndexer = () => (server.service as any).workspace?.host ?? null;

async function boot(page: Page) {
  const indexRequests: string[] = [];
  page.on('request', (r) => r.url().includes('/api/index/') && indexRequests.push(r.url()));
  await page.goto(server.url);
  await page.waitForSelector('html[data-ready="true"]');
  await page.waitForTimeout(3500); // past the idle moment that builds the index "at launch"
  return indexRequests;
}

test('nothing indexes at launch; going to a file by name stays index-free; find in files builds and finds', async ({ page }) => {
  const indexRequests = await boot(page);
  await expect(page.getByTestId('index-on-demand')).toHaveText('Search index: on demand');
  expect(indexRequests, 'index requests at launch').toEqual([]);
  expect(backendIndexer(), 'indexer thread at launch').toBeNull();
  expect(await page.evaluate(() => (window as any).__secEditSearch?.status.value ?? 'idle')).toBe('idle');

  await page.keyboard.press('Control+p');
  await page.keyboard.type('kubernet');
  await expect(page.locator('.se-palette-list .se-pal-item').filter({ hasText: 'kubernetes' }).first()).toBeVisible();
  await page.waitForTimeout(500);
  expect(indexRequests, 'quick open by name').toEqual([]);
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+Shift+f');
  await page.getByLabel('Search query').fill('needle in a haystack');
  await expect(page.locator('.se-search-results, .se-search').getByText('Deep note').first()).toBeVisible({ timeout: 15000 });
  expect(indexRequests.length, 'the first search built the index').toBeGreaterThan(0);
  expect(backendIndexer()).not.toBeNull();
  await expect(page.getByTestId('index-on-demand')).toHaveCount(0);
});

test('opening backlinks builds the index (fresh window)', async ({ page }) => {
  await boot(page);
  await expect(page.getByTestId('index-on-demand')).toBeVisible();
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+Alt+l');
  await expect(page.locator('.se-kn-backlinks').getByText('Daily notes').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('index-on-demand')).toHaveCount(0);
});

test('the file overview explains links need the index and builds it on request', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => (window as any).__secEdit.openFile('README.md'));
  await page.keyboard.press('Control+Alt+b');
  const links = page.locator('[data-section="connections"]');
  await expect(links).toContainText('built on demand');
  await links.getByRole('button', { name: 'Build now' }).click();
  await expect(links).toContainText('Daily notes', { timeout: 15000 });
  await expect(page.getByTestId('index-on-demand')).toHaveCount(0);
});
