import { describe, it, expect } from 'vitest';
import { LANGUAGES, languageForPath, languageForFence, languageById, formatterForFence, formatterForPath, sqlDialectFor, fenceAlias } from '../../../src/shared/languages';

describe('languages', () => {
  it('resolves paths', () => {
    expect(languageForPath('x.blade.php')?.id).toBe('blade');
    expect(languageForPath('a/b/UserController.php')?.id).toBe('php');
    expect(languageForPath('a/B.PHP')?.id).toBe('php');
    expect(languageForPath('Dockerfile')?.id).toBe('dockerfile');
    expect(languageForPath('notes/a.md')?.id).toBe('markdown');
    expect(languageForPath('.env')?.id).toBe('ini');
    expect(languageForPath('x.tsx')?.id).toBe('tsx');
    expect(languageForPath('x.nope')).toBeNull();
    expect(languageForPath('noext')).toBeNull();
  });
  it('resolves fences', () => {
    for (const f of ['sh', 'shell', 'console', 'bash', 'zsh']) expect(languageForFence(f)?.id).toBe('shell');
    expect(languageForFence('PHP title="x"')?.id).toBe('php');
    expect(languageForFence('js {1,3}')?.id).toBe('javascript');
    expect(languageForFence('.ts')?.id).toBe('typescript');
    for (const f of ['mysql', 'pgsql', 'postgresql', 'sqlite', 'tsql', 'mariadb']) expect(languageForFence(f)?.id).toBe('sql');
    expect(languageForFence('')).toBeNull();
    expect(languageForFence('whatever')).toBeNull();
    expect(languageById('yml')?.id).toBe('yaml');
    expect(fenceAlias('  Php:file.php')).toBe('php');
  });
  it('has unique ids, aliases and extensions', () => {
    const seen = new Map<string, string>();
    for (const l of LANGUAGES) {
      for (const key of [...new Set([l.id, ...l.aliases])].map((a) => `alias:${a}`).concat(l.extensions.map((e) => `ext:${e}`))) {
        expect(seen.get(key), `${key} claimed by ${seen.get(key)} and ${l.id}`).toBeUndefined();
        seen.set(key, l.id);
      }
      for (const e of l.extensions) expect(e.startsWith('.')).toBe(true);
    }
  });
  it('exposes formatter info', () => {
    expect(formatterForPath('a.php')).toMatchObject({ parser: 'php', plugin: 'php' });
    expect(formatterForPath('a.json5')?.parser).toBe('json5');
    expect(formatterForPath('a.jsonc')?.parser).toBe('jsonc');
    expect(formatterForPath('a.json')?.parser).toBe('json');
    expect(formatterForPath('a.mdx')?.parser).toBe('mdx');
    expect(formatterForPath('a.svg')?.parser).toBe('xml');
    expect(formatterForPath('x.blade.php')).toBeNull();
    expect(formatterForPath('a.py')).toBeNull();
    expect(formatterForFence('pgsql')).toMatchObject({ parser: 'sql', dialect: 'postgresql' });
    expect(formatterForFence('sql')?.dialect).toBe('sql');
    expect(formatterForFence('tsql')?.dialect).toBe('transactsql');
    expect(formatterForFence('bash')?.parser).toBe('sh');
    expect(formatterForFence('console')).toBeNull();
    expect(formatterForFence('terminal')).toBeNull();
    expect(sqlDialectFor('MariaDB')).toBe('mariadb');
    expect(sqlDialectFor(undefined)).toBe('sql');
  });
  it('every prettier entry names a known plugin', () => {
    const known = new Set(['babel', 'typescript', 'postcss', 'html', 'markdown', 'yaml', 'graphql', 'php', 'xml', 'sh', 'sql-formatter']);
    for (const l of LANGUAGES) if (l.prettier) expect(known.has(l.prettier.plugin), l.id).toBe(true);
  });
});
