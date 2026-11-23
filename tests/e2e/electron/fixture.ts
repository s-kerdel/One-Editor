// Launch helper for the real Electron app: fresh workspace copy + private userData per test.
import { _electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE = path.resolve(here, '../../fixtures/workspace');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  stdout: string[];
  /** ms from launch() call until html[data-ready]. */
  readyMs: number;
  timings: () => Promise<Record<string, number> | null>;
}

export interface ElectronFixture {
  tmp: string;
  ws: string; // workspace copy
  userData: string;
  launch(args?: string[], opts?: { env?: Record<string, string>; appDir?: string; executablePath?: string }): Promise<Launched>;
}

export const test = base.extend<{ el: ElectronFixture }>({
  el: async ({}, use) => {
    // Temp files stay inside the project (.tmp/, gitignored) rather than the system temp dir.
    const base = process.env.SEC_EDIT_E2E_TMP || path.resolve(here, '../../../.tmp/e2e');
    await fsp.mkdir(base, { recursive: true });
    const tmp = await fsp.mkdtemp(path.join(base, 'sec-edit-el-'));
    const ws = path.join(tmp, 'workspace');
    await fsp.cp(FIXTURE, ws, { recursive: true });
    const userData = path.join(tmp, 'userData');
    const apps: ElectronApplication[] = [];
    await use({
      tmp,
      ws,
      userData,
      async launch(args = [ws], opts = {}) {
        const stdout: string[] = [];
        const t0 = Date.now();
        const appDir = opts.appDir ?? process.env.SEC_EDIT_ELECTRON_APP!;
        const app = await _electron.launch({
          executablePath: opts.executablePath,
          args: opts.executablePath ? ['--disable-gpu', ...args] : ['--disable-gpu', appDir, ...args],
          env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99', SEC_EDIT_TEST: '1', SEC_EDIT_USER_DATA: userData, ...opts.env } as Record<string, string>,
          timeout: 30000,
        });
        apps.push(app);
        app.process().stdout?.on('data', (d) => stdout.push(String(d)));
        if (process.env.E2E_CONSOLE) {
          // Debug aid, off by default: main process output + every window's console in the test output.
          app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`));
          app.process().stderr?.on('data', (d) => process.stdout.write(`[main:err] ${d}`));
          const seen = new WeakSet<Page>();
          const logPage = (w: Page) => {
            if (seen.has(w)) return;
            seen.add(w);
            w.on('console', (m) => console.log(`[renderer:${m.type()}] ${m.text()}`));
            w.on('pageerror', (e) => console.log(`[renderer:pageerror] ${e.stack || e.message}`));
          };
          for (const w of app.windows()) logPage(w);
          app.on('window', logPage);
        }
        const page = await app.firstWindow();
        await page.waitForSelector('html[data-ready="true"]', { timeout: 20000 });
        const readyMs = Date.now() - t0;
        const timings = async () => {
          for (let i = 0; i < 40; i++) {
            const line = stdout.join('').split('\n').find((l) => l.startsWith('[sec-edit:timings]'));
            if (line) return JSON.parse(line.slice('[sec-edit:timings] '.length));
            await new Promise((r) => setTimeout(r, 50));
          }
          return null;
        };
        return { app, page, stdout, readyMs, timings };
      },
    });
    for (const a of apps) await a.close().catch(() => {});
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  },
});

export { expect, fs, path };
