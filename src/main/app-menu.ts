// macOS application menu. Electron's default menu has View → Reload / Force Reload (CmdOrCtrl+R,
// CmdOrCtrl+Shift+R): a window reload kills every terminal's shell, and in a terminal Ctrl+R is readline's
// reverse-i-search. So we set our own menu: the same roles minus the reload accelerators (dev builds keep
// Reload as a plain menu item without a key). Windows/Linux have no menu at all (main.ts).
// Pure (no electron import): tests/unit/platform/app-menu.test.ts.
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

export function appMenuTemplate(o: { name: string; dev: boolean; newWindow: (from: BrowserWindow | undefined) => void }): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }];
  if (o.dev) {
    view.unshift({ label: 'Reload', click: (_i, w) => (w as BrowserWindow | undefined)?.webContents.reload() }, { label: 'Force Reload', click: (_i, w) => (w as BrowserWindow | undefined)?.webContents.reloadIgnoringCache() }, { type: 'separator' });
  }
  // File = the default fileMenu role (Close) plus "New Window". Its key is shown, not registered: the renderer's
  // Mod-Shift-n command owns it (in the page and in a terminal alike).
  const file: MenuItemConstructorOptions[] = [{ label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false, click: (_i, w) => o.newWindow(w as BrowserWindow | undefined) }, { type: 'separator' }, { role: 'close' }];
  // The Window menu lists the open windows by itself.
  return [{ role: 'appMenu', label: o.name }, { label: 'File', submenu: file }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }];
}

/** macOS Dock menu (right-click on the icon): the open windows are listed by macOS itself. */
export function dockMenuTemplate(o: { newWindow: () => void }): MenuItemConstructorOptions[] {
  return [{ label: 'New Window', click: () => o.newWindow() }];
}
