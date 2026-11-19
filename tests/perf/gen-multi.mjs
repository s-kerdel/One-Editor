// Generates a parent folder with several real-world-ish projects (the "open ~/code" case):
// notes + source files that matter, plus what every project drags along — lockfiles, minified
// bundles and source maps, coverage reports, build output, logs — mostly listed in .gitignore.
// Usage: node tests/perf/gen-multi.mjs [outDir=.tmp/perf2/multi] [projects=5] [realFiles=10000]
// Deterministic; never deletes (use a fresh outDir to shrink).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noteContent, codeContent } from './gen-workspace.mjs';

const GITIGNORE = `# deps / build output
node_modules/
/vendor/
/public/build/
/coverage/
/target/
/out/
*.log
.env
/storage/framework/
generated/
*.map
`;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENT = 'abcdefghijklmnopqrstuvwxyz';
/** One-line minified JS of ~bytes. */
function minified(seed, bytes) {
  const r = rng(seed);
  const id = () => IDENT[Math.floor(r() * 26)] + IDENT[Math.floor(r() * 26)];
  const parts = [];
  let n = 0;
  while (n < bytes) {
    const s = `function ${id()}(${id()},${id()}){return ${id()}.${id()}(${id()})?${Math.floor(r() * 1e4)}:"${id()}${id()}"}var ${id()}=${id()}(${Math.floor(r() * 99)});`;
    parts.push(s);
    n += s.length;
  }
  return parts.join('');
}
const sourceMap = (seed, bytes) => JSON.stringify({ version: 3, sources: ['webpack:///src/app.ts'], names: [], mappings: minified(seed, bytes).replace(/[^A-Za-z]/g, 'A') });
function packageLock(seed, bytes) {
  const r = rng(seed);
  const pk = {};
  let n = 0;
  for (let i = 0; n < bytes; i++) {
    const name = `node_modules/${IDENT.slice(i % 20, (i % 20) + 4)}-${i}`;
    const e = { version: `${Math.floor(r() * 9)}.${Math.floor(r() * 20)}.${Math.floor(r() * 9)}`, resolved: `https://registry.npmjs.org/${name}/-/x-1.0.0.tgz`, integrity: `sha512-${Buffer.from(String(r())).toString('base64').repeat(4)}`, dev: r() > 0.5 };
    pk[name] = e;
    n += 220;
  }
  return JSON.stringify({ name: 'app', lockfileVersion: 3, requires: true, packages: pk }, null, 2);
}
const log = (seed, bytes) => {
  const r = rng(seed);
  let out = '';
  for (let i = 0; out.length < bytes; i++) out += `[2026-11-${String(1 + (i % 28)).padStart(2, '0')} 10:${String(i % 60).padStart(2, '0')}:00] production.ERROR: Undefined index ${Math.floor(r() * 1e6)} at /var/www/app/Http/Controller.php:${Math.floor(r() * 400)}\n`;
  return out;
};

export function generateMulti(outDir, projects = 5, realFiles = 10000) {
  const made = new Set();
  const write = (rel, content) => {
    const abs = path.join(outDir, rel);
    const dir = path.dirname(abs);
    if (!made.has(dir)) fs.mkdirSync(dir, { recursive: true }), made.add(dir);
    fs.writeFileSync(abs, content);
  };
  const per = Math.floor(realFiles / projects);
  let junkBytes = 0;
  const junk = (rel, content) => {
    junkBytes += content.length;
    write(rel, content);
  };
  for (let p = 0; p < projects; p++) {
    const root = `project-${p}`;
    const seed = 1000 * (p + 1);
    // A repository: .gitignore + .git/info/exclude (no git binary needed to generate).
    write(`${root}/.gitignore`, GITIGNORE);
    write(`${root}/.git/HEAD`, 'ref: refs/heads/main\n');
    write(`${root}/.git/info/exclude`, '/scratch/\n');
    const notes = Math.floor(per * 0.75);
    for (let i = 0; i < notes; i++) write(`${root}/docs/area-${i % 8}/note-${p}-${i}.md`, noteContent(p * per + i, realFiles));
    for (let i = 0; i < per - notes; i++) {
      const c = codeContent(p * per + i);
      const ext = ['ts', 'php', 'sql', 'py', 'json'][i % 5];
      write(`${root}/src/mod-${i % 10}/file-${i}.${ext}`, c);
    }
    write(`${root}/README.md`, `# Project ${p}\n\nSee [[note-${p}-0]].\n`);
    // Lockfiles (committed, not ignored): skipped by the generated-files filter.
    junk(`${root}/package-lock.json`, packageLock(seed + 1, 1_200_000));
    junk(`${root}/composer.lock`, packageLock(seed + 2, 400_000));
    junk(`${root}/yarn.lock`, packageLock(seed + 3, 600_000).replace(/[{}",]/g, ''));
    // Committed vendor bundle (not ignored, but minified).
    junk(`${root}/public/js/vendor.min.js`, minified(seed + 4, 800_000));
    junk(`${root}/public/css/app.min.css`, minified(seed + 5, 200_000).replace(/function/g, '.x{a:b}'));
    // Ignored build output.
    for (let i = 0; i < 4; i++) {
      junk(`${root}/public/build/chunk-${i}.js`, minified(seed + 10 + i, 600_000));
      junk(`${root}/public/build/chunk-${i}.js.map`, sourceMap(seed + 20 + i, 1_400_000));
    }
    for (let i = 0; i < 300; i++) junk(`${root}/coverage/lcov-report/file-${i}.html`, `<html><body><pre>${codeContent(seed + i).repeat(4)}</pre></body></html>`);
    for (let i = 0; i < 400; i++) junk(`${root}/target/debug/.fingerprint/crate-${i}/lib.json`, JSON.stringify({ rustc: seed + i, features: '[]', deps: Array.from({ length: 20 }, (_, k) => [k, `dep-${k}`]) }));
    for (let i = 0; i < 300; i++) junk(`${root}/out/gen-${i}.js`, codeContent(seed + 500 + i));
    for (let i = 0; i < 100; i++) junk(`${root}/src/generated/api-${i}.ts`, codeContent(seed + 900 + i).repeat(2));
    junk(`${root}/storage/logs/laravel.log`, log(seed + 6, 1_500_000));
    junk(`${root}/scratch/notes-dump.txt`, log(seed + 7, 300_000)); // .git/info/exclude
    // Excluded by the default exclude list (never walked): realistic, costs nothing.
    for (let i = 0; i < 50; i++) write(`${root}/node_modules/pkg-${i}/index.js`, codeContent(seed + 1500 + i));
  }
  return { projects, realFiles: per * projects, junkMB: Math.round(junkBytes / 1e6) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out = '.tmp/perf2/multi', projects = '5', real = '10000'] = process.argv.slice(2);
  const t = Date.now();
  console.log(generateMulti(out, Number(projects), Number(real)), `${Date.now() - t} ms`);
}
