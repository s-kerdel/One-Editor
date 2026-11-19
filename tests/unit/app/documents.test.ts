// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { minimalChange } from '../../../src/renderer/app/doc-save';

const apply = (a: string, c: { from: number; to: number; insert: string }) => a.slice(0, c.from) + c.insert + a.slice(c.to);

describe('minimalChange', () => {
  it('produces the smallest single edit (keeps cursor/scroll on external reloads)', () => {
    for (const [a, b] of [
      ['hello world', 'hello brave world'],
      ['abc', 'abc'],
      ['', 'new'],
      ['old', ''],
      ['aaaa', 'aaa'],
      ['line1\nline2\nline3', 'line1\nLINE2\nline3'],
    ]) {
      const c = minimalChange(a, b);
      expect(apply(a, c)).toBe(b);
    }
    expect(minimalChange('hello world', 'hello brave world')).toEqual({ from: 6, to: 6, insert: 'brave ' });
  });
});
