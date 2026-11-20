// @vitest-environment happy-dom
// <Icon> names outside the startup set arrive later (the lazy icon pack, a feature chunk's addIcons):
// until then the icon is an empty box of the same size, and it redraws once the path is registered.
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { Icon, addIcons, hasIcon } from '../../../src/renderer/app/icons';

const paths = (host: HTMLElement) => [...host.querySelectorAll('path')].map((p) => p.getAttribute('d'));
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 30))));

describe('lazy icons', () => {
  it('draws an empty same-size box, then the path once a chunk registers it', async () => {
    const host = document.createElement('div');
    render(<Icon name="test-later" size={13} />, host);
    const svg = host.querySelector('svg')!;
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual(['13', '13']);
    expect(paths(host)).toEqual([]);
    await act(() => addIcons({ 'test-later': 'M1 1h2|M3 3h4' }));
    expect(paths(host)).toEqual(['M1 1h2', 'M3 3h4']);
  });

  it('requests the icon pack for an unknown name; afterwards pack names draw and unknown ones fall back to the file icon', async () => {
    const host = document.createElement('div');
    render(
      <>
        <Icon name="check" />
        <Icon name="no-such-icon" />
      </>,
      host,
    );
    // The pack is loaded on demand (dynamic import) — wait for it.
    for (let i = 0; i < 50 && !hasIcon('check'); i++) await settle();
    await settle();
    expect(hasIcon('check')).toBe(true);
    const [check, unknown] = [...host.querySelectorAll('svg')].map((s) => [...s.querySelectorAll('path')].map((p) => p.getAttribute('d')));
    expect(check).toEqual(['M20 6 9 17l-5-5']);
    expect(unknown.length).toBeGreaterThan(0); // the generic file glyph, as before the split
  });
});
