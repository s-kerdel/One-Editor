import { describe, it, expect } from 'vitest';
import { accentCss, accentTokens, contrast, hexToRgb, isHexColor, rgbToHex } from '../../../src/renderer/app/accent';
import { ACCENT_SWATCHES } from '../../../src/renderer/app/settings-registry';

const DARK_BG = hexToRgb('#1b1d22');
const WHITE = hexToRgb('#ffffff');
const swatches = ACCENT_SWATCHES.map((s) => String(s.v)).filter(Boolean);

describe('accent colour derivation', () => {
  it('validates #rrggbb and round-trips hex', () => {
    expect(isHexColor('#12abEF')).toBe(true);
    for (const bad of ['', '#fff', 'red', '#12345g', null, 3]) expect(isHexColor(bad)).toBe(false);
    expect(rgbToHex(hexToRgb('#12abef'))).toBe('#12abef');
  });

  it('every curated swatch has its own readable accent in both themes', () => {
    expect(swatches.length).toBeGreaterThanOrEqual(10);
    expect(new Set(swatches).size).toBe(swatches.length);
    for (const hex of swatches) {
      expect(isHexColor(hex), hex).toBe(true);
      const dark = accentTokens(hex, 'dark');
      const light = accentTokens(hex, 'light');
      // as text / icon colour on the page background
      expect(contrast(hexToRgb(dark['--accent']), DARK_BG), `${hex} dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hexToRgb(light['--accent']), WHITE), `${hex} light`).toBeGreaterThanOrEqual(4.5);
      // text on an accent-filled button, normal and hovered
      for (const t of [dark, light]) {
        expect(contrast(hexToRgb(t['--accent-fg']), hexToRgb(t['--accent'])), `${hex} fg`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(hexToRgb(t['--accent-fg']), hexToRgb(t['--accent-strong'])), `${hex} fg on hover`).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('nudges extreme picks towards readable, keeping usable colours untouched', () => {
    // near-black on dark and near-white on light would vanish
    expect(contrast(hexToRgb(accentTokens('#101010', 'dark')['--accent']), DARK_BG)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hexToRgb(accentTokens('#fffff0', 'light')['--accent']), WHITE)).toBeGreaterThanOrEqual(4.5);
    // already readable → used as picked
    expect(accentTokens('#7aa2f7', 'dark')['--accent']).toBe('#7aa2f7');
    expect(accentTokens('#3b6ee8', 'light')['--accent']).toBe('#3b6ee8');
  });

  it('derives the soft tokens from the adjusted accent and moves "strong" towards more contrast', () => {
    const d = accentTokens('#7aa2f7', 'dark');
    expect(d['--accent-soft']).toBe('rgba(122, 162, 247, 0.15)');
    expect(d['--selection']).toBe('rgba(122, 162, 247, 0.28)');
    expect(d['--focus-ring']).toBe('rgba(122, 162, 247, 0.6)');
    expect(contrast(hexToRgb(d['--accent-strong']), DARK_BG)).toBeGreaterThan(contrast(hexToRgb(d['--accent']), DARK_BG));
    const l = accentTokens('#3b6ee8', 'light');
    expect(contrast(hexToRgb(l['--accent-strong']), WHITE)).toBeGreaterThan(contrast(hexToRgb(l['--accent']), WHITE));
  });

  it('builds one stylesheet for dark, light and system, tagged with the colour', () => {
    const css = accentCss('#F97316');
    expect(css.startsWith('/*#f97316*/')).toBe(true);
    expect(css).toContain('html:root:root{--accent:');
    expect(css).toContain("html[data-theme='light']:root:root{");
    expect(css).toContain("@media (prefers-color-scheme:light){html[data-theme='system']:root:root{");
    for (const token of ['--accent', '--accent-strong', '--accent-soft', '--accent-fg', '--selection', '--focus-ring']) expect(css.split(`${token}:`).length, token).toBe(4);
  });
});
