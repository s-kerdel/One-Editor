import { describe, expect, it } from 'vitest';
import { createLinkResolver, findWikiLinks, parseWikiLink, resolveWikiTarget, wikiTargetSpan } from '@shared/wikilinks';

const files = ['README.md', 'notes/Daily notes.md', 'notes/kubernetes.md', 'notes/img/diagram.png', 'projects/alpha/Plan.md', 'projects/beta/Plan.md', 'projects/Plan.md', 'archive/old/Todo.md', 'Todo.markdown', 'code/app.ts'];

describe('parseWikiLink', () => {
  it('parses target, heading, block and alias', () => {
    expect(parseWikiLink('Note')).toEqual({ target: 'Note', heading: undefined, block: undefined, alias: undefined, embed: false });
    expect(parseWikiLink('folder/Note#Some heading|Shown')).toMatchObject({ target: 'folder/Note', heading: 'Some heading', alias: 'Shown' });
    expect(parseWikiLink('Note#^abc-1')).toMatchObject({ target: 'Note', block: 'abc-1', heading: undefined });
    expect(parseWikiLink('#Local heading')).toMatchObject({ target: '', heading: 'Local heading' });
    expect(parseWikiLink(' Note | Alias ', true)).toMatchObject({ target: 'Note', alias: 'Alias', embed: true });
  });
  it('keeps # inside an alias and nested heading paths', () => {
    expect(parseWikiLink('Note|C# tips')).toMatchObject({ target: 'Note', alias: 'C# tips', heading: undefined });
    expect(parseWikiLink('Note#A#B')).toMatchObject({ target: 'Note', heading: 'A#B' });
  });
  it('handles the \\| escape used inside table cells', () => {
    expect(parseWikiLink('Note\\|Alias')).toMatchObject({ target: 'Note', alias: 'Alias' });
    expect(parseWikiLink('Note#H\\|Alias')).toMatchObject({ target: 'Note', heading: 'H', alias: 'Alias' });
  });
});

describe('wikiTargetSpan', () => {
  it('covers only the file part', () => {
    const cases: Array<[string, string]> = [
      ['Note', 'Note'],
      [' Note #H|A', 'Note'],
      ['a/b|x', 'a/b'],
      ['Note\\|x', 'Note'],
      ['#H', ''],
      ['Note#^id', 'Note'],
    ];
    for (const [inner, want] of cases) {
      const s = wikiTargetSpan(inner);
      expect(inner.slice(s.from, s.to)).toBe(want);
    }
  });
});

describe('findWikiLinks', () => {
  it('finds links and embeds with positions', () => {
    const text = 'a [[One]] b ![[img.png|200]] c [[Two#H|t]]';
    const l = findWikiLinks(text);
    expect(l.map((x) => x.target)).toEqual(['One', 'img.png', 'Two']);
    expect(l[1].embed).toBe(true);
    expect(text.slice(l[2].index, l[2].index + l[2].length)).toBe('[[Two#H|t]]');
  });
  it('finds table links with escaped pipes and ignores broken ones', () => {
    expect(findWikiLinks('| [[A\\|b]] | [[C]] |').map((x) => [x.target, x.alias])).toEqual([['A', 'b'], ['C', undefined]]);
    expect(findWikiLinks('[[]] [[a\nb]] [[ok]]').map((x) => x.target)).toEqual(['ok']);
  });
});

describe('resolveWikiTarget', () => {
  it('resolves case-insensitively, with and without extension', () => {
    expect(resolveWikiTarget('daily notes', files)).toBe('notes/Daily notes.md');
    expect(resolveWikiTarget('KUBERNETES', files)).toBe('notes/kubernetes.md');
    expect(resolveWikiTarget('kubernetes.md', files)).toBe('notes/kubernetes.md');
    expect(resolveWikiTarget('readme', files)).toBe('README.md');
    expect(resolveWikiTarget('Todo', files)).toBe('Todo.markdown');
  });
  it('resolves attachments only with their extension', () => {
    expect(resolveWikiTarget('diagram.png', files)).toBe('notes/img/diagram.png');
    expect(resolveWikiTarget('diagram', files)).toBeNull();
    expect(resolveWikiTarget('app.ts', files)).toBe('code/app.ts');
    expect(resolveWikiTarget('app', files)).toBeNull();
  });
  it('prefers the same folder, then the shortest path', () => {
    expect(resolveWikiTarget('Plan', files, 'projects/beta/Notes.md')).toBe('projects/beta/Plan.md');
    expect(resolveWikiTarget('Plan', files, 'projects/alpha/x.md')).toBe('projects/alpha/Plan.md');
    expect(resolveWikiTarget('Plan', files, 'README.md')).toBe('projects/Plan.md');
    expect(resolveWikiTarget('Plan', files)).toBe('projects/Plan.md');
  });
  it('resolves folder/Note paths (full, partial, relative)', () => {
    expect(resolveWikiTarget('projects/beta/Plan', files)).toBe('projects/beta/Plan.md');
    expect(resolveWikiTarget('beta/Plan', files)).toBe('projects/beta/Plan.md');
    expect(resolveWikiTarget('Beta/plan.md', files, 'README.md')).toBe('projects/beta/Plan.md');
    expect(resolveWikiTarget('old/Todo', files)).toBe('archive/old/Todo.md');
    expect(resolveWikiTarget('../alpha/Plan', files, 'projects/beta/x.md')).toBe('projects/alpha/Plan.md');
    expect(resolveWikiTarget('./img/diagram.png', files, 'notes/kubernetes.md')).toBe('notes/img/diagram.png');
    expect(resolveWikiTarget('gamma/Plan', files)).toBeNull();
    expect(resolveWikiTarget('ta/Plan', files)).toBeNull(); // must match whole segments
  });
  it('returns the source for an empty target and null for unknown ones', () => {
    expect(resolveWikiTarget('', files, 'README.md')).toBe('README.md');
    expect(resolveWikiTarget('', files)).toBeNull();
    expect(resolveWikiTarget('Nope', files)).toBeNull();
    expect(resolveWikiTarget('Daily', files)).toBeNull();
  });
  it('tolerates backslashes and sees in-place list growth', () => {
    expect(resolveWikiTarget('projects\\beta\\Plan', files)).toBe('projects/beta/Plan.md');
    const list = ['a.md'];
    expect(resolveWikiTarget('b', list)).toBeNull();
    list.push('b.md');
    expect(resolveWikiTarget('b', list)).toBe('b.md');
  });
});

describe('names that differ only in case (Linux, WSL roots: both files exist)', () => {
  const twins = ['cases/Note.md', 'cases/note.md', 'Docs/a.md', 'docs/a.md', 'other/x.md'];
  it('the exact spelling wins; folding is only the fallback', () => {
    const r = createLinkResolver(twins);
    expect(r('cases/Note')).toBe('cases/Note.md');
    expect(r('cases/note')).toBe('cases/note.md');
    expect(r('cases/note.md')).toBe('cases/note.md');
    expect(r('Note', 'other/x.md')).toBe('cases/Note.md');
    expect(r('note', 'other/x.md')).toBe('cases/note.md');
    expect(r('docs/a')).toBe('docs/a.md');
    expect(r('Docs/a')).toBe('Docs/a.md');
    expect(r('./note', 'cases/x.md')).toBe('cases/note.md');
    expect(r('../docs/a', 'cases/x.md')).toBe('docs/a.md');
    expect(r('NOTE', 'other/x.md')).toMatch(/^cases\/(Note|note)\.md$/); // no exact match: still found
    expect(r('cases/NOTE')).toMatch(/^cases\/(Note|note)\.md$/);
  });
});

describe('createLinkResolver aliases', () => {
  it('falls back to aliases after file names', () => {
    const r = createLinkResolver(files, new Map([['k8s', ['notes/kubernetes.md']], ['readme', ['notes/kubernetes.md']]]));
    expect(r('K8s')).toBe('notes/kubernetes.md');
    expect(r('readme')).toBe('README.md'); // a real file name wins over an alias
  });
});
