import { describe, it, expect } from 'vitest';
import { normalizeKey } from '../../../src/renderer/app/commands';

describe('normalizeKey', () => {
  it('is modifier-order insensitive', () => {
    expect(normalizeKey('Shift-Alt-f')).toBe('Alt-Shift-f');
    expect(normalizeKey('Alt-Shift-F')).toBe('Alt-Shift-f');
    expect(normalizeKey('Shift-Mod-p')).toBe('Mod-Shift-p');
  });
  it('handles a literal dash key (zoom out)', () => {
    expect(normalizeKey('Mod--')).toBe('Mod--');
  });
  it('keeps named keys', () => {
    expect(normalizeKey('F1')).toBe('F1');
    expect(normalizeKey('Ctrl-Shift-Tab')).toBe('Ctrl-Shift-Tab');
  });
});
