// Builds the renderer once per Playwright run into a private dir (safe with parallel runs).
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  if (process.env.E2E_SKIP_BUILD) return;
  const out = process.env.SEC_EDIT_RENDERER_OUT || path.resolve(__dirname, '../../.e2e-dist/renderer');
  process.env.SEC_EDIT_RENDERER_OUT = out;
  execSync('npx vite build --logLevel error', { stdio: 'inherit', env: { ...process.env, SEC_EDIT_RENDERER_OUT: out }, cwd: path.resolve(__dirname, '../..') });
}
