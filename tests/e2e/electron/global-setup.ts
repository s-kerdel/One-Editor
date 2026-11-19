// Stages the production app (same layout as the packaged one) and makes sure an X server is up.
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export default async function globalSetup() {
  const app = process.env.SEC_EDIT_ELECTRON_APP || path.join(os.tmpdir(), `sec-edit-electron-app-${process.pid}`);
  process.env.SEC_EDIT_ELECTRON_APP = app;
  if (!process.env.SEC_EDIT_SKIP_STAGE || !fs.existsSync(path.join(app, 'package.json'))) {
    execFileSync(process.execPath, [path.join(root, 'scripts/stage.mjs'), '--out', app], { stdio: 'inherit', cwd: root });
  }
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const xvfb = path.join(os.homedir(), '.local/xvfb/start-xvfb.sh');
    if (fs.existsSync(xvfb)) execSync(`${xvfb} :99`, { stdio: 'inherit' });
    process.env.DISPLAY = ':99';
  }
  return () => {
    if (!process.env.SEC_EDIT_KEEP_STAGE && !process.env.SEC_EDIT_SKIP_STAGE) fs.rmSync(app, { recursive: true, force: true });
  };
}
