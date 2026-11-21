// scripts/notices.mjs: the licence files package.mjs puts next to the executable.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain .mjs build script
import { BUNDLED_LICENCES, collectNotices, licenceId, licenceTexts, renderNotices, repoUrl, writeLicences } from '../../../scripts/notices.mjs';
// @ts-expect-error plain .mjs build script
import { shippedDeps, shippedEntries } from '../../../scripts/shipped-deps.mjs';

const root = path.resolve(__dirname, '../../..');
const dir = path.join(root, '.tmp/review/unit-notices');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('third-party notices of the packaged app', () => {
  it('lists every installed production package with its licence text, plus the bundled pdf.js / winpty licences', () => {
    const text: string = collectNotices(root, { product: 'One' });
    const installed = shippedEntries(lock).filter((e: { key: string }) => fs.existsSync(path.join(root, e.key, 'package.json')));
    expect(installed.length).toBeGreaterThan(100);
    for (const e of installed) expect(text).toContain(`\n${e.name} ${e.version}`);
    expect(text).toContain(`- ${installed.length} open-source packages`);
    for (const f of [...BUNDLED_LICENCES['pdfjs-dist'], ...BUNDLED_LICENCES['node-pty']]) expect(text).toContain(`[${f}]`);
    expect(text).toMatch(/^One \d+\.\d+\.\d+: third-party notices\n/);
    expect(text).toContain('One is licensed under GPL-3.0-or-later: see LICENSE.txt.');
    expect(text).toContain('Source code: https://github.com/s-kerdel/One-Editor');
    expect(text).not.toContain('\r');
    // Every package says what it is under (khroma has no lockfile licence: its package.json/LICENSE file covers it).
    expect(text).not.toContain('declares: nothing');
  });

  it('renders a section per package; labels files only when there are several; says so when there is none', () => {
    const out = renderNotices({
      product: 'One',
      version: '1.2.3',
      licence: 'GPL-3.0-or-later',
      source: 'https://example.com/repo',
      electron: '45.4.1',
      packages: [
        { name: 'a', version: '1.0.0', license: 'MIT', texts: [{ file: 'LICENSE', text: 'MIT text' }] },
        { name: 'b', version: '2.0.0', license: 'Apache-2.0', texts: [{ file: 'LICENSE', text: 'Apache text' }, { file: 'NOTICE', text: 'notice text' }] },
        { name: 'c', version: '3.0.0', license: 'ISC', texts: [] },
      ],
    });
    expect(out).toContain('Source code: https://example.com/repo (this build: tag v1.2.3)');
    expect(out).toContain('- Electron 45.4.1 (MIT): LICENSE.electron.txt');
    expect(out).toContain('a 1.0.0 (MIT)\n\nMIT text\n');
    expect(out).toContain('b 2.0.0 (Apache-2.0)\n\n[LICENSE]\nApache text\n\n[NOTICE]\nnotice text\n');
    expect(out).toContain('c 3.0.0 (ISC)\n\nThe package has no licence file; its package.json declares: ISC.');
    expect(out.endsWith('ISC.\n')).toBe(true);
  });

  it('fails the build when a bundled component licence is gone', () => {
    const pkg = path.join(dir, 'gone');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'LICENSE'), 'root\r\n');
    expect(licenceTexts(pkg, 'gone', [])).toEqual([{ file: 'LICENSE', text: 'root' }]);
    expect(() => licenceTexts(pkg, 'gone', ['wasm/LICENSE_X'])).toThrow(/gone has no wasm\/LICENSE_X/);
  });

  it("writes LICENSE.txt (One's), renames Electron's bare LICENSE and adds the notices", () => {
    const out = path.join(dir, 'app');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'LICENSE'), 'electron mit');
    writeLicences(root, out, { product: 'One' });
    expect(fs.readdirSync(out).sort()).toEqual(['LICENSE.electron.txt', 'LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']);
    expect(fs.readFileSync(path.join(out, 'LICENSE.electron.txt'), 'utf8')).toBe('electron mit');
    expect(fs.readFileSync(path.join(out, 'LICENSE.txt'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'LICENSE'), 'utf8'));
    // No bare LICENSE from the packager: Electron's own file is copied in instead.
    fs.rmSync(out, { recursive: true });
    fs.mkdirSync(out);
    writeLicences(root, out, { product: 'One' });
    expect(fs.readFileSync(path.join(out, 'LICENSE.electron.txt'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'node_modules/electron/LICENSE'), 'utf8'));
  });

  it('licence ids and repository URLs in their package.json shapes', () => {
    expect(licenceId(' MIT ')).toBe('MIT');
    expect(licenceId({ type: 'BSD' })).toBe('BSD');
    expect(licenceId([{ type: 'MIT' }, { type: 'Apache-2.0' }])).toBe('(MIT OR Apache-2.0)');
    expect(licenceId(undefined)).toBe('');
    expect(repoUrl('github:o/r')).toBe('https://github.com/o/r');
    expect(repoUrl({ url: 'git+https://github.com/o/r.git' })).toBe('https://github.com/o/r');
    expect(repoUrl(undefined)).toBe('');
  });

  it('shippedDeps (the security check list) still sends names and versions only', () => {
    const d = shippedDeps(lock);
    expect(d.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.packages.length).toBe(shippedEntries(lock).length);
    for (const p of d.packages) expect(Object.keys(p)).toEqual(['name', 'version']);
  });
});
