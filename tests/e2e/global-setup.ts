// Builds the renderer once per Playwright run into a private dir (safe with parallel runs).
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const out = process.env.SEC_EDIT_RENDERER_OUT || path.resolve(__dirname, '../../.e2e-dist/renderer');
  // The backend's indexer worker thread (the server under test runs from TypeScript sources), so
  // tests exercise the same off-main-thread indexing as the app. Fast (~0.1 s): built every run.
  const ix = path.join(path.dirname(out), 'indexer-worker.cjs');
  execSync(`npx esbuild src/backend/indexer-worker.ts --bundle --platform=node --format=cjs --target=node22 --log-level=error --outfile=${JSON.stringify(ix)}`, { stdio: 'inherit', cwd: path.resolve(__dirname, '../..') });
  process.env.SEC_EDIT_INDEXER_SRC_FILE = ix;
  if (process.env.E2E_SKIP_BUILD) return;
  process.env.SEC_EDIT_RENDERER_OUT = out;
  execSync('npx vite build --logLevel error', { stdio: 'inherit', env: { ...process.env, SEC_EDIT_RENDERER_OUT: out }, cwd: path.resolve(__dirname, '../..') });
}
