// Corpus for the search-torture journey: real-world commands plus near-miss decoys.
import fsp from 'node:fs/promises';
import path from 'node:path';

const F = '```';

export const CORPUS: Record<string, string> = {
  'qa/shell.md': [
    '# Shell snippets',
    '',
    'Count the todos:',
    '',
    F + 'bash',
    'grep -rn "TODO" . | wc -l',
    'export PATH="$HOME/bin:$PATH"',
    'rm -rf ./node_modules/*',
    `curl -X POST -H 'Content-Type: application/json' -d '{"a":1}' https://api.example.test/v1/items`,
    'tar -xzf backup.tar.gz > /dev/null 2>&1',
    'docker run --rm -it -v "$PWD":/app -w /app node:20 npm test',
    F,
    '',
    'Run `npm run build` before pushing to main.',
    '',
  ].join('\n'),
  'qa/sql.md': ['# Queries', '', F + 'sql', 'SELECT * FROM users WHERE id = 1;', F, ''].join('\n'),
  // CRLF file (Windows): line numbers and selections must still be exact.
  'qa/powershell.md': [
    '# Windows',
    '',
    'Node lives in C:\\Program Files\\nodejs\\node.exe on this box.',
    '',
    F + 'powershell',
    'Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1MB }',
    F,
    '',
  ].join('\r\n'),
  'qa/unicode.md': ['# Unicode', '', 'Café résumé naïve — 日本語のメモ — launch 🚀 day', 'Größe: 10 µm', ''].join('\n'),
  // Near misses: every line resembles a real command but must NOT match the exact queries.
  'qa/decoy.md': [
    '# Decoys',
    '',
    'we select the first of the users by name',
    '',
    F + 'bash',
    'grep -rn "FIXME" . | wc -c',
    'export PATH=/usr/bin',
    'rm -rf ./dist/*',
    'docker run --rm node:18 npm run lint',
    'npm test -- --watch',
    `curl -X GET -H 'Accept: text/plain' https://api.example.test/v1/items`,
    F,
    '',
    'Path C:\\Program Files (x86)\\nodejs is the 32-bit one.',
    '',
  ].join('\n'),
};

export async function writeCorpus(root: string) {
  await fsp.mkdir(path.join(root, 'qa'), { recursive: true });
  for (const [rel, text] of Object.entries(CORPUS)) await fsp.writeFile(path.join(root, rel), text);
}
