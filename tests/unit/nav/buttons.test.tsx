// @vitest-environment happy-dom
// Back / forward buttons (start of the tab strip): greyed out (aria-disabled, still focusable) until the
// history has somewhere to go, live as that changes; labelled, with the shortcut in the tooltip.
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { NavButtons } from '../../../src/renderer/nav/buttons';
import { navCan } from '../../../src/renderer/nav/install';

describe('NavButtons', () => {
  it('reflects navCan live; aria-disabled keeps the buttons focusable', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    await act(() => render(<NavButtons />, host));
    const back = host.querySelector<HTMLButtonElement>('[aria-label="Go back"]')!;
    const fwd = host.querySelector<HTMLButtonElement>('[aria-label="Go forward"]')!;
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Navigation history');
    const disabled = () => [back, fwd].map((b) => b.getAttribute('aria-disabled') === 'true');
    expect(disabled()).toEqual([true, true]);
    expect(back.disabled || fwd.disabled).toBe(false);
    back.focus();
    expect(document.activeElement).toBe(back);

    await act(() => void (navCan.back.value = true));
    expect(disabled()).toEqual([false, true]);
    await act(() => void ((navCan.back.value = false), (navCan.forward.value = true)));
    expect(disabled()).toEqual([true, false]);

    expect(back.title).toBe('Go back (Alt+←) · mouse back button\nRight-click or hold: recent places');
    expect(fwd.title).toMatch(/^Go forward \(Alt\+→\) · mouse forward button\n/);
    expect(back.querySelectorAll('path').length).toBe(2); // arrowLeft is a startup icon (no empty box)
    await act(() => render(null, host));
  });
});
