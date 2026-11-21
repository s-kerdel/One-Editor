// Zen mode's full screen (renderer app/zen-impl.ts → 'app:zenFullScreen'). Main remembers whether zen made
// the window full screen, so leaving zen gives back exactly the state from before: it never leaves a full
// screen the user had already, and once the user leaves it (OS, macOS green button) zen forgets its claim.
import type { BrowserWindow } from 'electron';

/** The window bits this needs (a real BrowserWindow in the app; a stub in unit tests). */
export type FsWindow = Pick<BrowserWindow, 'isFullScreen' | 'setFullScreen' | 'isMaximized' | 'isVisible' | 'isDestroyed' | 'on' | 'once'>;

export class ZenFullScreen {
  /** Set while zen holds the full screen; `max` = maximized before (what window-state.json should keep). */
  private held: { max: boolean } | null = null;

  attach(w: FsWindow): void {
    w.on('leave-full-screen', () => void (this.held = null));
  }

  set(w: FsWindow, on: boolean): void {
    if (w.isDestroyed()) return;
    if (!on) {
      const held = this.held;
      this.held = null;
      if (held && w.isFullScreen()) w.setFullScreen(false);
      return;
    }
    if (this.held || w.isFullScreen()) return;
    this.held = { max: w.isMaximized() };
    // Restored in zen at launch: the request can come before the window is shown.
    if (w.isVisible()) w.setFullScreen(true);
    else w.once('show', () => void (this.held && !w.isDestroyed() && w.setFullScreen(true)));
  }

  /** window-state.json's `maximized`: zen's full screen is not the window's own state. */
  maximized(w: FsWindow): boolean {
    return this.held ? this.held.max : w.isMaximized() || w.isFullScreen();
  }
}
