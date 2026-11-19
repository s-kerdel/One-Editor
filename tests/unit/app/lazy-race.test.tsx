// @vitest-environment happy-dom
// lazyComponent: preload() resolving between an instance's null render and its effect must not leave
// that instance empty forever.
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { lazyComponent } from '../../../src/renderer/app/lazy';

describe('lazyComponent preload race', () => {
  it('re-renders an instance that rendered before preload() settled', async () => {
    let resolve!: (c: () => any) => void;
    const loaded = new Promise<() => any>((r) => (resolve = r));
    const Lazy = lazyComponent(() => loaded);
    const host = document.createElement('div');
    // Render (null, chunk pending) and resolve the preload BEFORE effects flush.
    const p = Lazy.preload();
    render(<Lazy />, host);
    resolve(() => <b>ready</b>);
    await p;
    // Effects of a render outside act() flush on the next animation frame (happy-dom: a timer).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(host.textContent).toBe('ready');
  });
});
