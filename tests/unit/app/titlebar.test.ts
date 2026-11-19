// @vitest-environment happy-dom
// Integrated window frame: the colours handed to the native window controls come from the live CSS.
import { describe, it, expect } from 'vitest';
import { toHex } from '../../../src/renderer/app/titlebar';

describe('toHex (computed CSS colour → #rrggbb for the overlay IPC)', () => {
  it('reads what getComputedStyle and token values look like', () => {
    expect(toHex('rgb(22, 24, 28)')).toBe('#16181c');
    expect(toHex('rgba(246, 246, 245, 1)')).toBe('#f6f6f5');
    expect(toHex('rgb(22 24 28 / 0.5)')).toBe('#16181c');
    expect(toHex(' #8F96A3 ')).toBe('#8f96a3');
    expect(toHex('#abc')).toBe('#aabbcc');
    expect(toHex('#16181cff')).toBe('#16181c');
  });
  it('gives up (no IPC) on anything it cannot read', () => {
    for (const v of ['', 'transparent', 'var(--x)', 'color(srgb 1 0 0)', 'red']) expect(toHex(v), v).toBeNull();
  });
});

describe('isTransparent (what the window controls overlay is painted over)', () => {
  it('detects the computed forms of "no background"', async () => {
    const { isTransparent } = await import('../../../src/renderer/app/titlebar');
    for (const c of ['transparent', 'rgba(0, 0, 0, 0)', 'rgb(0 0 0 / 0)', '']) expect(isTransparent(c), c).toBe(true);
    for (const c of ['rgb(19, 21, 25)', 'rgba(19, 21, 25, 1)', 'rgb(0 0 0 / 0.5)', '#131519']) expect(isTransparent(c), c).toBe(false);
  });
});
