// After `npm install`: node-pty's macOS helper (prebuilds/darwin-*/spawn-helper) arrives without its execute bit
// (npm unpacks the tarball with mode 644), and without it the integrated terminal fails with "posix_spawnp failed".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const prebuilds = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'node-pty', 'prebuilds');
if (fs.existsSync(prebuilds)) {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
