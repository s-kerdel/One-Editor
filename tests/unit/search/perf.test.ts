// Performance budget (asserted): index 5,000 ~1.5KB notes < 2s; typical queries < 50ms.
import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../../src/search/engine';
import { synthDocs } from './synth';
import { cpuLoadMeter, describeLoad, type CpuLoad } from '../../perf/cpu-meter';

/** Wall-clock budgets are skipped (with the reason) when another job kept the CPUs busy meanwhile. */
const busyNote = (load: CpuLoad) => `${describeLoad(load)}: wall-clock budgets not measurable`;


// Timing budgets: retried so CPU contention from the parallel suite can't fail them; a real regression fails every attempt.
describe('performance', { retry: 2 }, () => {
  const docs = synthDocs(5000);
  const engine = new SearchEngine();
  let indexMs = 0;

  it('indexes 5,000 notes (~1.5KB each) in < 2s', (ctx) => {
    const meter = cpuLoadMeter();
    const bytes = docs.reduce((n, d) => n + d.content.length, 0);
    expect(bytes / docs.length).toBeGreaterThan(1400);
    const t0 = performance.now();
    engine.reset(docs);
    indexMs = performance.now() - t0;
    console.log(`[perf] indexed ${docs.length} docs / ${(bytes / 1e6).toFixed(1)}MB in ${indexMs.toFixed(0)}ms (vocab ${engine.vocab.size})`);
    expect(engine.size).toBe(5000);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(indexMs).toBeLessThan(2000);
  });

  const queries = ['--force-with-lease', 'php artisan migrate:fresh --seed', 'kubectl get pods -o wide', 'deploy server', 'release -draft', 'lang:bash docker', 'in:heading review', '/fox\\s+jumps/', 'kubctl', '"quick brown"', 'path:folder1/ cache'];
  for (const q of queries) {
    it(`query ${JSON.stringify(q)} < 50ms`, (ctx) => {
      const meter = cpuLoadMeter();
      engine.search(q); // warm
      const times: number[] = [];
      let r;
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        r = engine.search(q);
        times.push(performance.now() - t0);
      }
      // Best-of-7: a real regression slows every run; CPU contention from the parallel suite does not.
      const ms = Math.min(...times);
      console.log(`[perf] ${q.padEnd(36)} ${ms.toFixed(1).padStart(6)}ms  ${r!.totalMatches} hits / ${r!.totalFiles} files${r!.fuzzy ? ' (fuzzy)' : ''}`);
      expect(r!.totalFiles).toBeGreaterThan(0);
      const load = meter.stop();
      ctx.skip(load.busy, busyNote(load));
      expect(ms).toBeLessThan(50);
    });
  }

  it('incremental update of one doc is cheap (< 5ms)', (ctx) => {
    const meter = cpuLoadMeter();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) engine.upsert({ path: docs[i].path, content: docs[i].content + `\nedit ${i} zebra-unicorn` });
    const per = (performance.now() - t0) / 20;
    expect(engine.search('zebra-unicorn').totalFiles).toBe(20);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(per).toBeLessThan(5);
  });
});
