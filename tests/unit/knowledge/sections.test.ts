// Document map (src/knowledge/sections.ts): heading ranges, code fences, block ids, frontmatter span.
import { describe, expect, it } from 'vitest';
import { documentMap, findBlock, findSection, frontmatterValue, sliceLines } from '../../../src/knowledge/sections';

const DOC = [
  '---', //0
  'title: Plan', //1
  'tags:', //2
  '  - a', //3
  '  - b', //4
  'status: draft # comment', //5
  '---', //6
  '# Top', //7
  '', //8
  'Intro paragraph', //9
  'continues here ^intro', //10
  '', //11
  '## Plans', //12
  '', //13
  '```md', //14
  '# not a heading', //15
  'text ^notablock', //16
  '```', //17
  '', //18
  '### 2026', //19
  'Do things.', //20
  '', //21
  '| a | b |', //22
  '|---|---|', //23
  '^table', //24
  '', //25
  '## Other > side', //26
  '- one ^li', //27
  '  - nested', //28
  '- two', //29
  '', //30
  '', //31
].join('\n');

describe('documentMap', () => {
  const m = documentMap(DOC);

  it('heading sections end before the next heading of the same or a higher level (blank tail trimmed)', () => {
    expect(m.headings.map((h) => [h.text, h.level, h.line, h.end])).toEqual([
      ['Top', 1, 7, 29],
      ['Plans', 2, 12, 24],
      ['2026', 3, 19, 24],
      ['Other > side', 2, 26, 29],
    ]);
  });

  it('a fenced "# heading" and a ^id inside code are neither headings nor blocks', () => {
    expect(m.headings.some((h) => h.text === 'not a heading')).toBe(false);
    expect(m.blocks.map((b) => b.id)).toEqual(['intro', 'table', 'li']);
  });

  it('block ranges: paragraph, the table above a lone ^id line, a list item with its children', () => {
    expect(findBlock(m, '^intro')).toMatchObject({ start: 9, end: 10 });
    expect(findBlock(m, 'TABLE')).toMatchObject({ line: 24, start: 22, end: 23 });
    expect(findBlock(m, 'li')).toMatchObject({ start: 27, end: 28 });
    expect(findBlock(m, 'nope')).toBeNull();
  });

  it('frontmatter span and keys (list values included, comments stripped)', () => {
    expect(m.frontmatter).toMatchObject({ start: 0, end: 6 });
    expect(m.frontmatter!.keys.map((k) => [k.key, k.line, k.end])).toEqual([
      ['title', 1, 1],
      ['tags', 2, 4],
      ['status', 5, 5],
    ]);
    expect(frontmatterValue(DOC, m, 'TAGS')?.value).toEqual(['a', 'b']);
    expect(frontmatterValue(DOC, m, 'status')?.value).toBe('draft');
    expect(frontmatterValue(DOC, m, 'missing')).toBeNull();
  });

  it('no frontmatter unless the note starts with ---', () => {
    expect(documentMap('text\n---\na: b\n---').frontmatter).toBeNull();
  });
});

describe('findSection', () => {
  const m = documentMap(DOC);
  it('finds nested paths loosely, and a heading that itself contains " > "', () => {
    expect(findSection(m, ['plans', '2026'])?.line).toBe(19);
    expect(findSection(m, ['Top', 'Plans', '2026'])?.line).toBe(19);
    expect(findSection(m, ['Other', 'side'])?.line).toBe(26);
    expect(findSection(m, ['2026', 'Plans'])).toBeNull(); // wrong nesting
    expect(findSection(m, ['  '])).toBeNull();
    expect(sliceLines(DOC, 19, 20)).toBe('### 2026\nDo things.');
  });

  it('CRLF text maps the same lines', () => {
    const crlf = documentMap('# A\r\ntext ^b1\r\n## B\r\n');
    expect(crlf.headings.map((h) => [h.text, h.line, h.end])).toEqual([
      ['A', 0, 2],
      ['B', 2, 2],
    ]);
    expect(crlf.blocks[0]).toMatchObject({ id: 'b1', start: 1, end: 1 });
  });
});
