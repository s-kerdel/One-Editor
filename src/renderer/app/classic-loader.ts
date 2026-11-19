// Loader for the classic sidebar style chunk. main.tsx calls it before the first render when the
// saved style is classic (from localStorage), so the activity bar is there on first paint.
let p: Promise<typeof import('./classic')> | null = null;
export const loadClassic = () => (p ??= import('./classic'));

// Layout registers how to fully prime classic's lazy components (chunk + resolved components), so
// lazily loaded callers (Settings, the palette command) need not import Layout itself.
let primer: (() => Promise<unknown>) | null = null;
export const setClassicPrimer = (fn: () => Promise<unknown>) => (primer = fn);
export const primeClassic = () => (primer ? primer() : loadClassic());
