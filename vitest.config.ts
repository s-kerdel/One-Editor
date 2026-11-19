import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Temp dirs from tests (mkdtemp in os.tmpdir()) stay inside the project, never /tmp.
const TMP = fileURLToPath(new URL('./.tmp/tmp', import.meta.url));
mkdirSync(TMP, { recursive: true });

const TIMING_TESTS = ['tests/unit/**/perf.test.{ts,tsx}', 'tests/unit/**/*-perf.test.{ts,tsx}'];

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    environment: 'node', // DOM tests opt in with: // @vitest-environment happy-dom
    testTimeout: 20000,
    // Temp repos/workspaces live under .tmp/ inside this git repo: stop git discovery there.
    env: { GIT_CEILING_DIRECTORIES: fileURLToPath(new URL('./.tmp', import.meta.url)), TMPDIR: TMP },
    // Timing tests (perf.test.ts, *-perf.test.ts) run after the rest, one file at a time: the
    // parallel suite must not be the CPU contention they measure.
    projects: [
      { extends: true, test: { name: 'unit', include: ['tests/unit/**/*.test.{ts,tsx}'], exclude: [...configDefaults.exclude, ...TIMING_TESTS], sequence: { groupOrder: 0 } } },
      { extends: true, test: { name: 'timing', include: TIMING_TESTS, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
