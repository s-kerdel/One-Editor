// Deterministic synthetic workspace for performance tests (~1.5KB notes with prose, headings, code, commands).
const WORDS = 'the quick brown fox jumps over lazy dog project meeting notes release deploy server client database query index cache token session config build test review design plan sprint backlog issue feature bug fix refactor module component service handler request response error warning logger metric dashboard alert schedule migration backup restore network latency throughput storage volume cluster node pod container image registry secret policy role user group permission audit report summary detail context example sample draft final version branch commit merge rebase tag remote origin upstream'.split(' ');
const CMDS = [
  'git push --force-with-lease origin main',
  'php artisan migrate:fresh --seed',
  'kubectl get pods -o wide',
  'docker compose up -d --build',
  'npm run build -- --watch',
  'rg --hidden -g "!node_modules" TODO',
  'ssh -i ~/.ssh/id_ed25519 deploy@10.0.0.12',
  'tar -xvf archive.tar.gz -C /opt',
];
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function synthDocs(n: number, seed = 42): Array<{ path: string; content: string }> {
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const sentence = (k: number) => Array.from({ length: k }, () => pick(WORDS)).join(' ');
  const docs = [];
  for (let i = 0; i < n; i++) {
    let c = `# ${sentence(3)} ${i}\n\n`;
    while (c.length < 1400) {
      const x = r();
      if (x < 0.55) c += sentence(12 + Math.floor(r() * 14)) + '.\n\n';
      else if (x < 0.7) c += `## ${sentence(2)}\n\n`;
      else if (x < 0.85) c += '```bash\n' + pick(CMDS) + '\n' + pick(CMDS) + '\n```\n\n';
      else c += `- [ ] ${sentence(6)} \`${pick(WORDS)}_${pick(WORDS)}()\`\n`;
    }
    docs.push({ path: `notes/folder${i % 50}/${pick(WORDS)}-${i}.md`, content: c });
  }
  return docs;
}
