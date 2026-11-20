import { describe, expect, it } from 'vitest';
import { BRAND, brandTitle } from '../../../src/shared/brand';
import { osName } from '../../../src/renderer/app/build-info';

describe('brand', () => {
  it('formats the lockup with the folder after the scope operator', () => {
    expect(BRAND).toBe('One');
    expect(brandTitle('notes')).toBe('One :: notes');
    expect(brandTitle(null)).toBe('One');
  });

  it('names Windows instead of Node’s "win32"', () => {
    expect(osName('win32')).toBe('Windows');
    expect(osName('darwin')).toBe('macOS');
    expect(osName('freebsd')).toBe('freebsd');
  });
});
