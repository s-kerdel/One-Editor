import { describe, expect, it } from 'vitest';
import { extractHeadings, extractNote, parseFrontmatter, slugify } from '../../../src/knowledge/extract';

const note = (text: string, path = 'notes/a.md') => extractNote(path, text);

describe('links', () => {
  it('extracts wikilinks and embeds with heading/block/alias and positions', () => {
    const n = note('Intro [[One]] and [[Two#Part|second]]\n\n![[img.png]] then [[Three#^b1]]');
    expect(n.links.map((l) => [l.kind, l.target, l.heading, l.block, l.alias, l.embed, l.line])).toEqual([
      ['wiki', 'One', undefined, undefined, undefined, false, 0],
      ['wiki', 'Two', 'Part', undefined, 'second', false, 0],
      ['wiki', 'img.png', undefined, undefined, undefined, true, 2],
      ['wiki', 'Three', undefined, 'b1', undefined, false, 2],
    ]);
    expect('Intro [[One]]'.slice(n.links[0].col, n.links[0].col + n.links[0].length)).toBe('[[One]]');
  });
  it('extracts local markdown links, URL-decoded, and skips external ones', () => {
    const n = note('[a](../other%20note.md#Some%20head) [b](https://x.y/z.md) [c](mailto:a@b.c) [d](#local) ![e](img/p.png "title") [f](<my file.md>)\n[ref]: ./ref.md');
    expect(n.links.map((l) => [l.target, l.heading, l.embed])).toEqual([
      ['../other note.md', 'Some head', false],
      ['img/p.png', undefined, true],
      ['my file.md', undefined, false],
      ['./ref.md', undefined, false],
    ]);
  });
  it('ignores links in fenced code, inline code and frontmatter', () => {
    const n = note('---\nrelated: "[[Nope]]"\n---\n```md\n[[Nope2]]\n```\n~~~\n[[Nope3]]\n~~~\n`[[Nope4]]` [[Yes]] ``a ` [[Nope5]]``');
    expect(n.links.map((l) => l.target)).toEqual(['Yes']);
  });
  it('handles table links with escaped pipes', () => {
    expect(note('| [[Note\\|alias]] | x |').links[0]).toMatchObject({ target: 'Note', alias: 'alias' });
  });
});

describe('tags', () => {
  it('finds inline and nested tags', () => {
    expect(note('#idea and #tag/project, (#paren) #with-dash #über_tag').tags).toEqual(['idea', 'tag/project', 'paren', 'with-dash', 'über_tag']);
  });
  it('does not treat headings, numbers, anchors, URLs or code as tags', () => {
    const n = note(['# Heading', '## Another #real', 'issue #123 and a#b and &#39;', 'https://x.y/page#frag [l](a.md#sec) [[N#head]] [[#own]]', '`#code` ``#more``', '```', '#fenced', '```', '    text #indented-ok'].join('\n'));
    expect(n.tags).toEqual(['real', 'indented-ok']);
  });
  it('dedupes case-insensitively and reads frontmatter tag forms', () => {
    expect(note('---\ntags: [journal, daily]\n---\n#Journal #x').tags).toEqual(['Journal', 'x', 'daily']);
    expect(note('---\ntags:\n  - one\n  - "#two"\n  - nested/three\n---\n').tags).toEqual(['one', 'two', 'nested/three']);
    expect(note('---\ntags: alpha, beta\n---\n').tags).toEqual(['alpha', 'beta']);
    expect(note('---\ntags: alpha beta\n---\n').tags).toEqual(['alpha', 'beta']);
    expect(note('---\ntag: solo\n---\n').tags).toEqual(['solo']);
  });
});

describe('frontmatter', () => {
  it('parses scalars, flow lists, block lists and quotes', () => {
    const p = parseFrontmatter(['title: "Hello: world"', 'count: 3', 'draft: true', 'empty:', 'list: [a, "b, c", 3]', 'aliases:', '  - First alias', "  - 'Second'", '# comment', 'date: 2024-01-02', 'note: x # trailing']);
    expect(p).toEqual({ title: 'Hello: world', count: 3, draft: true, empty: null, list: ['a', 'b, c', 3], aliases: ['First alias', 'Second'], date: '2024-01-02', note: 'x' });
  });
  it('exposes aliases in list, inline and scalar form', () => {
    expect(note('---\naliases: [K8s, Kube]\n---\n').aliases).toEqual(['K8s', 'Kube']);
    expect(note('---\naliases:\n- One thing\n- Other\n---\n').aliases).toEqual(['One thing', 'Other']);
    expect(note('---\nalias: Single name\n---\n').aliases).toEqual(['Single name']);
    expect(note('---\naliases: A b, C d\n---\n').aliases).toEqual(['A b', 'C d']);
  });
  it('only treats a leading --- block as frontmatter', () => {
    const n = note('text\n---\ntags: [no]\n---\n');
    expect(n.tags).toEqual([]);
    expect(n.props).toEqual({});
  });
  it('survives CRLF content', () => {
    const n = note('---\r\ntags: [a]\r\naliases: [X]\r\n---\r\n# T\r\n[[L]] #b\r\n');
    expect(n.tags).toEqual(['b', 'a']);
    expect(n.aliases).toEqual(['X']);
    expect(n.headings[0]).toMatchObject({ text: 'T', line: 4 });
    expect(n.links[0].target).toBe('L');
  });
});

describe('headings, blocks, tasks', () => {
  it('extracts ATX headings with level, line and unique slugs', () => {
    const h = extractHeadings('# Title\n\ntext\n## Sub **bold** [[Link|shown]] ##\n```\n# not\n```\n## Sub bold shown\n####### seven\n#nospace\n   ### Indented');
    expect(h).toEqual([
      { level: 1, text: 'Title', line: 0, slug: 'title' },
      { level: 2, text: 'Sub bold shown', line: 3, slug: 'sub-bold-shown' },
      { level: 2, text: 'Sub bold shown', line: 7, slug: 'sub-bold-shown-1' },
      { level: 3, text: 'Indented', line: 10, slug: 'indented' },
    ]);
    expect(note('# A\n## B').headings.map((x) => x.text)).toEqual(['A', 'B']);
  });
  it('slugifies', () => {
    expect(slugify('Hello, World! 2')).toBe('hello-world-2');
    expect(slugify('Ünï côde')).toBe('ünï-côde');
  });
  it('extracts block ids', () => {
    expect(note('A paragraph ^para-1\n\n- item ^i2\n\n^alone\n\nnot^this x\n`code ^no`').blocks).toEqual([
      { id: 'para-1', line: 0 },
      { id: 'i2', line: 2 },
      { id: 'alone', line: 4 },
    ]);
  });
  it('counts open and done tasks, not ones in code', () => {
    expect(note('- [ ] a\n- [x] b\n  * [X] c\n1. [ ] d\n> - [ ] quoted\n```\n- [ ] no\n```\n- [y] nope\n[ ] nope').tasks).toEqual({ open: 3, done: 2 });
  });
  it('uses the file name as title', () => {
    expect(note('# Other', 'x/My note.md').title).toBe('My note');
  });
});
