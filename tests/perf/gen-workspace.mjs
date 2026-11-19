// Generates a large, deterministic workspace for scale testing.
// Usage: node tests/perf/gen-workspace.mjs [outDir=.tmp/perf/big] [notes=10000] [code=2000]
// Layout: notes/area-XX/topic-YY/*.md (~2 KB each: headings, [[wikilinks]], #tags, code fences),
//         src/pkg-XX/mod-YY/*.{ts,php,sql,py,json}, plus one 20 KB note (notes/big-note.md).
// Never deletes anything: files are overwritten in place (use a fresh outDir for smaller counts).
import fs from 'node:fs';
import path from 'node:path';

const WORDS = 'deploy cluster rollback migration index query cache token session worker queue retry timeout schema tenant invoice payment webhook pipeline artifact release canary metric alert trace latency throughput backup restore snapshot replica shard gateway proxy certificate secret config feature flag branch merge rebase commit review ticket sprint estimate incident postmortem runbook checklist'.split(' ');
const TAGS = ['ops', 'backend', 'frontend', 'db', 'howto', 'incident', 'idea', 'meeting', 'project/alpha', 'project/beta', 'todo', 'reference'];
const CODE = {
  bash: (r) => `kubectl -n ${r.w()} rollout restart deploy/${r.w()}\ngit push --force-with-lease origin ${r.w()}`,
  sql: (r) => `SELECT id, ${r.w()} FROM ${r.w()}s WHERE ${r.w()}_id = ${r.n(999)} ORDER BY created_at DESC LIMIT 20;`,
  php: (r) => `<?php\n$${r.w()} = ${r.w()}Repository::find(${r.n(99)});\nreturn response()->json($${r.w()});`,
  ts: (r) => `export async function ${r.w()}${r.n(99)}(id: string) {\n  return fetch(\`/api/${r.w()}/\${id}\`).then((r) => r.json());\n}`,
};

/** Small deterministic PRNG (mulberry32) so every run produces the same tree. */
function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = (max) => Math.floor(f() * max);
  const w = () => WORDS[n(WORDS.length)];
  const sentence = (len = 8 + n(10)) => Array.from({ length: len }, w).join(' ');
  return { f, n, w, sentence };
}

const pad = (n, w) => String(n).padStart(w, '0');
export const noteName = (i) => `Note ${pad(i, 5)}`;
export const notePath = (i) => `notes/area-${pad(i % 25, 2)}/topic-${pad(Math.floor(i / 25) % 16, 2)}/${noteName(i)}.md`;

export function noteContent(i, total, targetBytes = 2000) {
  const r = rng(i + 1);
  const langs = Object.keys(CODE);
  let out = `---\ntitle: ${noteName(i)}\ntags: [${TAGS[i % TAGS.length]}]\n---\n\n# ${noteName(i)} — ${r.sentence(3)}\n\n`;
  let section = 0;
  while (out.length < targetBytes) {
    out += `## ${r.sentence(3)} ${++section}\n\n`;
    out += `${r.sentence()} [[${noteName(r.n(total))}]] ${r.sentence()} #${TAGS[r.n(TAGS.length)]}.\n\n`;
    out += `- [ ] ${r.sentence(5)}\n- ${r.sentence(6)} see [[${noteName(r.n(total))}|${r.w()}]]\n\n`;
    const lang = langs[r.n(langs.length)];
    out += '```' + lang + '\n' + CODE[lang](r) + '\n```\n\n';
  }
  return out;
}

const EXT = ['ts', 'php', 'sql', 'py', 'json'];
export const codePath = (i) => `src/pkg-${pad(i % 20, 2)}/mod-${pad(Math.floor(i / 20) % 10, 2)}/file-${pad(i, 4)}.${EXT[i % EXT.length]}`;
export function codeContent(i) {
  const r = rng(100000 + i);
  const ext = EXT[i % EXT.length];
  if (ext === 'json') return JSON.stringify(Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`${r.w()}_${k}`, r.sentence(4)])), null, 2) + '\n';
  const body = ext === 'sql' ? CODE.sql : ext === 'php' ? CODE.php : CODE.ts;
  let out = ext === 'py' ? '' : `// ${r.sentence(6)}\n`;
  for (let k = 0; k < 12; k++) out += (ext === 'py' ? `def ${r.w()}_${k}(x):\n    return x + ${r.n(99)}  # ${r.sentence(4)}\n` : body(r)) + '\n\n';
  return out;
}

export function generate(outDir, notes = 10000, code = 2000) {
  const made = new Set();
  const write = (rel, content) => {
    const abs = path.join(outDir, rel);
    const dir = path.dirname(abs);
    if (!made.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    fs.writeFileSync(abs, content);
  };
  for (let i = 0; i < notes; i++) write(notePath(i), noteContent(i, notes));
  for (let i = 0; i < code; i++) write(codePath(i), codeContent(i));
  write('notes/big-note.md', noteContent(notes + 1, notes, 20000));
  write('README.md', `# Big workspace\n\n${notes} notes, ${code} code files. Start at [[${noteName(0)}]].\n`);
  return { notes, code, files: notes + code + 2 };
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  const out = path.resolve(process.argv[2] ?? '.tmp/perf/big');
  const t0 = Date.now();
  const r = generate(out, Number(process.argv[3] ?? 10000), Number(process.argv[4] ?? 2000));
  console.log(`generated ${r.files} files in ${out} (${Date.now() - t0} ms)`);
}
