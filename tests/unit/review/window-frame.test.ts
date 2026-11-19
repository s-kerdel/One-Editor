// Window frame (integrated = Window Controls Overlay): BrowserWindow options, renderer → main overlay
// validation, the first-paint overlay, and the restart flow behind "Restart now".
import { describe, it, expect, vi } from 'vitest';
import { createRelaunch, frameOf, frameWindowOptions, initialOverlay, isDarkColor, parseOverlay, rememberOverlay } from '../../../src/main/frame';
import { DEFAULT_SETTINGS } from '../../../src/shared/api';
import { settingByKey, filterSettings } from '../../../src/renderer/app/settings-registry';

describe('frameOf', () => {
  it('defaults to integrated; only an explicit "native" keeps the OS title bar', () => {
    expect(DEFAULT_SETTINGS.windowFrame).toBe('integrated');
    expect(frameOf({})).toBe('integrated');
    expect(frameOf(null)).toBe('integrated');
    expect(frameOf({ windowFrame: null as never })).toBe('integrated'); // "reset to default" writes null
    expect(frameOf({ windowFrame: 'bogus' as never })).toBe('integrated');
    expect(frameOf({ windowFrame: 'native' })).toBe('native');
  });
});

describe('frameWindowOptions', () => {
  const ov = { color: '#16181c', symbolColor: '#8f96a3', height: 37 };
  it('Windows/Linux: hidden title bar + overlay (native min/max/close, Snap Layouts)', () => {
    for (const p of ['win32', 'linux']) expect(frameWindowOptions('integrated', p, ov)).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: ov });
  });
  it('macOS keeps the traffic lights (inset) and only enables the WCO API', () => {
    expect(frameWindowOptions('integrated', 'darwin', ov)).toEqual({ titleBarStyle: 'hiddenInset', titleBarOverlay: true });
  });
  it('native = no frame options at all (today’s window)', () => {
    expect(frameWindowOptions('native', 'win32', ov)).toEqual({});
  });
  it('hands BrowserWindow its own copy of the overlay', () => {
    const o = frameWindowOptions('integrated', 'win32', ov);
    expect(o.titleBarOverlay).not.toBe(ov);
  });
});

describe('parseOverlay (renderer → main IPC)', () => {
  it('accepts exactly { color, symbolColor, height } with #rrggbb colours', () => {
    expect(parseOverlay({ color: '#16181C', symbolColor: '#8f96a3', height: 37 })).toEqual({ color: '#16181c', symbolColor: '#8f96a3', height: 37 });
  });
  it('refuses anything else', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'x',
      [],
      { color: '#16181c', symbolColor: '#8f96a3' },
      { color: 'red', symbolColor: '#8f96a3', height: 37 },
      { color: 'rgb(1,2,3)', symbolColor: '#8f96a3', height: 37 },
      { color: '#16181c80', symbolColor: '#8f96a3', height: 37 },
      { color: '#16181c', symbolColor: '#8f96a3', height: 37.5 },
      { color: '#16181c', symbolColor: '#8f96a3', height: '37' },
      { color: '#16181c', symbolColor: '#8f96a3', height: 0 },
      { color: '#16181c', symbolColor: '#8f96a3', height: 10_000 },
      { color: '#16181c', symbolColor: '#8f96a3', height: Number.NaN },
      { color: '#16181c', symbolColor: '#8f96a3', height: 37, extra: 1 },
      { color: '#16181c;background:url(x)', symbolColor: '#8f96a3', height: 37 },
    ];
    for (const b of bad) expect(parseOverlay(b), JSON.stringify(b)).toBeNull();
  });
});

describe('initialOverlay (first paint, before the renderer measured anything)', () => {
  it('first launch: the strip colours of the theme and --tab-h minus its bottom rule', () => {
    expect(initialOverlay({}, true)).toEqual({ color: '#16181c', symbolColor: '#8f96a3', height: 37 });
    expect(initialOverlay({}, false)).toEqual({ color: '#f6f6f5', symbolColor: '#5f6670', height: 37 });
    expect(initialOverlay({ uiDensity: 'compact' }, true).height).toBe(33);
    expect(initialOverlay({ uiDensity: 'spacious', zoom: 1.25 }, true).height).toBe(51);
  });
  it('later launches: what the renderer measured last time, per theme brightness', () => {
    let cache = rememberOverlay(null, { color: '#101010', symbolColor: '#a0a0a0', height: 44 }, true);
    cache = rememberOverlay(cache, { color: '#fafafa', symbolColor: '#505050', height: 44 }, false);
    expect(initialOverlay({}, true, cache)).toEqual({ color: '#101010', symbolColor: '#a0a0a0', height: 44 });
    expect(initialOverlay({}, false, cache)).toEqual({ color: '#fafafa', symbolColor: '#505050', height: 44 });
    // Only one brightness seen so far → the other falls back to the built-in strip colours.
    expect(initialOverlay({}, false, { dark: cache.dark, height: 40 })).toEqual({ color: '#f6f6f5', symbolColor: '#5f6670', height: 40 });
    // A hand-edited / corrupt height is ignored.
    expect(initialOverlay({}, true, { height: 9999 }).height).toBe(37);
  });
  it('isDarkColor keys the cache by the colour itself', () => {
    expect(isDarkColor('#16181c')).toBe(true);
    expect(isDarkColor('#f6f6f5')).toBe(false);
    expect(isDarkColor('#3b6ee8')).toBe(true);
  });
});

describe('createRelaunch ("Restart now")', () => {
  const setup = () => {
    const hooks = { close: vi.fn(), relaunch: vi.fn(), exit: vi.fn() };
    return { hooks, r: createRelaunch(hooks) };
  };
  it('closes through the normal close flow, then relaunches once every window is gone', () => {
    const { hooks, r } = setup();
    r.request();
    expect(hooks.close).toHaveBeenCalledOnce();
    expect(hooks.relaunch).not.toHaveBeenCalled(); // nothing happens before the close is approved
    expect(r.allClosed()).toBe(true);
    expect(hooks.relaunch).toHaveBeenCalledOnce();
    expect(hooks.exit).toHaveBeenCalledWith(0);
  });
  it('"Save changes?" → Cancel cancels the restart; a later normal close just quits', () => {
    const { hooks, r } = setup();
    r.request();
    r.cancelled();
    expect(r.requested).toBe(false);
    expect(r.allClosed()).toBe(false);
    expect(hooks.relaunch).not.toHaveBeenCalled();
    expect(hooks.exit).not.toHaveBeenCalled();
  });
  it('a plain close never relaunches', () => {
    const { hooks, r } = setup();
    expect(r.allClosed()).toBe(false);
    expect(hooks.relaunch).not.toHaveBeenCalled();
  });
});

describe('settings entry', () => {
  it('is a desktop-only Appearance setting, found by the words people use', () => {
    const d = settingByKey('windowFrame')!;
    expect(d).toMatchObject({ section: 'appearance', desktopOnly: true, default: 'integrated' });
    for (const q of ['title bar', 'window controls', 'frameless', 'maximize']) expect(filterSettings(q).map((x) => x.key), q).toContain('windowFrame');
  });
});
