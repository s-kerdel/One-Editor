// Perf guard: a note switch in the Connections view (related notes, local graph, backlinks, shared
// tags) must stay well inside a frame for 10k notes — it reads the index's adjacency, never all notes.
import { describe, expect, it } from 'vitest';
import { KnowledgeIndex } from '../../../src/knowledge/index';
import { localGraph, notesWithoutIncoming, orphanNotes, relatedNotes, sharedTags } from '../../../src/knowledge/connections';
// @ts-expect-error plain .mjs helper without types
import { noteContent, notePath } from '../../perf/gen-workspace.mjs';
import { cpuLoadMeter, describeLoad, type CpuLoad } from '../../perf/cpu-meter';

/** Wall-clock budgets are skipped (with the reason) when another job kept the CPUs busy meanwhile. */
const busyNote = (load: CpuLoad) => `${describeLoad(load)}: wall-clock budgets not measurable`;

const N = 10_000;

function switchCost(idx: KnowledgeIndex, path: string): number {
  const t0 = performance.now();
  relatedNotes(idx, path);
  localGraph(idx, path, 2, 70);
  idx.backlinks(path);
  idx.outgoing(path);
  sharedTags(idx, path);
  return performance.now() - t0;
}

describe('connections at 10k notes', { retry: 2, timeout: 120_000 }, () => {
  const idx = new KnowledgeIndex({ retainText: false });
  const paths: string[] = Array.from({ length: N }, (_, i) => notePath(i));
  idx.setFiles(paths);
  for (let i = 0; i < N; i++) idx.update(paths[i], noteContent(i, N, 1500));
  // Hub: links to 2,000 notes and is tagged like everything else.
  const hub = 'notes/Hub.md';
  idx.update(hub, `---\ntags: [ops, backend]\n---\n${Array.from({ length: 2000 }, (_, i) => `[[Note ${String(i * 5).padStart(5, '0')}]]`).join(' ')}\n`);
  idx.backlinks(paths[0]); // derive once (as after the initial build)

  it('switching notes costs well under a frame (p95 and worst case)', (ctx) => {
    const meter = cpuLoadMeter();
    const sample = Array.from({ length: 300 }, (_, k) => paths[(k * 7919) % N]);
    for (const p of sample.slice(0, 20)) switchCost(idx, p); // JIT warm-up
    const ms = sample.map((p) => switchCost(idx, p)).sort((a, b) => a - b);
    const p95 = ms[Math.floor(ms.length * 0.95)];
    const hubMs = switchCost(idx, hub);
    console.log(`[perf] connections switch @${N}: median ${ms[ms.length >> 1].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${ms[ms.length - 1].toFixed(2)} ms, hub (2k links) ${hubMs.toFixed(2)} ms`);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(p95).toBeLessThan(6);
    expect(ms[ms.length - 1]).toBeLessThan(16);
    expect(hubMs).toBeLessThan(16);
  });

  it('an edit to the open note re-derives incrementally, then the view recomputes fast', (ctx) => {
    const meter = cpuLoadMeter();
    const p = paths[1234];
    const t0 = performance.now();
    idx.update(p, `${noteContent(1234, N, 1500)}\nnew [[Note 00042]] link #idea`);
    const cost = switchCost(idx, p);
    const ms = performance.now() - t0;
    console.log(`[perf] edit + recompute @${N}: ${ms.toFixed(2)} ms`);
    expect(idx.linksFrom(p)).toContain(notePath(42));
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(ms).toBeLessThan(25);
    expect(cost).toBeLessThan(16);
  });

  it('orphan lists over all notes stay cheap (computed once per index change)', (ctx) => {
    const meter = cpuLoadMeter();
    const scan = () => {
      const t0 = performance.now();
      const notes = idx.notes().map((n) => n.path);
      orphanNotes(idx, notes);
      notesWithoutIncoming(idx, notes);
      return performance.now() - t0;
    };
    const cold = scan(); // fills the per-note adjacency cache
    idx.update(paths[77], `${noteContent(77, N, 1500)}\nedit`); // typing: one note re-linked
    const warm = scan();
    console.log(`[perf] orphans + no-incoming @${N}: ${cold.toFixed(1)} ms cold, ${warm.toFixed(1)} ms after an edit`);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(cold).toBeLessThan(150);
    expect(warm).toBeLessThan(16);
  });
});
