// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { validateName } from '../../../src/renderer/app/fileops';
import { countWords } from '../../../src/renderer/app/wordcount';

describe('validateName', () => {
  it('accepts normal names', () => {
    for (const n of ['note.md', 'Meeting 2024-01-02.md', 'über.txt', '.env', 'a.b.c']) expect(validateName(n)).toBeNull();
  });
  it('rejects names that break on Windows or escape the folder', () => {
    for (const n of ['', '  ', '.', '..', 'a/b', 'a\\b', 'what?.md', 'x:y', 'trailing.', 'CON', 'nul.txt', 'com1']) expect(validateName(n)).not.toBeNull();
  });
});

describe('countWords', () => {
  it('counts words across scripts and ignores markdown punctuation', () => {
    expect(countWords('# Hello world\n\n- item one').words).toBe(4);
    expect(countWords("don't stop — café").words).toBe(3);
    expect(countWords('a\nb').chars).toBe(2);
  });
});
