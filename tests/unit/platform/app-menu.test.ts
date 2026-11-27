import { describe, it, expect } from 'vitest';
import { appMenuTemplate, dockMenuTemplate } from '../../../src/main/app-menu';

const T = (dev: boolean, newWindow: (w: unknown) => void = () => {}) => appMenuTemplate({ name: 'One', dev, newWindow });
const flat = (t: unknown[]): Record<string, unknown>[] => t.flatMap((i) => [i as Record<string, unknown>, ...(Array.isArray((i as { submenu?: unknown }).submenu) ? flat((i as { submenu: unknown[] }).submenu) : [])]);

describe('macOS app menu', () => {
  it.each([false, true])('has no reload role and no accelerator on reload items (dev=%s)', (dev) => {
    const items = flat(T(dev));
    expect(items.some((i) => i.role === 'reload' || i.role === 'forceReload')).toBe(false);
    for (const i of items.filter((x) => /reload/i.test(String(x.label ?? '')))) expect(i.accelerator).toBeUndefined();
  });
  it('offers Reload only in dev builds', () => {
    const labels = (dev: boolean) => flat(T(dev)).map((i) => i.label);
    expect(labels(true)).toContain('Reload');
    expect(labels(false)).not.toContain('Reload');
  });
  // A key equivalent without Cmd runs before the page sees the key: it would take Ctrl+R / Ctrl+C from a terminal.
  // Electron resolves each role below to Cmd chords only (Menu.buildFromTemplate on Electron 45, macOS); a new role
  // (selectNextTab is Control+Tab…) or an explicit accelerator must be checked before it joins the list.
  it.each([false, true])('claims no chord without Cmd (dev=%s)', (dev) => {
    const items = flat(T(dev));
    const cmdOnlyRoles = new Set(['appMenu', 'close', 'editMenu', 'windowMenu', 'toggleDevTools', 'togglefullscreen']);
    for (const i of items) {
      if (i.accelerator !== undefined) expect(String(i.accelerator), String(i.label ?? i.role)).toMatch(/Cmd|Command/i);
      if (i.role !== undefined) expect(cmdOnlyRoles.has(String(i.role)), String(i.role)).toBe(true);
    }
  });
  // Several windows: File → New Window shows Cmd+Shift+N but leaves the key to the page (the renderer's command);
  // Close (the old fileMenu role) stays.
  it.each([false, true])('File menu: New Window (key shown, not registered) and Close (dev=%s)', (dev) => {
    const asked: unknown[] = [];
    const file = T(dev, (w) => asked.push(w)).find((m) => m.label === 'File') as { submenu: Record<string, unknown>[] };
    const item = file.submenu.find((i) => i.label === 'New Window')!;
    expect(item).toMatchObject({ accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false });
    expect(file.submenu.some((i) => i.role === 'close')).toBe(true);
    const win = { id: 7 };
    (item.click as (i: unknown, w: unknown) => void)({}, win);
    expect(asked).toEqual([win]);
  });
  it('Window menu role (macOS lists the windows) and a Dock menu with New Window', () => {
    expect(T(false).some((m) => m.role === 'windowMenu')).toBe(true);
    let n = 0;
    const dock = dockMenuTemplate({ newWindow: () => n++ });
    expect(dock.map((i) => i.label)).toEqual(['New Window']);
    expect(dock[0].accelerator).toBeUndefined();
    (dock[0].click as () => void)();
    expect(n).toBe(1);
  });
});
