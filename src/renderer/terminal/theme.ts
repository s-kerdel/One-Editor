// Terminal colours come from the app's CSS tokens (terminal.css maps them to --se-term-*), so dark /
// light / accent changes reach the terminal too. xterm.js wants concrete colours: computed custom
// properties can still hold color-mix(…), so every value is normalised through a 1×1 canvas.

export interface TermTheme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
  scrollbarSliderBackground: string;
  scrollbarSliderHoverBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  /** Search highlight colours (#rrggbb: the search addon accepts nothing else). */
  matchBackground: string;
  activeMatchBackground: string;
}

/** Theme key → custom property in terminal.css. */
export const THEME_VARS: Record<keyof TermTheme, string> = {
  foreground: '--se-term-fg',
  background: '--se-term-bg',
  cursor: '--se-term-cursor',
  cursorAccent: '--se-term-bg',
  selectionBackground: '--se-term-selection',
  selectionInactiveBackground: '--se-term-selection-inactive',
  scrollbarSliderBackground: '--se-term-scrollbar',
  scrollbarSliderHoverBackground: '--se-term-scrollbar-hover',
  black: '--se-term-black',
  red: '--se-term-red',
  green: '--se-term-green',
  yellow: '--se-term-yellow',
  blue: '--se-term-blue',
  magenta: '--se-term-magenta',
  cyan: '--se-term-cyan',
  white: '--se-term-white',
  brightBlack: '--se-term-bright-black',
  brightRed: '--se-term-bright-red',
  brightGreen: '--se-term-bright-green',
  brightYellow: '--se-term-bright-yellow',
  brightBlue: '--se-term-bright-blue',
  brightMagenta: '--se-term-bright-magenta',
  brightCyan: '--se-term-bright-cyan',
  brightWhite: '--se-term-bright-white',
  matchBackground: '--se-term-match',
  activeMatchBackground: '--se-term-match-active',
};

/** Fallbacks (dark) when a token is missing — e.g. before the stylesheet arrived. */
const FALLBACK: Partial<TermTheme> = { foreground: '#d9dce2', background: '#1b1d22', cursor: '#7aa2f7', selectionBackground: 'rgba(122, 162, 247, 0.28)' };

export type ColorResolver = (css: string, opts?: { opaqueOver?: string }) => string;

/** Any CSS colour → '#rrggbb' or 'rgba(r, g, b, a)'. Without a canvas (tests) values pass through. */
export function canvasColorResolver(doc: Document = document): ColorResolver {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    const c = doc.createElement('canvas');
    c.width = c.height = 1;
    ctx = c.getContext('2d', { willReadFrequently: true });
  } catch {}
  const cache = new Map<string, string>();
  return (css, opts) => {
    const value = css.trim();
    if (!ctx || !value) return value;
    const key = `${value}|${opts?.opaqueOver ?? ''}`;
    const hit = cache.get(key);
    if (hit) return hit;
    ctx.clearRect(0, 0, 1, 1);
    if (opts?.opaqueOver) {
      ctx.fillStyle = opts.opaqueOver;
      ctx.fillRect(0, 0, 1, 1);
    }
    ctx.fillStyle = '#000';
    ctx.fillStyle = value; // an invalid colour leaves the previous fillStyle
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    const out = a === 255 ? hex : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
    cache.set(key, out);
    return out;
  };
}

/** Reads the terminal palette from `el` (inside `.se-term`, so the --se-term-* tokens apply). */
export function readTerminalTheme(el: Element, resolve: ColorResolver, view: Pick<Window, 'getComputedStyle'> = window): TermTheme {
  const cs = view.getComputedStyle(el);
  const raw = (k: keyof TermTheme) => cs.getPropertyValue(THEME_VARS[k]).trim() || FALLBACK[k] || '';
  const bg = resolve(raw('background')) || '#1b1d22';
  const out = {} as TermTheme;
  for (const k of Object.keys(THEME_VARS) as Array<keyof TermTheme>) {
    // Search decorations must be opaque #rrggbb: blend them onto the background.
    const opaque = k === 'matchBackground' || k === 'activeMatchBackground' || k === 'background' || k === 'cursorAccent';
    out[k] = resolve(raw(k), opaque ? { opaqueOver: bg } : undefined);
  }
  return out;
}

export const sameTheme = (a: TermTheme | null, b: TermTheme) => !!a && (Object.keys(b) as Array<keyof TermTheme>).every((k) => a[k] === b[k]);

/**
 * Calls `cb` whenever the palette may have changed: theme / accent / density attributes on <html>,
 * the accent stylesheet in <head>, or the OS colour scheme (theme: system). Coalesced to one frame.
 */
export function watchTheme(cb: () => void, doc: Document = document): () => void {
  let raf = 0;
  const kick = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      cb();
    });
  };
  const mo = new MutationObserver(kick);
  mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  mo.observe(doc.head, { childList: true, subtree: true, characterData: true });
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  mq?.addEventListener?.('change', kick);
  return () => {
    mo.disconnect();
    mq?.removeEventListener?.('change', kick);
    if (raf) cancelAnimationFrame(raf);
  };
}
