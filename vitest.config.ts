import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

// Temp dirs from tests (mkdtemp in os.tmpdir()) stay inside the project, never /tmp.
const TMP = fileURLToPath(new URL('./.tmp/tmp', import.meta.url));
mkdirSync(TMP, { recursive: true });

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) } },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  test: {
    include: ['tests/unit/**/*.test.{ts,tsx}'],
    environment: 'node', // DOM tests opt in with: // @vitest-environment happy-dom
    testTimeout: 20000,
    // Temp repos/workspaces live under .tmp/ inside this git repo: stop git discovery there.
    env: { GIT_CEILING_DIRECTORIES: fileURLToPath(new URL('./.tmp', import.meta.url)), TMPDIR: TMP },
  },
});
