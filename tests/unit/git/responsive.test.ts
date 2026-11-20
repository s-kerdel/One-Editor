// Opening files stays fast while git runs: a fake git answers `status` with a huge porcelain output,
// and readFile latency is measured meanwhile (p95 < 100 ms).
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BackendService } from '../../../src/backend/service';
import { BASE, makeRepo, testEnv, write } from './helpers';

const services: BackendService[] = [];
afterEach(() => services.splice(0).forEach((s) => s.dispose()));

describe('responsiveness while git runs', () => {
  it('readFile p95 < 100 ms while a status of 300k entries streams in', async () => {
    const dir = await makeRepo('responsive', { 'note.md': '# note\n'.repeat(200), 'a.md': 'a\n' });
    write(dir, 'a.md', 'b\n');
    // 300k untracked records (~12 MB of porcelain), written slowly in pieces.
    const big = path.join(BASE, 'big-porcelain.bin');
    if (!fs.existsSync(big)) {
      const recs = ['# branch.oid ' + 'b'.repeat(40), '# branch.head main'];
      for (let i = 0; i < 300_000; i++) recs.push(`? gen/dir${i % 500}/generated-file-${i}.js`);
      fs.writeFileSync(big, recs.join('\0') + '\0');
    }
    const fake = path.join(BASE, 'big-status-git.sh');
    fs.writeFileSync(fake, `#!/bin/sh\nfor a in "$@"; do if [ "$a" = status ]; then dd if='${big}' bs=262144 2>/dev/null; exit 0; fi; done\nexec git "$@"\n`, { mode: 0o755 });
    const cfg = path.join(BASE, 'responsive-cfg');
    const s = new BackendService(cfg, {}, {}, { env: testEnv(), gitPath: fake });
    services.push(s);
    await s.openWorkspace(dir);
    await s.git('trust'); // the user's "Trust" in the Source control panel: no git runs without it
    await s.readFile('note.md');
    const lat: number[] = [];
    let stop = false;
    const probe = (async () => {
      while (!stop) {
        const t = performance.now();
        await s.readFile('note.md');
        lat.push(performance.now() - t);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const t0 = performance.now();
    for (let i = 0; i < 6; i++) {
      const r = (await s.git('status', { fresh: true })) as { ok: boolean; entries?: unknown[]; truncated?: boolean };
      expect(r.ok).toBe(true);
    }
    const gitMs = performance.now() - t0;
    stop = true;
    await probe;
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    console.log(`[git perf] 6 × status of 300k entries: ${Math.round(gitMs)} ms; readFile p95 ${p95.toFixed(1)} ms (max ${lat.at(-1)!.toFixed(1)}, n=${lat.length})`);
    expect(lat.length).toBeGreaterThan(10);
    expect(p95).toBeLessThan(100);
  }, 120_000);
});
