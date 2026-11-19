import { describe, expect, it } from 'vitest';
import { calloutItems, dateItems, filterSlashItems, nextFootnoteLabel, parseTableSize, rootItems, slashTransaction, slashTriggerOk, tableMarkdown, type SlashAction } from '../../../src/renderer/editor/slash-items';
import { mdState, show } from './helpers';

const root = rootItems();
const top = (q: string, items = root) => filterSlashItems(q, items)[0]?.item.title;

describe('slash menu filtering', () => {
  it('unfiltered: every visible item in catalog order, no search-only extras', () => {
    const all = filterSlashItems('', root);
    expect(all[0].item.title).toBe('Heading 1');
    expect(all.some((m) => m.item.searchOnly)).toBe(false);
    expect(all.map((m) => m.item.id)).toEqual(expect.arrayContaining(['table', 'code', 'callout', 'math', 'mermaid', 'image', 'footnote', 'date', 'link', 'embed', 'properties', 'template', 'command']));
  });

  it.each([
    ['todo', 'Task list'],
    ['pre', 'Code block'],
    ['snippet', 'Code block'],
    ['warn', 'Warning callout'],
    ['caution', 'Warning callout'],
    ['h2', 'Heading 2'],
    ['h5', 'Heading 5'],
    ['tab', 'Table'],
    ['latex', 'Math block'],
    ['flowchart', 'Mermaid diagram'],
    ['frontmatter', 'Properties'],
    ['yaml', 'Properties'],
    ['ul', 'Bullet list'],
    ['hr', 'Divider'],
    ['palette', 'Run command…'],
    ['wikilink', 'Link to note'],
    ['quote', 'Quote'],
  ])('"%s" → %s', (q, want) => expect(top(q)).toBe(want));

  it('date shortcuts beat the Date / time submenu when searched by exact name', () => {
    const items = [...root, ...dateItems(new Date(2026, 10, 18, 22, 15), 'YYYY-MM-DD', 'HH:mm', true)];
    expect(top('today', items)).toBe('Today');
    expect(top('now', items)).toBe('Now');
    const today = filterSlashItems('today', items)[0].item;
    expect(today.action).toEqual({ type: 'inline', text: '2026-11-18' });
  });

  it('title matches carry highlight positions; keyword-only matches do not', () => {
    const m = filterSlashItems('cod', root)[0];
    expect(m.item.title).toBe('Code block');
    expect(m.positions).toEqual([0, 1, 2]);
    const k = filterSlashItems('todo', root)[0];
    expect(k.positions).toEqual([]);
  });

  it('callout submenu lists the 13 canonical kinds with aliases as hints', () => {
    const c = calloutItems(false);
    expect(c).toHaveLength(13);
    expect(c.find((x) => x.tone === 'warning')!.hint).toBe('warn, caution, attention');
    expect(top('error', c)).toBe('Danger');
  });

  it('no results for nonsense', () => expect(filterSlashItems('zzzqqq', root)).toEqual([]));
});

describe('slash trigger + helpers', () => {
  it('opens only at line start or after whitespace', () => {
    expect(slashTriggerOk('')).toBe(true);
    expect(slashTriggerOk('- ')).toBe(true);
    expect(slashTriggerOk('word ')).toBe(true);
    expect(slashTriggerOk('word')).toBe(false);
    expect(slashTriggerOk('http:')).toBe(false);
  });
  it('table sizes', () => {
    expect(parseTableSize('4x5')).toEqual({ cols: 4, rows: 5 });
    expect(parseTableSize('4 × 2')).toEqual({ cols: 4, rows: 2 });
    expect(parseTableSize('6')).toEqual({ cols: 6, rows: 3 });
    expect(parseTableSize('abc')).toBeNull();
    expect(tableMarkdown(2, 2)).toBe('| Column 1 | Column 2 |\n| -------- | -------- |\n|          |          |');
  });
  it('footnote labels continue after the highest number', () => {
    expect(nextFootnoteLabel('a [^1] b [^7] [^x]')).toBe('8');
    expect(nextFootnoteLabel('none')).toBe('1');
  });
});

/** Runs a slash action where "/query" spans from the "/" to the cursor (‸). */
function slash(marked: string, action: SlashAction): string {
  const state = mdState(marked);
  const head = state.selection.main.head;
  const from = state.doc.toString().lastIndexOf('/', head - 1);
  return show(state.update(slashTransaction(state, from, head, action)).state);
}

describe('slash insert transactions', () => {
  it('headings restyle the line and drop the query', () => {
    expect(slash('Title /h2‸', { type: 'heading', level: 2 })).toBe('## Title ‸');
    expect(slash('- item /h1‸', { type: 'heading', level: 1 })).toBe('# item ‸');
    expect(slash('### Old /h1‸', { type: 'heading', level: 1 })).toBe('# Old ‸');
  });
  it('list / quote prefixes replace existing ones and keep indentation', () => {
    expect(slash('/todo‸', { type: 'line', prefix: '- [ ] ' })).toBe('- [ ] ‸');
    expect(slash('  - thing /num‸', { type: 'line', prefix: '1. ' })).toBe('  1. thing ‸');
    expect(slash('> quoted /bul‸', { type: 'line', prefix: '- ' })).toBe('- quoted ‸');
  });
  it('blocks replace an empty line, with blank-line separation from neighbours', () => {
    expect(slash('para\n/code‸\nnext', { type: 'block', text: '```\n```', cursor: 3 })).toBe('para\n\n```‸\n```\n\nnext');
    expect(slash('/div‸', { type: 'block', text: '---\n', cursor: 4 })).toBe('---\n‸');
    expect(slash('para\n\n/div‸', { type: 'block', text: '---\n', cursor: 4 })).toBe('para\n\n---\n‸');
  });
  it('a block typed after text goes below the paragraph', () => {
    expect(slash('Some text /math‸', { type: 'block', text: '$$\n\n$$', cursor: 3 })).toBe('Some text\n\n$$\n‸\n$$');
  });
  it('a list-marker-only line counts as empty', () => {
    expect(slash('- /table‸', { type: 'table', cols: 2, rows: 2 })).toBe('| «Column 1» | Column 2 |\n| -------- | -------- |\n|          |          |');
  });
  it('tables select the first header cell', () => {
    expect(slash('/t‸', { type: 'table', cols: 3, rows: 3 })).toMatch(/^\| «Column 1» \| Column 2 \| Column 3 \|\n(\| -+ ){3}\|\n(\|( +)\|( +)\|( +)\|\n?){2}$/);
  });
  it('inline inserts at the slash', () => {
    expect(slash('See /link‸ here', { type: 'inline', text: '[[]]', cursor: 2 })).toBe('See [[‸]] here');
    expect(slash('Date: /today‸', { type: 'inline', text: '2026-11-19' })).toBe('Date: 2026-11-19‸');
  });
  it('footnotes: reference at the slash, definition at the end, cursor in the definition', () => {
    expect(slash('Claim /fn‸\n\nMore text\n', { type: 'footnote' })).toBe('Claim [^1]\n\nMore text\n\n[^1]: ‸');
    expect(slash('A[^1] B /fn‸\n\n[^1]: first', { type: 'footnote' })).toBe('A[^1] B [^2]\n\n[^1]: first\n[^2]: ‸');
    expect(slash('/fn‸', { type: 'footnote' })).toBe('[^1]\n\n[^1]: ‸');
  });
  it('callout block puts the cursor in the body', () => {
    const item = filterSlashItems('warn', root)[0].item;
    expect(slash('/warn‸', item.action!)).toBe('> [!warning] Warning\n> ‸');
  });
});
