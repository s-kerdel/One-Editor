// Inputs: app-command / mouse button mapping and "one press = one step" de-duplication.
import { describe, expect, it } from 'vitest';
import { createNavDeduper, navFromAppCommand, navFromMouseButton } from '../../../src/shared/nav';

describe('navigation inputs', () => {
  it('maps BrowserWindow app-commands', () => {
    expect(navFromAppCommand('browser-backward')).toBe('back');
    expect(navFromAppCommand('browser-forward')).toBe('forward');
    for (const c of ['browser-refresh', 'media-play-pause', 'volume-up', '', null, undefined, 3]) expect(navFromAppCommand(c)).toBeNull();
  });

  it('maps the mouse side buttons only (no middle click, no wheel tilt)', () => {
    expect(navFromMouseButton(3)).toBe('back');
    expect(navFromMouseButton(4)).toBe('forward');
    for (const b of [0, 1, 2, 5, 6, -1]) expect(navFromMouseButton(b)).toBeNull();
  });

  it('one press arriving as mouse event and app-command is one step, in either order', () => {
    const a = createNavDeduper(250);
    expect(a('back', 'mouse', 1000)).toBe(true);
    expect(a('back', 'app', 1004)).toBe(false);
    const b = createNavDeduper(250);
    expect(b('forward', 'app', 1000)).toBe(true);
    expect(b('forward', 'mouse', 1010)).toBe(false);
  });

  it('two quick presses are two steps, each with its echo dropped', () => {
    const d = createNavDeduper(250);
    const got = [d('back', 'mouse', 0), d('back', 'app', 3), d('back', 'mouse', 120), d('back', 'app', 124), d('back', 'mouse', 240), d('back', 'app', 243)];
    expect(got).toEqual([true, false, true, false, true, false]);
    const e = createNavDeduper(250);
    expect([e('back', 'app', 0), e('back', 'mouse', 3), e('back', 'app', 120), e('back', 'mouse', 124)]).toEqual([true, false, true, false]);
  });

  it('does not drop a different direction, a late event, or the keyboard', () => {
    const d = createNavDeduper(250);
    expect(d('back', 'mouse', 0)).toBe(true);
    expect(d('forward', 'app', 5)).toBe(true);
    expect(d('forward', 'mouse', 400)).toBe(true); // outside the echo window
    expect(d('forward', 'key', 410)).toBe(true);
    expect(d('forward', 'app', 420)).toBe(true); // a key press has no echo
    expect(d('forward', 'app', 430)).toBe(true); // Windows-only setups: app-command alone repeats freely
  });
});
