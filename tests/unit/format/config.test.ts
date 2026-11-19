import { describe, it, expect } from 'vitest';
import { ConfigResolver, globMatches, parseEditorConfig, parsePrettierRc, optionsFromSettings, isConfigFile } from '../../../src/format/config';
import { formatText } from '../../../src/format';

function resolver(files: Record<string, string>) {
  const reads: string[] = [];
  const r = new ConfigResolver(async (p) => {
    reads.push(p);
    return p in files ? files[p] : null;
  });
  return { r, reads };
}

describe('config parsing', () => {
  it('parses JSON and YAML .prettierrc', () => {
    expect(parsePrettierRc('{"tabWidth": 8, "overrides":[{"files":"*.php","options":{"tabWidth":2}}]}')).toEqual({
      options: { tabWidth: 8 },
      overrides: [{ files: ['*.php'], excludeFiles: [], options: { tabWidth: 2 } }],
    });
    expect(parsePrettierRc('# c\nsingleQuote: true\nprintWidth: 100 # wide\ntrailingComma: "all"\n')?.options).toEqual({ singleQuote: true, printWidth: 100, trailingComma: 'all' });
    expect(parsePrettierRc('::: nonsense')).toBeNull();
    expect(parsePrettierRc('[1]')).toBeNull();
  });
  it('parses .editorconfig', () => {
    const c = parseEditorConfig('root = true\n\n[*]\nindent_style = space\nindent_size = 2\n; c\n[*.{php,phtml}]\nindent_size = 4\n');
    expect(c.root).toBe(true);
    expect(c.sections).toEqual([
      { glob: '*', props: { indent_style: 'space', indent_size: '2' } },
      { glob: '*.{php,phtml}', props: { indent_size: '4' } },
    ]);
  });
  it('matches globs', () => {
    expect(globMatches('*', 'a/b/c.php', '')).toBe(true);
    expect(globMatches('*.php', 'a/b/c.php', '')).toBe(true);
    expect(globMatches('*.{js,ts}', 'a/b/c.ts', '')).toBe(true);
    expect(globMatches('*.{js,ts}', 'a/b/c.tsx', '')).toBe(false);
    expect(globMatches('src/**/*.ts', 'src/a/b.ts', '')).toBe(true);
    expect(globMatches('src/**/*.ts', 'src/b.ts', '')).toBe(true);
    expect(globMatches('src/*.ts', 'pkg/src/b.ts', 'pkg')).toBe(true);
    expect(globMatches('src/*.ts', 'other/src/b.ts', 'pkg')).toBe(false);
    expect(globMatches('[Mm]akefile', 'Makefile', '')).toBe(true);
    expect(globMatches('**.md', 'a/b.md', '')).toBe(true);
  });
  it('maps settings keys', () => {
    expect(optionsFromSettings({ 'format.printWidth': 100, 'format.useTabs': true, 'format.sqlKeywordCase': 'lower', 'format.phpVersion': '8.1', 'format.tabWidth': 'x', theme: 'dark' })).toEqual({
      printWidth: 100,
      useTabs: true,
      sqlKeywordCase: 'lower',
      phpVersion: '8.1',
    });
    expect(optionsFromSettings({})).toEqual({});
    expect(isConfigFile('a/b/.prettierrc')).toBe(true);
    expect(isConfigFile('a/b/prettier.md')).toBe(false);
  });
});

describe('ConfigResolver', () => {
  it('layers settings < editorconfig < prettierrc, nearest ancestor first', async () => {
    const { r } = resolver({
      '.editorconfig': 'root = true\n[*]\nindent_style = tab\nmax_line_length = 120\n[*.php]\nindent_size = 4\n',
      'app/.editorconfig': '[*.php]\nindent_style = space\n',
      '.prettierrc': '{"semi": false, "tabWidth": 3}',
      'app/src/.prettierrc.json': '{"singleQuote": true, "overrides": [{"files": ["*.ts"], "options": {"printWidth": 60}}]}',
    });
    const settings = { 'format.printWidth': 90, 'format.singleQuote': false, 'format.sqlKeywordCase': 'lower' };
    expect(await r.resolve('app/x.php', settings)).toEqual({ printWidth: 120, singleQuote: false, sqlKeywordCase: 'lower', useTabs: false, tabWidth: 3, semi: false });
    expect(await r.resolve('app/src/deep/y.ts', settings)).toEqual({ printWidth: 60, singleQuote: true, sqlKeywordCase: 'lower', useTabs: true });
    expect(await r.resolve('z.md', {})).toEqual({ useTabs: true, printWidth: 120, semi: false, tabWidth: 3 });
  });

  it('caches reads until invalidated', async () => {
    const files: Record<string, string> = { '.prettierrc': '{"tabWidth": 8}' };
    const { r, reads } = resolver(files);
    expect((await r.resolve('a/b.ts', {})).tabWidth).toBe(8);
    const n = reads.length;
    await r.resolve('a/c.ts', {});
    expect(reads.length).toBe(n);
    files['.prettierrc'] = '{"tabWidth": 3}';
    expect((await r.resolve('a/b.ts', {})).tabWidth).toBe(8);
    r.invalidate('.prettierrc');
    expect((await r.resolve('a/b.ts', {})).tabWidth).toBe(3);
  });

  it('feeds real formatting', async () => {
    const { r } = resolver({ '.editorconfig': '[*.php]\nindent_style = tab\n', '.prettierrc': '{"singleQuote": false}' });
    const options = await r.resolve('src/a.php', {});
    const out = await formatText('<?php\nfunction a(){return \'x\';}', { path: 'src/a.php', options });
    expect(out.text).toBe('<?php\nfunction a()\n{\n\treturn "x";\n}\n');
  });
});
