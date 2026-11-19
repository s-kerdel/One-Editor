// Builds a ready-to-run desktop package from any OS (no wine needed: exe metadata/icon via resedit).
//   node scripts/package.mjs win32   → release/sec-edit-win32-x64/sec-edit.exe  + release/sec-edit-win32-x64.zip
//   node scripts/package.mjs linux   → release/sec-edit-linux-x64/sec-edit      + release/sec-edit-linux-x64.zip
// Ships only the staged app (package.json + dist/) inside app.asar, plus node-pty in app.asar.unpacked.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || 'x64';
if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unknown platform ${platform}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const release = path.join(root, 'release');
const staged = path.join(release, 'app');

const t0 = Date.now();
execFileSync(process.execPath, [path.join(root, 'scripts/stage.mjs'), '--out', staged, '--platform', platform, '--arch', arch], { stdio: 'inherit', cwd: root });

const [outDir] = await packager({
  dir: staged,
  out: release,
  platform,
  arch,
  electronVersion,
  name: 'sec-edit',
  executableName: 'sec-edit',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: `© ${new Date().getFullYear()} sec-edit`,
  // node-pty must be real files: its .node binaries, ConPTY's OpenConsole.exe and its worker scripts.
  // The web server + the UI it serves are real files too: the start scripts run them with the exe in
  // Node mode (ELECTRON_RUN_AS_NODE), where loading ESM from inside an asar is not reliable.
  asar: { unpackDir: '{node_modules/node-pty,node_modules/node-pty/**,dist/server,dist/server/**,dist/renderer,dist/renderer/**}' },
  overwrite: true,
  prune: false, // nothing to prune: the staged app has no package dependencies (node-pty is staged by hand)
  derefSymlinks: true,
  icon: path.join(root, platform === 'win32' ? 'build/icon.ico' : 'build/icon.png'),
  win32metadata: {
    CompanyName: 'sec-edit',
    FileDescription: 'sec-edit — Markdown & code editor',
    ProductName: 'sec-edit',
    InternalName: 'sec-edit',
    OriginalFilename: 'sec-edit.exe',
  },
  quiet: true,
});

// Electron's locales: keep English only (saves ~40 MB unpacked; UI is English).
const locales = path.join(outDir, platform === 'darwin' ? '' : 'locales');
if (platform !== 'darwin' && fs.existsSync(locales)) {
  for (const f of fs.readdirSync(locales)) if (!/^en-US\.pak$/.test(f)) fs.rmSync(path.join(locales, f));
}
if (platform === 'linux') {
  fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(outDir, 'sec-edit.png'));
  // Browser mode launcher (start-web.sh).
  for (const f of fs.readdirSync(path.join(root, 'build/linux'))) {
    fs.copyFileSync(path.join(root, 'build/linux', f), path.join(outDir, f));
    fs.chmodSync(path.join(outDir, f), 0o755);
  }
}
if (platform === 'win32') {
  // Optional Explorer integration (HKCU, no admin) + "Start web server.cmd" for browser mode.
  for (const f of fs.readdirSync(path.join(root, 'build/windows'))) fs.copyFileSync(path.join(root, 'build/windows', f), path.join(outDir, f));
}

const zip = `${outDir}.zip`;
fs.rmSync(zip, { force: true });
const name = path.basename(outDir);
try {
  execFileSync('zip', ['-qry', path.basename(zip), name], { cwd: release, stdio: 'inherit' });
} catch {
  execFileSync('python3', ['-m', 'zipfile', '-c', path.basename(zip), name], { cwd: release, stdio: 'inherit' });
}
const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
console.log(`\n✔ ${path.relative(root, outDir)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`✔ ${path.relative(root, zip)}  ${mb(zip)} MB`);
