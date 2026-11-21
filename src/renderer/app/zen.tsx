// Zen mode startup stub (View: Toggle zen mode, Mod-Alt-z): the flag lives in ui.zen (restored with the
// session before first paint, theme-boot.js draws the skeleton from data-zen); Layout reads it. What a
// toggle does is in the lazy ./zen-impl chunk.
import { app } from './app';
import { prettyKey } from './commands';
import { afterBootIdle, lazy } from './lazy';

const impl = lazy(() => import('./zen-impl'));
export const toggleZen = () => void impl.load().then((m) => m.toggleZen());
export const zenKeepsStatus = () => app.settings.value['zen.keepStatusBar'] === true;
export const installZen = () => afterBootIdle(() => void impl.load().then((m) => m.installZenImpl()));

/** Takes the tab strip's place: an empty band (the window's drag area with the integrated frame) whose
 *  right end shows "Exit zen" on hover — left of the window controls (`--wco-right`, app.css). */
export function ZenBar() {
  const key = prettyKey('Mod-Alt-z');
  return (
    <div class="se-zen-bar">
      <button class="se-zen-exit" data-testid="zen-exit" title={`Leave zen mode (${key})`} onClick={toggleZen}>
        Exit zen <kbd>{key}</kbd>
      </button>
    </div>
  );
}
