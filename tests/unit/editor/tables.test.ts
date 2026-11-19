import { describe, it, expect } from 'vitest';
import { formatTableLines, splitRow, isDelimiterRow, cellIndexAt, cellRanges, strWidth, tableAt, tableNextCell, tablePrevCell, tableEnter, formatTable, insertTable } from '../../../src/renderer/editor/tables';
import { mdState, apply } from './helpers';

describe('table parsing', () => {
  it('splits rows on unescaped pipes outside code', () => {
    expect(splitRow('| a | b |').cells).toEqual(['a', 'b']);
    expect(splitRow('a | b').cells).toEqual(['a', 'b']);
    expect(splitRow('| a \\| x | `c|d` |').cells).toEqual(['a \\| x', '`c|d`']);
    expect(splitRow('|  | x |').cells).toEqual(['', 'x']);
  });
  it('detects delimiter rows', () => {
    expect(isDelimiterRow('|---|:--:|--:|')).toBe(true);
    expect(isDelimiterRow('| a | b |')).toBe(false);
  });
  it('maps columns to cells', () => {
    const row = '| aa | bb | cc |';
    expect(cellIndexAt(row, 3)).toBe(0);
    expect(cellIndexAt(row, 7)).toBe(1);
    expect(cellIndexAt(row, 13)).toBe(2);
    expect(cellRanges(row)).toEqual([
      { from: 2, to: 4 },
      { from: 7, to: 9 },
      { from: 12, to: 14 },
    ]);
  });
  it('counts wide characters double', () => {
    expect(strWidth('abc')).toBe(3);
    expect(strWidth('日本')).toBe(4);
  });
});

describe('formatTableLines', () => {
  it('aligns pipes and pads short rows', () => {
    expect(formatTableLines(['|Name|Value|', '|-|-|', '|a|1|', '|long name|'])).toEqual([
      '| Name      | Value |',
      '| --------- | ----- |',
      '| a         | 1     |',
      '| long name |       |',
    ]);
  });
  it('respects alignment markers', () => {
    expect(formatTableLines(['| l | c | r |', '|:--|:-:|--:|', '| x | y | z |'])).toEqual(['| l   |  c  |   r |', '| :-- | :-: | --: |', '| x   |  y  |   z |']);
  });
  it('keeps indentation of the table', () => {
    expect(formatTableLines(['  |a|b|', '  |-|-|'])).toEqual(['  | a   | b   |', '  | --- | --- |']);
  });
});

describe('table commands', () => {
  const T = '| a | b |\n|---|---|\n| 1 | 2 |';
  it('finds the table around the cursor', () => {
    const st = mdState('text\n\n' + T.replace('1', '1‸'));
    const t = tableAt(st, st.selection.main.head)!;
    expect(t.lines).toHaveLength(3);
    expect(t.fromLine).toBe(3);
    expect(tableAt(mdState('a | b‸'), 5)).toBeNull();
  });
  it('Tab formats and moves to the next cell (skipping the delimiter row)', () => {
    expect(apply('|a‸|b|\n|-|-|\n|1|2|', tableNextCell)).toBe('| a   | «b»   |\n| --- | --- |\n| 1   | 2   |');
    expect(apply('| a | b‸ |\n|---|---|\n| 1 | 2 |', tableNextCell)).toBe('| a   | b   |\n| --- | --- |\n| «1»   | 2   |');
  });
  it('Tab in the last cell appends a row', () => {
    expect(apply('| a | b |\n|---|---|\n| 1 | 2‸ |', tableNextCell)).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |');
  });
  it('Shift-Tab moves back', () => {
    expect(apply('| a | b |\n|---|---|\n| 1‸ | 2 |', tablePrevCell)).toBe('| a   | «b»   |\n| --- | --- |\n| 1   | 2   |');
  });
  it('Enter adds a row below and moves into it', () => {
    expect(apply('| a | b |\n|---|---|\n| 1‸ | 2 |\n| 3 | 4 |', tableEnter)).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n| ‸    |     |\n| 3   | 4   |');
    expect(apply('| a‸ | b |\n|---|---|', tableEnter)).toBe('| a   | b   |\n| --- | --- |\n| ‸    |     |');
  });
  it('Enter on an empty last row leaves the table', () => {
    expect(apply('| a | b |\n|---|---|\n| 1 | 2 |\n|  ‸ |   |', tableEnter)).toBe('| a   | b   |\n| --- | --- |\n| 1   | 2   |\n‸');
  });
  it('Format table keeps the cursor in its cell', () => {
    expect(apply('|a|b‸b|\n|-|-|', formatTable)).toBe('| a   | «bb»  |\n| --- | --- |');
  });
  it('is not handled outside tables', () => {
    const st = mdState('plain‸');
    let ran = false;
    tableNextCell({ state: st, dispatch: () => (ran = true) });
    expect(ran).toBe(false);
  });
  it('inserts a table template', () => {
    expect(apply('‸', insertTable)).toBe('| «Column 1» | Column 2 |\n| -------- | -------- |\n|          |          |\n');
  });
});
