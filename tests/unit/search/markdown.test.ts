import { describe, expect, it } from 'vitest';
import { classifyAt, inlineSpans, parseStructure, K_CODE, K_FENCE, K_FM, K_HEADING, K_TEXT } from '../../../src/search/markdown';
import { outline } from '../../../src/search/symbols';

describe('markdown structure', () => {
  const md = ['---', 'title: My "note"', 'tags:', '  - alpha', '  - beta/x', '---', '# Title', '', '- item', '  ```js title="x"', '  const a = 1', '  ```', '~~~', 'tilde', '~~~', '> ```sh', '> ls -la', '> ```', 'Setext', '======', 'text #inline-tag and `#not-a-tag`', '```', 'unclosed'].join('\n');
  const s = parseStructure('n.md', md);

  it('classifies frontmatter, headings, fences (incl. lists, quotes, tildes, unclosed)', () => {
    expect([...s.kinds.slice(0, 6)]).toEqual([5, K_FM, K_FM, K_FM, K_FM, 5]);
    expect(s.kinds[6]).toBe(K_HEADING);
    expect([s.kinds[9], s.kinds[10], s.kinds[11]]).toEqual([K_FENCE, K_CODE, K_FENCE]);
    expect(s.blocks[0]).toMatchObject({ lang: 'js', langId: 'javascript', startLine: 9, endLine: 11 });
    expect(s.blocks[1]).toMatchObject({ lang: '', startLine: 12, endLine: 14 });
    expect(s.blocks[2]).toMatchObject({ lang: 'sh', langId: 'shell' });
    expect(s.kinds[16]).toBe(K_CODE);
    expect(s.kinds[18]).toBe(K_HEADING);
    expect(s.kinds[20]).toBe(K_TEXT);
    expect(s.kinds[22]).toBe(K_CODE); // unclosed fence runs to EOF
    expect(s.title).toBe('My "note"');
    expect(s.headings.map((h) => [h.line, h.level, h.text])).toEqual([[6, 1, 'Title'], [18, 1, 'Setext']]);
    expect(s.tags.sort()).toEqual(['alpha', 'beta/x', 'inline-tag']);
    expect([...s.langs].sort()).toEqual(['javascript', 'shell']);
  });

  it('inline spans: code spans (multi-backtick), wikilinks, md links, bare urls', () => {
    const line = 'a `x` b ``y ` z`` [[Note|alias]] [t](http://u) <https://a.b> https://c.d/e?f `[[no]]`';
    const sp = inlineSpans(line).map((x) => `${x.kind}:${line.slice(x.start, x.end)}`);
    expect(sp).toEqual(['inline-code:`x`', 'inline-code:``y ` z``', 'link:[[Note|alias]]', 'link:[t](http://u)', 'link:<https://a.b>', 'link:https://c.d/e?f', 'inline-code:`[[no]]`']);
  });

  it('classifyAt returns heading levels and code langs', () => {
    expect(classifyAt(s, 6, 3, '# Title')).toEqual({ context: 'heading', headingLevel: 1 });
    expect(classifyAt(s, 10, 4, '  const a = 1')).toMatchObject({ context: 'code', lang: 'js', langId: 'javascript' });
  });

  it('code files are code with the file language; txt is text', () => {
    expect(parseStructure('a.php', '<?php').mode).toBe('code');
    expect(parseStructure('a.php', '<?php').fileLang).toBe('php');
    expect(parseStructure('a.txt', 'x').mode).toBe('text');
    expect(parseStructure('Dockerfile', 'FROM x').fileLang).toBe('dockerfile');
  });

  it('outline extracts headings or code symbols', () => {
    expect(outline('a.md', '# A\n## B').map((x) => x.text)).toEqual(['A', 'B']);
    const php = outline('UserController.php', 'class UserController extends Controller {\n  public function index() {}\n  public function show(int $id) {}\n}');
    expect(php.map((x) => `${x.detail}:${x.text}`)).toEqual(['class:UserController', 'function:index', 'function:show']);
    const ts = outline('a.ts', 'export function greet() {}\nexport const add = (a, b) => a + b\ninterface X {}');
    expect(ts.map((x) => x.text)).toEqual(['greet', 'add', 'X']);
  });
});
