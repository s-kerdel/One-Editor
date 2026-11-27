// Bundles the Node-side entry points (Electron main/preload, server CLI, MCP server) with esbuild.
//   node scripts/build-node.mjs [--outdir dist] [--watch] [--only electron|server|mcp]
// Everything is bundled except node-pty (native; staged next to dist/ by stage.mjs).
import { build, context } from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeShippedDeps } from './shipped-deps.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const watch = args.includes('--watch');
const outdir = opt('--outdir', 'dist');
const only = opt('--only', 'all');
const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'info', minify: !watch, legalComments: 'none' };

// The indexer runs in a worker thread started from source (`eval: true`): bundle it first and embed it
// as a string, so it works from inside app.asar and next to the server bundle alike.
const indexer = await build({ ...common, logLevel: 'warning', entryPoints: ['src/backend/indexer-worker.ts'], format: 'cjs', write: false });
common.define = { __SEC_EDIT_INDEXER_SRC__: JSON.stringify(indexer.outputFiles[0].text) };

const jobs = [];
if (only === 'all' || only === 'electron') {
  // node-pty is native: loaded at runtime from node_modules (dev) or app.asar.unpacked (packaged).
  jobs.push({ ...common, entryPoints: ['src/main/main.ts'], outfile: `${outdir}/main/main.cjs`, format: 'cjs', external: ['electron', 'node-pty'] });
  jobs.push({ ...common, entryPoints: ['src/main/preload.ts'], outfile: `${outdir}/main/preload.cjs`, format: 'cjs', external: ['electron'] });
  // "Start web server": the utilityProcess entry that runs dist/server/cli.mjs (no Node mode: RunAsNode fuse off).
  jobs.push({ ...common, entryPoints: ['src/main/web-server-child.ts'], outfile: `${outdir}/main/web-server-child.cjs`, format: 'cjs' });
  // What this build ships (names + versions from the lockfile), read by the opt-in "Security updates" check.
  writeShippedDeps(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), path.resolve(outdir, 'main/shipped-deps.json'));
}
if (only === 'all' || only === 'server') {
  jobs.push({
    ...common,
    entryPoints: ['src/server/cli.ts'],
    outfile: `${outdir}/server/cli.mjs`,
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

if (only === 'all' || only === 'mcp') {
  // The MCP server MCP clients start over stdio (src/mcp/cli.ts). Packaged: app.asar.unpacked/dist/mcp.
  const { version } = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'));
  jobs.push({
    ...common,
    entryPoints: ['src/mcp/cli.ts'],
    outfile: `${outdir}/mcp/cli.mjs`,
    format: 'esm',
    define: { ...common.define, __ONE_VERSION__: JSON.stringify(version) },
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

if (watch) {
  for (const j of jobs) await (await context(j)).watch();
} else {
  await Promise.all(jobs.map((j) => build(j)));
}
