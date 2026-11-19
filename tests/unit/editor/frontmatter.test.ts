import { describe, expect, it } from 'vitest';
import { coerce, formatKey, formatScalar, frontmatterBody, parseProps, propLines, removeProp, renameProp, setProp, typeForNewKey } from '../../../src/renderer/editor/frontmatter';

const get = (body: string, key: string) => parseProps(body).props.find((p) => p.key === key)!;

describe('parseProps', () => {
  const body = [
    'title: Plain title',
    'quoted: "a: b # c"',
    "single: 'it''s'",
    'count: 42',
    'ratio: -1.5',
    'zip: 007',
    'done: true',
    'due: 2026-11-19',
    'at: 2026-11-19 22:15',
    'tags: [journal, "with, comma", daily]',
    'aliases:',
    '  - First',
    '  - "Second: two"',
    'compact:',
    '- a',
    '- b',
    'empty:',
    'nul: null',
    '# a comment',
    'nested:',
    '  a: 1',
    'block: |',
    '  multi',
    '  line',
    'withcomment: value # trailing',
    '"spaced key": x',
  ].join('\n');
  const { props, ok } = parseProps(body);

  it('understands the Obsidian subset', () => {
    expect(ok).toBe(true);
    expect(props.map((p) => [p.key, p.type])).toEqual([
      ['title', 'text'],
      ['quoted', 'text'],
      ['single', 'text'],
      ['count', 'number'],
      ['ratio', 'number'],
      ['zip', 'text'],
      ['done', 'checkbox'],
      ['due', 'date'],
      ['at', 'datetime'],
      ['tags', 'tags'],
      ['aliases', 'list'],
      ['compact', 'list'],
      ['empty', 'empty'],
      ['nul', 'empty'],
      ['nested', 'complex'],
      ['block', 'complex'],
      ['withcomment', 'text'],
      ['spaced key', 'text'],
    ]);
  });
  it('decodes values', () => {
    expect(get(body, 'quoted').value).toBe('a: b # c');
    expect(get(body, 'single').value).toBe("it's");
    expect(get(body, 'count').value).toBe(42);
    expect(get(body, 'zip').value).toBe('007');
    expect(get(body, 'done').value).toBe(true);
    expect(get(body, 'tags').value).toEqual(['journal', 'with, comma', 'daily']);
    expect(get(body, 'tags').flow).toBe(true);
    expect(get(body, 'aliases').value).toEqual(['First', 'Second: two']);
    expect(get(body, 'compact').value).toEqual(['a', 'b']);
    expect(get(body, 'withcomment').value).toBe('value');
  });
  it('tracks line ranges (multi-line values included)', () => {
    expect(get(body, 'aliases')).toMatchObject({ start: 10, end: 13 });
    expect(get(body, 'nested')).toMatchObject({ start: 19, end: 21 });
  });
  it('tags given as a scalar split into pills (" #x" stays a YAML comment)', () => {
    expect(parseProps('tags: one, two three').props[0].value).toEqual(['one', 'two', 'three']);
    expect(parseProps('tags: one, #two').props[0].value).toEqual(['one']);
  });
  it('flags YAML it cannot edit safely', () => {
    expect(parseProps('- top level list').ok).toBe(false);
    expect(parseProps('  indented orphan').ok).toBe(false);
    expect(parseProps('').ok).toBe(true);
  });
});

describe('formatting values safely', () => {
  it.each([
    ['plain text', 'plain text'],
    ['Réunion — 日本 🎉', 'Réunion — 日本 🎉'],
    ['a: b', '"a: b"'],
    ['ends with:', '"ends with:"'],
    ['has #hash', '"has #hash"'],
    ['#tag', '"#tag"'],
    ['- dash', '"- dash"'],
    ['[bracket', '"[bracket"'],
    ['say "hi"', 'say "hi"'],
    ['"quoted"', '"\\"quoted\\""'],
    ['true', '"true"'],
    ['No', '"No"'],
    ['null', '"null"'],
    ['123', '"123"'],
    ['2026-11-19', '"2026-11-19"'],
    [' padded ', '" padded "'],
    ['line\nbreak', '"line\\nbreak"'],
    ['back\\slash', 'back\\slash'],
    ['', '""'],
    ['@mention', '"@mention"'],
  ])('%j → %s', (input, want) => expect(formatScalar(input)).toBe(want));

  it('flow context also quotes commas and brackets', () => {
    expect(formatScalar('a, b', true)).toBe('"a, b"');
    expect(formatScalar('x]', true)).toBe('"x]"');
  });

  it('round-trips arbitrary strings through set → parse', () => {
    const samples = ['a: b', '"q" \'s\'', 'C:\\path\\to', 'emoji 🎉 & ünïcödé', 'tab\there', '  lead', 'trail  ', '#', '---', '...', 'key: value # not comment', 'yes', '0x1F', '1e3', '-', '?', '|', '>', '%x', '`tick`', '{a: 1}', 'multi\nline\ntext', 'ends with backslash\\', '\u2028sep'];
    for (const s of samples) {
      const body = setProp('title: x\nother: y', 'title', s);
      expect(get(body, 'title').value, JSON.stringify(s)).toBe(s);
      expect(get(body, 'other').value).toBe('y');
      expect(parseProps(body).ok).toBe(true);
      // Lists too (block and flow).
      for (const flow of [false, true]) {
        const lb = setProp('', 'list', [s, 'plain'], { flow });
        expect(get(lb, 'list').value, `${flow} ${JSON.stringify(s)}`).toEqual([s, 'plain']);
      }
    }
  });

  it('keys', () => {
    expect(formatKey('title')).toBe('title');
    expect(formatKey('my key')).toBe('my key');
    expect(formatKey('a: b')).toBe('"a: b"');
    expect(formatKey('true')).toBe('"true"');
    expect(formatKey('日本')).toBe('日本');
  });
});

describe('minimal edits', () => {
  const body = 'title: Old\n# keep me\ntags: [a, b]\nlist:\n  - x\n  - y\ncount: 1';

  it('setProp rewrites only that property (comments, order, styles kept)', () => {
    expect(setProp(body, 'title', 'New: "quoted"')).toBe('title: "New: \\"quoted\\""\n# keep me\ntags: [a, b]\nlist:\n  - x\n  - y\ncount: 1');
    expect(setProp(body, 'tags', ['a', 'b', 'c d'])).toBe('title: Old\n# keep me\ntags: [a, b, c d]\nlist:\n  - x\n  - y\ncount: 1');
    expect(setProp(body, 'list', ['z'])).toBe('title: Old\n# keep me\ntags: [a, b]\nlist:\n  - z\ncount: 1');
    expect(setProp(body, 'count', 2.5)).toBe('title: Old\n# keep me\ntags: [a, b]\nlist:\n  - x\n  - y\ncount: 2.5');
  });
  it('typed values are written plain', () => {
    expect(propLines('done', true)).toEqual(['done: true']);
    expect(propLines('due', '2026-01-02', { type: 'date' })).toEqual(['due: 2026-01-02']);
    expect(propLines('due', '2026-01-02', { type: 'text' })).toEqual(['due: "2026-01-02"']);
    expect(propLines('tags', [])).toEqual(['tags: []']);
    expect(propLines('x', null)).toEqual(['x:']);
  });
  it('appends new keys before trailing blank lines', () => {
    expect(setProp('a: 1\n\n', 'b', 'two')).toBe('a: 1\nb: two\n\n');
    expect(setProp('', 'first', 'v')).toBe('first: v');
  });
  it('removeProp / renameProp', () => {
    expect(removeProp(body, 'list')).toBe('title: Old\n# keep me\ntags: [a, b]\ncount: 1');
    expect(renameProp(body, 'tags', 'labels')).toBe('title: Old\n# keep me\nlabels: [a, b]\nlist:\n  - x\n  - y\ncount: 1');
    expect(renameProp('"odd key": 1', 'odd key', 'new key')).toBe('new key: 1');
    expect(renameProp(body, 'title', 'a: b')).toBe('"a: b": Old\n# keep me\ntags: [a, b]\nlist:\n  - x\n  - y\ncount: 1');
  });
  it('coerce + type guesses', () => {
    expect(coerce('42', 'number')).toBe(42);
    expect(coerce('abc', 'number')).toBe('abc');
    expect(coerce('#a, b ,', 'tags')).toEqual(['a', 'b']);
    expect(coerce('', 'text')).toBeNull();
    expect(typeForNewKey('Tags')).toBe('tags');
    expect(typeForNewKey('due')).toBe('date');
    expect(typeForNewKey('done')).toBe('checkbox');
    expect(typeForNewKey('author')).toBe('text');
  });
});

describe('frontmatterBody', () => {
  it('finds the body and the replaceable region', () => {
    const doc = '---\na: 1\nb: 2\n---\n# Body';
    const fm = frontmatterBody(doc)!;
    expect(fm.body).toBe('a: 1\nb: 2');
    expect(doc.slice(fm.from, fm.to)).toBe('\na: 1\nb: 2\n');
    expect(frontmatterBody('---\n---\nx')).toEqual({ body: '', from: 3, to: 4 });
    expect(frontmatterBody('---\na: 1\n...\n')!.body).toBe('a: 1');
    expect(frontmatterBody('no\n---\n')).toBeNull();
    expect(frontmatterBody('---\nunclosed')).toBeNull();
  });
});
