import { describe, it, expect } from 'vitest';
import { parseListLine, indentListItem, outdentListItem, renumberChanges, toggleTask, toggleTaskAt, deleteTaskMarker, renumberList } from '../../../src/renderer/editor/lists';
import { markdownKeymap } from '../../../src/renderer/editor/mdkeys';
import { mdState, show, run, apply } from './helpers';
import type { StateCommand } from '@codemirror/state';

const enter = markdownKeymap.find((k) => k.key === 'Enter')!.run as unknown as StateCommand;
const backspace = markdownKeymap.find((k) => k.key === 'Backspace')!.run as unknown as StateCommand;

describe('parseListLine', () => {
  it('parses bullets, numbers, tasks and quotes', () => {
    expect(parseListLine('- a')).toMatchObject({ bullet: '-', indent: '', contentFrom: 2 });
    expect(parseListLine('  12) b')).toMatchObject({ num: 12, delim: ')', indent: '  ', contentFrom: 6 });
    expect(parseListLine('- [x] done')).toMatchObject({ task: '[x] ', checked: true, contentFrom: 6 });
    expect(parseListLine('> * quoted')).toMatchObject({ quote: '> ', bullet: '*' });
    expect(parseListLine('-')).toMatchObject({ bullet: '-' });
  });
  it('rejects non-list lines and horizontal rules', () => {
    expect(parseListLine('text')).toBeNull();
    expect(parseListLine('-text')).toBeNull();
    expect(parseListLine('---')).toBeNull();
    expect(parseListLine('* * *')).toBeNull();
  });
});

describe('Enter list continuation', () => {
  it('continues bullets, numbers, tasks and quotes', () => {
    expect(apply('- one‸', enter)).toBe('- one\n- ‸');
    expect(apply('1. one‸', enter)).toBe('1. one\n2. ‸');
    expect(apply('- [x] done‸', enter)).toBe('- [x] done\n- [ ] ‸');
    expect(apply('> quote‸', enter)).toBe('> quote\n> ‸');
    expect(apply('> [!note] Title‸', enter)).toBe('> [!note] Title\n> ‸');
  });
  it('renumbers following ordered items', () => {
    expect(apply('1. a‸\n2. b\n3. c', enter)).toBe('1. a\n2. ‸\n3. b\n4. c');
  });
  it('empty item exits the list (also in tight lists)', () => {
    expect(apply('- a\n- b\n- ‸', enter)).toBe('- a\n- b\n‸');
    expect(apply('1. a\n2. ‸', enter)).toBe('1. a\n‸');
  });
  it('empty nested item outdents one level', () => {
    expect(apply('- a\n  - b\n  - ‸', enter)).toBe('- a\n  - b\n- ‸');
  });
  it('does nothing special outside lists and in code', () => {
    const { handled } = run(mdState('plain‸'), enter);
    expect(handled).toBe(false);
    expect(run(mdState('```\n- a‸\n```'), enter).handled).toBe(false);
  });
  it('closes an unclosed code fence', () => {
    expect(apply('```php‸', enter)).toBe('```php\n‸\n```');
    expect(run(mdState('```php‸\nx\n```'), enter).handled).toBe(false);
  });
});

describe('Tab / Shift-Tab', () => {
  it('nests an item under its previous sibling, aligned to the sibling text', () => {
    expect(apply('- a\n- b‸', indentListItem)).toBe('- a\n  - b‸');
    expect(apply('1. a\n2. b‸', indentListItem)).toBe('1. a\n   1. b‸');
  });
  it('moves children along and renumbers both levels', () => {
    expect(apply('1. a\n2. b‸\n   1. c\n3. d', indentListItem)).toBe('1. a\n   1. b‸\n      1. c\n2. d');
  });
  it('continues numbering of an existing sublist', () => {
    expect(apply('1. a\n   1. x\n2. b‸', indentListItem)).toBe('1. a\n   1. x\n   2. b‸');
  });
  it('keeps the first item in place (cannot nest)', () => {
    expect(apply('- a‸\n- b', indentListItem)).toBe('- a‸\n- b');
  });
  it('outdents to the parent level and renumbers', () => {
    expect(apply('1. a\n   1. b‸\n2. c', outdentListItem)).toBe('1. a\n2. b‸\n3. c');
    expect(apply('- a\n  - b‸\n    - c', outdentListItem)).toBe('- a\n- b‸\n  - c');
  });
  it('uses tabs when the list is tab-indented', () => {
    expect(apply('- a\n\t- x\n- b‸', indentListItem)).toBe('- a\n\t- x\n\t- b‸');
  });
  it('indents every selected item', () => {
    expect(apply('- a\n- «b\n- c»', indentListItem)).toBe('- a\n  - «b\n  - c»');
  });
  it('is not handled on non-list lines', () => {
    expect(run(mdState('text‸'), indentListItem).handled).toBe(false);
    expect(run(mdState('- top‸'), outdentListItem).handled).toBe(false);
  });
});

describe('renumbering', () => {
  it('fixes a run, keeping the start number of top-level lists', () => {
    const st = mdState('5. a\n9. b\n7. c');
    const r = run(st, renumberList).state;
    expect(r.doc.toString()).toBe('5. a\n6. b\n7. c');
  });
  it('leaves lazy "1. 1. 1." lists alone', () => {
    expect(renumberChanges(mdState('1. a\n1. b\n1. c'), 1)).toEqual([]);
  });
  it('nested runs are renumbered independently', () => {
    const r = run(mdState('1. a\n   3. x\n   5. y\n2. b'), renumberList).state;
    expect(r.doc.toString()).toBe('1. a\n   3. x\n   4. y\n2. b');
  });
  it('auto-renumbers after deleting an item line', () => {
    const st = mdState('1. a\n2. b\n3. c\n4. d');
    const line = st.doc.line(2);
    const next = st.update({ changes: { from: line.from, to: line.to + 1 }, userEvent: 'delete.line' }).state;
    expect(next.doc.toString()).toBe('1. a\n2. c\n3. d');
  });
  it('auto-renumbers after moving a line', () => {
    const st = mdState('1. a\n2. b\n3. c');
    // what moveLineDown on the first item produces: "2. b\n1. a\n3. c"
    const next = st.update({ changes: [{ from: 0, to: 5, insert: '' }, { from: 10, insert: '1. a\n' }], userEvent: 'move.line' }).state;
    expect(next.doc.toString()).toBe('1. b\n2. a\n3. c');
  });
  it('does not renumber while typing digits', () => {
    const st = mdState('1. a\n2. b');
    const next = st.update({ changes: { from: 5, to: 6, insert: '7' }, userEvent: 'input.type' }).state;
    expect(next.doc.toString()).toBe('1. a\n7. b');
  });
});

describe('tasks', () => {
  it('Mod-Enter cycles plain → task → checked → unchecked', () => {
    expect(apply('buy milk‸', toggleTask)).toBe('- [ ] buy milk‸');
    expect(apply('- buy milk‸', toggleTask)).toBe('- [ ] buy milk‸');
    expect(apply('- [ ] buy‸', toggleTask)).toBe('- [x] buy‸');
    expect(apply('- [x] buy‸', toggleTask)).toBe('- [ ] buy‸');
    expect(apply('  1. [X] nested‸', toggleTask)).toBe('  1. [ ] nested‸');
  });
  it('toggles each selected line', () => {
    expect(show(run(mdState('«- [ ] a\n- [x] b»'), toggleTask).state)).toBe('«- [x] a\n- [ ] b»');
  });
  it('toggleTaskAt flips the checkbox on a given line (widget click)', () => {
    const st = mdState('- [ ] a\n- [ ] b');
    const spec = toggleTaskAt(st, st.doc.line(2).from)!;
    expect(st.update(spec).state.doc.toString()).toBe('- [ ] a\n- [x] b');
    expect(toggleTaskAt(st.update({ changes: { from: 0, insert: 'x' } }).state, 0)).toBeNull();
  });
  it('Backspace at task text start removes the checkbox but keeps the bullet', () => {
    expect(apply('- [ ] ‸text', deleteTaskMarker)).toBe('- ‸text');
    expect(apply('- [ ] ‸text', backspace)).toBe('- ‸text');
  });
  it('Backspace inside an empty pair removes both markers', () => {
    expect(apply('a **‸** b', backspace)).toBe('a ‸ b');
  });
});
