// Bundles the Node-side entry points (Electron main/preload, server CLI) with esbuild.
//   node scripts/build-node.mjs [--outdir dist] [--watch] [--only electron|server]
// Everything is bundled except node-pty (native; staged next to dist/ by stage.mjs).
import { build, context } from 'esbuild';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const watch = args.includes('--watch');
const outdir = opt('--outdir', 'dist');
const only = opt('--only', 'all');
const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: false, logLevel: 'info', minify: !watch, legalComments: 'none' };

const jobs = [];
if (only !== 'server') {
  // node-pty is native: loaded at runtime from node_modules (dev) or app.asar.unpacked (packaged).
  jobs.push({ ...common, entryPoints: ['src/main/main.ts'], outfile: `${outdir}/main/main.cjs`, format: 'cjs', external: ['electron', 'node-pty'] });
  jobs.push({ ...common, entryPoints: ['src/main/preload.ts'], outfile: `${outdir}/main/preload.cjs`, format: 'cjs', external: ['electron'] });
}
if (only !== 'electron') {
  jobs.push({
    ...common,
    entryPoints: ['src/server/cli.ts'],
    outfile: `${outdir}/server/cli.mjs`,
    format: 'esm',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
}

if (watch) {
  for (const j of jobs) await (await context(j)).watch();
} else {
  await Promise.all(jobs.map((j) => build(j)));
}
