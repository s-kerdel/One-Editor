// Zen mode startup stub (View: Toggle zen mode, Mod-Alt-z): the flag lives in ui.zen (restored with the
// session before first paint, theme-boot.js draws the skeleton from data-zen); Layout reads it. The edge
// strips, the peeks and full screen are in the lazy ./zen-impl chunk; the toggle button is Shelf's ZenButton.
// Import this only from startup modules no lazy chunk imports (Layout, shell, main.tsx): reached from a lazy
// chunk too, its import() made the bundler split shared startup code into an extra chunk (more startup bytes).
import type { ComponentChildren } from 'preact';
import { app } from './app';
import * as ui from './ui';
import { afterBootIdle, lazy, lazyComponent } from './lazy';

const impl = lazy(() => import('./zen-impl'));
/** The sidebar / file overview folded into a strip (lazy); resolved before any frame that shows it. */
export const ZenStrip = lazyComponent<{ right?: boolean; children?: ComponentChildren }>(() => impl.load().then((m) => m.ZenStrip));
/** main.tsx awaits this before the first render when the session restores zen. */
export const preloadZenUi = () => ZenStrip.preload();
export const toggleZen = () => void preloadZenUi().then(() => impl.peek()!.toggleZen());
export const zenKeepsStatus = () => app.settings.value['zen.keepStatusBar'] === true;
/** Restored in zen: install at once (full screen, peeks); else once idle. */
export const installZen = () => {
  const go = () => void impl.load().then((m) => m.installZenImpl());
  if (ui.zen.peek()) go();
  else afterBootIdle(go);
};
