// The exact versions a build ships, for the app's opt-in "Security updates" check (src/main/update-check.ts):
// Electron + every production dependency of the lockfile, transitive ones included (what
// `npm ls --omit=dev --all` lists). Written next to main.cjs by build-node.mjs, so the running app knows
// its own versions without a lockfile. Names and versions only.
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{ packages?: Record<string, { version?: string, dev?: boolean, link?: boolean, license?: unknown }> }} Lock package-lock.json (v2 / v3) */

/** @param {Lock} lock */
export function shippedDeps(lock) {
  const e = lock?.packages?.['node_modules/electron'];
  const electron = e && !e.link && typeof e.version === 'string' ? e.version : '';
  const packages = shippedEntries(lock).map(({ name, version }) => ({ name, version }));
  if (!electron) throw new Error('shipped-deps: electron is not in package-lock.json');
  return { electron, packages };
}

/** Every production package of the lockfile, one per name@version (the first install path wins), sorted.
 *  `key` is its install path (`node_modules/a/node_modules/b`); notices.mjs reads its licence there.
 *  @param {Lock} lock */
export function shippedEntries(lock) {
  const all = lock?.packages;
  if (!all || typeof all !== 'object') throw new Error('shipped-deps: package-lock.json has no "packages" (lockfileVersion 2 or 3 needed)');
  const seen = new Map();
  for (const [key, p] of Object.entries(all)) {
    // "" is the project itself; links point at another entry; `dev: true` = only reachable from
    // devDependencies: what --omit=dev leaves out.
    if (!key || p.link || typeof p.version !== 'string' || p.dev) continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const id = `${name}@${p.version}`;
    if (!seen.has(id)) seen.set(id, { key, name, version: p.version, license: p.license });
  }
  return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

export function writeShippedDeps(root, file) {
  const deps = shippedDeps(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(deps));
  return deps;
}
