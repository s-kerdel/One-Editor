// macOS application menu. Electron's default menu has View → Reload / Force Reload (CmdOrCtrl+R,
// CmdOrCtrl+Shift+R): a window reload kills every terminal's shell, and in a terminal Ctrl+R is readline's
// reverse-i-search. So we set our own menu: the same roles minus the reload accelerators (dev builds keep
// Reload as a plain menu item without a key). Windows/Linux have no menu at all (main.ts).
// Pure (no electron import): tests/unit/platform/app-menu.test.ts.
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

export function appMenuTemplate(o: { name: string; dev: boolean }): MenuItemConstructorOptions[] {
  const view: MenuItemConstructorOptions[] = [{ role: 'toggleDevTools' }, { role: 'togglefullscreen' }];
  if (o.dev) {
    view.unshift({ label: 'Reload', click: (_i, w) => (w as BrowserWindow | undefined)?.webContents.reload() }, { label: 'Force Reload', click: (_i, w) => (w as BrowserWindow | undefined)?.webContents.reloadIgnoringCache() }, { type: 'separator' });
  }
  return [{ role: 'appMenu', label: o.name }, { role: 'fileMenu' }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }];
}
