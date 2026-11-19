import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Test workspaces live under .tmp/ inside this git repo: stop git discovery there, so the app's git
// features (and git tests) never mistake a temp workspace for part of the sec-edit repository.
process.env.GIT_CEILING_DIRECTORIES ||= fileURLToPath(new URL('./.tmp', import.meta.url));
// Temp dirs (mkdtemp in os.tmpdir(), Electron profiles, artifacts) stay inside the project, never /tmp.
process.env.TMPDIR ||= fileURLToPath(new URL('./.tmp/tmp', import.meta.url));
mkdirSync(process.env.TMPDIR, { recursive: true });

// Electron E2E (real app under Xvfb on Linux):  npm run test:electron
// The app is staged once per run into a private dir (see tests/e2e/electron/global-setup.ts).
export default defineConfig({
  testDir: 'tests/e2e/electron',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: './tests/e2e/electron/global-setup.ts',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  outputDir: process.env.SEC_EDIT_PW_OUTPUT || '.tmp/electron-results',
});
