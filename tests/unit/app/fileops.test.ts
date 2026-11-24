// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { topExtensions, validateName } from '../../../src/renderer/app/file-rules';
import { countWords } from '../../../src/renderer/app/wordcount';

describe('validateName', () => {
  it('accepts normal names', () => {
    for (const n of ['note.md', 'Meeting 2024-01-02.md', 'über.txt', '.env', 'a.b.c']) expect(validateName(n)).toBeNull();
  });
  it('rejects names that break on Windows or escape the folder', () => {
    for (const n of ['', '  ', '.', '..', 'a/b', 'a\\b', 'what?.md', 'x:y', 'trailing.', 'CON', 'nul.txt', 'com1']) expect(validateName(n)).not.toBeNull();
  });
});

describe('topExtensions', () => {
  const NOTES = new Set(['.md', '.markdown', '.mdx']);
  it('counts extensions case-folded, most-used first, ties alphabetical', () => {
    expect(topExtensions(['a.ts', 'b.TS', 'c.json', 'd.php'], 5, NOTES)).toEqual([
      { ext: '.ts', count: 2 },
      { ext: '.json', count: 1 },
      { ext: '.php', count: 1 },
    ]);
  });
  it('skips note extensions and extensionless names (dotfiles included: extname gives "")', () => {
    expect(topExtensions(['README.md', 'a.markdown', 'b.mdx', 'LICENSE', '.env', 'notes/x.md'], 5, NOTES)).toEqual([]);
  });
  it('counts compound extensions as their last segment (extname semantics)', () => {
    expect(topExtensions(['src/Template.blade.php', 'x.tpl.php'], 5, NOTES)).toEqual([{ ext: '.php', count: 2 }]);
  });
  it('slices to n', () => {
    const paths = ['a.ts', 'b.ts', 'c.ts', 'd.json', 'e.json', 'f.css', 'g.php', 'h.sql', 'i.yaml'];
    expect(topExtensions(paths, 5, NOTES).map((t) => t.ext)).toEqual(['.ts', '.json', '.css', '.php', '.sql']);
  });
  it('handles no paths', () => {
    expect(topExtensions([], 5, NOTES)).toEqual([]);
  });
});

describe('countWords', () => {
  it('counts words across scripts and ignores markdown punctuation', () => {
    expect(countWords('# Hello world\n\n- item one').words).toBe(4);
    expect(countWords("don't stop — café").words).toBe(3);
    expect(countWords('a\nb').chars).toBe(2);
  });
});
