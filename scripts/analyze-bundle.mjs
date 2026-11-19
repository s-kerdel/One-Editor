// Shows what ends up in the renderer's *startup* chunks (entry + its static imports), by package.
// Usage: node scripts/analyze-bundle.mjs   — keep this small: it is parsed before first paint.
import { build } from 'vite';
const res = await build({ configFile: new URL('../vite.config.ts', import.meta.url).pathname, logLevel: 'silent', build: { write: false } });
const chunks = (Array.isArray(res) ? res : [res]).flatMap((o) => o.output).filter((c) => c.type === 'chunk');
const byName = new Map(chunks.map((c) => [c.fileName, c]));
const entry = chunks.find((c) => c.isEntry);
const startup = new Set();
const visit = (c) => { if (!c || startup.has(c)) return; startup.add(c); c.imports.forEach((i) => visit(byName.get(i))); };
visit(entry);
const sizes = {};
let total = 0;
for (const c of startup) for (const [id, m] of Object.entries(c.modules)) {
  const rel = id.replace(process.cwd() + '/', '');
  const nm = rel.split('node_modules/').pop();
  const key = rel.includes('node_modules/') ? nm.split('/').slice(0, nm.startsWith('@') ? 2 : 1).join('/') : rel.split('/').slice(0, 3).join('/');
  sizes[key] = (sizes[key] || 0) + m.renderedLength;
  total += m.renderedLength;
}
console.log(`startup JS: ${(total / 1024).toFixed(1)} kB in ${startup.size} chunk(s) (${[...startup].map((c) => c.fileName).join(', ')})`);
for (const [k, n] of Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${(n / 1024).toFixed(1).padStart(8)} kB  ${k}`);
