// Accent colour (Settings → Appearance): derives every accent token for the dark and the light theme
// from one picked colour and installs them as a tiny stylesheet. The derived colours (#rrggbb only) are
// cached in localStorage and theme-boot.js builds the same stylesheet from them before first paint (no colour
// flash on refresh). Never CSS text: every folder's page shares localStorage, and theme-boot would inject it.
// The folder colour (Folder colours → One colour) works the same way with one token, --folder-color.
// Lazy: only loaded when a custom colour is set and its cache is missing or stale.

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

/** `c` nudged lighter (dir 1) or darker (dir -1) until it has `min` contrast on `bg`; the hue is kept. */
function readable(c: Rgb, bg: Rgb, dir: number, min: number): Rgb {
  for (let i = 0; i < 40 && contrast(c, bg) < min; i++) c = shift(c, 0.02 * dir);
  return c;
}

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
  const c = readable(hexToRgb(hex), t.bg, t.dir, t.min);
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

/** Folder icons are graphics: 3:1 (WCAG non-text) on the lightest (dark theme) / darkest (light theme)
 *  background a tree row can have — the hover row (--bg-hover). */
const FOLDER_BG = { dark: [38, 42, 49] as Rgb, light: [235, 235, 233] as Rgb };

/** The one folder colour for a theme (#rrggbb): the pick, nudged until it stays visible. */
export function folderColor(hex: string, theme: 'dark' | 'light'): string {
  return rgbToHex(readable(hexToRgb(hex), FOLDER_BG[theme], THEMES[theme].dir, 3));
}

/** Stylesheet defining --folder-color per theme (consumed by app.css under html[data-folders='one']). */
export function folderCss(hex: string): string {
  const h = hex.toLowerCase();
  const light = `--folder-color:${folderColor(h, 'light')}`;
  return `/*${h}*/html:root:root{--folder-color:${folderColor(h, 'dark')}}html[data-theme='light']:root:root{${light}}@media (prefers-color-scheme:light){html[data-theme='system']:root:root{${light}}}`;
}

const SHEETS = { accent: accentCss, folder: folderCss };

/** What theme-boot.js gets (space separated, every one #rrggbb), the order its stylesheet builder reads:
 *  accent = pick, dark accent / strong / fg, light accent / strong / fg; folder = pick, dark, light.
 *  The rgba() tokens are the accent with each theme's fixed alphas (THEMES), so they need no entry. */
export function colorCache(kind: keyof typeof SHEETS, hex: string): string {
  const h = hex.toLowerCase();
  if (kind === 'folder') return [h, folderColor(h, 'dark'), folderColor(h, 'light')].join(' ');
  const t = (theme: 'dark' | 'light') => {
    const a = accentTokens(h, theme);
    return [a['--accent'], a['--accent-strong'], a['--accent-fg']];
  };
  return [h, ...t('dark'), ...t('light')].join(' ');
}

/** Installs (or replaces) a colour stylesheet (`<style id="se-accent|se-folder">`) and caches its colours for the next launch. */
export function applyColorSheet(kind: keyof typeof SHEETS, hex: string): void {
  if (!isHexColor(hex)) return;
  const css = SHEETS[kind](hex);
  let el = document.getElementById(`se-${kind}`);
  if (!el) {
    el = document.createElement('style');
    el.id = `se-${kind}`;
    document.head.appendChild(el);
  }
  el.textContent = css;
  try {
    localStorage.setItem(`sec-edit-${kind}`, colorCache(kind, hex));
  } catch {}
}

export const applyAccent = (hex: string): void => applyColorSheet('accent', hex);
