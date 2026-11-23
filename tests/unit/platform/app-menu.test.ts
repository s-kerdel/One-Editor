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
});
