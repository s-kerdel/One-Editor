import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node', // DOM tests opt in with: // @vitest-environment happy-dom
    testTimeout: 20000,
    // Temp repos/workspaces live under .tmp/ inside this git repo: stop git discovery there.
    env: { GIT_CEILING_DIRECTORIES: fileURLToPath(new URL('./.tmp', import.meta.url)) },
  },
});
