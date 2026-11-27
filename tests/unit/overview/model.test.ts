import { describe, expect, it } from 'vitest';
import {
  activeOutlineIndex,
  blockLabel,
  docModel,
  foldToLevel,
  formatBytes,
  formatWhen,
  maxDepth,
  readingTimeLabel,
  taskMarkOffset,
  utf8Length,
  visibleAncestor,
  visibleOutlineRows,
} from '../../../src/renderer/overview/model';

const md = (text: string) => docModel(`n${Math.random()}.md`, text, true);
const texts = (text: string) => md(text).outline.map((e) => `${e.depth}:${e.text}`);

describe('outline (Markdown)', () => {
  it('nests by level; a skipped level indents once', () => {
    expect(texts('# A\n### A1\n## A2\n#### A2a\n# B')).toEqual(['0:A', '1:A1', '1:A2', '2:A2a', '0:B']);
  });

  it('reads setext headings, but not a list item or hr after a blank line', () => {
    const t = 'Title\n=====\n\nIntro\n\nSub\n---\n\n- item\n---\n\ntext\n\n---\n';
    expect(md(t).outline.map((e) => [e.level, e.text, e.line])).toEqual([
      [1, 'Title', 0],
      [2, 'Sub', 5],
    ]);
  });

  it('skips frontmatter (its --- is not a setext underline) and fenced code', () => {
    const t = '---\ntitle: x\ntags: [a]\n---\n# Real\n```sh\n# not a heading\n```\n~~~\n## nor this\n~~~\n## Also real';
    expect(texts(t)).toEqual(['0:Real', '1:Also real']);
  });

  it('strips inline markdown and closing hashes; drops empty headings; #tags are not headings', () => {
    expect(texts('## **Bold** [[Note|alias]] `code` ##\n#\n#tag line\n##   ')).toEqual(['0:Bold alias code']);
  });

  it('knows each section’s extent and the one holding the cursor', () => {
    const m = md('intro\n# A\ntext\n## A1\ntext\n# B\nend');
    const o = m.outline;
    expect(o.map((e) => [e.line, e.end])).toEqual([
      [1, 4],
      [3, 4],
      [5, 6],
    ]);
    expect(activeOutlineIndex(o, 0)).toBe(-1);
    expect(activeOutlineIndex(o, 2)).toBe(0);
    expect(activeOutlineIndex(o, 4)).toBe(1);
    expect(activeOutlineIndex(o, 6)).toBe(2);
  });

  it('folds: hidden children, highlight moves to the visible ancestor, collapse to level', () => {
    const o = md('# A\n## A1\n### A1a\n## A2\n# B\n## B1').outline;
    expect(maxDepth(o)).toBe(3);
    const foldA = new Set([o[0].key]);
    expect(visibleOutlineRows(o, foldA).map((r) => o[r.i].text)).toEqual(['A', 'B', 'B1']);
    expect(visibleAncestor(o, foldA, 2)).toBe(0); // cursor in A1a → A is highlighted
    const lvl1 = foldToLevel(o, 1);
    expect(visibleOutlineRows(o, lvl1).map((r) => o[r.i].text)).toEqual(['A', 'B']);
    const lvl2 = foldToLevel(o, 2);
    expect(visibleOutlineRows(o, lvl2).map((r) => o[r.i].text)).toEqual(['A', 'A1', 'A2', 'B', 'B1']);
  });

  it('fold keys are unique for duplicate headings and survive edits above them', () => {
    const a = md('# Notes\n## Todo\n# Other\n## Todo').outline.map((e) => e.key);
    expect(new Set(a).size).toBe(4);
    const b = md('new line\n\n# Notes\n## Todo\n# Other\n## Todo').outline.map((e) => e.key);
    expect(b).toEqual(a);
  });
});

describe('code blocks', () => {
  it('lists ``` and ~~~ fences with language and first meaningful line', () => {
    const t = ['```bash', '# install deps', 'npm ci', '```', '', '~~~sql', 'SELECT 1;', '~~~', '```', '```'].join('\n');
    const b = md(t).codeBlocks;
    expect(b.map((x) => [x.lang, x.label, x.note, x.line, x.lines, x.closed])).toEqual([
      ['bash', 'npm ci', '# install deps', 0, 2, true],
      ['sql', 'SELECT 1;', undefined, 5, 1, true],
      ['', '', undefined, 8, 0, true],
    ]);
  });

  it('finds fences indented inside lists and blockquotes; Copy text drops the container prefix', () => {
    const t = '1. Check:\n   ```bash\n   psql -c "select 1"\n     --flag\n   ```\n> ```sh\n> ls -la\n> ```\n';
    const m = md(t);
    expect(m.codeBlocks.map((x) => [x.lang, x.label, x.line])).toEqual([
      ['bash', 'psql -c "select 1"', 1],
      ['sh', 'ls -la', 5],
    ]);
    expect(m.blockText(m.codeBlocks[0])).toBe('psql -c "select 1"\n  --flag');
    expect(m.blockText(m.codeBlocks[1])).toBe('ls -la');
  });

  it('an unclosed fence runs to the end of the note', () => {
    const b = md('# x\n```js\nconst a = 1;\nmore').codeBlocks;
    expect(b[0]).toMatchObject({ lang: 'js', label: 'const a = 1;', closed: false, lines: 2 });
  });

  it('labels: prompts stripped, shebang / PHP open tag skipped, comment-only blocks keep the comment', () => {
    expect(blockLabel(['$ sudo systemctl reload nginx'], 'shell')?.label).toBe('sudo systemctl reload nginx');
    expect(blockLabel(['PS C:\\> Get-Process'], 'powershell')?.label).toBe('Get-Process');
    expect(blockLabel(['#!/usr/bin/env bash', '', 'set -e'], 'shell')?.label).toBe('set -e');
    expect(blockLabel(['<?php', "Artisan::call('x');"], 'php')?.label).toBe("Artisan::call('x');");
    expect(blockLabel(['// only a comment'], 'typescript')).toEqual({ label: '// only a comment' });
    expect(blockLabel(['-- top', 'SELECT 1'], 'sql')).toEqual({ label: 'SELECT 1', note: '-- top' });
    expect(blockLabel(['', '  '], 'shell')).toBeNull();
    // `#` is not a comment in e.g. CSS: `#id` is the meaningful line.
    expect(blockLabel(['#main { color: red }'], 'css')?.label).toBe('#main { color: red }');
  });
});

describe('tasks', () => {
  const t = [
    '---',
    'todo: - [ ] not a task (frontmatter)',
    '---',
    '- [ ] open one',
    '  - [x] done child',
    '  - [ ] open child',
    '* [X] star done',
    '1. [ ] numbered',
    '> - [ ] quoted',
    '```md',
    '- [ ] inside code',
    '```',
    '- [] not a task',
    '-[ ] nor this',
  ].join('\n');

  it('counts open / done outside code and frontmatter, with nesting depth', () => {
    const s = md(t).tasks;
    expect([s.open, s.done]).toEqual([4, 2]);
    expect(s.items.map((x) => [x.line, x.done, x.depth, x.text])).toEqual([
      [3, false, 0, 'open one'],
      [4, true, 1, 'done child'],
      [5, false, 1, 'open child'],
      [6, true, 0, 'star done'],
      [7, false, 0, 'numbered'],
      [8, false, 0, 'quoted'],
    ]);
  });

  it('locates the mark character for an in-place toggle (and refuses a stale line)', () => {
    const s = md(t).tasks;
    const at = taskMarkOffset(t, s.items[1]);
    expect(t[at]).toBe('x');
    expect(t.slice(at - 1, at + 2)).toBe('[x]');
    expect(taskMarkOffset(t, { line: 0, col: 3 })).toBe(-1);
    expect(taskMarkOffset(t, { line: 99, col: 3 })).toBe(-1);
  });
});

describe('stats + formatting', () => {
  it('words, characters, lines, reading time', () => {
    const m = md('# Title\n\nOne two three.\n');
    expect(m.stats).toMatchObject({ words: 4, lines: 4 });
    expect(m.lines).toBe(4);
    expect(readingTimeLabel(0)).toBe('-');
    expect(readingTimeLabel(100)).toBe('< 1 min');
    expect(readingTimeLabel(1200)).toBe('5 min');
  });

  it('sizes and times', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(200 * 1024)).toBe('200 KB');
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
    const now = Date.UTC(2026, 10, 19, 12);
    expect(formatWhen(now - 10_000, now)).toBe('just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(formatWhen(now - 86_400_000, now)).toBe('yesterday');
  });

  it('utf8Length matches TextEncoder (BMP, astral, CJK)', () => {
    for (const s of ['abc', 'héllo', '日本語', 'emoji 😀 x', '']) expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length);
  });
});

describe('memoised model', () => {
  it('same text → same model; parts are computed once, on demand', () => {
    const a = docModel('memo.md', '# A\n```sh\nls\n```', true);
    const o = a.outline;
    expect(docModel('memo.md', '# A\n```sh\nls\n```', true)).toBe(a);
    expect(a.outline).toBe(o);
    expect(docModel('memo.md', '# B', true)).not.toBe(a);
    // A .md shown as another language has no Markdown structure.
    expect(docModel('memo.md', '# A\n```sh\nls\n```', false).codeBlocks).toEqual([]);
  });

  it('stays fast on a 1 MB note (outline + code blocks + tasks + stats)', () => {
    const chunk = '## Section\n\nSome text with a [[link]] and #tag.\n\n```bash\nkubectl get pods -A\n```\n\n- [ ] task\n- [x] done\n\n';
    const big = chunk.repeat(Math.ceil(1_000_000 / chunk.length));
    // Warm the JIT, then time a fresh model.
    docModel('warm.md', big.slice(0, 50_000), true).tasks;
    const t0 = performance.now();
    const m = docModel('big.md', big, true);
    expect(m.outline.length).toBeGreaterThan(5000);
    expect(m.codeBlocks.length).toBe(m.outline.length);
    expect(m.tasks.open).toBe(m.outline.length);
    void m.stats.words;
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(600); // ~60–120 ms locally; generous for slow CI
    const t1 = performance.now();
    docModel('big.md', big, true).outline;
    expect(performance.now() - t1).toBeLessThan(5);
  });
});
