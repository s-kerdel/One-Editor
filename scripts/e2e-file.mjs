// Fast loop for ONE E2E spec file: a private build dir per area, and the build is reused while its
// inputs have not changed (plain `npx playwright test` rebuilds on every run).
//   npm run test:e2e:file -- tests/e2e/smoke.spec.ts [-g "title"] [more playwright args]
//   npm run test:e2e:file -- tests/e2e/electron/app.spec.ts          (Electron config, staged app reused)
// Env: E2E_AREA=<name> (default: the spec's file name) -> everything lands in .tmp/e2e-file/<name>/
//      E2E_REBUILD=1 forces the build.  E2E_CONSOLE=1 prints renderer console / page errors (harness).
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const specs = args.filter((a) => /\.spec\.ts(?::\d+)*$/.test(a));
if (!specs.length) {
  console.error('usage: npm run test:e2e:file -- tests/e2e/<file>.spec.ts [-g "title"]\nA spec file is required: this command never runs the whole suite.');
  process.exit(2);
}
const electron = specs.every((s) => /(^|\/)tests\/e2e\/electron\//.test(s.replace(/\\/g, '/')));
if (!electron && specs.some((s) => /(^|\/)tests\/e2e\/electron\//.test(s.replace(/\\/g, '/')))) {
  console.error('Browser and Electron specs use different configs: run them in two commands.');
  process.exit(2);
}
const area = (process.env.E2E_AREA || path.basename(specs[0]).replace(/\.spec\.ts(?::\d+)*$/, '')).replace(/[^\w.-]/g, '_');
const dir = path.join(root, '.tmp/e2e-file', area);
fs.mkdirSync(dir, { recursive: true });

// One run per area at a time: a second run would empty the build dir under the first one.
const lock = path.join(dir, 'run.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const owner = fs.existsSync(lock) ? Number(fs.readFileSync(lock, 'utf8')) : 0;
if (owner && owner !== process.pid && alive(owner)) {
  console.error(`Another run (pid ${owner}) uses .tmp/e2e-file/${area}/. Set E2E_AREA=<other name>.`);
  process.exit(2);
}
fs.writeFileSync(lock, String(process.pid));

/** Everything the build reads: all of src/ (path + size + mtime, so a deleted file counts too) and the
 *  build configs. Over-inclusive on purpose: a needless rebuild costs seconds, a stale build lies. */
function inputsStamp() {
  const h = createHash('sha1');
  const add = (rel) => { const st = fs.statSync(path.join(root, rel), { throwIfNoEntry: false }); h.update(`${rel}:${st ? `${st.size}:${st.mtimeMs}` : '-'}\n`); };
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p); else add(p);
    }
  };
  walk('src');
  for (const f of ['vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json']) add(f);
  if (electron) {
    for (const f of ['scripts/stage.mjs', 'scripts/build-node.mjs']) add(f);
    // The staged app shows the commit it was built from.
    try { h.update(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch {}
  }
  return h.digest('hex');
}

const stampFile = path.join(dir, electron ? 'stamp-electron' : 'stamp-renderer');
const built = electron ? path.join(dir, 'app/package.json') : path.join(dir, 'renderer/index.html');
const stamp = inputsStamp();
const fresh = !process.env.E2E_REBUILD && fs.existsSync(built) && fs.existsSync(stampFile) && fs.readFileSync(stampFile, 'utf8') === stamp;
fs.rmSync(stampFile, { force: true }); // written again only after a run that left a build behind

const env = { ...process.env };
const pw = [path.join(root, 'node_modules/@playwright/test/cli.js'), 'test'];
if (electron) {
  env.SEC_EDIT_ELECTRON_APP = path.join(dir, 'app');
  env.SEC_EDIT_PW_OUTPUT = path.join(dir, 'results');
  // Both are read in tests/e2e/electron/global-setup.ts: skip = reuse the staged app, keep = do not delete it.
  if (fresh) env.SEC_EDIT_SKIP_STAGE = '1'; else { delete env.SEC_EDIT_SKIP_STAGE; env.SEC_EDIT_KEEP_STAGE = '1'; }
  pw.push('-c', 'playwright.electron.config.ts');
} else {
  env.SEC_EDIT_RENDERER_OUT = path.join(dir, 'renderer');
  if (fresh) env.E2E_SKIP_BUILD = '1'; else delete env.E2E_SKIP_BUILD;
  pw.push('--output', path.join(dir, 'results'));
}
console.log(`[e2e-file] area .tmp/e2e-file/${area}/ - ${fresh ? 'build is fresh: reused' : 'building'}`);
const r = spawnSync(process.execPath, [...pw, ...args], { cwd: root, env, stdio: 'inherit' });
if (fs.existsSync(built)) fs.writeFileSync(stampFile, stamp);
fs.rmSync(lock, { force: true });
if (r.status !== 0) console.log(`[e2e-file] failed. Next: npm run trace:summary -- .tmp/e2e-file/${area}/results   (docs/llm/06-setup-and-debugging.md)`);
process.exit(r.status ?? 1);
