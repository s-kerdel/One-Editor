// @vitest-environment happy-dom
// Ctrl+Alt+B toggles the file overview — but AltGr typing a character on the same key (Hungarian
// AltGr+B = "{", reported as Ctrl+Alt on Windows) must stay text.
import { describe, expect, it } from 'vitest';
import { getCommand, installGlobalKeymap, isAltGrText } from '../../../src/renderer/app/commands';
import * as ui from '../../../src/renderer/app/ui';
import { installOverview } from '../../../src/renderer/overview';

function press(init: KeyboardEventInit & { altGraph?: boolean }) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  if (init.altGraph) Object.defineProperty(e, 'getModifierState', { value: (k: string) => k === 'AltGraph' });
  window.dispatchEvent(e);
  return e;
}

describe('file overview shortcut', () => {
  installGlobalKeymap(window);
  installOverview();

  it('registers "View: Toggle file overview" on Mod-Alt-b', () => {
    expect(getCommand('view.toggleOverview')).toMatchObject({ title: 'View: Toggle file overview', keys: ['Mod-Alt-b'] });
  });

  it('Ctrl+Alt+B toggles it (and the key goes no further)', () => {
    ui.overviewVisible.value = false;
    const e = press({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
    expect(ui.overviewVisible.value).toBe(true);
    expect(e.defaultPrevented).toBe(true);
    press({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true });
    expect(ui.overviewVisible.value).toBe(false);
  });

  it('AltGr+B typing "{" is text, not the shortcut; AltGr without a character of its own still is', () => {
    ui.overviewVisible.value = false;
    const typed = press({ key: '{', code: 'KeyB', ctrlKey: true, altKey: true, altGraph: true });
    expect(ui.overviewVisible.value).toBe(false);
    expect(typed.defaultPrevented).toBe(false);
    // German layout: AltGr+B produces nothing special → key is "b" → the shortcut works.
    press({ key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, altGraph: true });
    expect(ui.overviewVisible.value).toBe(true);
  });

  it('isAltGrText', () => {
    const ev = (init: KeyboardEventInit, altGraph: boolean) => Object.defineProperty(new KeyboardEvent('keydown', init), 'getModifierState', { value: (k: string) => altGraph && k === 'AltGraph' });
    expect(isAltGrText(ev({ key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true }, true))).toBe(true);
    expect(isAltGrText(ev({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }, true))).toBe(true);
    expect(isAltGrText(ev({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true }, true))).toBe(false);
    expect(isAltGrText(ev({ key: 'ł', code: 'KeyL', ctrlKey: true, altKey: true }, false))).toBe(false); // plain Ctrl+Alt (US layout)
    expect(isAltGrText(ev({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, altKey: true }, true))).toBe(false);
  });
});
