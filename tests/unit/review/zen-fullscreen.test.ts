// Zen mode's full screen in main (src/main/zen-fullscreen.ts): leaving zen gives back exactly the window
// state from before, never leaves a full screen the user had already, forgets its claim once the user
// leaves full screen, and window-state.json keeps the pre-zen "maximized".
import { describe, it, expect } from 'vitest';
import { ZenFullScreen, type FsWindow } from '../../../src/main/zen-fullscreen';

function fakeWindow(init: { full?: boolean; max?: boolean; visible?: boolean } = {}) {
  const on: Record<string, Array<() => void>> = {};
  const once: Record<string, Array<() => void>> = {};
  const st = { full: !!init.full, max: !!init.max, visible: init.visible ?? true, destroyed: false, calls: [] as boolean[] };
  const emit = (ev: string) => {
    for (const f of on[ev] ?? []) f();
    const o = once[ev] ?? [];
    once[ev] = [];
    for (const f of o) f();
  };
  const w = {
    isFullScreen: () => st.full,
    isMaximized: () => st.max && !st.full,
    isVisible: () => st.visible,
    isDestroyed: () => st.destroyed,
    setFullScreen: (v: boolean) => {
      st.calls.push(v);
      if (st.full === v) return;
      st.full = v;
      emit(v ? 'enter-full-screen' : 'leave-full-screen');
    },
    on: (ev: string, f: () => void) => ((on[ev] ??= []).push(f), w),
    once: (ev: string, f: () => void) => ((once[ev] ??= []).push(f), w),
  };
  return { w: w as unknown as FsWindow, st, emit, user: (v: boolean) => w.setFullScreen(v) };
}

describe('ZenFullScreen', () => {
  it('enters full screen for zen and leaves it again on exit', () => {
    const z = new ZenFullScreen();
    const { w, st } = fakeWindow({ max: true });
    z.attach(w);
    z.set(w, true);
    expect(st.full).toBe(true);
    z.set(w, true); // again: nothing new
    expect(st.calls).toEqual([true]);
    z.set(w, false);
    expect(st.full).toBe(false);
    expect(st.calls).toEqual([true, false]);
  });

  it('a window that was already full screen stays full screen when zen ends', () => {
    const z = new ZenFullScreen();
    const { w, st } = fakeWindow({ full: true });
    z.attach(w);
    z.set(w, true);
    z.set(w, false);
    expect(st.full).toBe(true);
    expect(st.calls).toEqual([]);
  });

  it('the user left full screen in zen (OS): leaving zen does not touch the window, also after the user went full screen again', () => {
    const z = new ZenFullScreen();
    const { w, st, user } = fakeWindow();
    z.attach(w);
    z.set(w, true);
    user(false); // OS / green button
    user(true); // the user's own full screen now
    z.set(w, false);
    expect(st.full).toBe(true);
    expect(st.calls).toEqual([true, false, true]);
  });

  it('restored in zen before the window is shown: goes full screen once shown, unless zen ended meanwhile', () => {
    const z = new ZenFullScreen();
    const a = fakeWindow({ visible: false });
    z.attach(a.w);
    z.set(a.w, true);
    expect(a.st.full).toBe(false);
    a.st.visible = true;
    a.emit('show');
    expect(a.st.full).toBe(true);

    const z2 = new ZenFullScreen();
    const b = fakeWindow({ visible: false });
    z2.attach(b.w);
    z2.set(b.w, true);
    z2.set(b.w, false);
    b.st.visible = true;
    b.emit('show');
    expect(b.st.calls).toEqual([]);
  });

  it('window-state.json keeps the state from before zen while zen holds full screen', () => {
    const z = new ZenFullScreen();
    const normal = fakeWindow();
    z.attach(normal.w);
    z.set(normal.w, true);
    expect(z.maximized(normal.w)).toBe(false); // a full screen of zen's is not "maximized"
    z.set(normal.w, false);
    const max = fakeWindow({ max: true });
    const z2 = new ZenFullScreen();
    z2.attach(max.w);
    z2.set(max.w, true);
    expect(z2.maximized(max.w)).toBe(true);
    // The user's own full screen (no zen) is saved as before: maximized.
    const own = fakeWindow({ full: true });
    expect(new ZenFullScreen().maximized(own.w)).toBe(true);
  });

  it('ignores a destroyed window', () => {
    const z = new ZenFullScreen();
    const { w, st } = fakeWindow();
    st.destroyed = true;
    z.set(w, true);
    expect(st.calls).toEqual([]);
  });
});
