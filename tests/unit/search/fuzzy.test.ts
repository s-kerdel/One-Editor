import { describe, expect, it } from 'vitest';
import { fuzzyFilter, fuzzyMatch, fuzzyMatchPath } from '../../../src/search/fuzzy';

const top = (q: string, items: string[], path = true) => fuzzyFilter(q, items, (x) => x, 10, { path }).map((r) => r.item);

describe('fuzzy matcher (fzf-like)', () => {
  it('matches subsequences and returns optimal positions', () => {
    expect(fuzzyMatch('abc', 'xaxbxc')!.positions).toEqual([1, 3, 5]);
    expect(fuzzyMatch('xyz', 'abc')).toBeNull();
    expect(fuzzyMatch('', 'abc')).toEqual({ score: 0, positions: [] });
    // optimal alignment prefers the word-start "s" + "av" over the first scattered match
    expect(fuzzyMatch('sav', 'Close tabs; Save file')!.positions).toEqual([12, 13, 14]);
  });

  it('prefers word boundaries, camelCase humps and consecutive runs', () => {
    expect(top('fof', ['affordof.md', 'findOrFail.php'], false)[0]).toBe('findOrFail.php');
    expect(top('gcs', ['logics.md', 'getCommandState.ts'], false)[0]).toBe('getCommandState.ts');
    expect(top('uc', ['src/lucid.ts', 'UserController.php'], false)[0]).toBe('UserController.php');
    expect(top('readme', ['docs/read-me-not.md', 'README.md', 'areadmexx'])[0]).toBe('README.md');
  });

  it('path mode favours file-name hits and path segments', () => {
    const files = ['deep/nested/folder/Deep note.md', 'notes/Daily notes.md', 'notes/kubernetes.md', 'README.md'];
    expect(top('deepnote', files)[0]).toBe('deep/nested/folder/Deep note.md');
    expect(top('kube', files)[0]).toBe('notes/kubernetes.md');
    expect(top('nd', ['src/nested/x.md', 'notes/Daily notes.md'])[0]).toBe('notes/Daily notes.md');
    const m = fuzzyMatchPath('kube', 'notes/kubernetes.md')!;
    expect(m.positions).toEqual([6, 7, 8, 9]);
  });

  it('space-separated words match in any order', () => {
    expect(fuzzyMatch('notes daily', 'notes/Daily notes.md')).not.toBeNull();
    expect(fuzzyMatch('daily zzz', 'notes/Daily notes.md')).toBeNull();
  });

  it('smart case and diacritics', () => {
    expect(fuzzyMatch('readme', 'README.md')).not.toBeNull();
    expect(fuzzyMatch('README', 'readme.md')).toBeNull();
    expect(fuzzyMatch('Readme', 'readme.md', { caseSensitive: false })).not.toBeNull();
    const m = fuzzyMatch('cafe', 'notes/café.md')!;
    expect(m).not.toBeNull();
    expect(m.positions).toEqual([6, 7, 8, 9]);
  });

  it('fuzzyFilter keeps the baseline signature and is stable', () => {
    const items = [{ t: 'Save file' }, { t: 'Save all' }, { t: 'Close tab' }];
    const r = fuzzyFilter('sav', items, (x) => x.t);
    expect(r.map((x) => x.item.t)).toEqual(['Save all', 'Save file']);
    expect(r[0].match.positions).toEqual([0, 1, 2]);
  });

  it('handles very long targets without blowing up', () => {
    const long = 'a/'.repeat(3000) + 'needle.md';
    expect(fuzzyMatch('needle', long)).not.toBeNull();
  });
});
