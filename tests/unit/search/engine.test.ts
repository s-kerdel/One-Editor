import { describe, expect, it } from 'vitest';
import { SearchEngine } from '../../../src/search/engine';
import { engineWith, fixtureDocs, hitTexts, paths, rows } from './helpers';

const NOTES = {
  'cmds.md': [
    '# Shell & code snippets',
    '',
    '```bash',
    'git push --force-with-lease origin main',
    'php artisan migrate:fresh --seed',
    'kubectl get pods -o wide',
    'Get-ChildItem C:\\Users\\x -Recurse',
    '```',
    '',
    'Inline `$this->render()` and `User::query()->where("a", 1)`; also `array_map($fn, $xs)`.',
    'Deploy 🚀 and stay naïve about café culture.',
  ].join('\n'),
  'other.md': 'Nothing about git here, just forcing a lease on an apartment.',
};

describe('exact matching of written commands (punctuation and all)', () => {
  const e = engineWith(NOTES);
  const cases: Array<[string, string]> = [
    ['--force-with-lease', '--force-with-lease'],
    ['$this->render()', '$this->render()'],
    ['User::query()', 'User::query()'],
    ['migrate:fresh --seed', 'migrate:fresh --seed'],
    ['array_map', 'array_map'],
    ['C:\\Users\\x', 'C:\\Users\\x'],
    ['🚀', '🚀'],
    ['naïve', 'naïve'],
    ['-Recurse', '-Recurse'],
    ['->where("a", 1)', '->where("a", 1)'],
  ];
  for (const [q, hit] of cases) {
    it(`finds ${q}`, () => {
      const r = e.search(q);
      expect(r.error).toBeUndefined();
      expect(paths(r)).toEqual(['cmds.md']);
      expect(hitTexts(r)).toContain(hit);
      expect(r.fuzzy).toBeUndefined();
    });
  }

  it('multi-term commands match on the same line with every term highlighted', () => {
    const r = e.search('php artisan migrate:fresh --seed');
    expect(paths(r)).toEqual(['cmds.md']);
    const m = r.results[0].matches[0];
    expect(m.lineText).toBe('php artisan migrate:fresh --seed');
    // verbatim occurrence → one continuous highlight
    expect(m.ranges!.map((x) => m.lineText.slice(x.start, x.end))).toEqual(['php artisan migrate:fresh --seed']);
    // scattered terms → each highlighted separately
    const s = e.search('kubectl wide git');
    expect(hitTexts(s)).toEqual(['git', 'kubectl', 'wide']);
    const k = e.search('kubectl get pods -o wide');
    expect(k.results[0].matches[0].lineText).toBe('kubectl get pods -o wide');
  });

  it('does not tokenize away punctuation: --force-with-lease never matches plain words', () => {
    expect(paths(e.search('--force-with-lease'))).toEqual(['cmds.md']);
    // plain words still match as substrings (other.md has "forcing", not "force")
    expect(paths(e.search('force with lease'))).toEqual(['cmds.md']);
  });

  it('classifies hits: fenced code (with fence lang), inline code, heading, text', () => {
    expect(rows(e.search('--force-with-lease'))).toEqual(['cmds.md:3:code/bash:--force-with-lease']);
    expect(rows(e.search('$this->render()'))).toEqual(['cmds.md:9:inline-code:$this->render()']);
    expect(rows(e.search('snippets'))).toEqual(['cmds.md:0:heading:snippets']);
    expect(e.search('snippets').results[0].matches[0].headingLevel).toBe(1);
    expect(rows(e.search('café'))).toEqual(['cmds.md:10:text:café']);
  });
});

describe('fixture workspace', () => {
  const e = engineWith(fixtureDocs());

  it('--force-with-lease is a bash code hit in README.md', () => {
    const r = e.search('--force-with-lease');
    expect(rows(r)).toEqual(['README.md:10:code/bash:--force-with-lease']);
    expect(r.results[0].matches[0]).toMatchObject({ col: 9, length: 18 });
  });

  it('lang:php findOrFail finds the PHP controller', () => {
    expect(rows(e.search('lang:php findOrFail'))).toEqual(['code/UserController.php:6:code/php:findOrFail']);
  });

  it('code files are classified as code with their language', () => {
    expect(rows(e.search('User::query()'))).toEqual(['code/UserController.php:4:code/php:User::query()']);
    expect(rows(e.search('left join'))[0]).toBe('code/query.sql:0:code/sql:left join');
  });

  it('frontmatter, link and tag contexts', () => {
    expect(rows(e.search('journal'))).toEqual(['notes/Daily notes.md:2:frontmatter:journal']);
    expect(rows(e.search('in:link example.com'))).toEqual(['README.md:5:link:example.com']);
    expect(paths(e.search('tag:journal'))).toEqual(['notes/Daily notes.md']);
    expect(paths(e.search('tag:tag'))).toEqual(['README.md']); // #tag/project matches parent tag
    expect(paths(e.search('tag:tag/project'))).toEqual(['README.md']);
    expect(paths(e.search('tag:nope'))).toEqual([]);
  });

  it('CRLF files are LF-normalised and still searchable', () => {
    expect(rows(e.search('two with CRLF'))).toEqual(['notes/windows-crlf.md:1:text:two with CRLF']);
    expect(rows(e.search('/CRLF$/'))).toEqual(['notes/windows-crlf.md:1:text:CRLF']);
  });

  it('filename hit beats a body mention', () => {
    const r = e.search('kubernetes');
    expect(paths(r)).toEqual(['notes/kubernetes.md', 'deep/nested/folder/Deep note.md']);
    expect(r.results[0].score).toBeGreaterThan(r.results[1].score * 1.5);
    expect(r.results[0].pathRanges).toEqual([{ start: 6, end: 16 }]);
  });

  it('few exact hits + a much more common spelling → suggestion', () => {
    const docs: Record<string, string> = { 'typo.md': 'I typed kubctl once' };
    for (let i = 0; i < 6; i++) docs[`k${i}.md`] = `kubectl get pods ${i}`;
    const r = engineWith(docs).search('kubctl');
    expect(paths(r)).toEqual(['typo.md']);
    expect(r.fuzzy).toBeUndefined();
    expect(r.suggestions).toEqual([{ from: 'kubctl', to: 'kubectl' }]);
  });

  it('fuzzy typo fallback: kubctl → kubectl, artsan → artisan (flagged)', () => {
    const k = e.search('kubctl');
    expect(k.fuzzy).toBe(true);
    expect(k.corrections).toEqual([{ from: 'kubctl', to: ['kubectl'] }]);
    expect(paths(k)).toEqual(['notes/kubernetes.md']);
    expect(k.results.every((r) => r.fuzzy)).toBe(true);
    const a = e.search('php artsan');
    expect(a.fuzzy).toBe(true);
    expect(rows(a)[0]).toBe('README.md:11:code/bash:php');
    expect(e.search('kubctl', { fuzzy: false }).results).toEqual([]);
  });
});

describe('operators and filters', () => {
  const e = engineWith({
    'notes/a.md': '# Alpha\nrelease notes draft\n\n```php\n$user = User::findOrFail($id);\n```\n',
    'notes/b.md': '## Beta\nrelease notes final\nkubectl rollout restart deployment/web\n',
    'archive/c.md': 'release notes from 2019\n`findOrFail` inline',
    'code/x.php': '<?php\nUser::findOrFail(1);\n',
    'code/y.ts': 'export const release = () => findOrFail();\n',
    'find.md': 'Run `find . -name "*.md"` to list notes.\n',
  });

  it('AND of terms in any order, anywhere in the file', () => {
    expect(paths(e.search('notes release')).sort()).toEqual(['archive/c.md', 'notes/a.md', 'notes/b.md']);
    expect(paths(e.search('final release'))).toEqual(['notes/b.md']);
  });

  it('"exact phrase", -exclude, OR', () => {
    expect(paths(e.search('"notes final"'))).toEqual(['notes/b.md']);
    expect(paths(e.search('release -draft -from')).sort()).toEqual(['code/y.ts', 'notes/b.md']);
    expect(paths(e.search('release -10'))).toEqual([]); // -10 is a literal (like `head -10`)
    expect(paths(e.search('draft OR final')).sort()).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('verbatim rescue: an exact command is found even if a token looks like an exclusion', () => {
    expect(paths(e.search('find . -name "*.md"'))).toEqual(['find.md']);
  });

  it('/regex/ with flags and smart case', () => {
    expect(hitTexts(e.search('/rollout\\s+\\w+/'))).toEqual(['rollout restart']);
    expect(paths(e.search('/^## \\w+/'))).toEqual(['notes/b.md']); // multiline anchors
    expect(paths(e.search('/BETA/i'))).toEqual(['notes/b.md']);
    expect(paths(e.search('/BETA/'))).toEqual([]);
    const bad = e.search('/(oops/');
    expect(bad.error).toMatch(/Invalid regular expression/);
    expect(bad.results).toEqual([]);
  });

  it('regex toggle treats the whole query as one regex', () => {
    expect(paths(e.search('User::\\w+\\(\\$id\\)', { regex: true }))).toEqual(['notes/a.md']);
    expect(e.search('[unclosed', { regex: true }).error).toMatch(/Invalid regular expression/);
  });

  it('path: file: ext: filters (substring and glob, negatable)', () => {
    expect(paths(e.search('release path:notes/')).sort()).toEqual(['notes/a.md', 'notes/b.md']);
    expect(paths(e.search('release -path:archive')).sort()).toEqual(['code/y.ts', 'notes/a.md', 'notes/b.md']);
    expect(paths(e.search('release path:**/*.md')).sort()).toEqual(['archive/c.md', 'notes/a.md', 'notes/b.md']);
    expect(paths(e.search('findOrFail ext:php'))).toEqual(['code/x.php']);
    expect(paths(e.search('findOrFail ext:php,ts')).sort()).toEqual(['code/x.php', 'code/y.ts']);
    expect(paths(e.search('release file:b.md'))).toEqual(['notes/b.md']);
  });

  it('lang: matches code files of that language OR fenced blocks of it (only hits inside the fence)', () => {
    expect(paths(e.search('findOrFail lang:php')).sort()).toEqual(['code/x.php', 'notes/a.md']);
    expect(rows(e.search('lang:php User'))).toContain('notes/a.md:4:code/php:User');
    expect(paths(e.search('lang:typescript findOrFail'))).toEqual(['code/y.ts']);
    expect(paths(e.search('lang:ts findOrFail'))).toEqual(['code/y.ts']); // alias
  });

  it('in:code / in:text / in:heading / -in:', () => {
    expect(paths(e.search('findOrFail in:code')).sort()).toEqual(['archive/c.md', 'code/x.php', 'code/y.ts', 'notes/a.md']);
    expect(rows(e.search('findOrFail in:inline'))).toEqual(['archive/c.md:1:inline-code:findOrFail']);
    expect(paths(e.search('beta in:heading'))).toEqual(['notes/b.md']);
    expect(paths(e.search('release in:text')).sort()).toEqual(['archive/c.md', 'notes/a.md', 'notes/b.md']);
    expect(paths(e.search('findOrFail -in:code'))).toEqual([]);
  });

  it('filter-only queries list files', () => {
    expect(paths(e.search('ext:php'))).toEqual(['code/x.php']);
    expect(e.search('in:code').results).toEqual([]); // needs a term
  });
});

describe('case and diacritics', () => {
  const e = engineWith({ 'a.md': 'Naïve café. NAIVE shout. naive plain. User user', 'b.md': 'decomposed nai\u0308ve here' });

  it('smart case: lowercase is insensitive, uppercase is sensitive', () => {
    expect(hitTexts(e.search('user'))).toEqual(['User', 'user']);
    expect(hitTexts(e.search('User'))).toEqual(['User']);
    expect(hitTexts(e.search('user', { caseSensitive: true }))).toEqual(['user']);
    expect(hitTexts(e.search('User case:no'))).toEqual(['User', 'user']);
  });

  it('diacritic folding: naive finds naïve (also decomposed), naïve stays exact', () => {
    const r = e.search('naive');
    expect(hitTexts(r)).toEqual(['Naïve', 'NAIVE', 'naive', 'nai\u0308ve']);
    expect(hitTexts(e.search('naïve'))).toEqual(['Naïve']);
    expect(hitTexts(e.search('cafe'))).toEqual(['café']);
    expect(hitTexts(e.search('naive', { diacritics: false }))).toEqual(['NAIVE', 'naive']);
  });
});

describe('whole word', () => {
  const e = engineWith({ 'a.md': 'map array_map mapping\ngit push --force-with-lease\n' });
  it('respects word boundaries but keeps punctuation-led terms working', () => {
    expect(hitTexts(e.search('map', { wholeWord: true }))).toEqual(['map']);
    expect(hitTexts(e.search('--force', { wholeWord: true }))).toEqual(['--force']);
    expect(hitTexts(e.search('lease', { wholeWord: true }))).toEqual(['lease']);
  });
});

describe('ranking', () => {
  it('same-line proximity beats scattered terms; stable tie-break by path', () => {
    const e = engineWith({
      'far.md': 'kubectl is a tool.\n' + 'lorem ipsum\n'.repeat(30) + 'and pods are things.',
      'near.md': 'notes\nkubectl get pods\n' + 'lorem ipsum\n'.repeat(30),
    });
    expect(paths(e.search('kubectl pods'))).toEqual(['near.md', 'far.md']);
    const t = engineWith({ 'b.md': 'same text', 'a.md': 'same text' });
    expect(paths(t.search('same'))).toEqual(['a.md', 'b.md']);
  });

  it('heading hits outrank body hits', () => {
    const e = engineWith({ 'body.md': 'intro\n\nwe talk about deployment here', 'head.md': '## Deployment\n\nsteps' });
    expect(paths(e.search('deployment'))[0]).toBe('head.md');
  });

  it('exact file name beats content-only mentions', () => {
    const e = engineWith({ 'notes/docker.md': '# Containers\nsome text', 'misc.md': 'docker docker docker docker in text' });
    expect(paths(e.search('docker'))[0]).toBe('notes/docker.md');
  });
});

describe('incremental index', () => {
  it('upsert / update / remove / rename are reflected immediately', () => {
    const e = new SearchEngine();
    e.upsert({ path: 'a.md', content: 'hello world' });
    expect(paths(e.search('hello'))).toEqual(['a.md']);
    e.upsert({ path: 'a.md', content: 'goodbye world' });
    expect(paths(e.search('hello'))).toEqual([]);
    expect(paths(e.search('goodbye'))).toEqual(['a.md']);
    e.rename('a.md', 'dir/b.md');
    expect(paths(e.search('goodbye'))).toEqual(['dir/b.md']);
    e.upsert({ path: 'dir/c.md', content: 'goodbye too' });
    e.rename('dir', 'other');
    expect(paths(e.search('goodbye')).sort()).toEqual(['other/b.md', 'other/c.md']);
    e.remove('other/b.md');
    expect(paths(e.search('goodbye'))).toEqual(['other/c.md']);
    expect(e.size).toBe(1);
  });

  it('vocabulary follows updates (typo suggestions disappear with the word)', () => {
    const e = engineWith({ 'a.md': 'kubectl' });
    expect(e.search('kubctl').fuzzy).toBe(true);
    e.upsert({ path: 'a.md', content: 'nothing' });
    expect(e.search('kubctl').results).toEqual([]);
  });
});

describe('unicode + long lines', () => {
  it('reports correct offsets around emoji and astral chars', () => {
    const e = engineWith({ 'u.md': '🚀🚀 launch `npm run build` 👍' });
    const m = e.search('npm run build').results[0].matches[0];
    expect(m.lineText.slice(m.start, m.end)).toBe('npm run build');
    expect(m.col).toBe(13); // UTF-16 offset: 2 surrogate pairs (4) + " launch `" (9)
    expect(m.context).toBe('inline-code');
    expect(e.search('👍').results[0].matches[0].context).toBe('text');
  });

  it('windows long lines around the hit', () => {
    const e = engineWith({ 'min.js': 'x'.repeat(5000) + 'NEEDLE' + 'y'.repeat(5000) });
    const m = e.search('NEEDLE').results[0].matches[0];
    expect(m.lineText.length).toBeLessThanOrEqual(400);
    expect(m.lineText.slice(m.start, m.end)).toBe('NEEDLE');
    expect(m.col).toBe(5000);
    expect((m.lineTextOffset ?? 0) + m.start).toBe(5000);
  });

  it('caps rows per file but counts all hits', () => {
    const e = engineWith({ 'many.md': Array.from({ length: 500 }, (_, i) => `line ${i} todo`).join('\n') });
    const r = e.search('todo', { maxMatchesPerFile: 20 });
    expect(r.results[0].matches).toHaveLength(20);
    expect(r.results[0].totalMatches).toBe(500);
    expect(r.totalMatches).toBe(500);
  });
});

describe('headings index', () => {
  it('fuzzy-searches headings across files and within a file query', () => {
    const e = engineWith(fixtureDocs());
    const h = e.headings('cheat');
    expect(h[0]).toMatchObject({ path: 'notes/kubernetes.md', text: 'Kubernetes cheatsheet', level: 1, line: 0 });
    expect(e.headings('', { fileQuery: 'readme' }).map((x) => x.text)).toEqual(['Welcome', 'Commands']);
  });
});
