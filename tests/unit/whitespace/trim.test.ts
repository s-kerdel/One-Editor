import { describe, expect, it } from 'vitest';
import { applyChanges, changedLines, codeLines, linesAt, trimChanges, trimPasted } from '../../../src/renderer/whitespace/trim';

const trim = (text: string, o: Partial<Parameters<typeof trimChanges>[1]> = {}) => applyChanges(text, trimChanges(text, { markdown: false, keepBreaks: true, ...o }));
const md = (text: string, o: Partial<Parameters<typeof trimChanges>[1]> = {}) => trim(text, { markdown: true, ...o });

describe('trimPasted (terminal / AI output)', () => {
  it('strips spaces, tabs, NBSP and other Unicode spaces at every line end', () => {
    expect(trimPasted('ls -la    \n  cd /tmp\t\t\nnbsp  \nwide　\nthin ​')).toBe('ls -la\n  cd /tmp\nnbsp\nwide\nthin');
  });
  it('drops trailing blank lines; keeps one final newline when the clipboard had one', () => {
    expect(trimPasted('a   \nb   \n      \n   \n')).toBe('a\nb\n');
    expect(trimPasted('a   \n\n\n')).toBe('a\n');
    expect(trimPasted('a   ')).toBe('a');
    expect(trimPasted('a\n   ')).toBe('a\n');
    expect(trimPasted('\n\n  x  \n')).toBe('\n\n  x\n'); // leading lines and indentation stay
  });
  it('CRLF / CR become LF; no hard-break exception for pasted text', () => {
    expect(trimPasted('one  \r\ntwo  \r\n')).toBe('one\ntwo\n');
    expect(trimPasted('one  \rtwo')).toBe('one\ntwo');
    expect(trimPasted('para line  \nnext')).toBe('para line\nnext');
  });
  it('whitespace-only pastes are left alone', () => {
    expect(trimPasted('    ')).toBe('    ');
    expect(trimPasted('\t')).toBe('\t');
    expect(trimPasted('')).toBe('');
  });
});

describe('trimChanges (save / command)', () => {
  it('code: every trailing run goes, edits are minimal', () => {
    const t = 'const a = 1;   \n\tfoo();\t\nbar()\n   \n';
    expect(trimChanges(t, { markdown: false, keepBreaks: true })).toEqual([
      { from: 12, to: 15, insert: '' },
      { from: 23, to: 24, insert: '' },
      { from: 31, to: 34, insert: '' },
    ]);
    expect(trim(t)).toBe('const a = 1;\n\tfoo();\nbar()\n\n');
  });

  it('markdown: hard breaks (≥ 2 spaces before a line with text) are kept, normalised to two', () => {
    expect(md('line one  \nline two')).toBe('line one  \nline two');
    expect(md('line one    \nline two')).toBe('line one  \nline two');
    expect(md('line one \nline two')).toBe('line one\nline two'); // one space is no break
    expect(md('before blank  \n\nnext')).toBe('before blank\n\nnext');
    expect(md('last line  ')).toBe('last line');
    expect(md('tabs\t\t\nnext')).toBe('tabs\nnext');
    expect(md('   \nx')).toBe('\nx'); // whitespace-only line
    expect(md('line one  \nline two', { keepBreaks: false })).toBe('line one\nline two');
  });

  it('markdown: fenced code content and frontmatter follow the code rules', () => {
    const t = '---\ntitle: x  \n---\ntext  \nmore\n```bash\necho hi  \necho  \n```\n> ~~~\n> quoted  \n> ~~~\nafter  \nend';
    expect(md(t)).toBe('---\ntitle: x\n---\ntext  \nmore\n```bash\necho hi\necho\n```\n> ~~~\n> quoted\n> ~~~\nafter  \nend');
    expect([...codeLines(t.split('\n'))].sort((a, b) => a - b)).toEqual([0, 1, 2, 6, 7, 10]);
  });

  it('only the given lines; never the skipped (caret) ones', () => {
    const t = 'a  \nb  \nc  ';
    expect(trim(t, { lines: new Set([1]) })).toBe('a  \nb\nc  ');
    expect(trim(t, { skip: new Set([0, 2]) })).toBe('a  \nb\nc  ');
  });

  it('CRLF text keeps its CR', () => {
    expect(trim('a  \r\nb\t\r\nc')).toBe('a\r\nb\r\nc');
  });
});

describe('changedLines (what "edited lines" means)', () => {
  it('only lines added or changed since the save — not moved neighbours', () => {
    const saved = 'one  \ntwo  \nthree  \nfour  ';
    expect([...changedLines(saved, saved)]).toEqual([]);
    expect([...changedLines(saved, 'one  \ntwo!  \nthree  \nfour  ')]).toEqual([1]);
    expect([...changedLines(saved, 'new  \none  \ntwo  \nthree  \nfour  ')]).toEqual([0]);
    expect([...changedLines(saved, 'one  \nthree  \nfour  ')]).toEqual([]); // a deleted line: nothing left to trim
    // Several cursors at once (lines 0 and 3).
    expect([...changedLines(saved, 'one  x\ntwo  \nthree  \nfour  x')].sort()).toEqual([0, 3]);
    // Edited back to what was saved (undo by hand): untouched.
    expect([...changedLines(saved, 'one  \ntwo  \nthree  \nfour  ')]).toEqual([]);
  });

  it('linesAt maps offsets to lines', () => {
    expect([...linesAt('ab\ncd\nef', [0, 2, 3, 8])].sort()).toEqual([0, 1, 2]);
  });
});
