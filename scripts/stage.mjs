// Stages a minimal production app folder:  <out>/package.json + <out>/dist/{main,renderer,server,mcp}
// + <out>/node_modules/node-pty (the one native module: runtime JS + the target's binaries only).
// Everything else is bundled, so packages ship exactly what runs.
//   node scripts/stage.mjs [--out release/app] [--platform win32|linux|darwin] [--arch x64|arm64]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(root, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'release/app');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const platform = opt('--platform', process.platform);
const arch = opt('--arch', process.arch);
const run = (cmd, cmdArgs, env = {}) => execFileSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'dist'), { recursive: true });
const node = process.execPath;
// Build details for Settings (app/build-info.tsx): commit (+"-dirty" with uncommitted changes) and UTC build time.
const git = (args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};
const commit = git(['rev-parse', '--short', 'HEAD']);
const buildEnv = {
  VITE_SEC_EDIT_COMMIT: commit ? commit + (git(['status', '--porcelain', '--untracked-files=no']) ? '-dirty' : '') : '',
  VITE_SEC_EDIT_BUILD_DATE: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
};
run(node, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'warn'], { SEC_EDIT_RENDERER_OUT: path.join(out, 'dist/renderer'), ...buildEnv });
// Electron main/preload + the browser-mode server (run by the packaged exe: "Start web server").
run(node, [path.join(root, 'scripts/build-node.mjs'), '--outdir', path.join(out, 'dist')]);
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: pkg.name,
      productName: 'sec-edit',
      version: pkg.version,
      description: pkg.description,
      main: 'dist/main/main.cjs',
      author: pkg.author || 'sec-edit',
      license: pkg.license,
    },
    null,
    2,
  ),
);
stageNodePty(path.join(out, 'node_modules/node-pty'));
console.log(`staged → ${path.relative(root, out) || out}`);

/** node-pty for the target: lib/*.js (no tests/maps), licences, and only that platform's binaries. */
function stageNodePty(dest) {
  const src = path.join(root, 'node_modules/node-pty');
  const copy = (rel) => {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) throw new Error(`node-pty: missing ${rel} (for ${platform}-${arch})`);
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  };
  const walk = (dir) =>
    fs.readdirSync(path.join(src, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name);
      return e.isDirectory() ? walk(rel) : /\.js$/.test(e.name) && !/\.test\.js$|testUtils/.test(e.name) ? [rel] : [];
    });
  for (const f of ['package.json', 'LICENSE', ...walk('lib')]) copy(f);
  let natives;
  if (platform === 'win32') {
    // ConPTY (conpty.node + bundled conpty.dll/OpenConsole.exe), the console-list agent, and winpty for old Windows 10.
    const pre = `prebuilds/win32-${arch}`;
    natives = ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty-agent.exe', 'winpty.dll', 'conpty/conpty.dll', 'conpty/OpenConsole.exe'].map((f) => `${pre}/${f}`);
    const conpty = path.join(src, 'third_party/conpty');
    for (const v of fs.existsSync(conpty) ? fs.readdirSync(conpty) : []) for (const f of ['LICENSE', 'NOTICE.md']) if (fs.existsSync(path.join(conpty, v, f))) copy(`third_party/conpty/${v}/${f}`);
  } else if (platform === 'darwin') {
    natives = ['pty.node', 'spawn-helper'].map((f) => `prebuilds/darwin-${arch}/${f}`);
  } else {
    // No Linux prebuilds: the module compiled by `npm install` (N-API, so it also loads in Electron).
    if (process.platform !== 'linux' || process.arch !== arch) throw new Error('node-pty for Linux must be compiled on Linux for the same arch');
    natives = ['build/Release/pty.node'];
  }
  for (const f of natives) copy(f);
  // node-pty rewrites its helper path with .replace('app.asar', 'app.asar.unpacked'), for a module that lives INSIDE the
  // asar. Ours is already a real folder in app.asar.unpacked (see package.mjs), so that turns the path into
  // "app.asar.unpacked.unpacked" and every macOS terminal fails with "posix_spawnp failed". Only rewrite a bare ".asar".
  const unixTerminal = path.join(dest, 'lib/unixTerminal.js');
  const code = fs.readFileSync(unixTerminal, 'utf8');
  const fixed = code.replace(/\.replace\('app\.asar', 'app\.asar\.unpacked'\)/, ".replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')").replace(/\.replace\('node_modules\.asar', 'node_modules\.asar\.unpacked'\)/, ".replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked')");
  if (fixed === code) throw new Error('node-pty: helperPath rewrite not found in lib/unixTerminal.js (changed upstream? re-check the staging fix)');
  fs.writeFileSync(unixTerminal, fixed);
  for (const f of natives) if (/spawn-helper$|\.exe$/.test(f)) fs.chmodSync(path.join(dest, f), 0o755);
}
