import { describe, it, expect } from 'vitest';
import { applyChanges, diffLineArrays, diffLines, diffStats, revertChange, splitLines, type Hunk } from '../../../src/renderer/git/line-diff';

const H = (kind: Hunk['kind'], newStart: number, newCount: number, oldStart: number, oldCount: number): Hunk => ({ kind, newStart, newCount, oldStart, oldCount });

/** Revert every hunk (last first, so earlier offsets stay valid) → must give back the old text. */
function revertAll(oldText: string, newText: string): string {
  const hunks = diffLines(oldText, newText);
  let text = newText;
  for (const h of [...hunks].reverse()) text = applyChanges(text, [revertChange(splitLines(text), splitLines(oldText), h)]);
  return text;
}

describe('diffLines', () => {
  it('identical → no hunks', () => {
    expect(diffLines('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(diffLines('', '')).toEqual([]);
  });

  it('added, modified, deleted', () => {
    expect(diffLines('a\nb\nc', 'a\nb\nX\nc')).toEqual([H('added', 2, 1, 2, 0)]);
    expect(diffLines('a\nb\nc', 'a\nB\nc')).toEqual([H('modified', 1, 1, 1, 1)]);
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([H('deleted', 1, 0, 1, 1)]);
    expect(diffLines('a\nb\nc', 'b\nc')).toEqual([H('deleted', 0, 0, 0, 1)]); // at the top
    expect(diffLines('a\nb', 'a')).toEqual([H('deleted', 1, 0, 1, 1)]); // at the end
  });

  it('several hunks in one file keep their own kinds', () => {
    const old = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n');
    const now = ['1', 'two', '3', '4', 'new', '5', '6', '8', '9'].join('\n');
    expect(diffLines(old, now)).toEqual([H('modified', 1, 1, 1, 1), H('added', 4, 1, 4, 0), H('deleted', 7, 0, 6, 1)]);
  });

  it('a modified block next to an insertion is one hunk', () => {
    expect(diffLines('a\nb\nc', 'a\nB\nB2\nc')).toEqual([H('modified', 1, 2, 1, 1)]);
  });

  it('empty file → content (and back)', () => {
    expect(diffLines('', 'x\ny\n')).toEqual([H('added', 0, 2, 0, 0)]);
    expect(revertAll('', 'x\ny\n')).toBe('');
    expect(revertAll('x\ny\n', '')).toBe('x\ny\n');
  });

  it('trailing newline only', () => {
    expect(revertAll('a\nb', 'a\nb\n')).toBe('a\nb');
    expect(revertAll('a\nb\n', 'a\nb')).toBe('a\nb\n');
  });

  it('falls back to one coarse hunk past the edit budget', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLineArrays(a, b, 10)).toEqual([H('modified', 0, 50, 0, 50)]);
  });

  it('stats', () => {
    expect(diffStats(diffLines('a\nb\nc', 'a\nX\nY\nc\nd'))).toEqual({ added: 3, removed: 1 });
  });
});

describe('revertChange', () => {
  it('reverts each kind of hunk', () => {
    expect(revertAll('a\nb\nc', 'a\nb\nX\nc')).toBe('a\nb\nc');
    expect(revertAll('a\nb\nc', 'a\nB\nc')).toBe('a\nb\nc');
    expect(revertAll('a\nb\nc', 'a\nc')).toBe('a\nb\nc');
    expect(revertAll('a\nb\nc', 'b\nc')).toBe('a\nb\nc');
    expect(revertAll('a\nb', 'a')).toBe('a\nb');
    expect(revertAll('a', 'a\nb\nc')).toBe('a');
  });

  it('reverting one hunk leaves the others alone', () => {
    const old = 'h1\nkeep\nh2\nkeep2\nh3';
    const now = 'H1\nkeep\nkeep2\nh3\nextra';
    const hunks = diffLines(old, now);
    expect(hunks.map((h) => h.kind)).toEqual(['modified', 'deleted', 'added']);
    const middle = applyChanges(now, [revertChange(splitLines(now), splitLines(old), hunks[1])]);
    expect(middle).toBe('H1\nkeep\nh2\nkeep2\nh3\nextra');
    expect(diffLines(old, middle).map((h) => h.kind)).toEqual(['modified', 'added']);
  });

  it('round-trips random edits (fuzz)', () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let round = 0; round < 400; round++) {
      const base = Array.from({ length: rnd(30) }, () => `l${rnd(8)}`);
      const lines = [...base];
      for (let e = rnd(6); e > 0; e--) {
        const at = rnd(lines.length + 1);
        const op = rnd(3);
        if (op === 0) lines.splice(at, 0, `n${rnd(5)}`);
        else if (op === 1 && lines.length) lines.splice(Math.min(at, lines.length - 1), 1);
        else if (lines.length) lines[Math.min(at, lines.length - 1)] = `m${rnd(5)}`;
      }
      const oldText = base.join('\n') + (rnd(2) ? '\n' : '');
      const newText = lines.join('\n') + (rnd(2) ? '\n' : '');
      // Every hunk is well-formed and hunks are ordered / non-overlapping.
      const hunks = diffLines(oldText, newText);
      let lastNew = -1;
      for (const h of hunks) {
        expect(h.newStart).toBeGreaterThan(lastNew);
        lastNew = h.newStart + h.newCount - (h.newCount ? 1 : 0);
        expect(h.kind === 'added' ? h.oldCount === 0 : h.kind === 'deleted' ? h.newCount === 0 : h.oldCount > 0 && h.newCount > 0).toBe(true);
      }
      expect(revertAll(oldText, newText)).toBe(oldText);
    }
  });

  it('is fast on a big file with scattered edits', () => {
    const base = Array.from({ length: 100_000 }, (_, i) => `line ${i} ${'x'.repeat(i % 40)}`);
    const edited = [...base];
    for (let i = 5; i < 100_000; i += 9_973) edited[i] = 'changed';
    edited.splice(50_000, 0, 'inserted');
    const t0 = performance.now();
    const hunks = diffLineArrays(base, edited);
    const ms = performance.now() - t0;
    console.log(`[git perf] line diff 100k lines, ${hunks.length} hunks: ${ms.toFixed(1)} ms`);
    expect(hunks.length).toBe(12);
    expect(ms).toBeLessThan(500);
  });
});
