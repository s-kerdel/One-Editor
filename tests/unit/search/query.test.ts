import { describe, expect, it } from 'vitest';
import { describeQuery, highlightPattern, parseQuery, type TextAtom } from '../../../src/search/query';

const terms = (q: string) => parseQuery(q).clauses.map((c) => (c.negated ? '-' : '') + c.atoms.map((a) => (a.kind === 'regex' ? `/${a.source}/` : (a as TextAtom).quoted ? `"${a.value}"` : a.value)).join('|'));

describe('query parser', () => {
  it('keeps punctuation-heavy commands literal', () => {
    expect(terms('git push --force-with-lease')).toEqual(['git', 'push', '--force-with-lease']);
    expect(terms('php artisan migrate:fresh --seed')).toEqual(['php', 'artisan', 'migrate:fresh', '--seed']);
    expect(terms('$this->render()')).toEqual(['$this->render()']);
    expect(terms('User::query()')).toEqual(['User::query()']);
    expect(terms('C:\\Users\\x')).toEqual(['C:\\Users\\x']);
    expect(terms('🚀 naïve')).toEqual(['🚀', 'naïve']);
  });

  it('treats short flags, numbers and key=value as literal, not exclusions', () => {
    expect(terms('kubectl get pods -o wide')).toEqual(['kubectl', 'get', 'pods', '-o', 'wide']);
    expect(terms('rm -rf node_modules')).toEqual(['rm', '-rf', 'node_modules']);
    expect(terms('tar -xvf a.tgz')).toEqual(['tar', '-xvf', 'a.tgz']);
    expect(terms('head -10 file')).toEqual(['head', '-10', 'file']);
    expect(terms('java -Dfoo=bar')).toEqual(['java', '-Dfoo=bar']);
    expect(terms('java -Xmx2g')).toEqual(['java', '-Xmx2g']);
  });

  it('parses exclusions, phrases, OR and escapes', () => {
    expect(terms('release -draft')).toEqual(['release', '-draft']);
    expect(terms('"needle in a" haystack')).toEqual(['"needle in a"', 'haystack']);
    expect(terms('kubectl OR docker compose')).toEqual(['kubectl|docker', 'compose']);
    expect(terms('a -"b c"')).toEqual(['a', '-"b c"']);
    expect(terms('\\-draft')).toEqual(['-draft']);
    expect(terms('"unterminated phrase')).toEqual(['"unterminated phrase"']);
    // lone exclusion = literal (nothing else to search for)
    expect(terms('-draft')).toEqual(['-draft']);
    // OR at the edges is a literal word
    expect(terms('OR')).toEqual(['OR']);
  });

  it('parses regex literals with flags; paths are not regexes', () => {
    const pq = parseQuery('/push\\s+--\\w+/i');
    expect(pq.clauses[0].atoms[0]).toMatchObject({ kind: 'regex', source: 'push\\s+--\\w+', caseSensitive: false });
    expect(terms('/etc/hosts')).toEqual(['/etc/hosts']);
    expect(terms('/foo/bar')).toEqual(['/foo/bar']);
    expect(terms('/a b/ c')).toEqual(['/a b/', 'c']);
  });

  it('reports invalid regex as an error message', () => {
    const pq = parseQuery('/(unclosed/');
    expect(pq.error).toMatch(/^Invalid regular expression: .*(group|parenthes)/i);
    expect(parseQuery('[a-', { regex: true }).error).toMatch(/Invalid regular expression/);
  });

  it('parses filters (only known keys), including quoted and negated values', () => {
    const pq = parseQuery('lang:php path:"my notes/" -path:archive ext:md,php in:code tag:#idea case:yes findOrFail');
    expect(pq.filters).toEqual([
      { key: 'lang', value: 'php', negated: false },
      { key: 'path', value: 'my notes/', negated: false },
      { key: 'path', value: 'archive', negated: true },
      { key: 'ext', value: 'md,php', negated: false },
      { key: 'in', value: 'code', negated: false },
      { key: 'tag', value: '#idea', negated: false },
      { key: 'case', value: 'yes', negated: false },
    ]);
    expect(terms('lang:php findOrFail')).toEqual(['findOrFail']);
    expect(pq.forcedCase).toBe(true);
    // not filters: unknown keys, URLs, incomplete
    expect(terms('migrate:fresh http://x file://c/d')).toEqual(['migrate:fresh', 'http://x', 'file://c/d']);
    expect(parseQuery('path: foo').filters).toEqual([]);
    expect(parseQuery('in:bogus x').warnings[0]).toMatch(/Unknown in:bogus/);
  });

  it('applies smart case per term, overridable', () => {
    const pq = parseQuery('User findorfail');
    expect(pq.clauses.map((c) => (c.atoms[0] as TextAtom).caseSensitive)).toEqual([true, false]);
    expect((parseQuery('user', { caseSensitive: true }).clauses[0].atoms[0] as TextAtom).caseSensitive).toBe(true);
    expect((parseQuery('User', { caseSensitive: false }).clauses[0].atoms[0] as TextAtom).caseSensitive).toBe(false);
    expect((parseQuery('User case:no').clauses[0].atoms[0] as TextAtom).caseSensitive).toBe(false);
    // regex smart case ignores escapes like \W \S
    expect(parseQuery('/\\Sfoo\\W/').clauses[0].atoms[0].caseSensitive).toBe(false);
    expect(parseQuery('/Foo/').clauses[0].atoms[0].caseSensitive).toBe(true);
  });

  it('regex and literal modes keep the whole text as one pattern but still extract filters', () => {
    const r = parseQuery('foo\\s+bar ext:md', { regex: true });
    expect(r.clauses).toHaveLength(1);
    expect(r.clauses[0].atoms[0]).toMatchObject({ kind: 'regex', source: 'foo\\s+bar' });
    expect(r.filters).toEqual([{ key: 'ext', value: 'md', negated: false }]);
    const l = parseQuery('kubectl get pods -o "wide" path:notes', { literal: true });
    expect(l.clauses[0].atoms[0]).toMatchObject({ kind: 'text', value: 'kubectl get pods -o "wide"' });
    expect(l.filters[0]).toMatchObject({ key: 'path', value: 'notes' });
  });

  it('describes the parsed query and builds an editor highlight pattern', () => {
    const pq = parseQuery('a OR b -cats "d e" ext:md');
    expect(describeQuery(pq).map((c) => `${c.kind}:${c.label}`)).toEqual(['or:a OR b', 'exclude:cats', 'phrase:"d e"', 'filter:ext:md']);
    expect(highlightPattern(parseQuery('--force'))).toEqual({ search: '--force', regexp: false, caseSensitive: false });
    expect(highlightPattern(parseQuery('a.b c'))).toEqual({ search: 'a\\.b|c', regexp: true, caseSensitive: false });
    expect(pq.hasOperators).toBe(true);
    expect(parseQuery('plain words').hasOperators).toBe(false);
  });
});
