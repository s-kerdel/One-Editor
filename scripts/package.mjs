// Builds a ready-to-run desktop package from any OS (no wine needed: exe metadata/icon via resedit).
//   node scripts/package.mjs win32   → release/One-win32-x64/One.exe  + release/One-win32-x64.zip
//   node scripts/package.mjs linux   → release/One-linux-x64/one       + release/One-linux-x64.zip
//   node scripts/package.mjs darwin  → release/One-darwin-<arch>/One.app + .zip   (npm run package:mac; arch = this Mac's)
//   macOS: ad-hoc signed (no Apple Developer ID), so the first launch needs right-click → Open; see README.
//   --out <dir>      build there instead of release/ (tests, snapshots: e.g. .tmp/<area>/release)
//   --test-package   a package for tests/e2e/electron/packaged.spec.ts: it accepts --remote-debugging-port (a
//                    release package refuses it). Needs --out: never into release/.
// Ships only the staged app (package.json + dist/) inside app.asar, plus node-pty in app.asar.unpacked.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { applyFuses } from './fuses.mjs';
import { writeLicences } from './notices.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const outArg = outAt === -1 ? null : argv[outAt + 1];
const testPackage = argv.includes('--test-package');
const positional = argv.filter((a, i) => !a.startsWith('--') && !(outAt !== -1 && i === outAt + 1));
const platform = positional[0] || process.platform;
// A Mac builds for itself by default (arm64 on Apple Silicon); pass x64 / arm64 to cross-build. Win/Linux: x64.
const arch = positional[1] || (platform === 'darwin' && process.arch === 'arm64' ? 'arm64' : 'x64');
if (testPackage && !outArg) throw new Error('--test-package needs --out <dir> (a test package never goes into release/)');
if (!['win32', 'linux', 'darwin'].includes(platform)) throw new Error(`Unknown platform ${platform}`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const release = outArg ? path.resolve(root, outArg) : path.join(root, 'release');
const staged = path.join(release, 'app');

const t0 = Date.now();
execFileSync(process.execPath, [path.join(root, 'scripts/stage.mjs'), '--out', staged, '--platform', platform, '--arch', arch, ...(testPackage ? ['--test-package'] : [])], { stdio: 'inherit', cwd: root });

const [outDir] = await packager({
  dir: staged,
  // Packager's scratch copy stays inside the project (never /tmp).
  tmpdir: path.join(root, '.tmp/packager'),
  out: release,
  platform,
  arch,
  electronVersion,
  // Product name people see (keep in sync with src/shared/brand.ts). The app's internal name stays
  // "sec-edit" (stage.mjs productName): it names the data folder, so settings and the vault stay put.
  name: 'One',
  executableName: platform === 'win32' ? 'One' : 'one',
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appCopyright: `© ${new Date().getFullYear()} One`,
  // node-pty must be real files: its .node binaries, ConPTY's OpenConsole.exe and its worker scripts.
  // The web server + the UI it serves and the MCP server stay real files too: `One --serve` / `One --mcp-stdio`
  // and the web server's utilityProcess import them as ES modules by their file path (src/main/headless.ts).
  asar: { unpackDir: '{node_modules/node-pty,node_modules/node-pty/**,dist/server,dist/server/**,dist/renderer,dist/renderer/**,dist/mcp,dist/mcp/**}' },
  overwrite: true,
  prune: false, // nothing to prune: the staged app has no package dependencies (node-pty is staged by hand)
  derefSymlinks: true,
  icon: path.join(root, platform === 'win32' ? 'build/icon.ico' : platform === 'darwin' ? 'build/icon.icns' : 'build/icon.png'),
  // macOS bundle: the id names the app for the OS (Dock, Launch Services, permissions); not the data folder (that is "sec-edit").
  appBundleId: 'app.one-editor.one',
  appCategoryType: 'public.app-category.developer-tools',
  // Finder's "Open With" lists an app only if its Info.plist says what it opens. Rank "Alternate": One is offered, but
  // never becomes the default for a file type on its own. The files then arrive as 'open-file' (main.ts).
  extendInfo: {
    CFBundleDocumentTypes: [
      { CFBundleTypeName: 'Folder', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.folder'] },
      {
        CFBundleTypeName: 'Text, Markdown and code',
        CFBundleTypeRole: 'Editor',
        LSHandlerRank: 'Alternate',
        LSItemContentTypes: ['public.text', 'public.plain-text', 'public.source-code', 'public.script', 'public.shell-script', 'public.json', 'public.xml', 'public.yaml', 'net.daringfireball.markdown'],
      },
      { CFBundleTypeName: 'PDF document', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['com.adobe.pdf'] },
    ],
  },
  // Ad-hoc signing is redone below, after the fuses change the framework binary.
  osxSign: false,
  win32metadata: {
    CompanyName: 'One',
    FileDescription: 'One — code, Markdown and PDF editor',
    ProductName: 'One',
    InternalName: 'One',
    OriginalFilename: 'One.exe',
  },
  quiet: true,
});

// Fuses (scripts/fuses.mjs): no Node mode, no NODE_OPTIONS, no --inspect, the app from app.asar only.
// macOS keeps the fuse wire in the Electron Framework binary, and flipping it breaks the code signature: the whole
// bundle is signed again (ad hoc) right after, which Apple Silicon requires anyway before it will run a binary.
const showFuses = (f) => console.log(`fuses: ${Object.entries(f).map(([k, v]) => `${k}=${v === true ? 'on' : v === false ? 'off' : v}`).join(' ')}`);
if (platform === 'darwin') {
  const app = path.join(outDir, 'One.app');
  // The `one` terminal command lives in the bundle (like VS Code's `code`), so a symlink to it always matches the installed app.
  fs.mkdirSync(path.join(app, 'Contents/Resources/bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'build/mac/bin/one'), path.join(app, 'Contents/Resources/bin/one'));
  fs.chmodSync(path.join(app, 'Contents/Resources/bin/one'), 0o755);
  // Packager fills CFBundleDisplayName from executableName ('one', which the launchers use): Finder, Launchpad and
  // the Dock would show "one". Fixed in the plist itself, before signing.
  const plist = path.join(app, 'Contents/Info.plist');
  const info = fs.readFileSync(plist, 'utf8');
  const named = info.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, '$1One$2');
  if (named === info && !info.includes('<string>One</string>')) throw new Error('Info.plist: CFBundleDisplayName not found');
  fs.writeFileSync(plist, named);
  showFuses(applyFuses(path.join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')));
  if (process.platform === 'darwin') {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
    console.log('signed: ad hoc (no Developer ID)');
  } else console.warn('signed: NOT — built off a Mac; run `codesign --force --deep --sign - One.app` on a Mac before first use');
} else {
  const exe = path.join(outDir, platform === 'win32' ? 'One.exe' : 'one');
  showFuses(applyFuses(exe));
}

// Electron's locales: keep English only (saves ~40 MB unpacked; UI is English).
const locales = path.join(outDir, platform === 'darwin' ? '' : 'locales');
if (platform !== 'darwin' && fs.existsSync(locales)) {
  for (const f of fs.readdirSync(locales)) if (!/^en-US\.pak$/.test(f)) fs.rmSync(path.join(locales, f));
}
// LICENSE.txt (One), LICENSE.electron.txt, THIRD-PARTY-NOTICES.txt: binary copies must carry the licence texts.
writeLicences(root, outDir, { product: 'One' });
if (platform === 'linux') {
  fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(outDir, 'one.png'));
  // Browser mode launcher (start-web.sh) and the MCP server's stdio launcher (one-mcp.sh).
  for (const f of fs.readdirSync(path.join(root, 'build/linux'))) {
    fs.copyFileSync(path.join(root, 'build/linux', f), path.join(outDir, f));
    fs.chmodSync(path.join(outDir, f), 0o755);
  }
}
if (platform === 'darwin') {
  // Browser mode launcher (start-web.sh) and the MCP server's stdio launcher (one-mcp.sh), next to One.app.
  for (const f of fs.readdirSync(path.join(root, 'build/mac'), { withFileTypes: true })) {
    if (!f.isFile()) continue;
    fs.copyFileSync(path.join(root, 'build/mac', f.name), path.join(outDir, f.name));
    fs.chmodSync(path.join(outDir, f.name), 0o755);
  }
}
if (platform === 'win32') {
  // Optional Explorer integration (HKCU, no admin) + "Start web server.cmd" for browser mode + "One MCP.cmd" (stdio).
  for (const f of fs.readdirSync(path.join(root, 'build/windows'))) fs.copyFileSync(path.join(root, 'build/windows', f), path.join(outDir, f));
}

const zip = `${outDir}.zip`;
fs.rmSync(zip, { force: true });
const name = path.basename(outDir);
try {
  if (platform === 'darwin' && process.platform === 'darwin') execFileSync('ditto', ['-c', '-k', '--keepParent', '--sequesterRsrc', name, path.basename(zip)], { cwd: release, stdio: 'inherit' });
  else execFileSync('zip', ['-qry', path.basename(zip), name], { cwd: release, stdio: 'inherit' });
} catch {
  execFileSync('python3', ['-m', 'zipfile', '-c', path.basename(zip), name], { cwd: release, stdio: 'inherit' });
}
const mb = (p) => (fs.statSync(p).size / 1048576).toFixed(1);
console.log(`\n✔ ${path.relative(root, outDir)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
console.log(`✔ ${path.relative(root, zip)}  ${mb(zip)} MB`);
if (platform === 'darwin') console.log(`\nInstall:  cp -R "${path.relative(root, path.join(outDir, 'One.app'))}" /Applications/\nFirst launch: right-click One in /Applications → Open (unsigned by Apple), or: xattr -cr /Applications/One.app\nTerminal:  sudo ln -sf /Applications/One.app/Contents/Resources/bin/one /usr/local/bin/one   (then: one . )`);
