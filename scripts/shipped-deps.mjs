// The exact versions a build ships, for the app's opt-in "Security updates" check (src/main/update-check.ts):
// Electron + every production dependency of the lockfile, transitive ones included (what
// `npm ls --omit=dev --all` lists). Written next to main.cjs by build-node.mjs, so the running app knows
// its own versions without a lockfile. Names and versions only.
import fs from 'node:fs';
import path from 'node:path';

/** @param {{ packages?: Record<string, { version?: string, dev?: boolean, link?: boolean }> }} lock package-lock.json (v2 / v3) */
export function shippedDeps(lock) {
  const all = lock?.packages;
  if (!all || typeof all !== 'object') throw new Error('shipped-deps: package-lock.json has no "packages" (lockfileVersion 2 or 3 needed)');
  const seen = new Map();
  let electron = '';
  for (const [key, p] of Object.entries(all)) {
    // "" is the project itself; links point at another entry.
    if (!key || p.link || typeof p.version !== 'string') continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (key === 'node_modules/electron') electron = p.version;
    // `dev: true` = only reachable from devDependencies: what --omit=dev leaves out.
    if (p.dev) continue;
    seen.set(`${name}@${p.version}`, { name, version: p.version });
  }
  if (!electron) throw new Error('shipped-deps: electron is not in package-lock.json');
  const packages = [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  return { electron, packages };
}

export function writeShippedDeps(root, file) {
  const deps = shippedDeps(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(deps));
  return deps;
}
