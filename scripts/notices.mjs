// Licence files for a packaged build, written next to the executable by package.mjs:
//   LICENSE.txt              One's own licence (the repo's LICENSE)
//   LICENSE.electron.txt     Electron's MIT licence (packager writes it as a bare "LICENSE", which reads as One's)
//   THIRD-PARTY-NOTICES.txt  every production package (shipped-deps.mjs) with its licence texts
// MIT / BSD / Apache want their texts in binary copies too. The list is a superset of what the bundles
// contain (all non-dev lockfile entries), which is the safe direction. Chromium's own: LICENSES.chromium.html.
import fs from 'node:fs';
import path from 'node:path';
import { shippedEntries } from './shipped-deps.mjs';

/** Licence-like files at a package root (LICENSE, LICENCE.md, COPYING, NOTICE, LICENSE-MIT…). */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;

/** Components a package bundles under their own licence, which the build ships: pdf.js runtime data
 *  (copied by vite.config.ts `pdfjsAssets`) and winpty (its binaries are staged by stage.mjs on Windows).
 *  A missing file fails the build: a renamed licence must not drop out silently. */
export const BUNDLED_LICENCES = {
  'pdfjs-dist': [
    'cmaps/LICENSE',
    'standard_fonts/LICENSE_FOXIT',
    'standard_fonts/LICENSE_LIBERATION',
    'iccs/LICENSE',
    'wasm/LICENSE_OPENJPEG',
    'wasm/LICENSE_PDFJS_OPENJPEG',
    'wasm/LICENSE_JBIG2',
    'wasm/LICENSE_PDFJS_JBIG2',
    'wasm/LICENSE_QCMS',
    'wasm/LICENSE_PDFJS_QCMS',
  ],
  'node-pty': ['deps/winpty/LICENSE'],
};

/** package.json `license` in its current and old shapes → one SPDX-ish string. */
export function licenceId(v) {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string') return v.type;
  if (Array.isArray(v)) {
    const ids = v.map(licenceId).filter(Boolean);
    if (ids.length) return ids.length > 1 ? `(${ids.join(' OR ')})` : ids[0];
  }
  return '';
}

/** "github:o/r", "git+https://github.com/o/r.git", { url } → a browsable https URL ('' when unknown). */
export function repoUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return '';
  const gh = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(raw);
  if (gh) return `https://github.com/${gh[1].replace(/\.git$/, '')}`;
  const m = /^(?:git\+)?(https:\/\/[^\s]+?)(?:\.git)?$/.exec(raw);
  return m ? m[1] : '';
}

/** A package's licence texts: root licence files, then its BUNDLED_LICENCES entries. */
export function licenceTexts(dir, name, bundled = BUNDLED_LICENCES[name] ?? []) {
  const root = fs.readdirSync(dir).filter((f) => LICENCE_FILE.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
  for (const rel of bundled) if (!fs.existsSync(path.join(dir, rel))) throw new Error(`notices: ${name} has no ${rel} any more (update BUNDLED_LICENCES in scripts/notices.mjs)`);
  return [...root, ...bundled].map((file) => ({ file, text: fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n?/g, '\n').trim() }));
}

/** @param {{ product: string, version: string, licence: string, source: string, electron: string,
 *    packages: Array<{ name: string, version: string, license: string, texts: Array<{ file: string, text: string }> }> }} o */
export function renderNotices(o) {
  const rule = '-'.repeat(80);
  const head = [
    `${o.product} ${o.version}: third-party notices`,
    '',
    `${o.product} is licensed under ${o.licence || 'the terms in LICENSE.txt'}: see LICENSE.txt.`,
    ...(o.source ? [`Source code: ${o.source} (this build: tag v${o.version})`] : []),
    '',
    'This package also contains:',
    `- Electron ${o.electron} (MIT): LICENSE.electron.txt`,
    '- Chromium and its components: LICENSES.chromium.html',
    `- ${o.packages.length} open-source packages, listed below with their licence texts.`,
    '',
  ];
  const parts = o.packages.map((p) => {
    const label = `${p.name} ${p.version}${p.license ? ` (${p.license})` : ''}`;
    const body = p.texts.length
      ? p.texts.flatMap((t) => [...(p.texts.length > 1 ? [`[${t.file}]`] : []), t.text, ''])
      : [`The package has no licence file; its package.json declares: ${p.license || 'nothing'}.`, ''];
    return [rule, label, '', ...body].join('\n');
  });
  return `${[...head, ...parts].join('\n').trimEnd()}\n`;
}

/** THIRD-PARTY-NOTICES.txt for the project at `root` (its lockfile and installed node_modules). */
export function collectNotices(root, { product }) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const pkg = read('package.json');
  const packages = [];
  for (const e of shippedEntries(read('package-lock.json'))) {
    const dir = path.join(root, e.key);
    // Not installed here (another platform's optional package) = not in this build either.
    if (!fs.existsSync(path.join(dir, 'package.json'))) continue;
    const license = licenceId(e.license) || licenceId(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).license);
    packages.push({ name: e.name, version: e.version, license, texts: licenceTexts(dir, e.name) });
  }
  return renderNotices({
    product,
    version: pkg.version,
    licence: licenceId(pkg.license),
    source: repoUrl(pkg.repository),
    electron: read('node_modules/electron/package.json').version,
    packages,
  });
}

/** Writes the three licence files into a packaged app folder (`outDir` = where the executable is). */
export function writeLicences(root, outDir, { product }) {
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outDir, 'LICENSE.txt'));
  const bare = path.join(outDir, 'LICENSE');
  if (fs.existsSync(bare)) fs.renameSync(bare, path.join(outDir, 'LICENSE.electron.txt'));
  else fs.copyFileSync(path.join(root, 'node_modules/electron/LICENSE'), path.join(outDir, 'LICENSE.electron.txt'));
  fs.writeFileSync(path.join(outDir, 'THIRD-PARTY-NOTICES.txt'), collectNotices(root, { product }));
}
