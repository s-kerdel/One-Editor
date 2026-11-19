import { describe, expect, it } from 'vitest';
import { applyEdits, expandReplacement, planReplace, previewLine } from '../../../src/search/replace';

describe('replace', () => {
  it('expands $1, $&, $<name>, $$, \\n and case modifiers', () => {
    const m = /(?<k>\w+)=(\w+)/.exec('key=value')!;
    expect(expandReplacement('$2=$1', m)).toBe('value=key');
    expect(expandReplacement('[$&]', m)).toBe('[key=value]');
    expect(expandReplacement('$<k>!', m)).toBe('key!');
    expect(expandReplacement('$$1 $9', m)).toBe('$1 $9');
    expect(expandReplacement('a\\nb\\t', m)).toBe('a\nb\t');
    expect(expandReplacement('\\U$1\\E-\\u$2', m)).toBe('KEY-Value');
  });

  it('literal mode replaces the exact text (punctuation, $ kept verbatim)', () => {
    const c = 'git push --force origin\ngit push --force-with-lease\n';
    const p = planReplace('a.md', c, '--force ', { caseSensitive: 'smart' }, '--force-with-lease ');
    expect(applyEdits(c, p.edits)).toBe('git push --force-with-lease origin\ngit push --force-with-lease\n');
    const d = planReplace('a.md', 'cost $5', '$5', {}, '$1');
    expect(applyEdits('cost $5', d.edits)).toBe('cost $1');
  });

  it('regex mode with capture groups', () => {
    const c = 'User::find(1)\nUser::find(2)\nPost::find(3)\n';
    const p = planReplace('a.php', c, '(\\w+)::find\\((\\d+)\\)', { regex: true }, '$1::findOrFail($2)');
    expect(applyEdits(c, p.edits)).toBe('User::findOrFail(1)\nUser::findOrFail(2)\nPost::findOrFail(3)\n');
    expect(planReplace('a', 'x', '(', { regex: true }, '').error).toMatch(/Invalid regular expression/);
  });

  it('respects line restriction, case, whole word and filters', () => {
    const c = 'foo\nfoo\nFoo food\n';
    expect(applyEdits(c, planReplace('a.md', c, 'foo', {}, 'bar', [1]).edits)).toBe('foo\nbar\nFoo food\n');
    expect(applyEdits(c, planReplace('a.md', c, 'foo', { wholeWord: true }, 'bar').edits)).toBe('bar\nbar\nbar food\n');
    expect(applyEdits(c, planReplace('a.md', c, 'Foo', {}, 'X').edits)).toBe('foo\nfoo\nX food\n');
    expect(planReplace('a.md', c, 'foo ext:php', {}, 'X').edits).toEqual([]);
    const md = 'run `npm test` then npm test\n';
    expect(applyEdits(md, planReplace('a.md', md, 'npm test in:code', {}, 'pnpm test').edits)).toBe('run `pnpm test` then npm test\n');
  });

  it('preview shows deletions and insertions per range', () => {
    expect(previewLine('a foo b foo', [{ start: 2, end: 5 }, { start: 8, end: 11 }], 'foo', {}, 'X')).toEqual([
      { text: 'a ', kind: 'keep' },
      { text: 'foo', kind: 'del' },
      { text: 'X', kind: 'ins' },
      { text: ' b ', kind: 'keep' },
      { text: 'foo', kind: 'del' },
      { text: 'X', kind: 'ins' },
    ]);
    expect(previewLine('k=v', [{ start: 0, end: 3 }], '(\\w)=(\\w)', { regex: true }, '$2=$1').map((p) => p.text)).toEqual(['k=v', 'v=k']);
  });
});
