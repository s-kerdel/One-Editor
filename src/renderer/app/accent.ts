// Accent colour (Settings → Appearance): derives every accent token for the dark and the light theme
// from one picked colour and installs them as a tiny stylesheet. The same stylesheet text is cached
// in localStorage so theme-boot.js can apply it before first paint (no colour flash on refresh).
// Lazy: only loaded when a custom accent is set and the cache is missing or stale.

type Rgb = [number, number, number];

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (c: Rgb) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgbToHsl([r, g, b]: Rgb): Rgb {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: Rgb): Rgb {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

const shift = (c: Rgb, dl: number): Rgb => {
  const [h, s, l] = rgbToHsl(c);
  return hslToRgb([h, s, Math.min(0.96, Math.max(0.04, l + dl))]);
};

/** Theme facts the derivation needs: page background, which way "more readable" is, and the alphas of the soft tokens. */
const THEMES = {
  dark: { bg: [27, 29, 34] as Rgb, dir: 1, min: 5, soft: 0.15, sel: 0.28, ring: 0.6 },
  light: { bg: [255, 255, 255] as Rgb, dir: -1, min: 4.5, soft: 0.11, sel: 0.2, ring: 0.5 },
};
const INK: Rgb = [15, 19, 32];
const WHITE: Rgb = [255, 255, 255];

export interface AccentTokens {
  '--accent': string;
  '--accent-strong': string;
  '--accent-soft': string;
  '--accent-fg': string;
  '--selection': string;
  '--focus-ring': string;
}

/** Accent tokens for one theme. The picked colour is nudged lighter (dark theme) or darker (light
 *  theme) until it is readable as text on the page background; the hue is kept. */
export function accentTokens(hex: string, theme: 'dark' | 'light'): AccentTokens {
  const t = THEMES[theme];
  let c = hexToRgb(hex);
  for (let i = 0; i < 40 && contrast(c, t.bg) < t.min; i++) c = shift(c, 0.02 * t.dir);
  const strong = shift(c, 0.07 * t.dir);
  const rgb = c.map(Math.round).join(', ');
  return {
    '--accent': rgbToHex(c),
    '--accent-strong': rgbToHex(strong),
    '--accent-soft': `rgba(${rgb}, ${t.soft})`,
    // Text on an accent-filled button: whichever of white / dark ink reads better on both fills.
    '--accent-fg': Math.min(contrast(WHITE, c), contrast(WHITE, strong)) >= Math.min(contrast(INK, c), contrast(INK, strong)) ? '#ffffff' : rgbToHex(INK),
    '--selection': `rgba(${rgb}, ${t.sel})`,
    '--focus-ring': `rgba(${rgb}, ${t.ring})`,
  };
}

const block = (hex: string, theme: 'dark' | 'light') =>
  Object.entries(accentTokens(hex, theme))
    .map(([k, v]) => `${k}:${v}`)
    .join(';');

/** Stylesheet overriding the accent tokens of styles/app.css for every theme (dark / light / system).
 *  Starts with the colour as a comment: settings.ts uses it to tell whether the cached sheet is current. */
export function accentCss(hex: string): string {
  const h = hex.toLowerCase();
  const light = block(h, 'light');
  // `:root:root` outranks the theme selectors in app.css whatever the stylesheet order.
  return `/*${h}*/html:root:root{${block(h, 'dark')}}html[data-theme='light']:root:root{${light}}@media (prefers-color-scheme:light){html[data-theme='system']:root:root{${light}}}`;
}

/** Installs (or replaces) the accent stylesheet and caches it for the next launch. */
export function applyAccent(hex: string): void {
  if (!isHexColor(hex)) return;
  const css = accentCss(hex);
  let el = document.getElementById('se-accent');
  if (!el) {
    el = document.createElement('style');
    el.id = 'se-accent';
    document.head.appendChild(el);
  }
  el.textContent = css;
  try {
    localStorage.setItem('sec-edit-accent', css);
  } catch {}
}
