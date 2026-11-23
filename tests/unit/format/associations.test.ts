// File type associations (setting `files.associations`): pattern rules, the one resolution every consumer
// uses (languageForPath), hostile / hand-edited stored values, and the consumers that key off the language.
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ASSOCIATIONS, MAX_PATTERN, PatternTable, describePattern, isReservedName, parsePattern, patternForName, patternFromInput } from '../../../src/shared/associations';
import { associatedLanguage, associationMatcher, associationsVersion, cleanAssociations, formatterForPath, languageForPath, setFileAssociations, withAssociation } from '../../../src/shared/languages';
import { outline } from '../../../src/search/symbols';
import { parseStructure } from '../../../src/search/markdown';
import { SearchHost } from '../../../src/search/host';
import type { FromWorker } from '../../../src/search/protocol';

afterEach(() => void setFileAssociations(null));

const ok = (p: string) => ({ ok: true, pattern: p });
const id = (p: string) => languageForPath(p)?.id ?? null;

describe('patterns', () => {
  it('what you type: the leading dot is optional, case does not matter, a name with a dot is that file', () => {
    for (const t of ['ctp', '.ctp', '*.ctp', '  CTP ', '.Ctp', '*.CTP']) expect(patternFromInput(t), t).toEqual(ok('*.ctp'));
    expect(patternFromInput('.tpl.php')).toEqual(ok('*.tpl.php'));
    expect(patternFromInput('*.html.twig')).toEqual(ok('*.html.twig'));
    expect(patternFromInput('nginx.conf')).toEqual(ok('nginx.conf'));
    expect(patternFromInput('Dockerfile.*')).toEqual(ok('dockerfile.*'));
    expect(patternFromInput('.babelrc')).toEqual(ok('*.babelrc'));
    expect(patternFromInput('my file.tpl')).toEqual(ok('my file.tpl'));
  });

  it('refuses empty, folders, other wildcards, lists, control characters and over-long input', () => {
    const bad = ['', '   ', '.', '..', '*', '*.', '.*', '*.*', '**', '*.a*', 'a*b', '*a', 'a.*.b', 'src/*.ctp', 'a/b', 'a\\b', '..\\x', '/etc/passwd', 'a?', '[ab]', '{a,b}', '!x', 'ctp, tpl', 'a;b', 'a\u0000b', 'a\tb', 'a\nb', 'x.', '*.x.', '*..x', 'x..*', 'x'.repeat(MAX_PATTERN + 1)];
    for (const t of bad) expect(patternFromInput(t).ok, JSON.stringify(t)).toBe(false);
    for (const v of [null, undefined, 42, {}, [], true]) expect(parsePattern(v).ok).toBe(false);
    expect(patternFromInput('x'.repeat(MAX_PATTERN - 2)).ok).toBe(true);
  });

  it('never re-maps Markdown notes or files that open in a viewer', () => {
    for (const t of ['md', '.markdown', '*.mdx', 'readme.md', '*.notes.md', 'pdf', 'png', '*.svg', 'logo.jpeg']) expect(patternFromInput(t).ok, t).toBe(false);
    expect((patternFromInput('md') as { error: string }).error).toMatch(/Markdown notes/);
    expect((patternFromInput('png') as { error: string }).error).toMatch(/viewer/);
    expect(isReservedName('a.md')).toBe(true);
    expect(isReservedName('a.ctp')).toBe(false);
    expect(isReservedName('md')).toBe(false); // a file named "md" is not a note
  });

  it('stored patterns are strict: no shorthand (a bare word is that file name)', () => {
    expect(parsePattern('ctp')).toEqual(ok('ctp'));
    expect(parsePattern('Jenkinsfile')).toEqual(ok('jenkinsfile'));
    expect(parsePattern('.env.local')).toEqual(ok('.env.local'));
    expect(parsePattern(' *.CTP ')).toEqual(ok('*.ctp'));
  });

  it('describes a pattern and derives one from a file name', () => {
    expect(describePattern('*.ctp')).toBe('files ending in .ctp');
    expect(describePattern('dockerfile.*')).toBe('files starting with dockerfile.');
    expect(describePattern('jenkinsfile')).toBe('files named jenkinsfile');
    expect(patternForName('View.CTP')).toBe('*.ctp');
    expect(patternForName('x.blade.php')).toBe('*.php');
    expect(patternForName('Jenkinsfile')).toBe('jenkinsfile');
    expect(patternForName('.env')).toBe('.env');
    expect(patternForName('note.md')).toBeNull();
    expect(patternForName('scan.pdf')).toBeNull();
    expect(patternForName('odd.')).toBeNull();
    expect(patternForName('a\\b')).toBeNull();
  });

  it('table: whole name, then the longest suffix, then the longest prefix; the first value of a pattern stays', () => {
    const t = new PatternTable<string>();
    expect(t.match('a.ctp')).toBeUndefined();
    for (const [p, v] of [['*.php', 'ext'], ['*.tpl.php', 'compound'], ['index.tpl.php', 'name'], ['dockerfile.*', 'prefix'], ['dockerfile.dev.*', 'long-prefix'], ['*.dev', 'dev']] as const) expect(t.add(p, v)).toBe(true);
    expect(t.add('*.php', 'again')).toBe(false);
    expect(t.size).toBe(6);
    expect(t.match('a.php')).toBe('ext');
    expect(t.match('a.tpl.php')).toBe('compound');
    expect(t.match('index.tpl.php')).toBe('name');
    expect(t.match('dockerfile.prod')).toBe('prefix');
    expect(t.match('dockerfile.dev.local')).toBe('long-prefix');
    expect(t.match('dockerfile.dev')).toBe('dev'); // suffix before prefix
    expect(t.match('.php')).toBe('ext');
    expect(t.match('php')).toBeUndefined();
    expect(t.match('dockerfile')).toBeUndefined();
    expect(t.match('a.phpx')).toBeUndefined();
    expect(t.match('a.php.md')).toBeUndefined(); // reserved, whatever matches
  });

  it('a lookup stays cheap on a pathological name', () => {
    const t = new PatternTable<number>();
    t.add('*.z', 1);
    t.add('a.*', 2);
    const dots = '.'.repeat(200_000);
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      expect(t.match(dots + 'q')).toBeUndefined();
      expect(t.match('q' + dots)).toBeUndefined();
      expect(t.match(dots + 'z')).toBe(1);
    }
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('stored value (settings.json may be hand-edited or hostile)', () => {
  it('keeps valid rows, canonical: language ids and aliases, case-insensitive', () => {
    expect(cleanAssociations({ '*.ctp': 'php', '*.TPL': 'PHP', 'Jenkinsfile': 'rb', '*.conf': 'nginx', '*.rc': ' json ' })).toEqual([
      { pattern: '*.ctp', language: 'php' },
      { pattern: '*.tpl', language: 'php' },
      { pattern: 'jenkinsfile', language: 'ruby' },
      { pattern: '*.conf', language: 'nginx' },
      { pattern: '*.rc', language: 'json' },
    ]);
  });

  it('drops everything else without throwing', () => {
    for (const raw of [null, undefined, 0, 'x', true, [], [['*.ctp', 'php']], ['*.ctp'], new Map([['*.ctp', 'php']])]) expect(cleanAssociations(raw), String(raw)).toEqual([]);
    const raw = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":"php","*.a":null,"*.b":42,"*.c":["php"],"*.d":{"id":"php"},"*.e":"nope","*.f":"","src/*.g":"php","../x":"php","*.md":"php","*.png":"php","*.h":"' +
        'p'.repeat(500) +
        '","*.ok":"php","*.OK":"html"}',
    );
    expect(cleanAssociations(raw)).toEqual([
      { pattern: 'constructor', language: 'php' },
      { pattern: '*.ok', language: 'php' },
    ]);
    expect(({} as { polluted?: string }).polluted).toBeUndefined();
    expect(setFileAssociations(raw)).toBe(true);
    expect(id('a.ok')).toBe('php');
    expect(id('toString')).toBeNull();
    expect(id('hasOwnProperty')).toBeNull();
  });

  it('is capped: at most MAX_ASSOCIATIONS rows, and a huge object is not walked to the end', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 50_000; i++) many[`*.e${i}`] = 'php';
    const rows = cleanAssociations(many);
    expect(rows).toHaveLength(MAX_ASSOCIATIONS);
    expect(rows[0].pattern).toBe('*.e0');
    const junk: Record<string, unknown> = {};
    for (let i = 0; i < 50_000; i++) junk[`*.j${i}`] = 1;
    junk['*.late'] = 'php';
    expect(cleanAssociations(junk)).toEqual([]);
  });

  it('withAssociation edits in place, keeps rows it cannot read, and stores null when nothing is left', () => {
    const stored = { '*.a': 'php', '*.CTP': 'php', '*.z': 'language-of-a-newer-build', '*.b': 'html' };
    expect(withAssociation(stored, '*.ctp', 'html')).toEqual({ '*.a': 'php', '*.ctp': 'html', '*.z': 'language-of-a-newer-build', '*.b': 'html' });
    expect(Object.keys(withAssociation(stored, '*.ctp', 'html')!)).toEqual(['*.a', '*.ctp', '*.z', '*.b']);
    expect(withAssociation(stored, '*.new', 'json')).toEqual({ ...stored, '*.new': 'json' });
    expect(withAssociation(stored, '*.ctp', null)).toEqual({ '*.a': 'php', '*.z': 'language-of-a-newer-build', '*.b': 'html' });
    expect(withAssociation({ '*.ctp': 'php', '*.Ctp': 'html' }, '*.ctp', null)).toBeNull();
    expect(withAssociation(null, '*.ctp', null)).toBeNull();
    expect(withAssociation('junk', '*.ctp', 'php')).toEqual({ '*.ctp': 'php' });
    expect(withAssociation(JSON.parse('{"__proto__":{"x":1},"*.a":"php"}'), '*.b', 'php')).toEqual({ '*.a': 'php', '*.b': 'php' });
    expect(stored).toEqual({ '*.a': 'php', '*.CTP': 'php', '*.z': 'language-of-a-newer-build', '*.b': 'html' }); // never mutated
  });
});

describe('one resolution: languageForPath', () => {
  it('the user map first, then the built-in table', () => {
    expect(id('View/Users/index.ctp')).toBeNull();
    const v = associationsVersion();
    expect(setFileAssociations({ '*.ctp': 'php' })).toBe(true);
    expect(associationsVersion()).toBe(v + 1);
    expect(id('View/Users/index.ctp')).toBe('php');
    expect(id('VIEW/INDEX.CTP')).toBe('php');
    expect(associatedLanguage('a/b.ctp')?.name).toBe('PHP');
    expect(associatedLanguage('a/b.php')).toBeNull();
    // Built-ins are untouched …
    expect(id('a.php')).toBe('php');
    expect(id('x.blade.php')).toBe('blade');
    expect(id('Dockerfile')).toBe('dockerfile');
    expect(id('x.nope')).toBeNull();
    // … the same value again is no change …
    expect(setFileAssociations({ '*.CTP': 'PHP' })).toBe(false);
    expect(associationsVersion()).toBe(v + 1);
    // … and without the setting the built-in table decides again.
    expect(setFileAssociations(undefined)).toBe(true);
    expect(id('index.ctp')).toBeNull();
  });

  it('a mapping beats a built-in extension; whole names, compound extensions and prefixes work', () => {
    setFileAssociations({ '*.inc': 'html', '*.php': 'text', '*.blade.php': 'blade', 'jenkinsfile': 'ruby', 'dockerfile.*': 'dockerfile', '*.tpl.php': 'html', '.env.local': 'ini' });
    expect(id('a.inc')).toBe('html');
    expect(id('a.php')).toBe('text');
    expect(id('x.blade.php')).toBe('blade');
    expect(id('x.tpl.php')).toBe('html');
    expect(id('ci/Jenkinsfile')).toBe('ruby');
    expect(id('Dockerfile.dev')).toBe('dockerfile');
    expect(id('Dockerfile')).toBe('dockerfile');
    expect(id('.env.local')).toBe('ini');
    expect(id('a.phtml')).toBe('php');
  });

  it('Markdown notes and viewer files keep their type whatever the stored value says', () => {
    setFileAssociations({ '*.md': 'php', 'readme.*': 'php', 'logo.*': 'php', '*.ctp': 'php' });
    expect(id('notes/a.md')).toBe('markdown');
    expect(id('README.md')).toBe('markdown');
    expect(id('readme.txt')).toBe('php');
    expect(id('logo.png')).toBeNull();
    expect(id('logo.svg')).toBe('xml'); // the built-in answer
  });

  it('associationMatcher answers over a stored value without installing it', () => {
    const stored = { '*.ctp': 'php' };
    const m = associationMatcher(stored);
    expect(m('a/B.CTP')?.id).toBe('php');
    expect(m('a.php')).toBeNull();
    expect(associationMatcher(stored)).toBe(m);
    expect(id('a.ctp')).toBeNull();
    for (const raw of [null, undefined, 'x', []]) expect(associationMatcher(raw)('a.ctp')).toBeNull();
  });
});

describe('consumers follow the mapping', () => {
  const PHP = '<?php\nclass UsersController {\n  public function index() {}\n}\n';

  it('formatter, outline and the search structure of a mapped file are its language', () => {
    const SH = 'deploy() {\n  echo hi\n}\nfunction build-all {\n}\n';
    const names = (path: string, text: string) => outline(path, text).map((o) => `${o.text}:${o.detail}`);
    expect(formatterForPath('index.ctp')).toBeNull();
    expect(parseStructure('index.ctp', PHP).mode).toBe('text');
    expect(names('deploy.task', SH)).toEqual(['build:function']); // the generic scan
    setFileAssociations({ '*.ctp': 'php', '*.task': 'shell' });
    expect(formatterForPath('index.ctp')).toMatchObject({ parser: 'php', plugin: 'php' });
    expect(names('index.ctp', PHP)).toEqual(names('index.php', PHP));
    expect(names('deploy.task', SH)).toEqual(['deploy:function', 'build-all:function']);
    expect(parseStructure('index.ctp', PHP)).toMatchObject({ mode: 'code', fileLang: 'php' });
    setFileAssociations({ '*.ctp': 'text' });
    expect(parseStructure('index.ctp', PHP).mode).toBe('text');
    expect(formatterForPath('index.ctp')).toBeNull();
  });

  it('a search shard takes the associations as a message: lang: filter and symbol index', async () => {
    const out: FromWorker[] = [];
    const host = new SearchHost((m) => out.push(m), () => new Promise((r) => setTimeout(r, 0)));
    const docs = [{ path: 'View/index.ctp', content: PHP }];
    const defs = (n: number) => {
      host.handle({ type: 'defs', id: n, q: { names: ['UsersController'] } });
      return (out.find((m) => m.type === 'defs' && m.id === n) as Extract<FromWorker, { type: 'defs' }>).hits.map((h) => `${h.path}:${h.lang}`);
    };
    host.handle({ type: 'reset', gen: 1, docs });
    expect(defs(1)).toEqual([]);
    host.handle({ type: 'fileTypes', assoc: { '*.ctp': 'php' } });
    host.handle({ type: 'reset', gen: 2, docs });
    expect(defs(2)).toEqual(['View/index.ctp:php']);
    expect(host.engine.search('lang:php UsersController', {}).results.map((r) => r.path)).toEqual(['View/index.ctp']);
    host.handle({ type: 'fileTypes', assoc: null });
    host.handle({ type: 'reset', gen: 3, docs });
    expect(defs(3)).toEqual([]);
    expect(out.some((m) => m.type === 'error')).toBe(false);
  });
});
