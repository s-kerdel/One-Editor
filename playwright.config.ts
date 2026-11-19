import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Test workspaces live under .tmp/ inside this git repo: stop git discovery there, so the app's git
// features (and git tests) never mistake a temp workspace for part of the sec-edit repository.
process.env.GIT_CEILING_DIRECTORIES ||= fileURLToPath(new URL('./.tmp', import.meta.url));
// Temp dirs (mkdtemp in os.tmpdir(), Electron profiles, artifacts) stay inside the project, never /tmp.
process.env.TMPDIR ||= fileURLToPath(new URL('./.tmp/tmp', import.meta.url));
mkdirSync(process.env.TMPDIR, { recursive: true });

// Tip for parallel runs: give each run its own build dir, e.g.
//   SEC_EDIT_RENDERER_OUT=$PWD/.tmp/x/renderer npx playwright test tests/e2e/search.spec.ts --output $PWD/.tmp/x/results
/** Specs that measure time / work (perf*.spec.ts, *-perf.spec.ts): they run after everything else,
 *  one at a time, so the suite itself never competes with what they measure. */
export const TIMING_SPECS = /(?:^|[\\/])(?:perf(?:-[^\\/]*)?|[^\\/]*-perf)\.spec\.ts$/;

/** Full run (no spec files named): timing specs wait for the functional project. Naming a spec file
 *  (`npx playwright test tests/e2e/perf-responsive.spec.ts`) runs just that, without the dependency. */
export const FULL_RUN = !process.argv.slice(2).some((a) => /\.spec\.ts(?::\d+)*$/.test(a) || /(?:^|\/)tests\/e2e(?:\/|$)/.test(a) || /^(?:-g|--grep(?:-invert)?|--last-failed|--only-changed)(?:=|$)/.test(a));

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  testIgnore: /electron\/.*/,
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: true,
  workers: 4,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1360, height: 860 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'functional', testIgnore: [/electron\/.*/, TIMING_SPECS] },
    // Timing specs: after the functional project, a single worker, a longer timeout (machine load can
    // slow the pointer / page round trips they count; it never loosens what they assert).
    { name: 'timing', testMatch: TIMING_SPECS, dependencies: FULL_RUN ? ['functional'] : [], workers: 1, fullyParallel: false, timeout: 90_000 },
  ],
});
