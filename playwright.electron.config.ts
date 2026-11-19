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
/** Specs that measure time / CPU (perf-*.spec.ts, *-perf.spec.ts): after the rest, one at a time. */
const TIMING_SPECS = /(?:^|[\\/])(?:perf(?:-[^\\/]*)?|[^\\/]*-perf)\.spec\.ts$/;
/** Full run only (no spec file / grep given): naming a timing spec runs just that. */
const FULL_RUN = !process.argv.slice(2).some((a) => /\.spec\.ts(?::\d+)*$/.test(a) || /(?:^|\/)tests\/e2e(?:\/|$)/.test(a) || /^(?:-g|--grep(?:-invert)?|--last-failed|--only-changed)(?:=|$)/.test(a));

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
  projects: [
    { name: 'functional', testIgnore: TIMING_SPECS },
    { name: 'timing', testMatch: TIMING_SPECS, dependencies: FULL_RUN ? ['functional'] : [], workers: 1, fullyParallel: false, timeout: 120_000 },
  ],
});
