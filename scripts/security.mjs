// Release security check (npm run security): known vulnerabilities, outdated packages, whether Electron is
// on the newest patch of its major and how long that major is supported, and the fuses of a packaged build.
// Exit code 1 = something to fix before releasing. Needs the network (npm registry, endoflife.date).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFuses, SEC_EDIT_FUSES } from './fuses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let failed = false;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const bad = (msg) => ((failed = true), console.log(`  ✘ ${msg}`));
const note = (msg) => console.log(`  · ${msg}`);
/** npm prints JSON even when it exits non-zero (audit with findings, outdated with updates). */
const npmJson = (args) => {
  try {
    return JSON.parse(execFileSync(npm, [...args, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || 'null');
  } catch (e) {
    return JSON.parse(e.stdout || 'null');
  }
};
const semver = (v) => v.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

console.log('Dependencies');
const audit = npmJson(['audit'])?.metadata?.vulnerabilities ?? {};
const serious = (audit.high ?? 0) + (audit.critical ?? 0);
const total = audit.total ?? 0;
if (serious) bad(`npm audit: ${audit.critical ?? 0} critical, ${audit.high ?? 0} high (${total} total) — run \`npm audit\``);
else if (total) note(`npm audit: ${total} low/moderate — run \`npm audit\``);
else ok('npm audit: no known vulnerabilities');
const outdated = Object.entries(npmJson(['outdated']) ?? {});
if (outdated.length) for (const [name, o] of outdated) note(`${name} ${o.current} → ${o.latest}`);
else ok('all packages up to date');

console.log('Electron');
const installed = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8')).version;
const major = installed.split('.')[0];
const versions = [].concat(npmJson(['view', `electron@${major}`, 'version']) ?? []);
const latestPatch = versions.filter((v) => /^\d+\.\d+\.\d+$/.test(v)).reduce((a, b) => (newer(b, a) ? b : a), installed);
if (newer(latestPatch, installed)) bad(`Electron ${installed} → ${latestPatch} available (Chromium security fixes): npm install --save-dev electron@^${latestPatch}`);
else ok(`Electron ${installed} is the newest ${major}.x`);
const latestStable = npmJson(['view', 'electron', 'version']);
if (typeof latestStable === 'string' && Number(latestStable.split('.')[0]) > Number(major)) note(`newer major: Electron ${latestStable} (plan the upgrade)`);
try {
  const res = await fetch('https://endoflife.date/api/v1/products/electron/', { signal: AbortSignal.timeout(10_000) });
  const rel = (await res.json())?.result?.releases?.find((r) => r.name === major);
  const eol = rel?.eolFrom;
  if (!eol) note(`end of support for ${major}: unknown (https://endoflife.date/electron)`);
  else {
    const days = Math.round((Date.parse(eol) - Date.now()) / 86_400_000);
    if (days < 0 || rel.isEol) bad(`Electron ${major} is out of support since ${eol}: upgrade the major`);
    else if (days < 45) bad(`Electron ${major} support ends ${eol} (${days} days): upgrade the major`);
    else ok(`Electron ${major} supported until ${eol} (${days} days)`);
  }
} catch {
  note('end of support: could not reach endoflife.date (https://endoflife.date/electron)');
}

console.log('Packaged build');
for (const exe of ['release/One-win32-x64/One.exe', 'release/One-linux-x64/one']) {
  const file = path.join(root, exe);
  if (!fs.existsSync(file)) {
    note(`${exe}: not built`);
    continue;
  }
  const fuses = readFuses(file);
  const wrong = Object.entries(SEC_EDIT_FUSES).filter(([k, v]) => fuses[k] !== v);
  if (wrong.length) bad(`${exe}: fuses ${wrong.map(([k, v]) => `${k} should be ${v ? 'on' : 'off'}`).join(', ')}`);
  else ok(`${exe}: fuses as intended (${Object.entries(SEC_EDIT_FUSES).map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')})`);
}

console.log(failed ? '\n✘ Fix the items above before releasing.' : '\n✔ Ready to release.');
process.exitCode = failed ? 1 : 0;
