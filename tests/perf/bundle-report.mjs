// Startup-bundle report: what the browser must download + parse before first paint.
// Usage: node tests/perf/bundle-report.mjs <built renderer dir>
//   (build first: npx vite build --outDir $PWD/.tmp/perf/build)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Entry script + modulepreloads + stylesheets referenced by index.html, plus their static imports. */
export function startupAssets(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\.\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  // Static imports that the HTML does not preload still block startup. (Dynamic `import(` never matches.)
  const seen = new Set(refs);
  const queue = refs.filter((r) => r.endsWith('.js'));
  while (queue.length) {
    const src = fs.readFileSync(path.join(dir, queue.pop()), 'utf8');
    for (const m of src.matchAll(/(?:^|[;}\n])\s*(?:import|export)\s*(?:[^'"()]*?from\s*)?["']\.\/([^"']+\.js)["']/g)) {
      const f = `assets/${m[1]}`;
      if (!seen.has(f) && fs.existsSync(path.join(dir, f))) {
        seen.add(f);
        queue.push(f);
      }
    }
  }
  return [...seen].map((file) => {
    const buf = fs.readFileSync(path.join(dir, file));
    return { file, bytes: buf.length, gzip: zlib.gzipSync(buf, { level: 9 }).length };
  });
}

export function startupTotals(dir) {
  const assets = startupAssets(dir);
  const sum = (ext, k) => assets.filter((a) => a.file.endsWith(ext)).reduce((n, a) => n + a[k], 0);
  return { assets, js: sum('.js', 'bytes'), jsGzip: sum('.js', 'gzip'), css: sum('.css', 'bytes'), cssGzip: sum('.css', 'gzip') };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const dir = path.resolve(process.argv[2] ?? '.tmp/perf/build');
  const t = startupTotals(dir);
  const kb = (n) => (n / 1000).toFixed(1).padStart(7) + ' kB';
  for (const a of t.assets.sort((x, y) => y.bytes - x.bytes)) console.log(`${kb(a.bytes)}  gzip ${kb(a.gzip)}  ${a.file}`);
  console.log(`startup JS  ${kb(t.js)}  gzip ${kb(t.jsGzip)}`);
  console.log(`startup CSS ${kb(t.css)}  gzip ${kb(t.cssGzip)}`);
}
