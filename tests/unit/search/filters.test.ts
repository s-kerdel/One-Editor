import { describe, expect, it } from 'vitest';
import { parseQuery } from '../../../src/search/query';
import { engineWith, paths } from './helpers';

// `report.pdf` / `notes/photo.pdf` / `img.png` stand in for files whose CONTENT cannot be indexed
// (a "no content" hit): the engine finds them by name / path / ext, but never by a content term.
// The backend feeds such name-only docs (see tests/unit/backend/index-pass.test.ts); these tests pin
// the engine half.
const FIX = {
  'report.pdf': '',
  'notes/photo.pdf': '',
  'img.png': '',
  'notes/a.md': '# Alpha\nrelease notes draft\n```php\nUser::findOrFail($id);\n```\nplain text about #idea',
  'notes/sub/b.md': '## Beta\nrelease notes final',
  'archive/c.md': 'release notes from 2019 #idea',
  'code/x.php': '<?php\nUser::findOrFail(1);\n',
  'code/y.ts': 'export const release = () => findOrFail();\n',
  'fm.md': '---\ntags: [idea, work]\n---\nbody release',
};

// files whose body says "release"
const RELEASE = ['archive/c.md', 'code/y.ts', 'fm.md', 'notes/a.md', 'notes/sub/b.md'];

describe('filter audit: every filter, positive and negated', () => {
  const e = engineWith(FIX);
  const q = (s: string) => paths(e.search(s)).sort();

  it('path: — substring, glob, negation', () => {
    expect(q('release path:notes/')).toEqual(['notes/a.md', 'notes/sub/b.md']);
    expect(q('release path:notes -path:notes/sub')).toEqual(['notes/a.md']);
    expect(q('release path:**/b.md')).toEqual(['notes/sub/b.md']);
    expect(q('path:archive')).toEqual(['archive/c.md']);
    expect(q('-path:archive')).toEqual([]); // negated filter alone → no positive anchor
  });

  it('file: — base name, glob, negation; values are case-insensitive', () => {
    expect(q('release file:b.md')).toEqual(['notes/sub/b.md']);
    expect(q('release file:B.MD')).toEqual(['notes/sub/b.md']);
    expect(q('file:*.pdf')).toEqual(['notes/photo.pdf', 'report.pdf']);
    expect(q('release -file:a.md')).toEqual(RELEASE.filter((p) => p !== 'notes/a.md'));
  });

  it('ext: — dot variants, uppercase, comma lists, negation', () => {
    expect(q('ext:pdf')).toEqual(['notes/photo.pdf', 'report.pdf']);
    expect(q('ext:.pdf')).toEqual(['notes/photo.pdf', 'report.pdf']); // leading dot ok
    expect(q('ext:PDF')).toEqual(['notes/photo.pdf', 'report.pdf']); // value case-insensitive
    expect(q('ext:php')).toEqual(['code/x.php']);
    expect(q('ext:pdf,php')).toEqual(['code/x.php', 'notes/photo.pdf', 'report.pdf']);
    expect(q('-ext:pdf')).toEqual([]); // negated filter alone → no positive anchor
  });

  it('lang: — code files and Markdown fences; alias; negation; wider than ext:', () => {
    expect(q('findOrFail lang:php')).toEqual(['code/x.php', 'notes/a.md']); // code file + php fence
    expect(q('lang:PHP findOrFail')).toEqual(['code/x.php', 'notes/a.md']); // value case-insensitive
    expect(q('lang:ts findOrFail')).toEqual(['code/y.ts']); // alias of typescript
    expect(q('ext:php findOrFail')).toEqual(['code/x.php']); // ext: ignores the php fence in a.md
    expect(q('release lang:php')).toEqual([]); // "release" is in the body, not in any php fence
    expect(q('release -lang:php')).toEqual(RELEASE.filter((p) => p !== 'notes/a.md')); // a.md has a php fence
  });

  it('in: — context filter with aliases and negation; in:path is path-only', () => {
    expect(q('findOrFail in:code')).toEqual(['code/x.php', 'code/y.ts', 'notes/a.md']);
    expect(q('beta in:heading')).toEqual(['notes/sub/b.md']);
    expect(q('idea in:frontmatter')).toEqual(['fm.md']);
    expect(q('idea in:fm')).toEqual(['fm.md']); // alias
    expect(q('idea in:yaml')).toEqual(['fm.md']); // alias
    expect(q('idea in:meta')).toEqual(['fm.md']); // alias
    expect(q('release -in:heading')).toEqual(RELEASE); // no "release" sits in a heading
    expect(q('in:path report')).toEqual(['report.pdf']); // path-only match for a no-content file
  });

  it('tag: — inline #tag, frontmatter tags, negation', () => {
    expect(q('tag:idea')).toEqual(['archive/c.md', 'fm.md', 'notes/a.md']);
    expect(q('tag:#idea')).toEqual(['archive/c.md', 'fm.md', 'notes/a.md']); // leading # optional
    expect(q('tag:work')).toEqual(['fm.md']); // frontmatter tag
    expect(q('tag:nope')).toEqual([]);
    expect(q('-tag:idea')).toEqual([]); // negated filter alone → no positive anchor
  });

  it('case: — yes/no and the word aliases force the term case', () => {
    expect(q('case:yes ReleAse')).toEqual([]); // exact case: nothing spelled like that
    expect(q('case:sensitive ReleAse')).toEqual([]);
    expect(q('case:no ReleAse')).toEqual(RELEASE);
    expect(q('case:ignore ReleAse')).toEqual(RELEASE);
  });

  it('filters apply to filename-only matches too (a no-content file)', () => {
    expect(q('report ext:pdf')).toEqual(['report.pdf']); // name match kept by the ext filter
    expect(q('report -ext:pdf')).toEqual([]); // negated ext drops it even though it matched by name
    expect(q('report -file:report.pdf')).toEqual([]);
  });
});

describe('-exclude semantics (intended, documented)', () => {
  const e = engineWith({
    'foo.md': 'foo and bar together',
    'onlyfoo.md': 'just foo here',
    'cmd.md': 'run find . -name "*.md" now\n',
    'lit.md': 'the literal -foo token appears\n',
  });

  it('a lone `-x` is a literal, not "everything except x"', () => {
    expect(parseQuery('-foo').clauses[0]).toMatchObject({ negated: false });
    expect(paths(e.search('-foo'))).toEqual(['lit.md']); // searched for the text "-foo"
  });

  it('a short `-word` (<= 3 letters) is read as a CLI flag, so it is a literal term too', () => {
    // This is why `foo -bar` finds nothing: it means foo AND the literal text "-bar".
    expect(parseQuery('foo -bar').clauses.map((c) => c.negated)).toEqual([false, false]);
    expect(paths(e.search('foo -bar'))).toEqual([]);
  });

  it('quote it (`-"bar"`) or use 4+ letters to make a real exclusion', () => {
    expect(parseQuery('foo -"bar"').clauses[1].negated).toBe(true);
    // onlyfoo.md (foo, no bar) is kept; foo.md (foo + bar) is dropped. lit.md has "foo" in "-foo", no bar.
    expect(paths(e.search('foo -"bar"')).sort()).toEqual(['lit.md', 'onlyfoo.md']);
    // foo.md (foo + together) is dropped; onlyfoo.md and lit.md (foo in "-foo", no "together") stay.
    expect(paths(e.search('foo -together')).sort()).toEqual(['lit.md', 'onlyfoo.md']);
  });

  it('`\\-x` escapes to a literal term', () => {
    expect(parseQuery('\\-foo').clauses[0]).toMatchObject({ negated: false, atoms: [{ value: '-foo' }] });
    expect(paths(e.search('\\-foo'))).toEqual(['lit.md']);
  });

  it('a real exclusion drops a doc that has the word, unless the whole query appears verbatim', () => {
    const ee = engineWith({ both: 'alpha beta', only: 'alpha alone' });
    expect(paths(ee.search('alpha -beta'))).toEqual(['only']);
    expect(paths(e.search('find . -name "*.md"'))).toEqual(['cmd.md']); // verbatim rescue keeps it
  });

  it('a real exclusion ALSO hides a file whose name / path matches (CONTRACT CHANGE)', () => {
    // Was: "a negated term matches CONTENT only, never the file name". Now an exclusion hides a
    // matching name / path too — `report -"secret"` drops `secret-report.pdf` (name) and a file under
    // a `secret/` folder (path), keeping only the clean one.
    const ee = engineWith({ 'secret-report.pdf': '', 'report.md': 'a clean report', 'notes/secret/x.md': 'report under a secret folder' });
    expect(paths(ee.search('report -"secret"')).sort()).toEqual(['report.md']);
    // A folder name in the path counts too (symmetric with how a positive term matches paths).
    expect(paths(ee.search('report')).sort()).toEqual(['notes/secret/x.md', 'report.md', 'secret-report.pdf']);
  });

  it('a literal short `-bar` is NOT an exclusion, so it never hides a matching name', () => {
    // -bar is a CLI-flag literal (alpha AND the literal text "-bar"), not an exclusion: bar.md's name is untouched.
    const ee = engineWith({ 'bar.md': 'alpha bar', 'alpha.md': 'alpha' });
    expect(paths(ee.search('alpha -bar'))).toEqual([]); // [] proves -bar is literal (an exclusion would leave alpha.md)
    // The literal-flag rule is untouched, but a 4+ letter exclusion DOES hide a name with no content hit.
    const ff = engineWith({ 'secret.md': 'alpha here', 'plain.md': 'alpha there' }); // "secret" only in the name
    expect(paths(ff.search('alpha -"secret"'))).toEqual(['plain.md']); // secret.md hidden by its name
  });
});

describe('a no-content file is findable by name/path/ext but not by content', () => {
  const e = engineWith({ 'report.pdf': '', 'notes/a.md': 'budget report for the quarter' });

  it('name / path / ext filters reach it', () => {
    expect(paths(e.search('ext:pdf'))).toEqual(['report.pdf']);
    expect(paths(e.search('file:report'))).toEqual(['report.pdf']);
    expect(paths(e.search('report')).sort()).toEqual(['notes/a.md', 'report.pdf']); // name hit + content hit
  });

  it('a content term that is not in its name does NOT match it', () => {
    expect(paths(e.search('budget'))).toEqual(['notes/a.md']); // the pdf has no content to match
  });
});
