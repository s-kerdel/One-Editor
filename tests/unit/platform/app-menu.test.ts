import { describe, it, expect } from 'vitest';
import { appMenuTemplate } from '../../../src/main/app-menu';

const flat = (t: unknown[]): Record<string, unknown>[] => t.flatMap((i) => [i as Record<string, unknown>, ...(Array.isArray((i as { submenu?: unknown }).submenu) ? flat((i as { submenu: unknown[] }).submenu) : [])]);

describe('macOS app menu', () => {
  it.each([false, true])('has no reload role and no accelerator on reload items (dev=%s)', (dev) => {
    const items = flat(appMenuTemplate({ name: 'One', dev }));
    expect(items.some((i) => i.role === 'reload' || i.role === 'forceReload')).toBe(false);
    for (const i of items.filter((x) => /reload/i.test(String(x.label ?? '')))) expect(i.accelerator).toBeUndefined();
  });
  it('offers Reload only in dev builds', () => {
    const labels = (dev: boolean) => flat(appMenuTemplate({ name: 'One', dev })).map((i) => i.label);
    expect(labels(true)).toContain('Reload');
    expect(labels(false)).not.toContain('Reload');
  });
  // A key equivalent without Cmd runs before the page sees the key: it would take Ctrl+R / Ctrl+C from a terminal.
  // Electron resolves each role below to Cmd chords only (Menu.buildFromTemplate on Electron 45, macOS); a new role
  // (selectNextTab is Control+Tab…) or an explicit accelerator must be checked before it joins the list.
  it.each([false, true])('claims no chord without Cmd (dev=%s)', (dev) => {
    const items = flat(appMenuTemplate({ name: 'One', dev }));
    const cmdOnlyRoles = new Set(['appMenu', 'fileMenu', 'editMenu', 'windowMenu', 'toggleDevTools', 'togglefullscreen']);
    for (const i of items) {
      if (i.accelerator !== undefined) expect(String(i.accelerator), String(i.label ?? i.role)).toMatch(/Cmd|Command/i);
      if (i.role !== undefined) expect(cmdOnlyRoles.has(String(i.role)), String(i.role)).toBe(true);
    }
  });
});
