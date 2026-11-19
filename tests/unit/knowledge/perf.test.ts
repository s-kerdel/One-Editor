import { describe, expect, it } from 'vitest';
import { KnowledgeIndex } from '../../../src/knowledge/index';
import { createRenameRewriter } from '../../../src/knowledge/rename';
import { buildGraph, ForceSim } from '../../../src/knowledge/graph';
import { applyTemplate, dailyNotePath, formatDate, sanitizeNoteName } from '../../../src/knowledge/templates';
import { cpuLoadMeter, describeLoad, type CpuLoad } from '../../perf/cpu-meter';

/** Wall-clock budgets are skipped (with the reason) when another job kept the CPUs busy meanwhile. */
const busyNote = (load: CpuLoad) => `${describeLoad(load)}: wall-clock budgets not measurable`;

function synth(n: number): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let seed = 42;
  const rnd = (m: number) => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) % m;
  for (let i = 0; i < n; i++) {
    const lines = ['---', `title: Note ${i}`, `tags: [area/t${i % 40}, kind${i % 7}]`, `aliases: [Alias ${i}]`, '---', `# Note ${i}`, ''];
    for (let p = 0; p < 12; p++) {
      const l = `Paragraph ${p} lorem ipsum dolor sit amet, see [[Note ${rnd(n)}]] and [[folder${rnd(50)}/Note ${rnd(n)}|alias]] plus [md](../folder${rnd(50)}/Note%20${rnd(n)}.md#h) #topic${rnd(100)} and \`code #nope\` consectetur adipiscing elit.`;
      lines.push(l, '');
      if (p % 4 === 0) lines.push(`## Section ${p}`, '', '- [ ] task', '- [x] done ^blk' + p, '', '```js', 'const x = "[[Nope]] #nope";', '```', '');
    }
    out.push([`folder${i % 50}/Note ${i}.md`, lines.join('\n')]);
  }
  return out;
}

// Timing budgets: retried so CPU contention from the parallel suite can't fail them; a real regression fails every attempt.
describe('performance', { retry: 2 }, () => {
  const N = 5000;
  const data = synth(N);

  it(`indexes ${N} notes (~${Math.round(data.reduce((a, [, t]) => a + t.length, 0) / 1e6)} MB) and answers queries fast`, (ctx) => {
    const meter = cpuLoadMeter();
    const idx = new KnowledgeIndex();
    const t0 = performance.now();
    idx.setFiles(data.map(([p]) => p));
    for (const [p, t] of data) idx.update(p, t);
    const tIndex = performance.now() - t0;

    const t1 = performance.now();
    const target = data[1234][0];
    idx.update(data[1][0], `${data[1][1]}\nsee [[Note 1234]] and plain Note 1234 here`);
    idx.update(data[2][0], `${data[2][1]}\nplain Note 1234 mention`);
    const back = idx.backlinks(target);
    const tFirstQuery = performance.now() - t1;

    const t2 = performance.now();
    idx.tags();
    idx.unresolvedLinks();
    idx.outgoing(target);
    idx.resolve('Alias 77');
    const tQueries = performance.now() - t2;

    const t3 = performance.now();
    const mentions = idx.unlinkedMentions(target);
    const tMentions = performance.now() - t3;

    const t4 = performance.now();
    idx.update(target, `${idx.text(target)}\nedit [[Note 1]]`);
    idx.backlinks(target);
    const tIncremental = performance.now() - t4;

    console.log(`[perf] index ${N}: ${tIndex.toFixed(0)}ms | first backlinks (derive): ${tFirstQuery.toFixed(0)}ms | tags+unresolved+outgoing: ${tQueries.toFixed(1)}ms | unlinked mentions: ${tMentions.toFixed(0)}ms | edit+requery: ${tIncremental.toFixed(0)}ms`);
    expect(idx.size).toBe(N);
    expect(back.length).toBeGreaterThan(0);
    expect(mentions.length).toBeGreaterThanOrEqual(2);
    expect(idx.resolve('Alias 77')).toBe('folder27/Note 77.md');
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(tIndex).toBeLessThan(1500);
    expect(tFirstQuery).toBeLessThan(1000);
    expect(tMentions).toBeLessThan(1000);
    expect(tIncremental).toBeLessThan(100);
  });

  it('knowledge panels re-read within a frame after every edit (unresolved count + top 300, tag tree)', (ctx) => {
    const idx = new KnowledgeIndex();
    idx.setFiles(data.map(([p]) => p));
    for (const [p, t] of data) idx.update(p, t);
    idx.backlinks(data[0][0]); // derive once (as after the initial build)
    const total = idx.unresolvedLinks().length;
    const meter = cpuLoadMeter();
    const per: number[] = [];
    for (let k = 0; k < 20; k++) {
      const p = data[100 + k][0];
      idx.update(p, `${data[100 + k][1]}\nedit ${k} [[Missing thing ${k % 3}]]`);
      const t0 = performance.now();
      const count = idx.unresolvedCount();
      const top = idx.unresolvedLinks(300);
      idx.tags();
      per.push(performance.now() - t0);
      expect(top).toHaveLength(300);
      expect(count).toBeGreaterThanOrEqual(total);
    }
    per.sort((x, y) => x - y);
    console.log(`[perf] panels after an edit @${N} (${total} targets): median ${per[10].toFixed(1)} ms, max ${per[19].toFixed(1)} ms`);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(per[10]).toBeLessThan(16);
  });

  it('rewrites links across 5k notes quickly', (ctx) => {
    const meter = cpuLoadMeter();
    const files = data.map(([p]) => p);
    const from = data[10][0];
    data[11][1] += '\n[[Note 10]] [x](../folder10/Note%2010.md)';
    const t0 = performance.now();
    const rw = createRenameRewriter(new Map([[from, 'folder10/Renamed thing.md']]), files);
    let touched = 0;
    for (const [p, t] of data) if (rw.edits(t, p).length) touched++;
    const ms = performance.now() - t0;
    console.log(`[perf] rename scan of ${N} notes: ${ms.toFixed(0)}ms, ${touched} notes touched`);
    expect(touched).toBeGreaterThan(0);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(ms).toBeLessThan(2500);
  });

  it('builds and simulates a 5k-node graph within a frame budget', (ctx) => {
    const meter = cpuLoadMeter();
    const idx = new KnowledgeIndex();
    for (const [p, t] of data) idx.update(p, t);
    idx.backlinks(data[0][0]); // derive links outside the measurement
    const t0 = performance.now();
    const g = buildGraph(idx);
    const tBuild = performance.now() - t0;
    const sim = new ForceSim(g.nodes.length, g.edges);
    const t1 = performance.now();
    for (let i = 0; i < 20; i++) sim.tick();
    const tTick = (performance.now() - t1) / 20;
    console.log(`[perf] graph build: ${tBuild.toFixed(0)}ms (${g.nodes.length} nodes, ${g.edges.length / 2} edges) | sim tick: ${tTick.toFixed(1)}ms`);
    expect(g.nodes.length).toBe(N);
    const load = meter.stop();
    ctx.skip(load.busy, busyNote(load));
    expect(tBuild).toBeLessThan(1000);
    expect(tTick).toBeLessThan(40);
  });
});

describe('templates + daily notes', () => {
  const d = new Date(2024, 2, 5, 9, 7, 3); // Tue 5 Mar 2024 09:07:03 local
  it('formats dates', () => {
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2024-03-05');
    expect(formatDate(d, 'D/M/YY HH:mm:ss')).toBe('5/3/24 09:07:03');
    expect(formatDate(d, 'dddd, MMMM D [at] H')).toBe('Tuesday, March 5 at 9');
    expect(formatDate(d, 'ddd MMM')).toBe('Tue Mar');
  });
  it('substitutes template variables', () => {
    expect(applyTemplate('# {{title}}\n{{date}} {{time}} {{ date:DD.MM.YYYY }} {{unknown}} {{Title}}', { title: 'My note', now: d })).toBe('# My note\n2024-03-05 09:07 05.03.2024 {{unknown}} My note');
  });
  it('computes daily note paths', () => {
    expect(dailyNotePath(d)).toBe('daily/2024-03-05.md');
    expect(dailyNotePath(d, 'journal/2024/', 'YYYY-MM-DD dddd')).toBe('journal/2024/2024-03-05 Tuesday.md');
    expect(dailyNotePath(d, '', 'HH:mm')).toBe('09-07.md');
  });
  it('sanitises new note names for Windows', () => {
    expect(sanitizeNoteName('What? A "note": yes*')).toBe('What A note yes');
    expect(sanitizeNoteName('folder/../Name. ')).toBe('folder/Name');
    expect(sanitizeNoteName('a\\b')).toBe('ab');
  });
});
