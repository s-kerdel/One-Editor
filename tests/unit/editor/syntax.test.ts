import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdownSupport, fenceLanguage } from '../../../src/renderer/editor/syntax';
import { linkTextFor, headingsOf, scanTags } from '../../../src/renderer/editor/complete';
import { detectIndent } from '../../../src/renderer/editor/code';

function nodes(doc: string): Array<[string, string]> {
  const st = EditorState.create({ doc, extensions: [markdownSupport()] });
  const tree = ensureSyntaxTree(st, doc.length, 5000)!;
  const out: Array<[string, string]> = [];
  tree.iterate({ enter: (n) => void (n.name !== 'Document' && out.push([n.name, doc.slice(n.from, n.to)])) });
  return out;
}
const has = (doc: string, name: string, text?: string) => nodes(doc).some(([n, t]) => n === name && (text === undefined || t === text));

describe('markdown extensions', () => {
  it('parses wikilinks, aliases and embeds', () => {
    const n = nodes('See [[Note#Head|alias]] and ![[pic.png|200]]');
    expect(n).toContainEqual(['WikiLink', '[[Note#Head|alias]]']);
    expect(n).toContainEqual(['WikiTarget', 'Note#Head']);
    expect(n).toContainEqual(['WikiAlias', 'alias']);
    expect(n).toContainEqual(['WikiEmbed', '![[pic.png|200]]']);
    expect(has('[[]]', 'WikiLink')).toBe(false);
    expect(has('[[a\nb]]', 'WikiLink')).toBe(false);
  });
  it('parses ==highlight==', () => {
    expect(has('a ==hi== b', 'Highlight', '==hi==')).toBe(true);
    expect(has('a === b', 'Highlight')).toBe(false);
  });
  it('parses inline and block math, not currency', () => {
    expect(has('x $e^{i\\pi}$ y', 'InlineMath', '$e^{i\\pi}$')).toBe(true);
    expect(has('costs $5 and $10 total', 'InlineMath')).toBe(false);
    expect(has('a $ b $ c', 'InlineMath')).toBe(false);
    expect(has('$$\nx^2\n$$\n\nafter', 'BlockMath', '$$\nx^2\n$$')).toBe(true);
    expect(has('$$ x $$', 'BlockMath')).toBe(true);
    expect(has('$$\nunclosed', 'BlockMath')).toBe(false);
    expect(has('`$code$`', 'InlineMath')).toBe(false);
  });
  it('parses #tags but not headings, numbers or url fragments', () => {
    expect(has('a #tag/sub b', 'Hashtag', '#tag/sub')).toBe(true);
    expect(has('# Heading', 'Hashtag')).toBe(false);
    expect(has('issue #123', 'Hashtag')).toBe(false);
    expect(has('see x.com/#frag', 'Hashtag')).toBe(false);
  });
  it('parses YAML frontmatter only at the top with a closing fence', () => {
    expect(has('---\ntitle: x\n---\n# H', 'Frontmatter')).toBe(true);
    expect(has('---\ntitle: x\n---\n# H', 'SetextHeading2')).toBe(false);
    expect(has('---\n\nSome text', 'Frontmatter')).toBe(false);
    expect(has('text\n\n---\ntitle: x\n---', 'Frontmatter')).toBe(false);
  });
  it('parses %%comments%% and ^block-ids', () => {
    expect(has('a %%hidden *x*%% b', 'ObsidianComment', '%%hidden *x*%%')).toBe(true);
    expect(has('a %%hidden *x*%% b', 'Emphasis')).toBe(false);
    expect(has('%%\nblock\n\ncomment\n%%\n', 'ObsidianCommentBlock')).toBe(true);
    expect(has('text ^abc-1', 'BlockId', '^abc-1')).toBe(true);
    expect(has('x^2 more', 'BlockId')).toBe(false);
    expect(has('a ^b c', 'BlockId')).toBe(false);
  });
  it('keeps GFM: tables, tasks, strikethrough', () => {
    expect(has('| a |\n|---|\n| 1 |', 'Table')).toBe(true);
    expect(has('- [ ] x', 'TaskMarker')).toBe(true);
    expect(has('~~s~~', 'Strikethrough')).toBe(true);
  });
  it('resolves fence languages through the shared table', () => {
    expect(fenceLanguage('php')?.name).toBe('PHP');
    expect(fenceLanguage('bash')?.name).toBe('Shell');
    expect(fenceLanguage('ts title="x"')?.name).toBe('TypeScript');
    expect(fenceLanguage('yml')?.name).toBe('YAML');
    expect(fenceLanguage('mysql')?.name).toBe('SQL');
    expect(fenceLanguage('json')?.name).toBe('JSON');
    expect(fenceLanguage('mermaid')).toBeNull();
  });
});

describe('completion helpers', () => {
  const files = ['notes/Daily notes.md', 'deep/a/Daily notes.md', 'README.md', 'img/pic.png'];
  it('uses the shortest link text that still resolves', () => {
    expect(linkTextFor('README.md', files, 'notes/x.md')).toBe('README');
    expect(linkTextFor('img/pic.png', files, 'notes/x.md')).toBe('pic.png');
    expect(linkTextFor('notes/Daily notes.md', files, 'notes/x.md')).toBe('Daily notes');
    expect(linkTextFor('deep/a/Daily notes.md', files, 'notes/x.md')).toBe('deep/a/Daily notes');
  });
  it('extracts headings (skipping fenced code)', () => {
    expect(headingsOf('# A\ntext\n```\n# not\n```\n## B ##')).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
    ]);
  });
  it('scans tags', () => {
    const m = new Map<string, number>();
    scanTags('#a #b/c\n# heading\n```\n#code\n```\n#a and #123', m);
    expect([...m.entries()]).toEqual([
      ['a', 2],
      ['b/c', 1],
    ]);
  });
  it('detects indentation units', () => {
    expect(detectIndent('a\n\tb\n\t\tc')).toBe('\t');
    expect(detectIndent('a\n  b\n    c\n  d')).toBe('  ');
    expect(detectIndent('a\n    b\n        c')).toBe('    ');
    expect(detectIndent('flat')).toBe('    ');
  });
});
